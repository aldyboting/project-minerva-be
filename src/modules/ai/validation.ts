import { AiError } from './errors'
import type {
  DocumentConsultResult,
  DocumentRefineResult,
  DocumentReviewResult,
  IeltsSpeakingEvaluation,
  IeltsWritingEvaluation,
  InterviewAnswerEvaluation,
  InterviewPlanResult,
  ProviderMetadata,
  RubricCriterion,
  SuggestionTone,
} from './types'

type JsonRecord = Record<string, unknown>

function invalidResponse(message: string): never {
  throw new AiError({
    message: `The AI provider returned an invalid response: ${message}`,
    code: 'AI_INVALID_RESPONSE',
    status: 502,
    retryable: true,
  })
}

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const expectRecord = (value: unknown, path: string): JsonRecord => {
  if (!isRecord(value)) invalidResponse(`${path} must be an object`)
  return value
}

export const expectString = (
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): string => {
  if (typeof value !== 'string') invalidResponse(`${path} must be a string`)
  const normalized = value.trim()
  const min = options.min ?? 1
  const max = options.max ?? 20_000
  if (normalized.length < min || normalized.length > max) {
    invalidResponse(`${path} must contain between ${min} and ${max} characters`)
  }
  return normalized
}

export const expectNumber = (
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidResponse(`${path} must be a finite number`)
  }
  const min = options.min ?? Number.NEGATIVE_INFINITY
  const max = options.max ?? Number.POSITIVE_INFINITY
  if (value < min || value > max) invalidResponse(`${path} is outside the allowed range`)
  return value
}

const expectStringArray = (
  value: unknown,
  path: string,
  options: { min?: number; max?: number; itemMax?: number } = {},
): string[] => {
  if (!Array.isArray(value)) invalidResponse(`${path} must be an array`)
  const min = options.min ?? 0
  const max = options.max ?? 12
  if (value.length < min || value.length > max) {
    invalidResponse(`${path} must contain between ${min} and ${max} items`)
  }
  return value.map((item, index) =>
    expectString(item, `${path}[${index}]`, { max: options.itemMax ?? 1_500 }),
  )
}

const expectEnum = <T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    invalidResponse(`${path} must be one of ${values.join(', ')}`)
  }
  return value as T
}

export const parseJsonObject = (content: string): JsonRecord => {
  const trimmed = content.trim()
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  try {
    return expectRecord(JSON.parse(withoutFence) as unknown, 'response')
  } catch (error) {
    if (error instanceof AiError) throw error
    return invalidResponse('content was not valid JSON')
  }
}

const parseCriterion = (value: unknown, path: string): RubricCriterion => {
  const record = expectRecord(value, path)
  return {
    score: expectNumber(record.score, `${path}.score`, { min: 0, max: 9 }),
    feedback: expectString(record.feedback, `${path}.feedback`, { max: 2_000 }),
  }
}

export const parseDocumentReview = (
  content: string,
  metadata: ProviderMetadata,
): DocumentReviewResult => {
  const value = parseJsonObject(content)
  if (!Array.isArray(value.suggestions)) invalidResponse('suggestions must be an array')
  if (value.suggestions.length < 1 || value.suggestions.length > 8) {
    invalidResponse('suggestions must contain between 1 and 8 items')
  }

  const tones = ['purple', 'yellow', 'blue', 'green'] as const
  const priorities = ['high', 'medium', 'low'] as const

  return {
    overall: expectNumber(value.overall, 'overall', { min: 0, max: 100 }),
    clarity: expectNumber(value.clarity, 'clarity', { min: 0, max: 100 }),
    grammar: expectNumber(value.grammar, 'grammar', { min: 0, max: 100 }),
    structure: expectNumber(value.structure, 'structure', { min: 0, max: 100 }),
    impact: expectNumber(value.impact, 'impact', { min: 0, max: 100 }),
    scholarshipAlignment: expectNumber(value.scholarshipAlignment, 'scholarshipAlignment', {
      min: 0,
      max: 100,
    }),
    summary: expectString(value.summary, 'summary', { max: 2_000 }),
    strengths: expectStringArray(value.strengths, 'strengths', { min: 1, max: 6 }),
    suggestions: value.suggestions.map((item, index) => {
      const suggestion = expectRecord(item, `suggestions[${index}]`)
      return {
        category: expectString(suggestion.category, `suggestions[${index}].category`, { max: 80 }),
        title: expectString(suggestion.title, `suggestions[${index}].title`, { max: 160 }),
        detail: expectString(suggestion.detail, `suggestions[${index}].detail`, { max: 1_500 }),
        originalText: expectString(suggestion.originalText, `suggestions[${index}].originalText`, {
          max: 4_000,
        }),
        replacement: expectString(suggestion.replacement, `suggestions[${index}].replacement`, {
          max: 4_000,
        }),
        priority: expectEnum(
          suggestion.priority,
          `suggestions[${index}].priority`,
          priorities,
        ),
        tone: expectEnum<SuggestionTone>(suggestion.tone, `suggestions[${index}].tone`, tones),
      }
    }),
    metadata,
  }
}

export const parseDocumentRefine = (
  content: string,
  metadata: ProviderMetadata,
): DocumentRefineResult => {
  const value = parseJsonObject(content)
  if (!Array.isArray(value.changes)) invalidResponse('changes must be an array')
  if (value.changes.length < 1 || value.changes.length > 8) {
    invalidResponse('changes must contain between 1 and 8 items')
  }

  return {
    summary: expectString(value.summary, 'summary', { max: 2_000 }),
    changes: value.changes.map((item, index) => {
      const change = expectRecord(item, `changes[${index}]`)
      return {
        originalText: expectString(change.originalText, `changes[${index}].originalText`, {
          max: 4_000,
        }),
        replacement: expectString(change.replacement, `changes[${index}].replacement`, {
          max: 4_000,
        }),
        reason: expectString(change.reason, `changes[${index}].reason`, { max: 500 }),
      }
    }),
    metadata,
  }
}

export const parseDocumentConsult = (
  content: string,
  metadata: ProviderMetadata,
): DocumentConsultResult => {
  const value = parseJsonObject(content)
  return {
    reply: expectString(value.reply, 'reply', { max: 4_000 }),
    intent: expectEnum(value.intent, 'intent', ['advise', 'refine'] as const),
    refineInstruction: expectString(value.refineInstruction, 'refineInstruction', { max: 1_000 }),
    metadata,
  }
}

export const parseInterviewPlan = (
  content: string,
  metadata: ProviderMetadata,
): InterviewPlanResult => {
  const value = parseJsonObject(content)
  if (!Array.isArray(value.questions)) invalidResponse('questions must be an array')
  if (value.questions.length < 5 || value.questions.length > 7) {
    invalidResponse('questions must contain between 5 and 7 items')
  }

  return {
    questions: value.questions.map((item, index) => {
      const question = expectRecord(item, `questions[${index}]`)
      return {
        text: expectString(question.text, `questions[${index}].text`, { max: 800 }),
        focus: expectString(question.focus, `questions[${index}].focus`, { max: 300 }),
      }
    }),
    metadata,
  }
}

export const parseInterviewAnswer = (
  content: string,
  metadata: ProviderMetadata,
): InterviewAnswerEvaluation => {
  const value = parseJsonObject(content)
  return {
    relevance: expectNumber(value.relevance, 'relevance', { min: 0, max: 100 }),
    clarity: expectNumber(value.clarity, 'clarity', { min: 0, max: 100 }),
    structure: expectNumber(value.structure, 'structure', { min: 0, max: 100 }),
    specificity: expectNumber(value.specificity, 'specificity', { min: 0, max: 100 }),
    scholarshipAlignment: expectNumber(value.scholarshipAlignment, 'scholarshipAlignment', {
      min: 0,
      max: 100,
    }),
    highlights: expectStringArray(value.highlights, 'highlights', { min: 1, max: 6 }),
    improvements: expectStringArray(value.improvements, 'improvements', { min: 1, max: 6 }),
    strongerAnswerExample: expectString(value.strongerAnswerExample, 'strongerAnswerExample', {
      max: 5_000,
    }),
    metadata,
  }
}

export const parseIeltsWriting = (
  content: string,
  metadata: ProviderMetadata,
): IeltsWritingEvaluation => {
  const value = parseJsonObject(content)
  if (!Array.isArray(value.correctedExamples)) {
    invalidResponse('correctedExamples must be an array')
  }
  if (value.correctedExamples.length > 8) invalidResponse('correctedExamples has too many items')

  return {
    taskAchievement: parseCriterion(value.taskAchievement, 'taskAchievement'),
    coherenceAndCohesion: parseCriterion(value.coherenceAndCohesion, 'coherenceAndCohesion'),
    lexicalResource: parseCriterion(value.lexicalResource, 'lexicalResource'),
    grammaticalRangeAndAccuracy: parseCriterion(
      value.grammaticalRangeAndAccuracy,
      'grammaticalRangeAndAccuracy',
    ),
    estimatedBand: expectNumber(value.estimatedBand, 'estimatedBand', { min: 0, max: 9 }),
    strengths: expectStringArray(value.strengths, 'strengths', { min: 1, max: 6 }),
    improvements: expectStringArray(value.improvements, 'improvements', { min: 1, max: 6 }),
    correctedExamples: value.correctedExamples.map((item, index) => {
      const example = expectRecord(item, `correctedExamples[${index}]`)
      return {
        original: expectString(example.original, `correctedExamples[${index}].original`, { max: 1_500 }),
        correction: expectString(example.correction, `correctedExamples[${index}].correction`, {
          max: 1_500,
        }),
        explanation: expectString(example.explanation, `correctedExamples[${index}].explanation`, {
          max: 1_500,
        }),
      }
    }),
    disclaimer: 'Unofficial AI estimate for practice only; it is not an official IELTS score.',
    metadata,
  }
}

export const parseIeltsSpeaking = (
  content: string,
  metadata: ProviderMetadata,
  metrics: IeltsSpeakingEvaluation['metrics'],
): IeltsSpeakingEvaluation => {
  const value = parseJsonObject(content)
  return {
    fluencyAndCoherence: parseCriterion(value.fluencyAndCoherence, 'fluencyAndCoherence'),
    lexicalResource: parseCriterion(value.lexicalResource, 'lexicalResource'),
    grammaticalRangeAndAccuracy: parseCriterion(
      value.grammaticalRangeAndAccuracy,
      'grammaticalRangeAndAccuracy',
    ),
    estimatedBand: expectNumber(value.estimatedBand, 'estimatedBand', { min: 0, max: 9 }),
    strengths: expectStringArray(value.strengths, 'strengths', { min: 1, max: 6 }),
    improvements: expectStringArray(value.improvements, 'improvements', { min: 1, max: 6 }),
    pronunciationAssessment:
      'Pronunciation is not assessed because this estimate is based on the transcript and timing only.',
    disclaimer:
      'Unofficial AI estimate for practice only; pronunciation is excluded and this is not an official IELTS score.',
    metrics,
    metadata,
  }
}
