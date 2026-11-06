export type AiOperation =
  | 'chat'
  | 'document_review'
  | 'document_refine'
  | 'document_consult'
  | 'interview_questions'
  | 'interview_answer'
  | 'ielts_writing'
  | 'ielts_speaking'
  | 'transcription'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessageInput {
  role: ChatRole
  content: string
}

export interface ProviderUsage {
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number
}

export interface ProviderMetadata {
  provider: 'elice' | 'google' | 'openrouter'
  model: string
  requestId?: string
  usage: ProviderUsage
  latencyMs: number
}

export interface TerraCompletion {
  content: string
  metadata: ProviderMetadata
}

export interface TerraCompletionRequest {
  messages: ChatMessageInput[]
  maxCompletionTokens?: number
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
  responseSchema?: {
    name: string
    schema: Record<string, unknown>
  }
}

export interface TerraPort {
  complete(request: TerraCompletionRequest): Promise<TerraCompletion>
}

export interface TranscriptChunk {
  timestamp: [number, number]
  text: string
}

export interface TranscriptResult {
  text: string
  chunks: TranscriptChunk[]
  language?: string
  metadata: ProviderMetadata
}

export interface TranscriptionRequest {
  audio: Blob
  filename: string
  language?: 'english' | 'korean'
  returnTimestamps?: true | 'word'
}

export interface WhisperPort {
  transcribe(request: TranscriptionRequest): Promise<TranscriptResult>
}

export interface SpeechSynthesisRequest {
  text: string
  language: 'a' | 'b'
  voice?: string
  speed?: number
}

export interface SpeechSynthesisResult {
  dataUrl: string
  contentType: string
  metadata: ProviderMetadata
}

export interface KokoroPort {
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>
}

export type SuggestionTone = 'purple' | 'yellow' | 'blue' | 'green'

export interface DocumentSuggestionDraft {
  category: string
  title: string
  detail: string
  originalText: string
  replacement: string
  priority: 'high' | 'medium' | 'low'
  tone: SuggestionTone
}

export interface DocumentReviewResult {
  overall: number
  clarity: number
  grammar: number
  structure: number
  impact: number
  scholarshipAlignment: number
  summary: string
  strengths: string[]
  suggestions: DocumentSuggestionDraft[]
  metadata: ProviderMetadata
}

export interface DocumentRefineChange {
  originalText: string
  replacement: string
  reason: string
}

export interface DocumentRefineResult {
  summary: string
  changes: DocumentRefineChange[]
  metadata: ProviderMetadata
}

export interface DocumentConsultResult {
  reply: string
  intent: 'advise' | 'refine'
  refineInstruction: string
  metadata: ProviderMetadata
}

export interface InterviewQuestionDraft {
  text: string
  focus: string
}

export interface InterviewPlanResult {
  questions: InterviewQuestionDraft[]
  metadata: ProviderMetadata
}

export interface InterviewAnswerEvaluation {
  relevance: number
  clarity: number
  structure: number
  specificity: number
  scholarshipAlignment: number
  highlights: string[]
  improvements: string[]
  strongerAnswerExample: string
  metadata: ProviderMetadata
}

export interface RubricCriterion {
  score: number
  feedback: string
}

export interface IeltsWritingEvaluation {
  taskAchievement: RubricCriterion
  coherenceAndCohesion: RubricCriterion
  lexicalResource: RubricCriterion
  grammaticalRangeAndAccuracy: RubricCriterion
  estimatedBand: number
  strengths: string[]
  improvements: string[]
  correctedExamples: Array<{
    original: string
    correction: string
    explanation: string
  }>
  disclaimer: string
  metadata: ProviderMetadata
}

export interface SpeakingMetrics {
  durationSeconds: number
  wordCount: number
  wordsPerMinute: number
  longPauseCount: number
}

export interface IeltsSpeakingEvaluation {
  fluencyAndCoherence: RubricCriterion
  lexicalResource: RubricCriterion
  grammaticalRangeAndAccuracy: RubricCriterion
  estimatedBand: number
  strengths: string[]
  improvements: string[]
  pronunciationAssessment: string
  disclaimer: string
  metrics: SpeakingMetrics
  metadata: ProviderMetadata
}

export interface MinervaAI {
  chat(input: {
    messages: ChatMessageInput[]
    context?: string
  }): Promise<{ text: string; metadata: ProviderMetadata }>

  reviewDocument(input: {
    title: string
    prompt?: string
    content: string
    scholarshipContext?: string
  }): Promise<DocumentReviewResult>

  refineDocument(input: {
    title: string
    instruction: string
    prompt?: string
    content: string
    scholarshipContext?: string
  }): Promise<DocumentRefineResult>

  consultDocument(input: {
    title: string
    message: string
    prompt?: string
    content: string
    scholarshipContext?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }): Promise<DocumentConsultResult>

  generateInterview(input: {
    scholarshipName: string
    provider: string
    country: string
    language: 'en' | 'id'
    context?: string
  }): Promise<InterviewPlanResult>

  evaluateInterviewAnswer(input: {
    scholarshipName: string
    provider: string
    question: string
    transcript: string
    durationSeconds: number
    language: 'en' | 'id'
  }): Promise<InterviewAnswerEvaluation>

  replyToInterviewAnswer(input: {
    scholarshipName: string
    question: string
    transcript: string
    language: 'en' | 'id'
    allowFollowUp: boolean
    previousTurns?: Array<{ question: string; answer: string; reply?: string }>
  }): Promise<{ text: string; followUp?: string; metadata: ProviderMetadata }>

  replyToIeltsSpeaking(input: {
    part: number
    prompt: string
    partBrief?: string
    transcript: string
    previousTurns: Array<{ examiner: string; candidate: string }>
  }): Promise<{ text: string; nextQuestion?: string; shouldContinue: boolean; metadata: ProviderMetadata }>

  synthesizeSpeech(input: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>

  evaluateIeltsWriting(input: {
    task: string
    prompt: string
    response: string
  }): Promise<IeltsWritingEvaluation>

  evaluateIeltsSpeaking(input: {
    prompt: string
    transcript: TranscriptResult
    durationSeconds: number
  }): Promise<IeltsSpeakingEvaluation>

  transcribe(input: TranscriptionRequest): Promise<TranscriptResult>
}
