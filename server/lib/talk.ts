import { platformKeyOf } from '../../shared/utils/blocked-platforms'
import { dropPlatform } from './platform-block'
import { and, asc, desc, eq, like } from 'drizzle-orm'
import { isCommunitySweep } from '../../shared/utils/community-sweep'
import { z } from 'zod'
import { OPEN_STATUSES } from '../../shared/utils/domain'
import { platformRule } from '../../shared/utils/social'
import { isValidIso } from '../../shared/utils/dates'
import { notToday, TALK_DROPPED, TALK_PREFIX, talkLine, wantsDrop, type TalkKind } from '../../shared/utils/talk'
import type { TaskWhere } from '../../shared/utils/where'
import { withRules } from '../prompts/de'
import { talkPrompt, TALK_SYSTEM } from '../prompts/talk'
import { agentReady, projectFacts, withRun, workspaceLlm } from './agent'
import { docsContext } from './documents'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { enqueueJob, pendingJobs } from './jobs'
import { mailInfo, mailInfoText } from './mail'
import { chat, extractJson } from './llm'
import { socialTarget } from './publish'
import { retypeFromTalk } from './retype'
import { dayLabel, moveContext } from './talk-schedule'
import { updateTask } from './tasks'
import { taskWhereOf } from './where'

type Workspace = typeof schema.workspaces.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Project = typeof schema.projects.$inferSelect

export interface TalkReply {
  type: 'ask' | 'answer' | 'revise'
  text: string
  fact: string | null
  convert?: 'article' | 'post' | null
  posts?: boolean
  move?: string | null
  drop?: boolean
  block?: string | null
}

export interface TalkView {
  lines: { id: string, who: 'agent' | 'user', kind: TalkKind | 'version', text: string, at: string }[]
  draft: { id: string, version: number, status: string } | null
  writing: boolean
  busy: boolean
  canTalk: boolean
}

const replySchema = z.object({
  type: z.enum(['ask', 'answer', 'revise']).catch('answer'),
  text: z.string().catch(''),
  fact: z.string().nullable().optional().catch(null),
  convert: z.enum(['article', 'post']).nullable().optional().catch(null),
  posts: z.boolean().optional().catch(false),
  move: z.string().nullable().optional().catch(null),
  drop: z.boolean().optional().catch(false),
  block: z.string().nullable().optional().catch(null),
})

const dash = (s: string) => s.replace(/[–—]/g, '-')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

export function parseTalkReply(content: string): TalkReply | null {
  const raw = content.trim()
  if (!raw) return null
  try {
    const r = replySchema.safeParse(extractJson(raw))
    if (r.success && r.data.text.trim()) return { type: r.data.type, text: clip(dash(r.data.text.trim()), 1200), fact: r.data.fact?.trim() ? clip(dash(r.data.fact.trim()), 300) : null, ...(r.data.convert ? { convert: r.data.convert } : {}), ...(r.data.posts ? { posts: true } : {}), ...(r.data.move && isValidIso(r.data.move.trim()) ? { move: r.data.move.trim() } : {}), ...(r.data.drop ? { drop: true } : {}), ...(platformKeyOf(r.data.block) ? { block: platformKeyOf(r.data.block) } : {}) }
  }
  catch {}
  const quoted = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (quoted) {
    const text = quoted[1]!.replace(/\\n/g, '\n').replace(/\\"/g, '"').trim()
    if (text) return { type: /"type"\s*:\s*"revise"/.test(raw) ? 'revise' : /"type"\s*:\s*"ask"/.test(raw) ? 'ask' : 'answer', text: clip(dash(text), 1200), fact: null }
  }
  if (/^[{[]|```/.test(raw)) return null
  return { type: raw.endsWith('?') ? 'ask' : 'answer', text: clip(dash(raw), 1200), fact: null }
}

const WHERE_KIND: Record<TaskWhere['kind'], string> = { blog: 'Blog/Ratgeber', external: 'extern', community: 'Community', directory: 'Verzeichnis', social: 'Social', mail: 'Mail', none: '' }

export function whereText(w: TaskWhere, project: Pick<Project, 'name' | 'url'> | null, accounts: string[] = []): string | null {
  const name = project?.name ?? 'Das Projekt'
  const by = w.by === 'agent' ? 'Aimarage veröffentlicht nach Freigabe automatisch.' : 'Der Mensch veröffentlicht selbst.'
  if (w.kind === 'none') return null
  if (w.missing) {
    if (w.kind === 'blog') return `Noch kein Ziel festgelegt: ${name} hat keinen Blog${project?.url ? ` (${project.url} hat keinen Blog-Bereich)` : ''}. Vorschlag: einen Blog-Bereich auf der Seite anlegen (z.B. /ratgeber) oder den Artikel als LinkedIn-Artikel, auf Medium oder dev.to veröffentlichen. Festlegen geht mit "Ziel festlegen" oben auf der Aufgabe oder in den Projekt-Einstellungen (Blog/Ratgeber-Adresse).`
    if (w.kind === 'social') return `${w.mark ? platformRule(w.mark).label : 'Social'}, aber für ${name} ist dort kein Konto verbunden. So geht der Post nicht raus: Konto anlegen und unter Konten verbinden oder selbst posten.`
    return `Noch kein Ziel festgelegt (${w.kind === 'community' ? 'kein Subreddit oder Forum' : 'kein Verzeichnis'}). Vorschlag: im Kanal oder Ziel-Link der Aufgabe festlegen.`
  }
  if (w.kind === 'mail') return `Mail an ${w.place ?? 'noch offenen Empfänger'}. ${w.by === 'agent' ? 'Aimarage sendet nach Freigabe über das Projekt-Postfach.' : 'Der Mensch sendet selbst.'}`
  if (w.kind === 'social') return `${w.mark ? platformRule(w.mark).label : 'Social'}${accounts.length ? ` (Konto: ${accounts.join(', ')})` : ''}. ${by}`
  return `${WHERE_KIND[w.kind]}${w.place ? `: ${w.place}` : ''}${w.url && w.url !== w.place ? ` (${w.url})` : ''}. ${by}`
}

export function canRevise(task: Pick<Task, 'status' | 'draftKind'>): boolean {
  return OPEN_STATUSES.includes(task.status) && !!task.draftKind
}

export async function taskTalk(db: Db, ws: Workspace, task: Task): Promise<TalkView> {
  const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(200)
  const drafts = await db.select({ id: schema.drafts.id, version: schema.drafts.version, status: schema.drafts.status, byAgent: schema.drafts.byAgent, createdAt: schema.drafts.createdAt })
    .from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version))
  const talk = notes.map(n => ({ n, l: talkLine(n.text, n.byAgent) })).filter(x => x.l).slice(0, 60).reverse()
  const lines: TalkView['lines'] = []
  const first = talk[0]?.n.createdAt.getTime() ?? Infinity
  const marks = drafts.filter(d => d.createdAt.getTime() > first).reverse()
  let m = 0
  for (const { n, l } of talk) {
    while (m < marks.length && marks[m]!.createdAt.getTime() <= n.createdAt.getTime()) {
      lines.push({ id: `v-${marks[m]!.id}`, who: 'agent', kind: 'version', text: String(marks[m]!.version), at: marks[m]!.createdAt.toISOString() })
      m++
    }
    lines.push({ id: n.id, who: l!.who, kind: l!.kind, text: l!.text, at: n.createdAt.toISOString() })
  }
  for (; m < marks.length; m++) lines.push({ id: `v-${marks[m]!.id}`, who: 'agent', kind: 'version', text: String(marks[m]!.version), at: marks[m]!.createdAt.toISOString() })
  const writing = await draftPending(db, ws.id, task.id)
  const d = drafts[0]
  return { lines, draft: d ? { id: d.id, version: d.version, status: d.status } : null, writing, busy: busy.has(task.id), canTalk: agentReady(ws) && OPEN_STATUSES.includes(task.status) }
}

const busy = new Set<string>()
const waitingFor = new Set<string>()

export function talkBusy(taskId: string): boolean {
  return busy.has(taskId)
}

async function draftPending(db: Db, workspaceId: string, taskId: string): Promise<boolean> {
  return (await pendingJobs(db, workspaceId)).some(j => j.type === 'draft_task' && j.taskId === taskId)
}

const queuedLike = (taskId: string) => and(eq(schema.taskNotes.taskId, taskId), eq(schema.taskNotes.byAgent, false), like(schema.taskNotes.text, `${TALK_PREFIX.queued}%`))

// Antwortet der Agent gerade oder schreibt er einen Entwurf, wartet die Nachricht und wird danach mit allen wartenden zusammen gelesen.
export async function talkOrQueue(db: Db, ws: Workspace, task: Task, userId: string | null, message: string, fetchImpl?: typeof fetch): Promise<(TalkReply & { revising: boolean, dropped?: boolean, moved?: string, queued?: false }) | { queued: true, id: string }> {
  const [waiting] = await db.select({ at: schema.taskNotes.createdAt }).from(schema.taskNotes).where(queuedLike(task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(1)
  if (!busy.has(task.id) && !waiting && !await draftPending(db, ws.id, task.id)) return talkAboutTask(db, ws, task, userId, message, fetchImpl)
  const at = new Date(Math.max(now().getTime(), (waiting?.at.getTime() ?? 0) + 1))
  const [n] = await db.insert(schema.taskNotes).values({ taskId: task.id, userId, text: `${TALK_PREFIX.queued} ${dash(message.trim()).slice(0, 4000)}`, createdAt: at }).returning({ id: schema.taskNotes.id })
  waitingFor.add(task.id)
  void drainTalk(db, ws, task.id, fetchImpl).catch(err => console.error('[talk]', err))
  return { queued: true, id: n!.id }
}

export async function dropQueuedTalk(db: Db, taskId: string, noteId: string): Promise<boolean> {
  const gone = await db.delete(schema.taskNotes).where(and(eq(schema.taskNotes.id, noteId), queuedLike(taskId))).returning({ id: schema.taskNotes.id })
  return gone.length > 0
}

// Liest alle wartenden Nachrichten einer Aufgabe als eine Runde. Jede Nachricht wird genau einmal übernommen (Löschen mit returning).
export async function drainTalk(db: Db, ws: Workspace, taskId: string, fetchImpl?: typeof fetch, opts: { afterDraft?: boolean } = {}): Promise<boolean> {
  if (busy.has(taskId)) return false
  if (!opts.afterDraft && await draftPending(db, ws.id, taskId)) return false
  busy.add(taskId)
  let claimed: (typeof schema.taskNotes.$inferSelect)[] = []
  try {
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId))
    if (!task || !agentReady(ws)) return false
    claimed = (await db.delete(schema.taskNotes).where(queuedLike(taskId)).returning()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    if (!claimed.length) return false
    waitingFor.delete(taskId)
    const lines = claimed.map(n => talkLine(n.text, false)?.text ?? '').filter(Boolean)
    try {
      await runTalk(db, ws, task, claimed.at(-1)!.userId, lines, fetchImpl)
    }
    catch (err) {
      console.error('[talk]', task.code, err)
      const at = now().getTime()
      await db.insert(schema.taskNotes).values([
        ...lines.map((l, i) => ({ taskId, userId: claimed[i]?.userId ?? null, text: `${TALK_PREFIX.user} ${l}`, createdAt: new Date(at + i) })),
        { taskId, byAgent: true, text: `${TALK_PREFIX.answer} ${TALK_FAILED}`, createdAt: new Date(at + lines.length) },
      ])
    }
    return true
  }
  finally {
    busy.delete(taskId)
    if (claimed.length) void drainTalk(db, ws, taskId, fetchImpl).catch(err => console.error('[talk]', err))
  }
}

export const TALK_FAILED = 'Darauf konnte ich gerade nicht antworten. Schick es bitte nochmal.'

// Mensch lehnt die Aufgabe im Gespräch ab: Entwurf und Aufgabe verwerfen, mit Notiz, statt neu zu schreiben.
export async function dropFromTalk(db: Db, ws: Workspace, task: Task, userId: string | null, text: string, lines: string[] = [text], answer: string = TALK_DROPPED): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update')
    if (!cur || !['geplant', 'entwurf_fertig'].includes(cur.status)) return false
    await tx.update(schema.drafts).set({ status: 'verworfen' }).where(and(eq(schema.drafts.taskId, task.id), eq(schema.drafts.status, 'offen')))
    const at = now().getTime()
    const k = lines.length
    await tx.insert(schema.taskNotes).values([
      ...lines.map((l, i) => ({ taskId: task.id, userId, text: `${TALK_PREFIX.user} ${l}`, createdAt: new Date(at + i) })),
      { taskId: task.id, byAgent: true, text: `${TALK_PREFIX.answer} ${answer}`, createdAt: new Date(at + k) },
      { taskId: task.id, byAgent: true, text: `Im Gespräch verworfen: ${clip(text, 300)}`, createdAt: new Date(at + k + 1) },
    ])
    await updateTask(tx as unknown as Db, cur, { status: 'verworfen' }, { type: 'user', userId })
    return true
  })
}

export async function talkAboutTask(db: Db, ws: Workspace, task: Task, userId: string | null, message: string, fetchImpl?: typeof fetch, opts: { via?: 'mcp' } = {}): Promise<TalkReply & { revising: boolean, dropped?: boolean, moved?: string }> {
  if (busy.has(task.id)) throw new Error('Agent antwortet noch')
  busy.add(task.id)
  try {
    return await runTalk(db, ws, task, userId, [message], fetchImpl, opts)
  }
  finally {
    busy.delete(task.id)
    if (waitingFor.delete(task.id)) void drainTalk(db, ws, task.id, fetchImpl).catch(err => console.error('[talk]', err))
  }
}

async function runTalk(db: Db, ws: Workspace, task: Task, userId: string | null, messages: string[], fetchImpl?: typeof fetch, opts: { via?: 'mcp' } = {}): Promise<TalkReply & { revising: boolean, dropped?: boolean, moved?: string }> {
  const said = messages.map(m => dash(m.trim())).filter(Boolean)
  const text = said.join('\n\n')
  if (opts.via !== 'mcp' && wantsDrop(text) && await dropFromTalk(db, ws, task, userId, text, said)) return { type: 'answer', text: TALK_DROPPED, fact: null, revising: false, dropped: true }
  const project = task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  const memory = project ? (await db.select().from(schema.projectMemory).where(eq(schema.projectMemory.projectId, project.id)).orderBy(asc(schema.projectMemory.createdAt)).limit(20)).map(m => m.text) : []
  if (project) memory.push(...await docsContext(db, project.id, [task.title, task.description ?? '', text].join('\n'), 2000))
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
  const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(30)).reverse()
  const history = notes.map(n => talkLine(n.text, n.byAgent)).filter(l => l && l.kind !== 'saved' && l.kind !== 'queued').slice(-16).map(l => `${l!.who === 'agent' ? 'Agent' : 'Mensch'}: ${l!.text}`)
  const other = notes.filter(n => !talkLine(n.text, n.byAgent) && !/^Nachprüfung:/.test(n.text)).slice(-5).map(n => n.text)
  const lastAgent = notes.map(n => talkLine(n.text, n.byAgent)).filter(l => l?.who === 'agent').at(-1)
  const askedBefore = lastAgent?.kind === 'ask'
  const revisable = canRevise(task)
  const where = await taskWhereOf(db, ws, task, project, draft?.recipient)
  const accounts = where.kind === 'social' && project ? (socialTarget(ws, project)?.platforms ?? []).filter(a => a.platform === where.mark).map(a => a.name) : []
  const inMail = await mailInfo(db, task.id)
  const mailFromBox = task.draftKind === 'mail' && /eingegangene mail/i.test(task.description ?? '')
  const pages = (project?.setup?.site?.pages ?? []).slice(0, 15).map(pg => `${pg.url}${pg.title ? ` (${pg.title})` : ''}`)
  const open = ['geplant', 'entwurf_fertig'].includes(task.status)
  const sched = open ? await moveContext(db, ws, task) : null
  const prompt = talkPrompt({
    project: project ? { name: project.name, url: project.url, description: project.description, tonality: project.tonality, pages } : null,
    task,
    where: whereText(where, project, accounts),
    askedBefore,
    facts: projectFacts(project),
    memory,
    draft: draft ? { version: draft.version, status: draft.status, kind: draft.kind, subject: draft.subject, body: draft.body, variants: draft.variants ?? {} } : null,
    notes: other,
    history,
    message: text,
    canRevise: revisable,
    schedule: sched?.text ?? null,
    mail: inMail ? mailInfoText(inMail, ws.timezone) : mailFromBox ? 'Eingegangene Mail: Metadaten (Datum, Message-ID) sind zu dieser Aufgabe nicht gespeichert.' : null,
  })
  let reply: TalkReply | null = null
  await withRun(db, ws, 'draft_talk', { projectId: task.projectId, taskId: task.id }, async (ctx) => {
    const base = workspaceLlm(ws, 'task_chat')
    const cfg = { ...base, timeoutMs: Math.min(base.timeoutMs, base.own ? 180_000 : 60_000), fallback: base.fallback ? { ...base.fallback, timeoutMs: Math.min(base.fallback.timeoutMs, 60_000) } : undefined }
    const res = await chat(cfg, { messages: [{ role: 'system', content: withRules(TALK_SYSTEM, project?.rules) }, { role: 'user', content: prompt }], maxTokens: 700, temperature: 0.3 }, fetchImpl, 2, 5)
    ctx.usage.push(res)
    ctx.log.push(prompt, `Antwort: ${res.content}`)
    reply = parseTalkReply(res.content)
    if (!reply) throw new Error('Antwort des Agenten war nicht lesbar')
    return { status: 'ok', summary: `Gespräch zu ${task.code}: ${reply.type === 'revise' ? 'neue Version' : reply.type === 'ask' ? 'Rückfrage' : 'Antwort'}` }
  })
  const r = reply as TalkReply | null
  if (!r) throw new Error('Antwort des Agenten war nicht lesbar')
  const type: TalkReply['type'] = r.type === 'revise' ? (revisable ? 'revise' : 'answer') : r.type === 'ask' && !askedBefore ? 'ask' : 'answer'
  // Plattform ganz streichen ("lege kein LinkedIn-Konto an"): zentrale Sperre statt nur Notiz, die Aufgabe fällt mit weg.
  if (r.block && project && type !== 'ask') {
    const res = await dropPlatform(db, ws, [project], r.block, { userId, apply: true, disconnect: false })
    const at = now().getTime()
    await db.insert(schema.taskNotes).values([
      ...said.map((l, i) => ({ taskId: task.id, userId, text: `${TALK_PREFIX.user} ${l}`, createdAt: new Date(at + i) })),
      { taskId: task.id, byAgent: true, text: `${TALK_PREFIX.answer} ${r.text}`, createdAt: new Date(at + said.length) },
    ])
    return { type: 'answer', text: r.text, fact: null, revising: false, ...(res.tasks.includes(task.code) ? { dropped: true } : {}) }
  }
  if (sched && r.drop && type !== 'ask') {
    if (await dropFromTalk(db, ws, task, userId, text, said, r.text)) return { type: 'answer', text: r.text, fact: null, revising: false, dropped: true }
  }
  let answerText = r.text
  let moved: string | undefined
  // Termin selbst verschieben: auf Wunsch des Agenten, oder wenn der Mensch "heute nicht" sagt und der Termin sonst heute/überfällig stehen bliebe.
  const stale = !!sched && !!task.dueDate && task.dueDate <= sched.today && notToday(text) && type !== 'ask'
  if (sched && type !== 'ask' && (r.move || stale)) {
    const target = r.move && r.move > sched.today ? r.move : sched.suggest
    if (target !== task.dueDate) {
      const row = await updateTask(db, task, { dueDate: target }, { type: 'user', userId })
      moved = row.dueDate ?? target
      const label = dayLabel(moved)
      if (!answerText.includes(label) && !answerText.includes(moved)) answerText = `${answerText} Neuer Termin: ${label}${r.move ? '' : ' - soll er ganz weg, sag Bescheid.'}`
    }
  }
  const known = new Set([...projectFacts(project).known, ...projectFacts(project).avoid].map(f => f.toLowerCase()))
  const fact = r.fact && project && !known.has(r.fact.toLowerCase()) ? r.fact : null
  const at = now().getTime()
  const k = said.length
  await db.insert(schema.taskNotes).values([
    ...said.map((l, i) => ({ taskId: task.id, userId, text: `${TALK_PREFIX.user} ${l}`, createdAt: new Date(at + i) })),
    { taskId: task.id, byAgent: true, text: `${TALK_PREFIX[type]} ${answerText}`, createdAt: new Date(at + k) },
    ...(fact ? [{ taskId: task.id, byAgent: true, text: `${TALK_PREFIX.fact} ${fact}`, createdAt: new Date(at + k + 1) }] : []),
  ])
  await logActivity(db, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: opts.via === 'mcp' ? 'mcp' : 'user', userId, action: 'note_added', detail: { title: task.title, ...(opts.via ? { via: opts.via } : {}) } })
  if (r.convert || r.posts) await retypeFromTalk(db, ws, task, r.convert ?? null, !!r.posts, userId, type === 'revise')
  if (type === 'revise' || isCommunitySweep(task)) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: task.id, ...(opts.via ? { hold: true } : {}) }, dedupeKey: `draft_task:${task.id}:${at}` })
  return { type, text: answerText, fact, revising: type === 'revise', ...(moved ? { moved } : {}) }
}

export async function rememberFact(db: Db, ws: Workspace, task: Task, noteId: string): Promise<string> {
  const [note] = await db.select().from(schema.taskNotes).where(and(eq(schema.taskNotes.id, noteId), eq(schema.taskNotes.taskId, task.id)))
  const line = note ? talkLine(note.text, note.byAgent) : null
  if (!note || line?.kind !== 'fact') throw new Error('Vorschlag nicht gefunden')
  if (!task.projectId) throw new Error('Aufgabe gehört zu keinem Projekt')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId))
  if (!project) throw new Error('Projekt nicht gefunden')
  const facts = projectFacts(project)
  const known = facts.known.some(f => f.toLowerCase() === line.text.toLowerCase()) ? facts.known : [...facts.known, line.text].slice(-30)
  await db.update(schema.projects).set({ setup: { ...project.setup, facts: { known, avoid: facts.avoid } } }).where(eq(schema.projects.id, project.id))
  await db.update(schema.taskNotes).set({ text: `${TALK_PREFIX.saved} ${line.text}` }).where(eq(schema.taskNotes.id, note.id))
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'user', action: 'facts_updated', detail: { title: project.name } })
  return line.text
}
