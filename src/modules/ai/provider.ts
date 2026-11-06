import {
  OPENROUTER_DEFAULT_CHAT_MODEL,
  OPENROUTER_DEFAULT_TRANSCRIPTION_MODEL,
  OPENROUTER_DEFAULT_VOICE,
} from './adapters/openrouter'

export type AiProviderName = 'elice' | 'openrouter'

/**
 * AI_PROVIDER picks the provider explicitly. Without it, OpenRouter is used
 * when OPENROUTER_API_KEY is set, and Elice otherwise.
 *
 * Under NODE_ENV=test the fallback is always Elice. Bun loads .env during
 * `bun test`, and the existing suites mock only the Elice adapters, so a real
 * OPENROUTER_API_KEY in .env would otherwise send test traffic to OpenRouter.
 */
export const activeAiProvider = (): AiProviderName => {
  const configured = process.env.AI_PROVIDER?.trim().toLowerCase()
  if (configured === 'elice' || configured === 'openrouter') return configured
  if (process.env.NODE_ENV === 'test') return 'elice'
  return process.env.OPENROUTER_API_KEY?.trim() ? 'openrouter' : 'elice'
}

export const activeChatModel = (): string =>
  activeAiProvider() === 'openrouter'
    ? process.env.OPENROUTER_CHAT_MODEL || OPENROUTER_DEFAULT_CHAT_MODEL
    : process.env.ELICE_TERRA_MODEL || 'gpt-5.6-terra'

export const activeTranscriptionModel = (): string =>
  activeAiProvider() === 'openrouter'
    ? process.env.OPENROUTER_TRANSCRIPTION_MODEL || OPENROUTER_DEFAULT_TRANSCRIPTION_MODEL
    : process.env.ELICE_WHISPER_MODEL || 'whisper-large-v3'

export const useGoogleSpeech = (): boolean =>
  process.env.TTS_PROVIDER?.trim().toLowerCase() === 'google'

export const defaultSpeechVoice = (): string => {
  if (useGoogleSpeech()) return process.env.GOOGLE_TTS_VOICE?.trim() || 'en-US-Wavenet-F'
  if (activeAiProvider() === 'openrouter') return process.env.OPENROUTER_TTS_VOICE?.trim() || OPENROUTER_DEFAULT_VOICE
  return 'af_heart'
}
