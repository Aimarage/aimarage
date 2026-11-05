import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const port = 3299
const base = `http://127.0.0.1:${port}`
let proc: ChildProcess
let dir: string
let cookie = ''

async function api<T = any>(path: string, init: { method?: string, body?: unknown } = {}): Promise<{ status: number, data: T }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]!
  const text = await res.text()
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  if (!existsSync('.output/server/index.mjs')) throw new Error('Erst `npm run build` ausführen')
  dir = mkdtempSync(join(tmpdir(), 'ma-api-'))
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, MEDIA_DIR: join(dir, 'media'), APP_SECRET: 'api-test-secret', MA_NOW: '2026-10-13T08:15:00+02:00', APP_URL: 'https://ma.example.org', LLM_API_KEY: '', WORKER_INLINE: 'false', NODE_ENV: 'production', SECURE_COOKIES: 'false', SEED_ON_START: 'owner', SEED_EMAIL: 'ich@firma.example', SEED_PASSWORD: 'geheim-123', SEED_WORKSPACE: 'Firma' }
  delete env.DATABASE_URL
  delete env.SMTP_URL
  proc = spawn(process.execPath, ['.output/server/index.mjs'], { env, stdio: 'pipe' })
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/me`)
      if (r.ok) return
    }
    catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('Server startet nicht')
}, 60_000)

afterAll(() => {
  proc?.kill()
  rmSync(dir, { recursive: true, force: true })
})

describe('Selbst-Installation: eine Anmeldung', () => {
  it('ohne Anmeldung kein Zugriff', async () => {
    expect((await api('/api/me')).data).toEqual({ user: null })
    expect((await api('/api/dashboard')).status).toBe(401)
  })

  it('falsches Passwort wird abgelehnt', async () => {
    expect((await api('/api/auth/login', { method: 'POST', body: { email: 'ich@firma.example', password: 'falsch' } })).status).toBe(401)
  })

  it('Inhaber aus SEED_EMAIL/SEED_PASSWORD meldet sich an, Arbeitsbereich ist leer', async () => {
    expect((await api('/api/auth/login', { method: 'POST', body: { email: 'ich@firma.example', password: 'geheim-123' } })).status).toBe(200)
    const me = await api('/api/me')
    expect(me.data.user).toBeTruthy()
    expect(me.data.projects).toEqual([])
    expect(me.data.members).toHaveLength(1)
    expect(me.data.agent.configured).toBe(false)
  })

  it('Projekt anlegen und Aufgabe planen', async () => {
    const p = await api('/api/projects', { method: 'POST', body: { name: 'Testprojekt', url: 'https://shop.example' } })
    expect(p.status).toBe(200)
    const t = await api('/api/tasks', { method: 'POST', body: { project: p.data.slug, title: 'API-Test', category: 'social', dueDate: '2026-10-14', dueTime: '10:00' } })
    expect(t.status).toBe(200)
    const c = await api('/api/calendar?from=2026-10-12&to=2026-10-18')
    expect(c.data.items.some((i: { title: string }) => i.title === 'API-Test')).toBe(true)
  })

  it('keine Registrierung, kein Abo', async () => {
    expect((await fetch(`${base}/registrieren`, { redirect: 'manual' })).status).not.toBe(200)
    expect((await api('/api/saas/plans')).status).toBe(404)
  })

  it('Login wird nach 10 Fehlversuchen gebremst', async () => {
    cookie = ''
    for (let i = 0; i < 10; i++) expect((await api('/api/auth/login', { method: 'POST', body: { email: 'brute@firma.example', password: 'x' } })).status).toBe(401)
    expect((await api('/api/auth/login', { method: 'POST', body: { email: 'brute@firma.example', password: 'x' } })).status).toBe(429)
  })
})
