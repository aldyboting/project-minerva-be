import { Elysia, t } from 'elysia'
import { requireAuth } from '../../../auth/session'
import { AppError } from '../../../lib/errors'
import { InterviewSession, toStoredMetadata } from '../models'
import { runPaidAiOperation } from '../paid-operation'
import { recordCompletedUsage, recordFailedUsage } from '../usage'
import { activeChatModel, activeTranscriptionModel } from '../provider'
import {
  resolveScholarship,
  throwRouteError,
  validateAudio,
  type AiRouteDependencies,
} from './shared'

const withoutMetadata = <T extends { metadata: unknown }>(value: T): Omit<T, 'metadata'> => {
  const { metadata: _metadata, ...result } = value
  return result
}

type QuestionLike = {
  _id: unknown
  text: string
  focus: string
  position: number
}

type EvaluationLike = {
  relevance: number
  clarity: number
  structure: number
  specificity: number
  scholarshipAlignment: number
  highlights: string[]
  improvements: string[]
  strongerAnswerExample: string
}

type AnswerLike = {
  questionId: unknown
  durationSeconds: number
  transcript: { text: string; chunks: Array<{ timestamp: number[]; text: string }>; language?: string }
  evaluation: EvaluationLike
  interviewerReply?: string
  createdAt: Date
}

type InterviewHistoryLike = {
  _id: unknown
  scholarshipName: string
  provider: string
  country: string
  language: 'en' | 'id'
  status: 'active' | 'completed'
  questions: unknown[]
  answers: unknown[]
  aggregate?: { overall?: number }
  createdAt: Date
  completedAt?: Date
  updatedAt: Date
}

const average = (values: number[]): number =>
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0

const aggregateAnswers = (answers: AnswerLike[]) => {
  if (!answers.length) throw new AppError(409, 'NO_INTERVIEW_ANSWERS', 'Record at least one answer before completing the interview')
  const relevance = average(answers.map((answer) => answer.evaluation.relevance))
  const clarity = average(answers.map((answer) => answer.evaluation.clarity))
  const structure = average(answers.map((answer) => answer.evaluation.structure))
  const specificity = average(answers.map((answer) => answer.evaluation.specificity))
  const scholarshipAlignment = average(
    answers.map((answer) => answer.evaluation.scholarshipAlignment),
  )
  return {
    overall: average([relevance, clarity, structure, specificity, scholarshipAlignment]),
    relevance,
    clarity,
    structure,
    specificity,
    scholarshipAlignment,
    highlights: [...new Set(answers.flatMap((answer) => answer.evaluation.highlights))].slice(0, 8),
    improvements: [...new Set(answers.flatMap((answer) => answer.evaluation.improvements))].slice(0, 8),
    answeredQuestions: answers.length,
  }
}

export const createInterviewRoutes = ({ getAi }: AiRouteDependencies) =>
  new Elysia({ name: 'minerva-ai-interviews' })
    .get('/api/interviews', async ({ request }) => {
      const { userId } = await requireAuth(request)
      const sessions = await InterviewSession.find({ userId })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(10)
        .select('scholarshipName provider country language status questions answers aggregate createdAt completedAt updatedAt')
        .lean() as unknown as InterviewHistoryLike[]
      return {
        sessions: sessions.map((session) => ({
          id: String(session._id),
          scholarshipName: session.scholarshipName,
          provider: session.provider,
          country: session.country,
          language: session.language,
          status: session.status,
          questionCount: session.questions.length,
          answerCount: session.answers.length,
          overall: session.aggregate?.overall,
          createdAt: session.createdAt,
          completedAt: session.completedAt,
          updatedAt: session.updatedAt,
        })),
      }
    })
    .post(
      '/api/interviews',
      async ({ request, body, set }) => {
        const { userId } = await requireAuth(request)
        if (await InterviewSession.countDocuments({ userId }) >= 10) { throw new AppError(409, 'INTERVIEW_LIMIT_REACHED', 'You can keep up to 10 interviews. Delete one from history before starting another.') }
        const persisted = await resolveScholarship(body.scholarshipId) as Record<string, unknown> | null
        const scholarshipName = typeof persisted?.name === 'string' ? persisted.name : body.scholarshipName
        const provider = typeof persisted?.provider === 'string' ? persisted.provider : body.provider
        const country = typeof persisted?.country === 'string' ? persisted.country : body.country

        const paidResult = await runPaidAiOperation(userId, () =>
          getAi().generateInterview({
            scholarshipName,
            provider,
            country,
            language: body.language,
            context: body.context,
          }),
        ).catch(async (error) => {
          await recordFailedUsage({
            userId,
            operation: 'interview_questions',
            model: activeChatModel(),
            error,
          })
          return throwRouteError(error)
        })
        const plan = paidResult.value
        await recordCompletedUsage({
          userId,
          operation: 'interview_questions',
          metadata: plan.metadata,
        })
        const session = await InterviewSession.create({
          userId,
          scholarshipId: body.scholarshipId,
          scholarshipName,
          provider,
          country,
          language: body.language,
          context: body.context,
          status: 'active',
          questions: plan.questions.map((question, position) => ({ ...question, position })),
          answers: [],
        })
        set.status = 201
        return {
          sessionId: String(session._id),
          questions: (session.questions as unknown as QuestionLike[])
            .sort((left, right) => left.position - right.position)
            .map((question) => ({ id: String(question._id), text: question.text })),
          tokenBalance: paidResult.tokenBalance,
        }
      },
      {
        body: t.Object({
          scholarshipId: t.String({ minLength: 1, maxLength: 100 }),
          scholarshipName: t.String({ minLength: 1, maxLength: 300 }),
          provider: t.String({ minLength: 1, maxLength: 300 }),
          country: t.String({ minLength: 1, maxLength: 120 }),
          language: t.Union([t.Literal('en'), t.Literal('id')]),
          context: t.Optional(t.String({ maxLength: 12_000 })),
        }),
      },
    )
    .get('/api/interviews/:sessionId', async ({ request, params }) => {
      const { userId } = await requireAuth(request)
      const session = await InterviewSession.findOne({ _id: params.sessionId, userId }).lean()
      if (!session) throw new AppError(404, 'INTERVIEW_NOT_FOUND', 'Interview session not found')
      const questions = session.questions as unknown as QuestionLike[]
      const answers = session.answers as unknown as AnswerLike[]
      return {
        session: {
          id: String(session._id),
          scholarshipId: session.scholarshipId,
          scholarshipName: session.scholarshipName,
          provider: session.provider,
          country: session.country,
          language: session.language,
          status: session.status,
          questions: questions
            .sort((left, right) => left.position - right.position)
            .map((question) => ({ id: String(question._id), text: question.text, focus: question.focus })),
          answers: answers.map((answer) => ({
            questionId: String(answer.questionId),
            durationSeconds: answer.durationSeconds,
            transcript: answer.transcript,
            evaluation: answer.evaluation,
            interviewerReply: answer.interviewerReply,
            createdAt: answer.createdAt,
          })),
          aggregate: session.aggregate,
          createdAt: session.createdAt,
          completedAt: session.completedAt,
        },
      }
    })
    .delete('/api/interviews/:sessionId', async ({ request, params }) => {
      const { userId } = await requireAuth(request)
      const deleted = await InterviewSession.findOneAndDelete({ _id: params.sessionId, userId })
      if (!deleted) throw new AppError(404, 'INTERVIEW_NOT_FOUND', 'Interview session not found')
      return { success: true }
    })
    .post(
      '/api/interviews/:sessionId/question-voice',
      async ({ request, params, body }) => {
        const { userId } = await requireAuth(request)
        const session = await InterviewSession.findOne({ _id: params.sessionId, userId }).lean()
        if (!session) throw new AppError(404, 'INTERVIEW_NOT_FOUND', 'Interview session not found')
        const questions = session.questions as unknown as QuestionLike[]
        const question = questions.find((item) => String(item._id) === body.questionId)
        if (!question) throw new AppError(404, 'QUESTION_NOT_FOUND', 'Interview question not found')
        const introduction = question.position === 0
          ? (session.language === 'id'
            ? 'Halo, saya Minerva, pewawancara AI Anda. Jawablah pertanyaan ini dengan tenang.'
            : 'Hello, I am Minerva, your AI interviewer. Take your time and answer this question.')
          : (session.language === 'id'
            ? 'Terima kasih. Berikut pertanyaan berikutnya.'
            : 'Thank you. Here is the next question.')
        try {
          const voice = await getAi().synthesizeSpeech({
            text: `${introduction} ${question.text}`,
            language: 'a',
            speed: 1,
          })
          return { voice: { text: `${introduction} ${question.text}`, dataUrl: voice.dataUrl, contentType: voice.contentType } }
        } catch (error) {
          console.warn('Interview question voice unavailable', error)
          return { voice: null, reason: 'Minerva voice is temporarily unavailable. You can continue with the question on screen.' }
        }
      },
      { body: t.Object({ questionId: t.String({ minLength: 1, maxLength: 100 }) }) },
    )
    .post(
      '/api/interviews/:sessionId/answers',
      async ({ request, params, body, set }) => {
        const { userId } = await requireAuth(request)
        const session = await InterviewSession.findOne({ _id: params.sessionId, userId })
        if (!session) throw new AppError(404, 'INTERVIEW_NOT_FOUND', 'Interview session not found')
        if (session.status !== 'active') {
          throw new AppError(409, 'INTERVIEW_COMPLETED', 'This interview has already been completed')
        }

        const audioValue = body.audio as unknown
        const audio = audioValue instanceof File
          ? audioValue
          : typeof Blob !== 'undefined' && audioValue instanceof Blob
            ? new File([audioValue], 'interview-answer.webm', { type: audioValue.type || 'audio/webm' })
            : null
        if (!audio) throw new AppError(422, 'MISSING_AUDIO', 'Record an answer before sending it to the interviewer')
        validateAudio(audio)

        const questionId = String(body.questionId || '')
        const durationSeconds = Math.min(1_800, Math.max(1, Number(body.durationSeconds) || 1))
        const questions = session.questions as unknown as QuestionLike[]
        const question = questions.find((item) => String(item._id) === questionId)
        if (!question) throw new AppError(404, 'QUESTION_NOT_FOUND', 'Interview question not found')
        const answers = session.answers as unknown as AnswerLike[]
        if (answers.some((answer) => String(answer.questionId) === questionId)) {
          throw new AppError(409, 'ANSWER_ALREADY_SUBMITTED', 'An answer has already been submitted for this question')
        }

        const previousTurns = answers.slice(-8).map((answer) => {
          const matched = questions.find((item) => String(item._id) === String(answer.questionId))
          return {
            question: matched?.text || 'Previous question',
            answer: answer.transcript?.text || '',
            reply: answer.interviewerReply,
          }
        }).filter((turn) => turn.answer)

        const paidResult = await runPaidAiOperation(userId, async () => {
          const transcript = await getAi().transcribe({
            audio,
            filename: audio.name || 'interview-answer.webm',
            language: session.language === 'en' ? 'english' : undefined,
            returnTimestamps: 'word',
          }).catch(async (error) => {
            await recordFailedUsage({
              userId,
              operation: 'transcription',
              model: activeTranscriptionModel(),
              error,
              audioSeconds: durationSeconds,
            })
            throw error
          })
          await recordCompletedUsage({
            userId,
            operation: 'transcription',
            metadata: transcript.metadata,
            audioSeconds: durationSeconds,
          })

          const evaluation = await getAi().evaluateInterviewAnswer({
            scholarshipName: session.scholarshipName,
            provider: session.provider,
            question: question.text,
            transcript: transcript.text,
            durationSeconds,
            language: session.language,
          }).catch(async (error) => {
            await recordFailedUsage({
              userId,
              operation: 'interview_answer',
              model: activeChatModel(),
              error,
              audioSeconds: durationSeconds,
            })
            throw error
          })
          await recordCompletedUsage({
            userId,
            operation: 'interview_answer',
            metadata: evaluation.metadata,
            audioSeconds: durationSeconds,
          })
          const reply = await getAi().replyToInterviewAnswer({
            scholarshipName: session.scholarshipName,
            question: question.text,
            transcript: transcript.text,
            language: session.language,
            allowFollowUp: question.focus !== 'follow-up',
            previousTurns,
          })
          return { transcript, evaluation, reply }
        }).catch((error) => throwRouteError(error))
        const { transcript, evaluation, reply } = paidResult.value
        let followUp: { id: string; text: string } | undefined
        if (reply.followUp) {
          const created = session.questions.create({ text: reply.followUp, focus: 'follow-up', position: question.position + 0.5 })
          session.questions.push(created)
          followUp = { id: String(created._id), text: created.text }
        }

        session.answers.push({
          questionId: question._id,
          durationSeconds,
          transcript: {
            text: transcript.text,
            chunks: transcript.chunks,
            language: transcript.language,
          },
          evaluation: withoutMetadata(evaluation),
          interviewerReply: reply.text,
          transcriptionMetadata: toStoredMetadata(transcript.metadata),
          evaluationMetadata: toStoredMetadata(evaluation.metadata),
          createdAt: new Date(),
        })
        await session.save()
        let voice: { text: string; dataUrl: string; contentType: string } | undefined
        try {
          const spokenReply = reply.followUp ? `${reply.text} ${reply.followUp}` : reply.text
          const speech = await getAi().synthesizeSpeech({
            text: spokenReply,
            language: 'a',
            speed: 1,
          })
          voice = { text: spokenReply, dataUrl: speech.dataUrl, contentType: speech.contentType }
        } catch {
          // Transcript, analysis, and the text reply remain available if voice synthesis is temporarily unavailable.
        }
        set.status = 201
        return {
          transcript: {
            text: transcript.text,
            chunks: transcript.chunks,
            language: transcript.language,
          },
          evaluation: withoutMetadata(evaluation),
          reply: { text: reply.text },
          followUp,
          voice,
          tokenBalance: paidResult.tokenBalance,
        }
      },
      {
        body: t.Object({
          questionId: t.Union([t.String(), t.Number()]),
          audio: t.Any(),
          durationSeconds: t.Union([t.String(), t.Number()]),
        }),
      },
    )
    .post('/api/interviews/:sessionId/complete', async ({ request, params }) => {
      const { userId } = await requireAuth(request)
      const session = await InterviewSession.findOne({ _id: params.sessionId, userId })
      if (!session) throw new AppError(404, 'INTERVIEW_NOT_FOUND', 'Interview session not found')
      if (session.status === 'completed' && session.aggregate) return { aggregate: session.aggregate }

      const aggregate = aggregateAnswers(session.answers as unknown as AnswerLike[])
      session.aggregate = aggregate
      session.status = 'completed'
      session.completedAt = new Date()
      await session.save()
      return { aggregate }
    })
