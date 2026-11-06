import { AiError } from '../errors'
import type {
  ProviderMetadata,
  ProviderUsage,
  TerraCompletion,
  TerraCompletionRequest,
  TerraPort,
} from '../types'
import { expectRecord, expectString, isRecord } from '../validation'

export interface ChatAdapterOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof globalThis.fetch
}

/**
 * One OpenAI-compatible chat provider. Elice Terra and OpenRouter use the same
 * request and response shape, so one adapter serves both.
 */
export interface ChatProviderProfile {
  provider: ProviderMetadata['provider']
  label: string
  apiKeyEnv: string
  defaultBaseUrl: string
  defaultModel: string
  headers?: Record<string, string>
}

const chatCompletionsUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/v1/chat/completions')) return normalized
  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`
  return `${normalized}/v1/chat/completions`
}

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const parseUsage = (value: unknown): ProviderUsage => {
  if (!isRecord(value)) {
    return { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 }
  }

  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined
  return {
    promptTokens: numberOrZero(value.prompt_tokens),
    completionTokens: numberOrZero(value.completion_tokens),
    cachedPromptTokens: numberOrZero(value.cached_prompt_tokens ?? promptDetails?.cached_tokens),
  }
}

const providerMessage = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined
  const error = isRecord(value.error) ? value.error : value
  if (typeof error.message !== 'string') return undefined
  const message = error.message.trim()
  return message ? message.slice(0, 500) : undefined
}

const errorForStatus = (label: string, status: number, body: unknown): AiError => {
  const upstreamMessage = providerMessage(body)
  if (status === 401 || status === 403) {
    return new AiError({
      message: `${label} authentication failed. Check the server-side AI configuration.`,
      code: 'AI_AUTHENTICATION_ERROR',
      status: 503,
      providerStatus: status,
    })
  }
  if (status === 402) {
    return new AiError({
      message: `${label} has no credit left for this request. Top up the account balance.`,
      code: 'AI_PROVIDER_ERROR',
      status: 503,
      providerStatus: status,
    })
  }
  if (status === 429) {
    return new AiError({
      message: 'The AI provider is busy. Please retry shortly.',
      code: 'AI_RATE_LIMITED',
      status: 503,
      retryable: true,
      providerStatus: status,
    })
  }
  if (status >= 400 && status < 500) {
    return new AiError({
      message: upstreamMessage || `${label} rejected the AI request.`,
      code: 'AI_BAD_REQUEST',
      status: 422,
      providerStatus: status,
    })
  }
  return new AiError({
    message: upstreamMessage || `${label} could not complete the AI request.`,
    code: 'AI_PROVIDER_ERROR',
    status: 502,
    retryable: true,
    providerStatus: status,
  })
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export class OpenAiCompatibleChatAdapter implements TerraPort {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly profile: ChatProviderProfile

  constructor(options: ChatAdapterOptions, profile: ChatProviderProfile) {
    if (!options.apiKey.trim()) {
      throw new AiError({
        message: `${profile.apiKeyEnv} is required to use AI features.`,
        code: 'AI_CONFIGURATION_ERROR',
        status: 503,
      })
    }

    this.profile = profile
    this.apiKey = options.apiKey
    this.endpoint = chatCompletionsUrl(options.baseUrl || profile.defaultBaseUrl)
    this.model = options.model || profile.defaultModel
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async complete(request: TerraCompletionRequest): Promise<TerraCompletion> {
    const label = this.profile.label
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      reasoning_effort: request.reasoningEffort ?? 'low',
    }
    if (request.maxCompletionTokens) payload.max_completion_tokens = request.maxCompletionTokens
    if (request.responseSchema) {
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseSchema.name,
          strict: true,
          schema: request.responseSchema.schema,
        },
      }
    }

    let lastError: AiError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const startedAt = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...this.profile.headers,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })

        const body = await response.json().catch(() => undefined) as unknown
        if (!response.ok) {
          const error = errorForStatus(label, response.status, body)
          if (error.retryable && attempt < this.maxRetries) {
            lastError = error
            await delay(300 * 2 ** attempt)
            continue
          }
          throw error
        }

        const root = expectRecord(body, 'chat completion')
        if (!Array.isArray(root.choices) || root.choices.length === 0) {
          throw new AiError({
            message: `${label} returned an invalid response: choices were missing.`,
            code: 'AI_INVALID_RESPONSE',
            status: 502,
            retryable: true,
          })
        }
        const choice = expectRecord(root.choices[0], 'choices[0]')
        const message = expectRecord(choice.message, 'choices[0].message')
        const content = expectString(message.content, 'choices[0].message.content', {
          max: 200_000,
        })
        const requestId =
          response.headers.get('x-request-id') ||
          (typeof root.id === 'string' ? root.id : undefined)

        const metadata: ProviderMetadata = {
          provider: this.profile.provider,
          model: typeof root.model === 'string' ? root.model : this.model,
          requestId,
          usage: parseUsage(root.usage),
          latencyMs: Date.now() - startedAt,
        }
        return { content, metadata }
      } catch (error) {
        if (error instanceof AiError) throw error
        if (controller.signal.aborted) {
          lastError = new AiError({
            message: `The ${label} text request timed out.`,
            code: 'AI_TIMEOUT',
            status: 504,
            retryable: true,
            cause: error,
          })
        } else {
          lastError = new AiError({
            message: `The ${label} text endpoint could not be reached.`,
            code: 'AI_PROVIDER_ERROR',
            status: 502,
            retryable: true,
            cause: error,
          })
        }

        if (attempt < this.maxRetries) {
          await delay(300 * 2 ** attempt)
          continue
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    throw lastError ?? new AiError({
      message: `The ${label} text request could not be completed.`,
      code: 'AI_PROVIDER_ERROR',
      status: 502,
      retryable: true,
    })
  }
}

