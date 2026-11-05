import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { chunks, deleteDocument, detectDocType, digestDocument, docsContext, docsDigest, DocumentError, extractText, MAX_DOC_BYTES, relevantExcerpts, saveDocument, saveDocumentFact, validateDocument, withSource } from '../../server/lib/documents'
import { fileExists } from '../../server/lib/media'

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const utf8 = (s: string) => new TextEncoder().encode(s)

describe('Unterlagen prüfen', () => {
  it('erkennt Typen am Inhalt, nicht nur an der Endung', () => {
    expect(detectDocType('a.pdf', fx('unterlage.pdf'))).toBe('pdf')
    expect(detectDocType('falsch.txt', fx('unterlage.pdf'))).toBe('pdf')
    expect(detectDocType('a.docx', fx('unterlage.docx'))).toBe('docx')
    expect(detectDocType('a.xlsx', fx('unterlage.xlsx'))).toBe('xlsx')
    expect(detectDocType('notiz.md', utf8('# Titel\nText'))).toBe('md')
    expect(detectDocType('liste.csv', utf8('a;b\n1;2'))).toBe('csv')
    expect(detectDocType('notiz.txt', utf8('Hallo'))).toBe('txt')
  })

  it('lehnt Unbekanntes, Leeres, Binäres und zu Großes ab', () => {
    expect(() => validateDocument('bild.jpg', new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]))).toThrow(DocumentError)
    expect(() => validateDocument('programm.exe', utf8('MZ...'))).toThrow(/Nur PDF/)
    expect(() => validateDocument('leer.txt', new Uint8Array())).toThrow(/leer/)
    expect(() => validateDocument('binaer.txt', new Uint8Array([0x41, 0x00, 0x42]))).toThrow(DocumentError)
    const big = new Uint8Array(MAX_DOC_BYTES + 1)
    big.set([0x25, 0x50, 0x44, 0x46])
    expect(() => validateDocument('gross.pdf', big)).toThrow(/zu groß/)
    expect(() => validateDocument('archiv.zip', new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0, 0]))).toThrow(DocumentError)
    expect(validateDocument('ok.pdf', fx('unterlage.pdf'))).toEqual({ type: 'pdf', mime: 'application/pdf' })
  })
})

describe('Text extrahieren', () => {
  it('PDF über alle Seiten', async () => {
    const t = await extractText('pdf', fx('unterlage.pdf'))
    expect(t).toContain('Album erscheint am 20. November 2026.')
    expect(t).toContain('Tour startet in Wien.')
  })

  it('Word-Dokument', async () => {
    const t = await extractText('docx', fx('unterlage.docx'))
    expect(t).toContain('Produktblatt')
    expect(t).toContain('Preis: 49 Euro pro Monat.')
  })

  it('Excel mit mehreren Blättern', async () => {
    const t = await extractText('xlsx', fx('unterlage.xlsx'))
    expect(t).toContain('## Preise')
    expect(t).toContain('Pro | 49')
    expect(t).toContain('## Termine')
    expect(t).toContain('Wien')
  })

  it('Text, CSV und Markdown, auch Windows-1252, ohne lange Striche', async () => {
    expect(await extractText('md', utf8('\uFEFF# Titel \u2014 Unter\r\n\r\n\r\n\r\nText'))).toBe('# Titel - Unter\n\nText')
    expect(await extractText('csv', new Uint8Array([0x4B, 0xE4, 0x73, 0x65, 0x3B, 0x31]))).toBe('Käse;1')
  })
})

describe('Relevante Auszüge', () => {
  const docs = [
    { name: 'preise.pdf', summary: 'Preisliste 2026', text: 'Einleitung zum Unternehmen.\n\nDas Paket Pro kostet 49 Euro pro Monat.\n\nKontakt: hallo@example.org' },
    { name: 'tour.docx', summary: null, text: 'Die Tour startet am 20. November in Wien.\n\nTickets gibt es ab 30 Euro.' },
  ]

  it('teilt lange Texte in Stücke', () => {
    const c = chunks('a'.repeat(1500), 700)
    expect(c.length).toBe(3)
    expect(c.every(x => x.length <= 700)).toBe(true)
  })

  it('findet passende Stellen zum Suchtext, innerhalb des Budgets', () => {
    const r = relevantExcerpts(docs, 'Post zur Tour in Wien', 500)
    expect(r[0]!.name).toBe('tour.docx')
    expect(r[0]!.text).toContain('Wien')
    expect(relevantExcerpts(docs, 'Pro Paket Preis', 500)[0]!.text).toContain('49 Euro')
    expect(relevantExcerpts(docs, 'xyz', 500)).toEqual([])
    expect(relevantExcerpts(docs, 'Wien', 5)).toEqual([])
  })

  it('Überblick mit Zusammenfassung oder Anfang, dann Auszüge', () => {
    const lines = docsDigest(docs, 'Tickets für Wien', 2000)
    expect(lines[0]).toBe('Unterlage "preise.pdf": Preisliste 2026')
    expect(lines[1]).toMatch(/^Unterlage "tour.docx": Die Tour startet/)
    expect(lines.some(l => l.startsWith('Auszug aus "tour.docx"'))).toBe(true)
    expect(docsDigest([], 'x')).toEqual([])
  })

  it('Quelle am Fakt, ohne doppelte Quelle', () => {
    expect(withSource('Album am 20.11.', 'presse.pdf')).toBe('Album am 20.11. (Unterlage: presse.pdf)')
    expect(withSource('Album am 20.11. (Unterlage: alt.pdf)', 'presse.pdf')).toBe('Album am 20.11. (Unterlage: presse.pdf)')
  })
})

describe('Unterlagen speichern, zusammenfassen, löschen', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect

  beforeAll(async () => {
    process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'ma-docs-'))
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tv', name: 'The Wanderer', code: 'TV', icon: 'T', setup: { facts: { known: ['Band aus Wien'], avoid: [] } } }).returning())[0]!
  })
  afterAll(async () => {
    await close()
    delete process.env.MEDIA_DIR
  })

  it('speichert Datei und Text, plant die Zusammenfassung', async () => {
    const doc = await saveDocument(db, ws, project, { name: 'presse<mappe>.pdf', data: fx('unterlage.pdf'), userId: null })
    expect(doc.name).toBe('presse_mappe_.pdf')
    expect(doc.type).toBe('pdf')
    expect(doc.text).toContain('20. November 2026')
    expect(doc.status).toBe('neu')
    expect(await fileExists(doc.file)).toBe(true)
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'document_digest'))
    expect(jobs.map(j => j.payload.documentId)).toContain(doc.id)
  })

  it('fasst per LLM zusammen, schlägt Fakten vor, übernimmt sie mit Quelle', async () => {
    const [doc] = await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, project.id))
    let prompt = ''
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      prompt = String(init.body)
      return new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: '{"summary": "Pressemappe \u2014 Album und Tour.", "facts": ["Album erscheint am 20. November 2026", "Band aus Wien", "Tour startet in Wien"]}' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 })
    }) as unknown as typeof fetch
    await digestDocument(db, ws, doc!.id, fetchImpl)
    expect(prompt).toContain('Tour startet in Wien')
    const [after] = await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.id, doc!.id))
    expect(after!.status).toBe('fertig')
    expect(after!.summary).toBe('Pressemappe - Album und Tour.')
    expect(after!.facts.map(f => f.text)).toEqual(['Album erscheint am 20. November 2026', 'Tour startet in Wien'])
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.job, 'document_digest'))
    expect(run!.tokensIn).toBe(100)
    const text = await saveDocumentFact(db, ws, after!, 0, null)
    expect(text).toBe('Album erscheint am 20. November 2026 (Unterlage: presse_mappe_.pdf)')
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
    expect(p!.setup.facts?.known).toContain(text)
    const [saved] = await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.id, doc!.id))
    expect(saved!.facts[0]!.saved).toBe(true)
  })

  it('liefert Kontext für den Agenten', async () => {
    const lines = await docsContext(db, project.id, 'Tour Wien')
    expect(lines[0]).toContain('Pressemappe - Album und Tour.')
    expect(lines.join('\n')).toContain('Tour startet in Wien')
  })

  it('löschen entfernt Datei, Text und auf Wunsch die Fakten', async () => {
    const [doc] = await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, project.id))
    const r = await deleteDocument(db, doc!, { removeFacts: true })
    expect(r.removedFacts).toBe(1)
    expect(await fileExists(doc!.file)).toBe(false)
    expect(await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.id, doc!.id))).toEqual([])
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
    expect(p!.setup.facts?.known).toEqual(['Band aus Wien'])
  })

  it('ohne Agent kein Job, Status gleich fertig', async () => {
    const off = (await db.insert(schema.workspaces).values({ name: 'Ohne', settings: { agentEnabled: false } }).returning())[0]!
    const p2 = (await db.insert(schema.projects).values({ workspaceId: off.id, slug: 'x', name: 'X', code: 'X', icon: 'X' }).returning())[0]!
    const doc = await saveDocument(db, off, p2, { name: 'notiz.md', data: utf8('# Notiz\nWichtig'), userId: null })
    expect(doc.status).toBe('fertig')
    expect((await db.select().from(schema.jobs).where(eq(schema.jobs.workspaceId, off.id))).length).toBe(0)
  })
})
