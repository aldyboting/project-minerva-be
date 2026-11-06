import {
  OpenAiCompatibleChatAdapter,
  type ChatAdapterOptions,
  type ChatProviderProfile,
} from './openai-compatible-chat'

const DEFAULT_TERRA_BASE_URL = 'https://mlapi.run/e1ede337-92cd-45f8-b0a1-f7d58d337268'
const DEFAULT_MODEL = 'gpt-5.6-terra'

export type EliceTerraOptions = ChatAdapterOptions

const ELICE_TERRA_PROFILE: ChatProviderProfile = {
  provider: 'elice',
  label: 'Elice',
  apiKeyEnv: 'ELICE_API_KEY',
  defaultBaseUrl: DEFAULT_TERRA_BASE_URL,
  defaultModel: DEFAULT_MODEL,
}

export class EliceTerraAdapter extends OpenAiCompatibleChatAdapter {
  constructor(options: EliceTerraOptions) {
    super(options, ELICE_TERRA_PROFILE)
  }
}

export const createEliceTerraFromEnv = (): EliceTerraAdapter =>
  new EliceTerraAdapter({
    apiKey: process.env.ELICE_TERRA_API_KEY || process.env.ELICE_API_KEY || '',
    baseUrl: process.env.ELICE_TERRA_BASE_URL || DEFAULT_TERRA_BASE_URL,
    model: process.env.ELICE_TERRA_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(process.env.ELICE_TIMEOUT_MS) || 120_000,
  })
