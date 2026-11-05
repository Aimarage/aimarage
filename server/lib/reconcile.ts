import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { plural } from '../../shared/utils/plural'
import { z } from 'zod'
import { WEIGHT_PER_WEEK } from '../../shared/utils/plan'
import { oldReleaseHit, releaseHitText, releaseRule, type ReleaseFocus } from '../../shared/utils/release-focus'
import { OBSOLETE_DROP, obsoleteReason, STALE_DROP, STALE_HINT, STALE_KEEP } from '../../shared/utils/stale'
import { SYSTEM, withRules } from '../prompts/de'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { chatJson, llmStatus, type ChatResult, type LlmConfig } from './llm'
import { matchChannel, oldChannelNames, remapTasks, settleChannelHints } from './channel-match'
import { closeConnectedSetups } from './plan-guard'
import { releaseExempt, releaseFocusFor } from './release-focus'
import { activeStrategy, type StrategyRow } from './strategy'
import { updateTask, type TaskRow } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export { STALE_DROP, STALE_HINT, STALE_KEEP }

const MAX_LLM = 40

export interface ReconcileDeps {
  llm: LlmConfig | null
  llmFetch?: FetchLike
  usage?: ChatResult[]
  log?: string[]
}

export interface ReconcileResult {
  dropped: string[]
  suggested: string[]
  checked: number
}

interface Candidate {
  task: TaskRow
  human: boolean
  text: string
}

const verdictSchema = z.object({
  decisions: z.array(z.object({ code: z.string(), action: z.enum(['keep', 'drop']).catch('keep'), reason: z.string().catch('') })).catch([]),
})

function clean(s: string, n: number): string {
  return s.replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().slice(0, n)
}

export function strategyBrief(st: Pick<StrategyRow, 'summary' | 'channels'>): string {
  const lines = st.channels.map(c => `- ${c.name} (${c.category}${c.active ? `, ca. ${WEIGHT_PER_WEEK[c.weight] ?? c.weight} pro Woche` : ', pausiert'})${c.places?.length ? `, Orte: ${c.places.join(', ')}` : ''}${c.topics?.length ? `, Themen: ${c.topics.join('; ')}` : ''}`)
  return [st.summary ? `Kurzfassung: ${st.summary}` : '', 'Kanäle:', ...lines].filter(Boolean).join('\n')
}

export function reconcilePrompt(i: { project: string, day: string, strategy: string, release: string, tasks: string[] }): string {
  return [
    `Projekt ${i.project}, heute ${i.day}. Die Strategie wurde geändert. Prüfe die offenen Aufgaben aus dem bisherigen Plan gegen die aktuelle Strategie.`,
    '',
    'AKTUELLE STRATEGIE',
    i.strategy,
    i.release ? `\n${i.release}` : '',
    '',
    'OFFENE AUFGABEN (Code | Fällig | Status | Kanal | Titel | Beschreibung)',
    ...i.tasks,
    '',
    'Entscheide je Aufgabe: "keep" (passt weiter) oder "drop" (verwerfen). drop nur, wenn klar ist, dass sie nicht mehr passt:',
    '- Kanal oder Ort steht nicht mehr in der Strategie',
    '- Thema widerspricht den Schwerpunkten oder dem aktuellen Release',
    '- doppelt (gleiche Sache wie eine andere offene Aufgabe, dann die spätere verwerfen)',
    '- Anlass vorbei (Termin, Aktion oder Ereignis ist vorüber)',
    '- schon erledigt (laut Strategie oder Beschreibung bereits vorhanden)',
    'Im Zweifel keep. Pflege- und Einrichtungs-Aufgaben nur verwerfen, wenn sie eindeutig erledigt oder gegenstandslos sind.',
    'Grund kurz, ein Satz auf Deutsch, normale Bindestriche.',
    '',
    'Antworte nur mit JSON: {"decisions":[{"code":"...","action":"keep|drop","reason":"..."}]}',
  ].filter(s => s !== '').join('\n')
}

function taskLine(t: TaskRow): string {
  return [t.code, t.dueDate ?? '-', t.status, clean(t.channel ?? t.strategyChannel ?? '-', 60), clean(t.title, 140), clean(t.description ?? '', 200) || '-'].join(' | ')
}

// Offene Aufgaben eines Projekts gegen die aktive Strategie abgleichen.
// Ohne menschliche Spuren wird verworfen, sonst nur ein Hinweis zum Verwerfen in die Aufgabe gelegt.
// Inhalte (Artikel) mit fertigem Entwurf werden nie automatisch verworfen.
export async function reconcileProject(db: DbOrTx, ws: Workspace, project: Project, deps: ReconcileDeps): Promise<ReconcileResult> {
  const out: ReconcileResult = { dropped: [], suggested: [], checked: 0 }
  if (ws.settings?.agentEnabled === false) return out
  const st = await activeStrategy(db, project.id)
  if (!st) return out
  const day = today(ws.timezone)
  const since = st.decidedAt ?? st.createdAt
  const oldNames = await oldChannelNames(db, project.id)
  const remapped = await remapTasks(db, project.id, st.channels, oldNames)
  await settleChannelHints(db, project.id, st.channels)
  if (remapped.length) deps.log?.push(`${remapped.length} Aufgaben auf den passenden neuen Kanal umgehängt: ${remapped.slice(0, 20).join(', ')}`)
  const rows = await db.select({ t: schema.tasks, recActive: schema.recurrences.active }).from(schema.tasks)
    .leftJoin(schema.recurrences, eq(schema.recurrences.id, schema.tasks.recurrenceId))
    .where(and(
      eq(schema.tasks.projectId, project.id),
      inArray(schema.tasks.status, ['geplant', 'entwurf_fertig']),
      sql`coalesce(${schema.tasks.origin}, '') not like 'seo%'`,
      sql`coalesce(${schema.tasks.origin}, '') not like 'setup:%'`,
    ))
    .orderBy(sql`${schema.tasks.dueDate} asc nulls last`, asc(schema.tasks.code))
    .limit(150)
  const tasks = rows.filter(r => !r.recActive).map(r => r.t)
  if (!tasks.length) return out
  const ids = tasks.map(t => t.id)
  const notes = await db.select({ taskId: schema.taskNotes.taskId, text: schema.taskNotes.text, byAgent: schema.taskNotes.byAgent, createdAt: schema.taskNotes.createdAt }).from(schema.taskNotes).where(inArray(schema.taskNotes.taskId, ids))
  const drafts = await db.select({ taskId: schema.drafts.taskId, byAgent: schema.drafts.byAgent, status: schema.drafts.status, subject: schema.drafts.subject, body: schema.drafts.body, platforms: schema.drafts.platforms }).from(schema.drafts).where(inArray(schema.drafts.taskId, ids))
  const touched = new Set((await db.select({ taskId: schema.activity.taskId }).from(schema.activity).where(and(inArray(schema.activity.taskId, ids), inArray(schema.activity.actor, ['user', 'mcp'])))).map(a => a.taskId))
  const focus: ReleaseFocus | null = await releaseFocusFor(db, project.id, day)
  const byKey = new Map(st.channels.map(c => [c.key, c]))

  const verdicts = new Map<string, string>()
  const open: Candidate[] = []
  for (const t of tasks) {
    const tn = notes.filter(n => n.taskId === t.id)
    if (tn.some(n => (n.text.startsWith(STALE_HINT) || n.text.startsWith(STALE_KEEP)) && n.createdAt >= since)) continue
    const td = drafts.filter(d => d.taskId === t.id)
    const finishedContent = (t.category === 'content' || t.draftKind === 'article') && (t.status === 'entwurf_fertig' || td.some(d => d.status === 'offen'))
    const human = !!t.createdByUserId || t.releaseOk || t.milestone || finishedContent || tn.some(n => !n.byAgent) || td.some(d => !d.byAgent || d.status === 'freigegeben') || touched.has(t.id)
    const text = [t.title, t.description ?? '', ...td.filter(d => d.status === 'offen').flatMap(d => [d.subject ?? '', d.body])].join('\n')
    out.checked++
    if (t.strategyChannel) {
      const c = byKey.get(t.strategyChannel)
      const platforms = td.find(d => d.status === 'offen' || d.status === 'freigegeben')?.platforms ?? []
      // Kanal umbenannt oder neu geschnitten, Plattform bzw. Inhaltsart gibt es aber weiter: kein Hinweis.
      const covered = !c && matchChannel(t, platforms, st.channels, oldNames.get(t.strategyChannel) ?? t.channel).covered
      if ((!c && !covered) || (c && !c.active)) {
        verdicts.set(t.id, c ? `Kanal "${c.name}" ist in der Strategie pausiert.` : `Kanal "${oldNames.get(t.strategyChannel) ?? t.channel ?? t.strategyChannel}" steht nicht mehr in der Strategie.`)
        open.push({ task: t, human, text })
        continue
      }
    }
    const hit = oldReleaseHit(text, focus)
    if (hit && focus && !await releaseExempt(db, t, focus)) {
      verdicts.set(t.id, `Nennt ein älteres Release (${releaseHitText(hit, focus)}).`)
      open.push({ task: t, human, text })
      continue
    }
    open.push({ task: t, human, text })
  }

  const ask = open.filter(c => !verdicts.has(c.task.id)).slice(0, MAX_LLM)
  if (ask.length && deps.llm && llmStatus(deps.llm).configured) {
    try {
      const prompt = reconcilePrompt({ project: project.name, day, strategy: strategyBrief(st), release: releaseRule(focus), tasks: ask.map(c => taskLine(c.task)) })
      deps.log?.push(prompt)
      const { data, usage } = await chatJson(deps.llm, { maxTokens: 2000, messages: [{ role: 'system', content: withRules(SYSTEM, project.rules) }, { role: 'user', content: prompt }] }, verdictSchema, deps.llmFetch)
      deps.usage?.push(...usage)
      const byCode = new Map(ask.map(c => [c.task.code, c.task.id]))
      for (const d of data.decisions) {
        const id = byCode.get(d.code.trim())
        if (id && d.action === 'drop') verdicts.set(id, clean(d.reason, 200) || 'Passt nicht mehr zur aktuellen Strategie.')
      }
    }
    catch (err) {
      deps.log?.push(`Abgleich ohne KI: ${(err as Error).message}`)
    }
  }

  for (const c of open) {
    const reason = verdicts.get(c.task.id)
    if (!reason) continue
    if (c.human) {
      await db.insert(schema.taskNotes).values({ taskId: c.task.id, byAgent: true, text: `${STALE_HINT} ${reason} Verwerfen?`, createdAt: now() })
      out.suggested.push(c.task.code)
      continue
    }
    await updateTask(db, c.task, { status: 'verworfen' }, { type: 'agent' })
    await db.insert(schema.taskNotes).values({ taskId: c.task.id, byAgent: true, text: `${STALE_DROP} ${reason} Zurückholen: Status auf "geplant" setzen.`, createdAt: now() })
    out.dropped.push(c.task.code)
  }
  if (out.dropped.length) await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'tasks_reconciled', detail: { title: project.name, count: out.dropped.length, codes: out.dropped.slice(0, 20) }, at: now() })
  if (out.suggested.length) await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'tasks_stale_suggested', detail: { title: project.name, count: out.suggested.length, codes: out.suggested.slice(0, 20) }, at: now() })
  return out
}

// Abgleich für alle Projekte, ohne KI nur die festen Regeln (Kanal weg, älteres Release, Konto verbunden).
export async function reconcileAll(db: DbOrTx, ws: Workspace, deps: ReconcileDeps, projectIds?: string[]): Promise<ReconcileResult> {
  const total: ReconcileResult = { dropped: [], suggested: [], checked: 0 }
  await closeConnectedSetups(db, ws)
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), sql`${schema.projects.archivedAt} is null`, projectIds ? inArray(schema.projects.id, projectIds.length ? projectIds : ['00000000-0000-0000-0000-000000000000']) : undefined))
  for (const p of projects) {
    const r = await reconcileProject(db, ws, p, deps)
    total.dropped.push(...r.dropped)
    total.suggested.push(...r.suggested)
    total.checked += r.checked
  }
  return total
}

export async function reconcileNews(db: DbOrTx, workspaceId: string, from: Date): Promise<string[]> {
  const rows = await db.select({ action: schema.activity.action, detail: schema.activity.detail }).from(schema.activity).where(and(eq(schema.activity.workspaceId, workspaceId), inArray(schema.activity.action, ['tasks_reconciled', 'tasks_stale_suggested']), gte(schema.activity.createdAt, from)))
  return rows.map(r => r.action === 'tasks_reconciled'
    ? `${String(r.detail.title ?? '')}: ${Number(r.detail.count ?? 0)} veraltete Aufgaben nach Strategie-Änderung entfernt`
    : `${String(r.detail.title ?? '')}: ${plural(Number(r.detail.count ?? 0), 'Aufgabe passt', 'Aufgaben passen')} evtl. nicht mehr zur Strategie (Hinweis in der Aufgabe, verwerfen oder behalten)`)
}

// Letzter Entwurf vom Menschen verworfen und der Grund macht die Aufgabe überflüssig (doppelt, entfällt ...):
// Aufgabe schließen statt neu zu entwerfen. Hat jemand sie danach wieder geöffnet (spätere Notiz), bleibt sie offen.
export async function closeIfRejectedObsolete(db: DbOrTx, ws: Workspace, task: Pick<TaskRow, 'id' | 'projectId' | 'title' | 'status'> & Partial<TaskRow>): Promise<boolean> {
  const [last] = await db.select({ version: schema.drafts.version, status: schema.drafts.status }).from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
  if (!last || last.status !== 'verworfen') return false
  const notes = await db.select({ text: schema.taskNotes.text, userId: schema.taskNotes.userId, byAgent: schema.taskNotes.byAgent, createdAt: schema.taskNotes.createdAt }).from(schema.taskNotes)
    .where(eq(schema.taskNotes.taskId, task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(30)
  const prefix = `Entwurf v${last.version} verworfen`
  const idx = notes.findIndex(n => !n.byAgent && n.text.startsWith(prefix))
  if (idx < 0) return false
  const reason = notes[idx]!.text.slice(prefix.length).replace(/^[:,]\s*/, '').trim()
  if (!obsoleteReason(reason) && !/Aufgabe entfällt/.test(reason)) return false
  if (notes.slice(0, idx).some(n => n.text.startsWith(OBSOLETE_DROP) || !n.byAgent)) return false
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  if (!row || row.status === 'verworfen') return false
  await updateTask(db, row, { status: 'verworfen' }, { type: 'agent' })
  await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `${OBSOLETE_DROP} ${reason.slice(0, 200)} Zurückholen: Status auf "geplant" setzen.`, createdAt: now() })
  await logActivity(db, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'task_obsolete', detail: { title: task.title }, at: now() })
  return true
}
