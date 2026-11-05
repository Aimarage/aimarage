import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function str(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

export const isProduction = process.env.NODE_ENV === 'production'

export const config = {
  get databaseUrl() {
    return str('DATABASE_URL', '')
  },
  get usePglite() {
    return !this.databaseUrl.startsWith('postgres')
  },
  get dataDir() {
    return resolve(str('DATA_DIR', './data/pglite'))
  },
  get mediaDir() {
    return resolve(str('MEDIA_DIR', './data/media'))
  },
  get storageDriver() {
    const v = str('STORAGE_DRIVER', 'local').toLowerCase()
    if (v !== 'local' && v !== 's3') throw new Error(`STORAGE_DRIVER muss local oder s3 sein, nicht "${v}"`)
    return v as 'local' | 's3'
  },
  get s3() {
    return {
      endpoint: str('S3_ENDPOINT', ''),
      region: str('S3_REGION', 'us-east-1'),
      bucket: str('S3_BUCKET', ''),
      accessKey: str('S3_ACCESS_KEY', ''),
      secretKey: str('S3_SECRET_KEY', ''),
      prefix: str('S3_PREFIX', ''),
    }
  },
  get migrationsDir() {
    return resolve(str('MIGRATIONS_DIR', './server/db/migrations'))
  },
  get workerInline() {
    return bool('WORKER_INLINE', this.usePglite)
  },
  get seedOnStart() {
    return str('SEED_ON_START', 'owner') as 'owner' | 'none'
  },
  get fixedNow() {
    return str('MA_NOW', '')
  },
  get llm() {
    return {
      baseUrl: str('LLM_BASE_URL', ''),
      apiKey: str('LLM_API_KEY', ''),
      model: str('LLM_MODEL', ''),
      modelFast: str('LLM_MODEL_FAST', ''),
      timeoutMs: Number(str('LLM_TIMEOUT_MS', '120000')),
    }
  },
  get llmWriterModel() {
    return str('LLM_MODEL_WRITER', '')
  },
  get llmEu() {
    const model = str('LLM_EU_MODEL', '')
    return {
      baseUrl: str('LLM_EU_BASE_URL', ''),
      apiKey: str('LLM_EU_API_KEY', ''),
      model,
      modelFast: str('LLM_EU_MODEL_FAST', model),
      timeoutMs: Number(str('LLM_TIMEOUT_MS', '120000')),
    }
  },
  get appUrl() {
    return str('APP_URL', 'http://localhost:3210').replace(/\/+$/, '')
  },
  get publicUrl() {
    return (str('PUBLIC_URL', '') || this.appUrl).replace(/\/+$/, '')
  },
  get trustProxy() {
    return bool('TRUST_PROXY', false)
  },
  get sessionDays() {
    return Number(str('SESSION_DAYS', '30'))
  },
  get secureCookies() {
    return bool('SECURE_COOKIES', isProduction)
  },
  get hosted() {
    return bool('HOSTED', false)
  },
  get workerConcurrency() {
    const n = Number(str('WORKER_CONCURRENCY', this.hosted ? '3' : '1'))
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  },
  get previewLlmEur() {
    const n = Number(str('PREVIEW_LLM_EUR', '0.10'))
    return Number.isFinite(n) && n >= 0 ? n : 0.1
  },
  // Social-Schlüssel aus der .env (ZERNIO_API_KEY, UPLOAD_POST_API_KEY) für Workspaces ohne eigenen Schlüssel.
  // Gehostet aus: Kunden posten nie über die Schlüssel des Betreibers, Ausnahme nur settings.socialEnvFallback am Workspace.
  get socialEnvFallback() {
    return bool('SOCIAL_ENV_FALLBACK', !this.hosted)
  },
  // Gehostete Dienste: Betreiber-Schlüssel für Workspaces ohne eigenen Schlüssel (nur mit HOSTED=true).
  get braveApiKey() {
    return this.hosted ? str('BRAVE_API_KEY', '') : ''
  },
  // Spracheingabe im Chat: Mistral Voxtral (EU). Ohne Schlüssel nur mit eigenem Mistral-Schlüssel des Workspaces.
  get transcribeApiKey() {
    return str('TRANSCRIBE_API_KEY', '')
  },
  get transcribeBaseUrl() {
    return str('TRANSCRIBE_BASE_URL', 'https://api.mistral.ai/v1')
  },
  get transcribeModel() {
    return str('TRANSCRIBE_MODEL', 'voxtral-mini-latest')
  },
  get zernioApiKey() {
    return this.hosted ? str('ZERNIO_API_KEY', '') : ''
  },
  get zernioWebhookSecret() {
    return str('ZERNIO_WEBHOOK_SECRET', '')
  },
  get zernioUsdPerAccount() {
    const n = Number(str('ZERNIO_USD_PER_ACCOUNT', '3'))
    return Number.isFinite(n) && n >= 0 ? n : 3
  },
  get llmSettingsLocked() {
    return bool('LLM_SETTINGS_LOCKED', false)
  },
  get authPassword() {
    return bool('AUTH_PASSWORD', !this.hosted)
  },
  get rpId() {
    return new URL(this.appUrl).hostname
  },
  get appOrigin() {
    return new URL(this.appUrl).origin
  },
}

export function envValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  if (process.env.NODE_ENV === 'test') return undefined
  const file = resolve('.env')
  if (!existsSync(file)) return undefined
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && m[1] === name) return m[2]!.replace(/^(['"])(.*)\1$/, '$2') || undefined
    }
  }
  catch {
    return undefined
  }
  return undefined
}
