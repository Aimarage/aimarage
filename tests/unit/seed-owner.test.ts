import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { login } from '../../server/lib/auth'
import { seedIfEmpty } from '../../server/lib/bootstrap'
import { openTestDb, schema, type Db } from '../../server/lib/db'

const ENV = ['SEED_ON_START', 'SEED_EMAIL', 'SEED_PASSWORD', 'SEED_NAME', 'SEED_WORKSPACE', 'SEED_LOCALE']
let db: Db
let close: () => Promise<void>

beforeAll(async () => {
  ({ db, close } = await openTestDb())
})
afterAll(() => close())
afterEach(() => {
  for (const k of ENV) delete process.env[k]
})

describe('Erstanlage für Selbst-Installation (SEED_ON_START=owner)', () => {
  it('legt leeren Arbeitsbereich mit Inhaber an, nur einmal', async () => {
    Object.assign(process.env, { SEED_ON_START: 'owner', SEED_EMAIL: 'ich@firma.at', SEED_PASSWORD: 'geheim123', SEED_WORKSPACE: 'Firma' })
    const log = vi.fn()
    expect(await seedIfEmpty(db, log)).toBe(true)
    expect(log.mock.calls[0]![0]).not.toContain('geheim123')
    const ws = await db.select().from(schema.workspaces)
    expect(ws.map(w => w.name)).toEqual(['Firma'])
    expect(ws[0]!.settings.publishLive).toBe(false)
    expect(await db.select().from(schema.projects)).toEqual([])
    const m = await db.select().from(schema.memberships)
    expect(m.map(x => x.role)).toEqual(['owner'])
    expect(await login(db, 'ich@firma.at', 'geheim123')).not.toBeNull()
    expect(await seedIfEmpty(db, log)).toBe(false)
  })
})

describe('ohne Passwort', () => {
  it('erzeugt ein zufälliges Passwort und nennt es im Log', async () => {
    const { db: db2, close: close2 } = await openTestDb()
    Object.assign(process.env, { SEED_ON_START: 'owner', SEED_EMAIL: 'admin' })
    const log = vi.fn()
    expect(await seedIfEmpty(db2, log)).toBe(true)
    const pw = /Passwort (\S+)/.exec(log.mock.calls[0]![0] as string)![1]!
    expect(pw.length).toBeGreaterThanOrEqual(12)
    expect(await login(db2, 'admin', pw)).not.toBeNull()
    await close2()
  })
})
