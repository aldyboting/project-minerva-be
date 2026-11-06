import { InferSchemaType, Model, Schema, model, models } from 'mongoose'

const providerMetadataSchema = new Schema(
  {
    provider: { type: String, enum: ['elice', 'google', 'openrouter'], required: true },
    model: { type: String, required: true },
    requestId: { type: String },
    promptTokens: { type: Number, default: 0, min: 0 },
    completionTokens: { type: Number, default: 0, min: 0 },
    cachedPromptTokens: { type: Number, default: 0, min: 0 },
    latencyMs: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
)

const aiChatThreadSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    summary: { type: String, default: '', maxlength: 12_000 },
    applicationId: { type: String, trim: true },
    lastMessageAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
)
aiChatThreadSchema.index({ userId: 1, lastMessageAt: -1 })

const aiChatMessageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    threadId: { type: Schema.Types.ObjectId, ref: 'AiChatThread', required: true, index: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, required: true, maxlength: 50_000 },
    metadata: { type: providerMetadataSchema },
  },
  { timestamps: true },
)
aiChatMessageSchema.index({ threadId: 1, createdAt: 1 })

const reviewSuggestionSchema = new Schema({
  category: { type: String, required: true, maxlength: 80 },
  title: { type: String, required: true, maxlength: 160 },
  detail: { type: String, required: true, maxlength: 2_000 },
  originalText: { type: String, required: true, maxlength: 4_000 },
  replacement: { type: String, required: true, maxlength: 4_000 },
  priority: { type: String, enum: ['high', 'medium', 'low'], required: true },
  tone: { type: String, enum: ['purple', 'yellow', 'blue', 'green'], required: true },
  status: { type: String, enum: ['pending', 'accepted', 'dismissed'], default: 'pending' },
  resolvedAt: { type: Date },
})

const documentAiReviewSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
    scholarshipId: { type: String, trim: true },
    reviewedContentHash: { type: String, required: true },
    overall: { type: Number, required: true, min: 0, max: 100 },
    clarity: { type: Number, required: true, min: 0, max: 100 },
    grammar: { type: Number, required: true, min: 0, max: 100 },
    structure: { type: Number, required: true, min: 0, max: 100 },
    impact: { type: Number, required: true, min: 0, max: 100 },
    scholarshipAlignment: { type: Number, required: true, min: 0, max: 100 },
    summary: { type: String, required: true, maxlength: 2_000 },
    strengths: [{ type: String, required: true, maxlength: 2_000 }],
    suggestions: [reviewSuggestionSchema],
    metadata: { type: providerMetadataSchema, required: true },
  },
  { timestamps: true },
)
documentAiReviewSchema.index({ userId: 1, documentId: 1, createdAt: -1 })

const transcriptChunkSchema = new Schema(
  {
    timestamp: {
      type: [Number],
      required: true,
      validate: {
        validator: (value: number[]) => value.length === 2,
        message: 'A transcript timestamp must contain a start and end value',
      },
    },
    text: { type: String, required: true, maxlength: 20_000 },
  },
  { _id: false },
)

const interviewEvaluationSchema = new Schema(
  {
    relevance: { type: Number, required: true, min: 0, max: 100 },
    clarity: { type: Number, required: true, min: 0, max: 100 },
    structure: { type: Number, required: true, min: 0, max: 100 },
    specificity: { type: Number, required: true, min: 0, max: 100 },
    scholarshipAlignment: { type: Number, required: true, min: 0, max: 100 },
    highlights: [{ type: String, required: true, maxlength: 2_000 }],
    improvements: [{ type: String, required: true, maxlength: 2_000 }],
    strongerAnswerExample: { type: String, required: true, maxlength: 5_000 },
  },
  { _id: false },
)

const interviewQuestionSchema = new Schema({
  text: { type: String, required: true, maxlength: 800 },
  focus: { type: String, required: true, maxlength: 300 },
  position: { type: Number, required: true, min: 0 },
})

const interviewAnswerSchema = new Schema({
  questionId: { type: Schema.Types.ObjectId, required: true },
  durationSeconds: { type: Number, required: true, min: 0, max: 1_800 },
  transcript: {
    text: { type: String, required: true, maxlength: 250_000 },
    chunks: [transcriptChunkSchema],
    language: { type: String },
  },
  evaluation: { type: interviewEvaluationSchema, required: true },
  interviewerReply: { type: String, maxlength: 2_000 },
  transcriptionMetadata: { type: providerMetadataSchema, required: true },
  evaluationMetadata: { type: providerMetadataSchema, required: true },
  createdAt: { type: Date, default: Date.now },
})

const aggregateSchema = new Schema(
  {
    overall: { type: Number, required: true, min: 0, max: 100 },
    relevance: { type: Number, required: true, min: 0, max: 100 },
    clarity: { type: Number, required: true, min: 0, max: 100 },
    structure: { type: Number, required: true, min: 0, max: 100 },
    specificity: { type: Number, required: true, min: 0, max: 100 },
    scholarshipAlignment: { type: Number, required: true, min: 0, max: 100 },
    highlights: [{ type: String, maxlength: 2_000 }],
    improvements: [{ type: String, maxlength: 2_000 }],
    answeredQuestions: { type: Number, required: true, min: 1 },
  },
  { _id: false },
)

const interviewSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scholarshipId: { type: String, required: true, trim: true },
    scholarshipName: { type: String, required: true, maxlength: 300 },
    provider: { type: String, required: true, maxlength: 300 },
    country: { type: String, required: true, maxlength: 120 },
    language: { type: String, enum: ['en', 'id'], required: true },
    context: { type: String, maxlength: 12_000 },
    status: { type: String, enum: ['active', 'completed'], default: 'active' },
    questions: [interviewQuestionSchema],
    answers: [interviewAnswerSchema],
    aggregate: { type: aggregateSchema },
    completedAt: { type: Date },
  },
  { timestamps: true },
)
interviewSessionSchema.index({ userId: 1, createdAt: -1 })

const ieltsAiEvaluationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['writing', 'speaking'], required: true },
    task: { type: String, maxlength: 100 },
    prompt: { type: String, required: true, maxlength: 8_000 },
    response: { type: String, maxlength: 40_000 },
    transcript: { type: String, maxlength: 250_000 },
    durationSeconds: { type: Number, min: 0, max: 1_800 },
    result: { type: Schema.Types.Mixed, required: true },
    metadata: { type: providerMetadataSchema, required: true },
    transcriptionMetadata: { type: providerMetadataSchema },
  },
  { timestamps: true },
)
ieltsAiEvaluationSchema.index({ userId: 1, kind: 1, createdAt: -1 })

const aiRecommendationDailySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dayKey: { type: String, required: true, maxlength: 10 },
    count: { type: Number, required: true, default: 0, min: 0, max: 3 },
  },
  { timestamps: true },
)
aiRecommendationDailySchema.index({ userId: 1, dayKey: 1 }, { unique: true })
const aiUsageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    operation: {
      type: String,
      enum: [
        'chat',
        'document_review',
        'document_refine',
        'document_consult',
        'interview_questions',
        'interview_answer',
        'ielts_writing',
        'ielts_speaking',
        'transcription',
      ],
      required: true,
    },
    provider: { type: String, enum: ['elice', 'google', 'openrouter'], default: 'elice' },
    model: { type: String, required: true },
    requestId: { type: String },
    promptTokens: { type: Number, default: 0, min: 0 },
    completionTokens: { type: Number, default: 0, min: 0 },
    cachedPromptTokens: { type: Number, default: 0, min: 0 },
    audioSeconds: { type: Number, min: 0 },
    latencyMs: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['completed', 'failed'], required: true },
    errorCode: { type: String },
  },
  { timestamps: true },
)
aiUsageSchema.index({ userId: 1, createdAt: -1 })

type AiChatThreadShape = InferSchemaType<typeof aiChatThreadSchema>
type AiChatMessageShape = InferSchemaType<typeof aiChatMessageSchema>
type DocumentAiReviewShape = InferSchemaType<typeof documentAiReviewSchema>
type InterviewSessionShape = InferSchemaType<typeof interviewSessionSchema>
type IeltsAiEvaluationShape = InferSchemaType<typeof ieltsAiEvaluationSchema>
type AiRecommendationDailyShape = InferSchemaType<typeof aiRecommendationDailySchema>
type AiUsageShape = InferSchemaType<typeof aiUsageSchema>

export const AiChatThread =
  (models.AiChatThread as Model<AiChatThreadShape> | undefined) ||
  model<AiChatThreadShape>('AiChatThread', aiChatThreadSchema)

export const AiChatMessage =
  (models.AiChatMessage as Model<AiChatMessageShape> | undefined) ||
  model<AiChatMessageShape>('AiChatMessage', aiChatMessageSchema)

export const DocumentAiReview =
  (models.DocumentAiReview as Model<DocumentAiReviewShape> | undefined) ||
  model<DocumentAiReviewShape>('DocumentAiReview', documentAiReviewSchema)

export const InterviewSession =
  (models.InterviewSession as Model<InterviewSessionShape> | undefined) ||
  model<InterviewSessionShape>('InterviewSession', interviewSessionSchema)

export const IeltsAiEvaluation =
  (models.IeltsAiEvaluation as Model<IeltsAiEvaluationShape> | undefined) ||
  model<IeltsAiEvaluationShape>('IeltsAiEvaluation', ieltsAiEvaluationSchema)

export const AiRecommendationDaily =
  (models.AiRecommendationDaily as Model<AiRecommendationDailyShape> | undefined) ||
  model<AiRecommendationDailyShape>('AiRecommendationDaily', aiRecommendationDailySchema)
export const AiUsage =
  (models.AiUsage as Model<AiUsageShape> | undefined) ||
  model<AiUsageShape>('AiUsage', aiUsageSchema)

export const toStoredMetadata = (metadata: {
  provider: 'elice' | 'google' | 'openrouter'
  model: string
  requestId?: string
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens: number }
  latencyMs: number
}) => ({
  provider: metadata.provider,
  model: metadata.model,
  requestId: metadata.requestId,
  promptTokens: metadata.usage.promptTokens,
  completionTokens: metadata.usage.completionTokens,
  cachedPromptTokens: metadata.usage.cachedPromptTokens,
  latencyMs: metadata.latencyMs,
})
