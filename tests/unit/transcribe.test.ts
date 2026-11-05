import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { sttTarget, transcribe } from '../../server/lib/transcribe'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
})
afterAll(async () => {
  delete process.env.TRANSCRIBE_API_KEY
  await close()
})

describe('Spracheingabe', () => {
  it('ohne Schlüssel nicht verfügbar', () => {
    delete process.env.TRANSCRIBE_API_KEY
    expect(sttTarget(ws)).toBeNull()
  })
  it('schickt das Audio an Voxtral und gibt nur den Text zurück', async () => {
    process.env.TRANSCRIBE_API_KEY = 'k'
    const calls: { url: string, body: FormData }[] = []
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as FormData })
      return new Response(JSON.stringify({ text: 'Die letzte Mail ist erledigt – danke' }), { status: 200 })
    }
    const text = await transcribe(db, ws, { data: Buffer.from('abc'), type: 'audio/mp4', name: 'audio.m4a' }, 'de', fake)
    expect(text).toBe('Die letzte Mail ist erledigt - danke')
    expect(calls[0]!.url).toBe('https://api.mistral.ai/v1/audio/transcriptions')
    expect(calls[0]!.body.get('model')).toBe('voxtral-mini-latest')
    expect(calls[0]!.body.get('language')).toBe('de')
    const [u] = await db.select().from(schema.serviceUsage)
    expect(u).toMatchObject({ service: 'stt', units: 1 })
  })
})
