import { afterEach, describe, expect, it } from 'bun:test'
import {
  OpenRouterChatAdapter,
  OpenRouterSpeechAdapter,
  OpenRouterTranscriptionAdapter,
} from './adapters/openrouter'
import { AiError } from './errors'
import { activeAiProvider, activeChatModel, defaultSpeechVoice } from './provider'

type Captured = { url: string; init?: RequestInit }

const capture = (respond: () => Response) => {
  const calls: Captured[] = []
  const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return respond()
  }) as unknown as typeof fetch
  return { calls, fetchMock }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('OpenRouter chat adapter', () => {
  it('sends the Terra payload to OpenRouter and tags metadata with the provider', async () => {
    const { calls, fetchMock } = capture(() =>
      json({
        id: 'gen-1',
        model: 'openai/gpt-5.6-terra',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
      }),
    )
    const adapter = new OpenRouterChatAdapter({ apiKey: 'or-key', fetch: fetchMock, maxRetries: 0 })

    const result = await adapter.complete({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoningEffort: 'medium',
      responseSchema: { name: 'demo', schema: { type: 'object' } },
    })

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer or-key')
    expect(headers.get('x-title')).toBe('Minerva')
    const payload = JSON.parse(String(calls[0]?.init?.body))
    expect(payload.model).toBe('openai/gpt-5.6-terra')
    expect(payload.reasoning_effort).toBe('medium')
    expect(payload.response_format.json_schema.name).toBe('demo')
    expect(result.metadata.provider).toBe('openrouter')
    expect(result.metadata.usage).toEqual({ promptTokens: 10, completionTokens: 4, cachedPromptTokens: 3 })
  })

  it('reports an empty credit balance as a clear configuration problem', async () => {
    const { fetchMock } = capture(() => json({ error: { code: 402, message: 'Insufficient credits' } }, 402))
    const adapter = new OpenRouterChatAdapter({ apiKey: 'or-key', fetch: fetchMock, maxRetries: 0 })

    const error = await adapter.complete({ messages: [{ role: 'user', content: 'Hi' }] }).catch((e) => e)

    expect(error).toBeInstanceOf(AiError)
    expect(error.status).toBe(503)
    expect(error.message).toContain('OpenRouter has no credit left')
  })

  it('refuses to start without an API key', () => {
    expect(() => new OpenRouterChatAdapter({ apiKey: '  ' })).toThrow('OPENROUTER_API_KEY is required')
  })
})

describe('OpenRouter transcription adapter', () => {
  it('requests verbose JSON and maps word timestamps to transcript chunks', async () => {
    const { calls, fetchMock } = capture(() =>
      json({
        text: 'Hello there',
        language: 'en',
        segments: [{ id: 0, start: 0, end: 1.4, text: 'Hello there' }],
        words: [
          { word: 'Hello', start: 0, end: 0.5 },
          { word: 'there', start: 0.6, end: 1.4 },
        ],
      }),
    )
    const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-key', fetch: fetchMock, maxRetries: 0 })

    const result = await adapter.transcribe({
      audio: new Blob(['audio'], { type: 'audio/webm' }),
      filename: 'answer.webm',
      language: 'english',
      returnTimestamps: 'word',
    })

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    const form = calls[0]?.init?.body as FormData
    expect(form.get('model')).toBe('openai/whisper-large-v3')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('language')).toBe('en')
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment', 'word'])
    expect(result.text).toBe('Hello there')
    expect(result.chunks).toEqual([
      { timestamp: [0, 0.5], text: 'Hello' },
      { timestamp: [0.6, 1.4], text: 'there' },
    ])
    expect(result.metadata.provider).toBe('openrouter')
  })

  it('falls back to segment timestamps when the model returns no words', async () => {
    const { fetchMock } = capture(() =>
      json({ text: 'Hi', segments: [{ id: 0, start: 0.2, end: 0.9, text: ' Hi ' }] }),
    )
    const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-key', fetch: fetchMock, maxRetries: 0 })

    const result = await adapter.transcribe({
      audio: new Blob(['audio']),
      filename: 'a.webm',
      returnTimestamps: 'word',
    })

    expect(result.chunks).toEqual([{ timestamp: [0.2, 0.9], text: 'Hi' }])
  })

  it('accepts a plain JSON response with text only', async () => {
    const { fetchMock } = capture(() => json({ text: 'Only text' }))
    const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-key', fetch: fetchMock, maxRetries: 0 })

    const result = await adapter.transcribe({ audio: new Blob(['audio']), filename: 'a.webm' })

    expect(result.text).toBe('Only text')
    expect(result.chunks).toEqual([])
  })
})

describe('OpenRouter speech adapter', () => {
  it('requests MP3 from Kokoro and returns a data URL', async () => {
    const { calls, fetchMock } = capture(
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    )
    const adapter = new OpenRouterSpeechAdapter({ apiKey: 'or-key', fetch: fetchMock })

    const result = await adapter.synthesize({ text: 'Tell me about yourself.', language: 'a' })

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/audio/speech')
    const payload = JSON.parse(String(calls[0]?.init?.body))
    expect(payload).toEqual({
      model: 'hexgrad/kokoro-82m',
      input: 'Tell me about yourself.',
      voice: 'af_heart',
      response_format: 'mp3',
      speed: 1,
    })
    expect(result.contentType).toBe('audio/mpeg')
    expect(result.dataUrl).toBe('data:audio/mpeg;base64,AQID')
  })

  it('rejects empty speech text before calling the provider', async () => {
    const { calls, fetchMock } = capture(() => json({}))
    const adapter = new OpenRouterSpeechAdapter({ apiKey: 'or-key', fetch: fetchMock })

    await expect(adapter.synthesize({ text: '   ', language: 'a' })).rejects.toThrow('Speech text is required.')
    expect(calls).toHaveLength(0)
  })
})

describe('AI provider selection', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const key of ['AI_PROVIDER', 'OPENROUTER_API_KEY', 'OPENROUTER_CHAT_MODEL', 'TTS_PROVIDER', 'NODE_ENV']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('keeps tests on the mocked Elice adapters even when .env holds an OpenRouter key', () => {
    delete process.env.AI_PROVIDER
    process.env.NODE_ENV = 'test'
    process.env.OPENROUTER_API_KEY = 'or-key'
    expect(activeAiProvider()).toBe('elice')
  })

  it('uses OpenRouter outside tests when only the OpenRouter key is set', () => {
    delete process.env.AI_PROVIDER
    process.env.NODE_ENV = 'development'
    process.env.OPENROUTER_API_KEY = 'or-key'
    expect(activeAiProvider()).toBe('openrouter')
    expect(activeChatModel()).toBe('openai/gpt-5.6-terra')
    expect(defaultSpeechVoice()).toBe('af_heart')
  })

  it('lets AI_PROVIDER force Elice even when an OpenRouter key exists', () => {
    process.env.AI_PROVIDER = 'elice'
    process.env.OPENROUTER_API_KEY = 'or-key'
    expect(activeAiProvider()).toBe('elice')
    expect(activeChatModel()).toBe(process.env.ELICE_TERRA_MODEL || 'gpt-5.6-terra')
  })

  it('reads a custom OpenRouter chat model from the environment', () => {
    process.env.AI_PROVIDER = 'openrouter'
    process.env.OPENROUTER_CHAT_MODEL = 'openai/gpt-5.6-luna'
    expect(activeChatModel()).toBe('openai/gpt-5.6-luna')
  })
})
