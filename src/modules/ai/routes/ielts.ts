import { Elysia, t } from 'elysia'
import { requireAuth } from '../../../auth/session'
import { AppError } from '../../../lib/errors'
import { IeltsAiEvaluation, toStoredMetadata } from '../models'
import { runPaidAiOperation } from '../paid-operation'
import { recordCompletedUsage, recordFailedUsage } from '../usage'
import { activeChatModel, activeTranscriptionModel } from '../provider'
import { throwRouteError, validateAudio, type AiRouteDependencies } from './shared'

const withoutMetadata = <T extends { metadata: unknown }>(value: T): Omit<T, 'metadata'> => {
  const { metadata: _metadata, ...result } = value
  return result
}

const asUploadFile = (value: unknown, fallbackName: string): File => {
  if (value instanceof File) return value
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return new File([value], fallbackName, { type: value.type || 'audio/webm' })
  }
  throw new AppError(422, 'MISSING_AUDIO', 'Record an answer before sending it to the examiner')
}

type EvaluationListItem = {
  _id: unknown
  kind: 'writing' | 'speaking'
  task?: string
  prompt: string
  transcript?: string
  durationSeconds?: number
  result: unknown
  createdAt: Date
}

export const createIeltsAiRoutes = ({ getAi }: AiRouteDependencies) =>
  new Elysia({ name: 'minerva-ai-ielts' })
    .get('/api/ielts/evaluations', async ({ request, query }) => {
      const { userId } = await requireAuth(request)
      const kind = query.kind === 'writing' || query.kind === 'speaking' ? query.kind : undefined
      const evaluations = await IeltsAiEvaluation.find({ userId, ...(kind ? { kind } : {}) })
        .sort({ createdAt: -1 })
        .limit(30)
        .select('kind task prompt transcript durationSeconds result createdAt')
        .lean() as unknown as EvaluationListItem[]
      return {
        evaluations: evaluations.map((evaluation) => ({
          id: String(evaluation._id),
          kind: evaluation.kind,
          task: evaluation.task,
          prompt: evaluation.prompt,
          transcript: evaluation.transcript,
          durationSeconds: evaluation.durationSeconds,
          result: evaluation.result,
          createdAt: evaluation.createdAt,
        })),
      }
    })
    .post(
      '/api/ielts/speaking/turn',
      async ({ request, body, set }) => {
        const { userId } = await requireAuth(request)
        const audio = asUploadFile(body.audio, 'ielts-speaking-turn.webm')
        validateAudio(audio)

        const part = Math.min(3, Math.max(1, Number(body.part)))
        const durationSeconds = Math.min(1_800, Math.max(1, Number(body.durationSeconds) || 1))
        const prompt = String(body.prompt || '').trim()
        const partBrief = String(body.partBrief || '').trim() || undefined
        if (!prompt) throw new AppError(422, 'EMPTY_PROMPT', 'A speaking question is required')
        if (!Number.isFinite(part) || part < 1 || part > 3) {
          throw new AppError(422, 'INVALID_PART', 'Speaking part must be 1, 2, or 3')
        }

        let previousTurns: Array<{ examiner: string; candidate: string }> = []
        const historyValue = body.history as unknown
        if (Array.isArray(historyValue)) {
          previousTurns = historyValue
            .map((entry) => {
              if (!entry || typeof entry !== 'object') return null
              const row = entry as Record<string, unknown>
              const examiner = row.examiner == null ? '' : String(row.examiner).trim()
              const candidate = row.candidate == null ? '' : String(row.candidate).trim()
              if (!examiner || !candidate) return null
              return { examiner, candidate }
            })
            .filter((entry): entry is { examiner: string; candidate: string } => Boolean(entry))
            .slice(-24)
        } else if (typeof historyValue === 'string' && historyValue.trim()) {
          try {
            const parsed = JSON.parse(historyValue)
            previousTurns = Array.isArray(parsed)
              ? parsed
                .map((entry) => {
                  if (!entry || typeof entry !== 'object') return null
                  const row = entry as Record<string, unknown>
                  const examiner = row.examiner == null ? '' : String(row.examiner).trim()
                  const candidate = row.candidate == null ? '' : String(row.candidate).trim()
                  if (!examiner || !candidate) return null
                  return { examiner, candidate }
                })
                .filter((entry): entry is { examiner: string; candidate: string } => Boolean(entry))
                .slice(-24)
              : []
          } catch {
            previousTurns = []
          }
        }

        const paidResult = await runPaidAiOperation(userId, async () => {
          const transcript = await getAi().transcribe({
            audio,
            filename: audio.name || 'ielts-speaking-turn.webm',
            language: 'english',
            returnTimestamps: 'word',
          })
          const reply = await getAi().replyToIeltsSpeaking({
            part,
            prompt,
            partBrief,
            transcript: transcript.text,
            previousTurns,
          })
          return { transcript, reply }
        }).catch(async (error) => {
          await recordFailedUsage({
            userId,
            operation: 'ielts_speaking',
            model: activeChatModel(),
            error,
            audioSeconds: durationSeconds,
          })
          return throwRouteError(error)
        })
        const { transcript, reply } = paidResult.value
        await recordCompletedUsage({
          userId,
          operation: 'ielts_speaking',
          metadata: reply.metadata,
          audioSeconds: durationSeconds,
        })
        const record = await IeltsAiEvaluation.create({
          userId,
          kind: 'speaking',
          prompt,
          transcript: transcript.text,
          durationSeconds,
          result: {
            conversational: true,
            part,
            reply: reply.text,
            nextQuestion: reply.nextQuestion,
            shouldContinue: reply.shouldContinue,
          },
          metadata: toStoredMetadata(reply.metadata),
          transcriptionMetadata: toStoredMetadata(transcript.metadata),
        })
        let voice: { dataUrl: string; contentType: string } | undefined
        try {
          const spokenText = reply.nextQuestion ? `${reply.text} ${reply.nextQuestion}` : reply.text
          const speech = await getAi().synthesizeSpeech({ text: spokenText, language: 'a', speed: 1 })
          voice = { dataUrl: speech.dataUrl, contentType: speech.contentType }
        } catch { /* Text reply remains available when TTS is unavailable. */ }
        set.status = 201
        return {
          turnId: String(record._id),
          transcript: {
            text: transcript.text,
            chunks: transcript.chunks,
            language: transcript.language,
          },
          examiner: {
            text: reply.text,
            nextQuestion: reply.nextQuestion,
            shouldContinue: reply.shouldContinue,
          },
          tokenBalance: paidResult.tokenBalance,
          voice,
        }
      },
      {
        body: t.Object({
          // Multipart parsers may keep fields as strings or JSON-decode them.
          audio: t.Any(),
          prompt: t.String({ minLength: 1, maxLength: 8_000 }),
          part: t.Union([t.String(), t.Number()]),
          durationSeconds: t.Union([t.String(), t.Number()]),
          history: t.Optional(t.Union([
            t.String(),
            t.Null(),
            t.Array(t.Object({
              examiner: t.String(),
              candidate: t.String(),
            })),
            t.Array(t.Any()),
          ])),
          partBrief: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      },
    )
    .post(
      '/api/ielts/speaking/question-voice',
      async ({ request, body }) => {
        await requireAuth(request)
        try {
          const introduction = body.introduction?.trim() || 'Hello. I am your IELTS speaking examiner. Here is your question.'
          const spoken = `${introduction} ${body.text.trim()}`.slice(0, 1_200)
          const speech = await getAi().synthesizeSpeech({ text: spoken, language: 'a', speed: 1 })
          return { voice: { text: spoken, dataUrl: speech.dataUrl, contentType: speech.contentType } }
        } catch (error) {
          console.warn('IELTS speaking question voice unavailable', error)
          return { voice: null, reason: 'Examiner voice is temporarily unavailable. You can continue with the question on screen.' }
        }
      },
      {
        body: t.Object({
          text: t.String({ minLength: 1, maxLength: 2_000 }),
          introduction: t.Optional(t.String({ maxLength: 300 })),
          part: t.Optional(t.Numeric({ minimum: 1, maximum: 3 })),
        }),
      },
    )
    .post(
      '/api/ielts/writing/evaluate',
      async ({ request, body, set }) => {
        const { userId } = await requireAuth(request)
        const paidResult = await runPaidAiOperation(
          userId,
          () => getAi().evaluateIeltsWriting(body),
        ).catch(async (error) => {
          await recordFailedUsage({
            userId,
            operation: 'ielts_writing',
            model: activeChatModel(),
            error,
          })
          return throwRouteError(error)
        })
        const evaluation = paidResult.value
        await recordCompletedUsage({
          userId,
          operation: 'ielts_writing',
          metadata: evaluation.metadata,
        })
        const result = withoutMetadata(evaluation)
        const record = await IeltsAiEvaluation.create({
          userId,
          kind: 'writing',
          task: body.task,
          prompt: body.prompt,
          response: body.response,
          result,
          metadata: toStoredMetadata(evaluation.metadata),
        })
        set.status = 201
        return { evaluationId: String(record._id), evaluation: result, tokenBalance: paidResult.tokenBalance }
      },
      {
        body: t.Object({
          task: t.String({ minLength: 1, maxLength: 100 }),
          prompt: t.String({ minLength: 1, maxLength: 8_000 }),
          response: t.String({ minLength: 1, maxLength: 40_000 }),
        }),
      },
    )
    .post(
      '/api/ielts/speaking/evaluate',
      async ({ request, body, set }) => {
        const { userId } = await requireAuth(request)
        validateAudio(body.audio)
        const paidResult = await runPaidAiOperation(userId, async () => {
          const transcript = await getAi().transcribe({
            audio: body.audio,
            filename: body.audio.name || 'ielts-speaking.webm',
            language: 'english',
            returnTimestamps: 'word',
          }).catch(async (error) => {
            await recordFailedUsage({
              userId,
              operation: 'transcription',
              model: activeTranscriptionModel(),
              error,
              audioSeconds: body.durationSeconds,
            })
            throw error
          })
          await recordCompletedUsage({
            userId,
            operation: 'transcription',
            metadata: transcript.metadata,
            audioSeconds: body.durationSeconds,
          })

          const evaluation = await getAi().evaluateIeltsSpeaking({
            prompt: body.prompt,
            transcript,
            durationSeconds: body.durationSeconds,
          }).catch(async (error) => {
            await recordFailedUsage({
              userId,
              operation: 'ielts_speaking',
              model: activeChatModel(),
              error,
              audioSeconds: body.durationSeconds,
            })
            throw error
          })
          await recordCompletedUsage({
            userId,
            operation: 'ielts_speaking',
            metadata: evaluation.metadata,
            audioSeconds: body.durationSeconds,
          })
          return { transcript, evaluation }
        }).catch((error) => throwRouteError(error))
        const { transcript, evaluation } = paidResult.value
        const result = withoutMetadata(evaluation)
        const record = await IeltsAiEvaluation.create({
          userId,
          kind: 'speaking',
          prompt: body.prompt,
          transcript: transcript.text,
          durationSeconds: body.durationSeconds,
          result,
          transcriptionMetadata: toStoredMetadata(transcript.metadata),
          metadata: toStoredMetadata(evaluation.metadata),
        })
        set.status = 201
        return {
          evaluationId: String(record._id),
          transcript: {
            text: transcript.text,
            chunks: transcript.chunks,
            language: transcript.language,
          },
          evaluation: result,
          tokenBalance: paidResult.tokenBalance,
        }
      },
      {
        body: t.Object({
          audio: t.File(),
          prompt: t.String({ minLength: 1, maxLength: 8_000 }),
          durationSeconds: t.Numeric({ minimum: 1, maximum: 1_800 }),
        }),
      },
    )
