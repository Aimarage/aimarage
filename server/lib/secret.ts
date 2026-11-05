import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let cached: { source: string, key: Buffer } | null = null

export function secretFile(): string {
  return resolve(process.env.APP_SECRET_FILE || './data/app-secret')
}

function appSecret(): string {
  const env = process.env.APP_SECRET
  if (env) return env
  const file = secretFile()
  if (existsSync(file)) {
    const v = readFileSync(file, 'utf8').trim()
    if (v) return v
  }
  mkdirSync(dirname(file), { recursive: true })
  const fresh = randomBytes(32).toString('base64url')
  try {
    writeFileSync(file, `${fresh}\n`, { mode: 0o600, flag: 'wx' })
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return readFileSync(file, 'utf8').trim()
  }
  chmodSync(file, 0o600)
  return fresh
}

function masterKey(): Buffer {
  const source = process.env.APP_SECRET ? `env:${process.env.APP_SECRET}` : `file:${secretFile()}`
  if (cached?.source === source) return cached.key
  const key = Buffer.from(hkdfSync('sha256', appSecret(), 'marketingagent', 'workspace-secret-v1', 32))
  cached = { source, key }
  return key
}

export function resetSecretCache(): void {
  cached = null
}

export function encryptSecret(plain: string, context: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', masterKey(), iv)
  c.setAAD(Buffer.from(context))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`
}

export function decryptSecret(token: string, context: string): string | null {
  try {
    if (!token.startsWith('v1.')) return null
    const raw = Buffer.from(token.slice(3), 'base64url')
    if (raw.length < 29) return null
    const d = createDecipheriv('aes-256-gcm', masterKey(), raw.subarray(0, 12))
    d.setAAD(Buffer.from(context))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  }
  catch {
    return null
  }
}

export function derivedKey(info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey(), 'marketingagent', info, 32))
}
