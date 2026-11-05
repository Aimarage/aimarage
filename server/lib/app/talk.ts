import { desc, eq } from 'drizzle-orm'
import { isRedditNote } from '../../../shared/utils/reddit'
import { TALK_PREFIX, talkLine } from '../../../shared/utils/talk'
import { agentReady } from '../agent'
import { now } from '../clock'
import { schema } from '../db'
import { TALK_FAILED, taskTalk, talkOrQueue } from '../talk'
import { AppError, type AppCtx } from './core'
import { appSafeText, appText } from './safe'
import { langOf, loadDraft, toApproval, type AppApproval } from './views'

type Task = typeof schema.tasks.$inferSelect
type Project = typeof schema.projects.$inferSelect

export interface AppTalkLine {
  id: string
  who: 'agent' | 'user'
  kind: 'question' | 'ask' | 'answer' | 'revise' | 'message' | 'queued' | 'version' | 'note'
  text: string
  at: string
}

export interface AppTalk {
  lines: AppTalkLine[]
  busy: boolean
  writing: boolean
  canTalk: boolean
  approval: AppApproval | null
}

// Aufgaben, deren Nachricht aus der App gerade im Hintergrund beantwortet wird.
const sending = new Set<string>()

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s)

// Aufgaben-Chat eines Entwurfs wie im Web, dazu knappe Agent-Notizen und die aktuelle Fassung.
export async function appTalk(c: AppCtx, draftId: string): Promise<AppTalk> {
  const { task, project } = await loadDraft(c, draftId)
  return talkView(c, task, project)
}

async function talkView(c: AppCtx, task: Task, project: Project | null): Promise<AppTalk> {
  const t = await taskTalk(c.db, c.s.workspace, task)
  const notes = await c.db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(80)
  const extra: AppTalkLine[] = notes
    .filter(n => !talkLine(n.text, n.byAgent) && !isRedditNote(n.text) && (n.byAgent || /^Von Claude/.test(n.text)))
    .map(n => ({ id: n.id, who: 'agent', kind: 'note', text: clip(n.text.replace(/\s+/g, ' ').trim(), 280), at: n.createdAt.toISOString() }))
  const talk = t.lines.filter(l => l.kind !== 'fact' && l.kind !== 'saved') as AppTalkLine[]
  const lang = langOf(c)
  const lines = [...talk, ...extra].map(x => (x.who === 'agent' ? { ...x, text: appText(appSafeText(x.text, lang), lang) } : x)).sort((a, b) => a.at.localeCompare(b.at)).slice(-30)
  const [d] = await c.db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
  let approval: AppApproval | null = null
  if (d) {
    const info = notes.some(n => n.byAgent && n.text.startsWith('Info nötig:') && n.createdAt.getTime() >= d.createdAt.getTime() - 2000)
    approval = await toApproval(c, task, d, project, info ? { canApprove: false } : {})
  }
  return { lines, busy: t.busy || sending.has(task.id) || talk.some(l => l.kind === 'queued'), writing: t.writing, canTalk: t.canTalk, approval }
}

// Nachricht in den Aufgaben-Chat. Die Antwort läuft im Hintergrund, die App fragt nach (GET talk).
export async function appTalkSend(c: AppCtx, draftId: string, text: string, fetchImpl?: typeof fetch): Promise<AppTalk> {
  const { task, project } = await loadDraft(c, draftId)
  if (!agentReady(c.s.workspace)) throw new AppError(409, 'Der Agent ist noch nicht eingerichtet.')
  const t = await taskTalk(c.db, c.s.workspace, task)
  if (!t.canTalk) throw new AppError(409, 'Diese Aufgabe ist schon abgeschlossen.')
  const db = c.db
  const userId = c.s.user.id
  sending.add(task.id)
  const run = talkOrQueue(db, c.s.workspace, task, userId, text, fetchImpl)
    .catch(async (err) => {
      console.error('[app-talk]', task.code, err)
      const at = now().getTime()
      await db.insert(schema.taskNotes).values([
        { taskId: task.id, userId, text: `${TALK_PREFIX.user} ${text.trim().slice(0, 4000)}`, createdAt: new Date(at) },
        { taskId: task.id, byAgent: true, text: `${TALK_PREFIX.answer} ${TALK_FAILED}`, createdAt: new Date(at + 1) },
      ]).catch(e => console.error('[app-talk]', e))
    })
    .finally(() => sending.delete(task.id))
  await Promise.race([run, new Promise(r => setTimeout(r, 400))])
  return talkView(c, task, project)
}
