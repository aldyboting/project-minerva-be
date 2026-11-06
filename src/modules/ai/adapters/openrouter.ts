import { AiError } from '../errors'
import type {
  KokoroPort,
  ProviderMetadata,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  TranscriptChunk,
  TranscriptResult,
  TranscriptionRequest,
  WhisperPort,
} from '../types'
import { expectRecord, expectString, isRecord } from '../validation'
import { OpenAiCompatibleChatAdapter, type ChatAdapterOptions, type ChatProviderProfile } from './openai-compatible-chat'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
// Same models that Minerva used through Elice, served by OpenRouter.
export const OPENROUTER_DEFAULT_CHAT_MODEL = 'openai/gpt-5.6-terra'
export const OPENROUTER_DEFAULT_TRANSCRIPTION_MODEL = 'openai/whisper-large-v3'
export const OPENROUTER_DEFAULT_SPEECH_MODEL = 'hexgrad/kokoro-82m'
export const OPENROUTER_DEFAULT_VOICE = 'af_heart'

const LABEL = 'OpenRouter'

// OpenRouter uses these optional headers to attribute traffic to an app.
const attributionHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'X-Title': 'Minerva' }
  const referer = process.env.FRONTEND_ORIGIN?.trim()
  if (referer) headers['HTTP-Referer'] = referer
  return headers
}

const baseUrl = (value?: string) => (value?.trim() || OPENROUTER_BASE_URL).replace(/\/+$/, '')

const requireApiKey = (apiKey: string, feature: string) => {
  if (!apiKey.trim()) {
    throw new AiError({
      message: `OPENROUTER_API_KEY is required to use ${feature}.`,
      code: 'AI_CONFIGURATION_ERROR',
      status: 503,
    })
  }
}

const providerMessage = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined
  const error = isRecord(body.error) ? body.error : body
  return typeof error.message === 'string' && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : undefined
}

const errorForStatus = (status: number, body: unknown, fallback: string): AiError => {
  if (status === 401 || status === 403) {
    return new AiError({
      message: 'OpenRouter authentication failed. Check OPENROUTER_API_KEY.',
      code: 'AI_AUTHENTICATION_ERROR',
      status: 503,
      providerStatus: status,
    })
  }
  if (status === 402) {
    return new AiError({
      message: 'OpenRouter has no credit left for this request. Top up the account balance.',
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
      message: providerMessage(body) || fallback,
      code: 'AI_BAD_REQUEST',
      status: 422,
      providerStatus: status,
    })
  }
  return new AiError({
    message: providerMessage(body) || fallback,
    code: 'AI_PROVIDER_ERROR',
    status: 502,
    retryable: true,
    providerStatus: status,
  })
}

const networkError = (aborted: boolean, what: string, cause: unknown) =>
  new AiError({
    message: aborted ? `The OpenRouter ${what} request timed out.` : `The OpenRouter ${what} endpoint could not be reached.`,
    code: aborted ? 'AI_TIMEOUT' : 'AI_PROVIDER_ERROR',
    status: aborted ? 504 : 502,
    retryable: true,
    cause,
  })

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const timeoutFromEnv = () =>
  Number(process.env.OPENROUTER_TIMEOUT_MS) || Number(process.env.ELICE_TIMEOUT_MS) || 120_000

/* ------------------------------------------------------------------ chat */

const OPENROUTER_CHAT_PROFILE: ChatProviderProfile = {
  provider: 'openrouter',
  label: LABEL,
  apiKeyEnv: 'OPENROUTER_API_KEY',
  defaultBaseUrl: OPENROUTER_BASE_URL,
  defaultModel: OPENROUTER_DEFAULT_CHAT_MODEL,
}

export class OpenRouterChatAdapter extends OpenAiCompatibleChatAdapter {
  constructor(options: ChatAdapterOptions) {
    super(options, { ...OPENROUTER_CHAT_PROFILE, headers: attributionHeaders() })
  }
}

export const createOpenRouterChatFromEnv = () =>
  new OpenRouterChatAdapter({
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: baseUrl(process.env.OPENROUTER_BASE_URL),
    model: process.env.OPENROUTER_CHAT_MODEL || OPENROUTER_DEFAULT_CHAT_MODEL,
    timeoutMs: timeoutFromEnv(),
  })

/* --------------------------------------------------------- speech to text */

export interface OpenRouterAudioOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof globalThis.fetch
}

// The app passes Whisper-style language names. OpenRouter expects ISO-639-1 codes.
const ISO_LANGUAGE: Record<NonNullable<TranscriptionRequest['language']>, string> = {
  english: 'en',
  korean: 'ko',
}

const finiteSeconds = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const toChunks = (items: unknown, textKey: 'text' | 'word'): TranscriptChunk[] => {
  if (!Array.isArray(items)) return []
  const chunks: TranscriptChunk[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const start = finiteSeconds(item.start)
    const end = finiteSeconds(item.end)
    const text = typeof item[textKey] === 'string' ? (item[textKey] as string).trim() : ''
    if (start === undefined || end === undefined || end < start || !text) continue
    chunks.push({ timestamp: [start, end], text: text.slice(0, 20_000) })
  }
  return chunks
}

export class OpenRouterTranscriptionAdapter implements WhisperPort {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: OpenRouterAudioOptions) {
    requireApiKey(options.apiKey, 'speech transcription')
    this.apiKey = options.apiKey
    this.endpoint = `${baseUrl(options.baseUrl)}/audio/transcriptions`
    this.model = options.model || OPENROUTER_DEFAULT_TRANSCRIPTION_MODEL
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptResult> {
    let lastError: AiError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const startedAt = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      // A FormData body cannot be reused after a failed attempt, so build it each time.
      const form = new FormData()
      form.append('file', request.audio, request.filename)
      form.append('model', this.model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'segment')
      if (request.returnTimestamps === 'word') form.append('timestamp_granularities[]', 'word')
      if (request.language) form.append('language', ISO_LANGUAGE[request.language])

      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...attributionHeaders(),
          },
          body: form,
          signal: controller.signal,
        })
        const body = await response.json().catch(() => undefined) as unknown
        if (!response.ok) {
          const error = errorForStatus(response.status, body, 'OpenRouter could not transcribe the audio.')
          if (error.retryable && attempt < this.maxRetries) {
            lastError = error
            await delay(300 * 2 ** attempt)
            continue
          }
          throw error
        }

        const root = expectRecord(body, 'transcription')
        const text = expectString(root.text, 'transcription.text', { max: 250_000 })
        const words = request.returnTimestamps === 'word' ? toChunks(root.words, 'word') : []
        const metadata: ProviderMetadata = {
          provider: 'openrouter',
          model: this.model,
          requestId: response.headers.get('x-request-id') || undefined,
          usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 },
          latencyMs: Date.now() - startedAt,
        }
        return {
          text,
          chunks: words.length ? words : toChunks(root.segments, 'text'),
          language: typeof root.language === 'string' ? root.language : undefined,
          metadata,
        }
      } catch (error) {
        if (error instanceof AiError) throw error
        lastError = networkError(controller.signal.aborted, 'transcription', error)
        if (attempt < this.maxRetries) {
          await delay(300 * 2 ** attempt)
          continue
        }
      } finally {
        clearTimeout(timeout)
      }
    }
    throw lastError ?? networkError(false, 'transcription', undefined)
  }
}

export const createOpenRouterTranscriptionFromEnv = () =>
  new OpenRouterTranscriptionAdapter({
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: process.env.OPENROUTER_BASE_URL,
    model: process.env.OPENROUTER_TRANSCRIPTION_MODEL || OPENROUTER_DEFAULT_TRANSCRIPTION_MODEL,
    timeoutMs: timeoutFromEnv(),
  })

/* --------------------------------------------------------- text to speech */

export class OpenRouterSpeechAdapter implements KokoroPort {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: OpenRouterAudioOptions) {
    requireApiKey(options.apiKey, 'the interviewer voice')
    this.apiKey = options.apiKey
    this.endpoint = `${baseUrl(options.baseUrl)}/audio/speech`
    this.model = options.model || OPENROUTER_DEFAULT_SPEECH_MODEL
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const text = request.text.trim().slice(0, 4_000)
    if (!text) throw new AiError({ message: 'Speech text is required.', code: 'AI_BAD_REQUEST', status: 422 })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const startedAt = Date.now()
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'audio/*',
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...attributionHeaders(),
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice: request.voice || OPENROUTER_DEFAULT_VOICE,
          response_format: 'mp3',
          speed: request.speed ?? 1,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as unknown
        throw errorForStatus(response.status, body, 'OpenRouter could not create the interviewer voice.')
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!bytes.byteLength) {
        throw new AiError({ message: 'OpenRouter returned an empty audio response.', code: 'AI_INVALID_RESPONSE', status: 502, retryable: true })
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0] || 'audio/mpeg'
      const metadata: ProviderMetadata = {
        provider: 'openrouter',
        model: this.model,
        requestId: response.headers.get('x-request-id') || undefined,
        usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 },
        latencyMs: Date.now() - startedAt,
      }
      return { dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`, contentType, metadata }
    } catch (error) {
      if (error instanceof AiError) throw error
      throw networkError(controller.signal.aborted, 'voice', error)
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const createOpenRouterSpeechFromEnv = () =>
  new OpenRouterSpeechAdapter({
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: process.env.OPENROUTER_BASE_URL,
    model: process.env.OPENROUTER_SPEECH_MODEL || OPENROUTER_DEFAULT_SPEECH_MODEL,
    timeoutMs: timeoutFromEnv(),
  })
