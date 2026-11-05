import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DocumentFact } from '../db/schema'
import { agentReady, projectFacts, withRun, workspaceLlm } from './agent'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { chatJson } from './llm'
import { assertStorage } from './limits'
import { cleanName, readFileData, removeFile, storeFile } from './media'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
export type ProjectDocument = typeof schema.projectDocuments.$inferSelect

export type DocType = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'md'

export const DOC_TYPES: Record<DocType, { mime: string, label: string }> = {
  pdf: { mime: 'application/pdf', label: 'PDF' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  csv: { mime: 'text/csv', label: 'CSV' },
  txt: { mime: 'text/plain', label: 'Text' },
  md: { mime: 'text/markdown', label: 'Markdown' },
}

export const DOC_ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md'
export const MAX_DOC_BYTES = 20 * 1024 * 1024
export const MAX_DOC_TEXT = 300_000
export const MAX_DOCS_PER_PROJECT = 200

export class DocumentError extends Error {}

function extOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? ''
}

function hasBytes(data: Uint8Array, needle: string): boolean {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(needle, 0, 'latin1')
}

export function isDocumentName(name: string): boolean {
  return ['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md', 'markdown'].includes(extOf(name))
}

export function detectDocType(name: string, data: Uint8Array): DocType | null {
  const b = (i: number) => data[i] ?? -1
  const ext = extOf(name)
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'pdf'
  if (b(0) === 0x50 && b(1) === 0x4B && b(2) === 0x03 && b(3) === 0x04) {
    if (hasBytes(data, 'word/')) return 'docx'
    if (hasBytes(data, 'xl/')) return 'xlsx'
    return null
  }
  if (!['txt', 'md', 'markdown', 'csv'].includes(ext)) return null
  if (data.subarray(0, 8192).includes(0)) return null
  return ext === 'csv' ? 'csv' : ext === 'txt' ? 'txt' : 'md'
}

export function validateDocument(name: string, data: Uint8Array): { type: DocType, mime: string } {
  if (!data.byteLength) throw new DocumentError('Datei ist leer')
  if (data.byteLength > MAX_DOC_BYTES) throw new DocumentError(`Datei zu groß (max. ${MAX_DOC_BYTES / 1024 / 1024} MB)`)
  const type = detectDocType(name, data)
  if (!type) throw new DocumentError('Nur PDF, Word (DOCX), Excel (XLSX), CSV, TXT oder Markdown')
  return { type, mime: DOC_TYPES[type].mime }
}

function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '')
  }
  catch {
    return new TextDecoder('windows-1252').decode(data)
  }
}

export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DOC_TEXT)
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).trim()
}

export async function extractText(type: DocType, data: Uint8Array): Promise<string> {
  switch (type) {
    case 'pdf': {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(data))
      const r = await pdfText(pdf, { mergePages: true })
      return cleanText(r.text)
    }
    case 'docx': {
      const mammoth = (await import('mammoth')).default
      const r = await mammoth.extractRawText({ buffer: Buffer.from(data) })
      return cleanText(r.value)
    }
    case 'xlsx': {
      const readXlsx = (await import('read-excel-file/node')).default
      const sheets = await readXlsx(Buffer.from(data))
      const out: string[] = []
      for (const s of sheets) {
        const rows = s.data.map(r => r.map(cellText)).filter(r => r.some(Boolean)).map(r => r.join(' | ').replace(/( \| )+$/, ''))
        if (rows.length) out.push(`${sheets.length > 1 ? `## ${s.sheet}\n` : ''}${rows.join('\n')}`)
      }
      return cleanText(out.join('\n\n'))
    }
    default:
      return cleanText(decodeText(data))
  }
}

const STOP = new Set(['aber', 'alle', 'auch', 'auf', 'aus', 'bei', 'bitte', 'dass', 'dein', 'deine', 'dem', 'den', 'der', 'des', 'die', 'dies', 'diese', 'dieser', 'durch', 'eine', 'einem', 'einen', 'einer', 'eines', 'für', 'haben', 'hat', 'ich', 'ihr', 'ist', 'kann', 'mehr', 'mit', 'nach', 'nicht', 'noch', 'oder', 'sein', 'sich', 'sie', 'sind', 'über', 'und', 'uns', 'unter', 'vom', 'von', 'vor', 'was', 'wie', 'wir', 'wird', 'zum', 'zur', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'are', 'was', 'have', 'has', 'not', 'you', 'our', 'post', 'beitrag', 'entwurf', 'aufgabe', 'social'])

export function words(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3 && !STOP.has(w)) out.add(w)
  return out
}

export function chunks(text: string, size = 700): string[] {
  const parts = text.split(/\n{2,}|\n(?=[-*#\d])/).map(p => p.trim()).filter(Boolean)
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    for (let i = 0; i < p.length; i += size) {
      const piece = p.slice(i, i + size)
      if (cur && cur.length + piece.length + 1 > size) {
        out.push(cur)
        cur = ''
      }
      cur = cur ? `${cur}\n${piece}` : piece
    }
  }
  if (cur) out.push(cur)
  return out
}

export interface DocLike {
  name: string
  summary: string | null
  text: string
}

export function relevantExcerpts(docs: DocLike[], query: string, budget: number, size = 700): { name: string, text: string, score: number }[] {
  const q = words(query)
  if (!q.size || budget <= 0) return []
  const scored: { name: string, text: string, score: number, i: number }[] = []
  let i = 0
  for (const d of docs) {
    for (const c of chunks(d.text, size)) {
      const w = words(c)
      let score = 0
      for (const x of q) if (w.has(x)) score++
      if (score) scored.push({ name: d.name, text: c, score, i: i++ })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  const out: { name: string, text: string, score: number }[] = []
  let used = 0
  for (const s of scored) {
    if (used + s.text.length > budget) continue
    out.push({ name: s.name, text: s.text, score: s.score })
    used += s.text.length
  }
  return out
}

export function docsDigest(docs: DocLike[], query: string, budget = 2500): string[] {
  if (!docs.length) return []
  const lines: string[] = []
  let used = 0
  for (const d of docs.slice(0, 10)) {
    const about = (d.summary?.trim() || d.text.slice(0, 240).replace(/\s+/g, ' ')).slice(0, 320)
    const line = `Unterlage "${d.name}": ${about}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }
  for (const x of relevantExcerpts(docs, query, Math.max(0, budget - used))) lines.push(`Auszug aus "${x.name}": ${x.text.replace(/\n+/g, ' ')}`)
  return lines
}

export async function projectDocs(db: DbOrTx, projectId: string, limit = 20): Promise<DocLike[]> {
  return db.select({ name: schema.projectDocuments.name, summary: schema.projectDocuments.summary, text: schema.projectDocuments.text }).from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, projectId)).orderBy(desc(schema.projectDocuments.createdAt)).limit(limit)
}

export async function docsContext(db: DbOrTx, projectId: string, query: string, budget = 2500): Promise<string[]> {
  return docsDigest(await projectDocs(db, projectId), query, budget)
}

export function factSource(name: string): string {
  return `(Unterlage: ${name})`
}

export function withSource(fact: string, name: string): string {
  return `${fact.replace(/\s*\(Unterlage: [^)]*\)\s*$/, '').trim()} ${factSource(name)}`
}

export async function saveDocument(db: Db, ws: Workspace, project: Project, input: { name: string, data: Uint8Array, userId: string | null }): Promise<ProjectDocument> {
  const { type, mime } = validateDocument(input.name, input.data)
  const name = cleanName(input.name)
  let text: string
  try {
    text = await extractText(type, input.data)
  }
  catch (err) {
    throw new DocumentError(`Text konnte nicht gelesen werden (${(err as Error).message.slice(0, 120)})`)
  }
  await assertStorage(db, ws, input.data.byteLength)
  const { file } = await storeFile([ws.id, 'docs', project.id], type, input.data, mime)
  const ready = agentReady(ws) && text.length > 0
  const [row] = await db.insert(schema.projectDocuments).values({
    workspaceId: ws.id,
    projectId: project.id,
    name,
    type,
    mime,
    size: input.data.byteLength,
    file,
    text,
    status: ready ? 'neu' : 'fertig',
    error: text ? null : 'Kein Text gefunden (z.B. eingescanntes PDF ohne Texterkennung)',
    createdByUserId: input.userId,
    createdAt: now(),
  }).returning()
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'user', userId: input.userId, action: 'document_added', detail: { title: name }, at: now() })
  if (ready) await enqueueJob(db, 'document_digest', { workspaceId: ws.id, payload: { documentId: row!.id }, dedupeKey: `document_digest:${row!.id}`, maxAttempts: 2 })
  return row!
}

const digestSchema = z.object({
  summary: z.string().catch(''),
  facts: z.array(z.string()).catch([]),
})

export function digestPrompt(project: Pick<Project, 'name' | 'description'>, doc: Pick<ProjectDocument, 'name' | 'text'>, known: string[]): string {
  const text = doc.text.length > 14_000 ? `${doc.text.slice(0, 11_000)}\n[...]\n${doc.text.slice(-3000)}` : doc.text
  return [
    `Projekt: ${project.name}${project.description ? ` - ${project.description}` : ''}`,
    `Unterlage: ${doc.name}`,
    known.length ? `Schon bekannte Fakten (nicht wiederholen):\n${known.slice(0, 30).map(f => `- ${f}`).join('\n')}` : '',
    `Inhalt:\n"""\n${text}\n"""`,
    'Aufgabe: Fasse die Unterlage in 2-4 Sätzen auf Deutsch zusammen (wofür sie fürs Marketing nützt). Nenne dann bis zu 8 wichtige, belegbare Fakten für Marketing-Texte (Termine, Preise, Zahlen, Namen, Besonderheiten), je ein kurzer Satz. Nichts erfinden, nur was im Text steht. Normale Bindestriche statt langer Striche.',
    'Antworte nur mit JSON: {"summary": "...", "facts": ["...", "..."]}',
  ].filter(Boolean).join('\n\n')
}

export async function digestDocument(db: Db, ws: Workspace, documentId: string, fetchImpl?: typeof fetch) {
  const [doc] = await db.select().from(schema.projectDocuments).where(and(eq(schema.projectDocuments.id, documentId), eq(schema.projectDocuments.workspaceId, ws.id)))
  if (!doc) return { status: 'skipped' as const, summary: 'Unterlage nicht gefunden' }
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, doc.projectId))
  if (!project) return { status: 'skipped' as const, summary: 'Projekt nicht gefunden' }
  try {
    return await withRun(db, ws, 'document_digest', { projectId: project.id }, async (ctx) => {
      if (!doc.text.trim()) return { status: 'skipped', summary: `Kein Text in ${doc.name}` }
      const r = await chatJson(workspaceLlm(ws, 'document_digest'), { messages: [{ role: 'system', content: 'Du liest Unterlagen für einen Marketing-Agenten und ziehst nüchtern das Wichtige heraus.' }, { role: 'user', content: digestPrompt(project, doc, projectFacts(project).known) }], maxTokens: 900, temperature: 0.2 }, digestSchema, fetchImpl)
      ctx.usage.push(...r.usage)
      const dash = (s: string) => s.replace(/[\u2013\u2014]/g, '-').trim()
      const known = new Set(projectFacts(project).known.map(f => f.toLowerCase()))
      const facts: DocumentFact[] = [...new Set(r.data.facts.map(dash).filter(f => f && f.length <= 300))].filter(f => !known.has(f.toLowerCase())).slice(0, 8).map(text => ({ text, saved: false }))
      await db.update(schema.projectDocuments).set({ summary: dash(r.data.summary).slice(0, 1200) || null, facts, status: 'fertig', error: null }).where(eq(schema.projectDocuments.id, doc.id))
      return { status: 'ok', summary: `Unterlage gelesen: ${doc.name} (${facts.length} Fakten vorgeschlagen)` }
    })
  }
  catch (err) {
    await db.update(schema.projectDocuments).set({ status: 'fehler', error: (err as Error).message.slice(0, 300) }).where(eq(schema.projectDocuments.id, doc.id))
    throw err
  }
}

export async function saveDocumentFact(db: Db, ws: Workspace, doc: ProjectDocument, index: number, userId: string | null): Promise<string> {
  const f = doc.facts[index]
  if (!f) throw new DocumentError('Fakt nicht gefunden')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, doc.projectId))
  if (!project) throw new DocumentError('Projekt nicht gefunden')
  const text = withSource(f.text, doc.name)
  const facts = projectFacts(project)
  const known = facts.known.some(k => k.toLowerCase() === text.toLowerCase()) ? facts.known : [...facts.known, text].slice(-30)
  await db.update(schema.projects).set({ setup: { ...project.setup, facts: { known, avoid: facts.avoid } } }).where(eq(schema.projects.id, project.id))
  await db.update(schema.projectDocuments).set({ facts: doc.facts.map((x, i) => (i === index ? { ...x, saved: true } : x)) }).where(eq(schema.projectDocuments.id, doc.id))
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'user', userId, action: 'facts_updated', detail: { title: project.name } })
  return text
}

export async function deleteDocument(db: Db, doc: ProjectDocument, opts: { removeFacts?: boolean } = {}): Promise<{ removedFacts: number }> {
  let removedFacts = 0
  if (opts.removeFacts) {
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, doc.projectId))
    if (project) {
      const facts = projectFacts(project)
      const tag = factSource(doc.name)
      const known = facts.known.filter(k => !k.endsWith(tag))
      removedFacts = facts.known.length - known.length
      if (removedFacts) await db.update(schema.projects).set({ setup: { ...project.setup, facts: { known, avoid: facts.avoid } } }).where(eq(schema.projects.id, project.id))
    }
  }
  await db.delete(schema.projectDocuments).where(eq(schema.projectDocuments.id, doc.id))
  await removeFile(doc.file).catch(() => {})
  return { removedFacts }
}

export async function readDocumentFile(doc: Pick<ProjectDocument, 'file'>): Promise<Uint8Array> {
  return readFileData(doc.file)
}

export function documentView(d: ProjectDocument) {
  return { id: d.id, name: d.name, type: d.type, size: d.size, chars: d.text.length, summary: d.summary, facts: d.facts, status: d.status, error: d.error, createdAt: d.createdAt.toISOString() }
}
