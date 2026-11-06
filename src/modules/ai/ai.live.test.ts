import { expect, it } from 'bun:test'
import { createEliceTerraFromEnv } from './adapters/elice-terra'
import { createEliceWhisperFromEnv } from './adapters/elice-whisper'

const live = process.env.RUN_ELICE_SMOKE_TESTS === 'true' ? it : it.skip

live(
  'completes a minimal live Terra request',
  async () => {
    const result = await createEliceTerraFromEnv().complete({
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      reasoningEffort: 'none',
      maxCompletionTokens: 16,
    })
    expect(result.content.trim()).toBe('OK')
    expect(result.metadata.model).toContain('terra')
  },
  180_000,
)

const audioPath = process.env.ELICE_SMOKE_AUDIO_PATH?.trim()
const liveWithAudio = process.env.RUN_ELICE_SMOKE_TESTS === 'true' && audioPath ? it : it.skip

liveWithAudio(
  'transcribes a configured live audio fixture with Whisper',
  async () => {
    const audio = Bun.file(audioPath as string)
    expect(await audio.exists()).toBe(true)
    const result = await createEliceWhisperFromEnv().transcribe({
      audio,
      filename: audio.name || 'smoke-audio.webm',
      returnTimestamps: 'word',
    })
    expect(result.text.length).toBeGreaterThan(0)
  },
  180_000,
)

const liveOpenRouter = process.env.RUN_OPENROUTER_SMOKE_TESTS === 'true' ? it : it.skip

liveOpenRouter(
  'completes a minimal live chat request through OpenRouter',
  async () => {
    const { createOpenRouterChatFromEnv } = await import('./adapters/openrouter')
    const result = await createOpenRouterChatFromEnv().complete({
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      reasoningEffort: 'none',
      maxCompletionTokens: 16,
    })
    expect(result.content.trim()).toBe('OK')
    expect(result.metadata.provider).toBe('openrouter')
  },
  180_000,
)

liveOpenRouter(
  'creates a short live voice clip through OpenRouter',
  async () => {
    const { createOpenRouterSpeechFromEnv } = await import('./adapters/openrouter')
    const result = await createOpenRouterSpeechFromEnv().synthesize({ text: 'Hello from Minerva.', language: 'a' })
    expect(result.dataUrl.startsWith('data:audio/')).toBe(true)
  },
  180_000,
)
