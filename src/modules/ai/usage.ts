import type { AiOperation, ProviderMetadata } from './types'
import { AiUsage, toStoredMetadata } from './models'
import { AiError } from './errors'
import { activeAiProvider } from './provider'

export const recordCompletedUsage = async (input: {
  userId: string
  operation: AiOperation
  metadata: ProviderMetadata
  audioSeconds?: number
}): Promise<void> => {
  try {
    await AiUsage.create({
      userId: input.userId,
      operation: input.operation,
      ...toStoredMetadata(input.metadata),
      audioSeconds: input.audioSeconds,
      status: 'completed',
    })
    
    // this part is modified to ensure [Account-Level Budgeting by tracking token consumption in MongoDB]
    const tokens = (input.metadata.usage?.promptTokens || 0) + (input.metadata.usage?.completionTokens || 0)
    if (tokens > 0) {
      const { User } = await import('../../models/User')
      await User.updateOne({ _id: input.userId }, { $inc: { dailyTokenUsage: tokens } })
    }
  } catch {
    // Usage telemetry is best-effort and must not turn a successful AI result into a user-facing failure.
  }
}

export const recordFailedUsage = async (input: {
  userId: string
  operation: AiOperation
  model: string
  error: unknown
  audioSeconds?: number
}): Promise<void> => {
  if (!(input.error instanceof AiError)) return
  const error = input.error
  try {
    await AiUsage.create({
      userId: input.userId,
      operation: input.operation,
      provider: activeAiProvider(),
      model: input.model,
      audioSeconds: input.audioSeconds,
      status: 'failed',
      errorCode: error.code,
    })
  } catch {
    // See recordCompletedUsage: telemetry must remain non-blocking.
  }
}
