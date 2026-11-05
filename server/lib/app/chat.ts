import { and, desc, eq, ne } from 'drizzle-orm'
import { agentReady } from '../agent'
import { conversationMessages, findConversation, isBusy, QUEUED, queueUserMessage, runTurn } from '../chat'
import { config } from '../config'
import { schema } from '../db'
import type { MessageCard } from '../../db/schema'
import { actorOf, AppError, type AppCtx } from './core'
import { appSafeText } from './safe'
import { appApprovals, langOf, toApproval, weekStat, type AppApproval, type AppStat, type AppTodo, type Lang } from './views'

type Project = typeof schema.projects.$inferSelect

export { appSafeText }

export type AppCard =
  | { type: 'draft', approval: AppApproval }
  | { type: 'approvals', approvals: AppApproval[] }
  | { type: 'stat', stat: AppStat }
  | { type: 'tasks', items: AppTodo[] }
  | { type: 'link', title: string, url: string }

export interface AppChatMessage { id: string, role: 'user' | 'agent', text: string, cards: AppCard[], at: string, queued?: boolean }

// Was der Agent gerade tut, für die Statuszeile in der App.
const STATUS: Record<string, [string, string]> = {
  get_overview: ['Schaut in den Stand', 'Checking the status'],
  show_approvals: ['Schaut in die Freigaben', 'Checking approvals'],
  get_traffic: ['Schaut, woher die Besucher kommen', 'Checking where visitors come from'],
  list_tasks: ['Sucht Aufgaben', 'Looking for tasks'],
  create_task: ['Legt eine Aufgabe an', 'Creating a task'],
  update_task: ['Ändert die Aufgabe', 'Updating the task'],
  draft_from_link: ['Liest die Seite', 'Reading the page'],
  fetch_website: ['Liest die Website', 'Reading the website'],
  read_documents: ['Liest die Unterlagen', 'Reading the documents'],
  run_review: ['Prüft die Strategie', 'Reviewing the strategy'],
  analyze_and_propose: ['Analysiert', 'Analysing'],
  rethink_strategy: ['Denkt die Strategie neu', 'Rethinking the strategy'],
  read_help: ['Liest die Hilfe', 'Reading the help'],
  plan_release: ['Plant das Release', 'Planning the release'],
}

export function statusLabel(tool: string | null, l: Lang): string {
  const s = tool ? STATUS[tool] : null
  return s ? s[l === 'en' ? 1 : 0] : l === 'en' ? 'Thinking' : 'Denkt nach'
}

const shortDate = (d: string, l: Lang) => (l === 'en' ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : `${d.slice(8, 10)}.${d.slice(5, 7)}.`)

async function projectById(c: AppCtx, id: unknown): Promise<Project | null> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null
  const [p] = await c.db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, c.s.workspace.id)))
  if (!p || (!c.access.all && !c.access.ids.includes(p.id))) return null
  return p
}

// Karten des Web-Chats in Karten der App übersetzen: Entwürfe mit Text und Knöpfen, Zahlen, Aufgaben, Links.
export async function expandCards(c: AppCtx, cards: MessageCard[], fallback: Project | null): Promise<AppCard[]> {
  const l = langOf(c)
  const out: AppCard[] = []
  const tasks: AppTodo[] = []
  for (const card of cards) {
    const project = (await projectById(c, card.data?.projectId)) ?? fallback
    if (card.type === 'draft' && card.id) {
      const [row] = await c.db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
        .where(and(eq(schema.drafts.taskId, card.id), eq(schema.tasks.workspaceId, c.s.workspace.id), ne(schema.drafts.status, 'ersetzt')))
        .orderBy(desc(schema.drafts.version)).limit(1)
      if (row && (c.access.all || (row.task.projectId && c.access.ids.includes(row.task.projectId)))) out.push({ type: 'draft', approval: await toApproval(c, row.task, row.draft, project) })
    }
    else if (card.type === 'approvals') {
      const list = (await appApprovals(c, project)).filter(a => !a.byReviewer).sort((x, y) => Number(y.canApprove) - Number(x.canApprove)).slice(0, 5)
      if (list.length === 1) out.push({ type: 'draft', approval: list[0]! })
      else if (list.length) out.push({ type: 'approvals', approvals: list })
    }
    else if (card.type === 'goals') {
      if (!out.some(x => x.type === 'stat')) out.push({ type: 'stat', stat: await weekStat(c, project) })
    }
    else if (card.type === 'task' && card.id) {
      tasks.push({ id: card.id, taskId: card.id, title: String(card.data?.title ?? ''), minutes: 0, kind: 'task', detail: card.data?.date ? `${shortDate(String(card.data.date), l)}${card.data.time ? ` ${card.data.time}` : ''}` : null })
    }
    else if (card.type === 'strategy' && card.id) {
      out.push({ type: 'link', title: l === 'en' ? 'Open strategy' : 'Strategie öffnen', url: `${config.publicUrl}/p/${project?.slug ?? 'alle'}/strategie` })
    }
    else if (card.type === 'project' && card.data?.slug) {
      out.push({ type: 'link', title: String(card.data.name ?? card.data.slug), url: `${config.publicUrl}/p/${card.data.slug}` })
    }
  }
  if (tasks.length) out.push({ type: 'tasks', items: tasks.slice(0, 6) })
  return out
}

export async function appConversation(c: AppCtx, project: Project | null) {
  const conv = await findConversation(c.db, actorOf(c), project?.id ?? null, { create: true })
  if (!conv) throw new AppError(500, 'Gespräch nicht verfügbar')
  return conv
}

// Stand des Projekt-Chats (gleiches Gespräch wie im Web). Die App fragt nach, solange busy gilt.
export async function appChat(c: AppCtx, project: Project | null, limit = 40) {
  const l = langOf(c)
  const conv = await appConversation(c, project)
  const rows = await conversationMessages(c.db, conv.id, limit)
  const waiting = rows.filter(m => m.role === QUEUED)
  if (waiting.length && !isBusy(conv.id)) void runTurn(c.db, actorOf(c), conv.id).catch(err => console.error('[app-chat]', err))
  const busy = isBusy(conv.id) || waiting.length > 0
  const lastUser = rows.findLastIndex(m => m.role === 'user')
  const lastTool = busy ? rows.slice(lastUser + 1).findLast(m => m.role === 'assistant' && m.toolCalls?.length) : null
  const messages: AppChatMessage[] = []
  for (const m of [...rows.filter(m => m.role !== QUEUED), ...waiting]) {
    if (m.role === 'user' || m.role === QUEUED) messages.push({ id: m.id, role: 'user', text: m.content, cards: [], at: m.createdAt.toISOString(), queued: m.role === QUEUED })
    else if (m.role === 'assistant' && (m.content || m.cards.length)) {
      const cards = await expandCards(c, m.cards, project)
      if (m.content || cards.length) messages.push({ id: m.id, role: 'agent', text: appSafeText(m.content, l), cards, at: m.createdAt.toISOString() })
    }
  }
  return {
    conversationId: conv.id,
    busy,
    ready: agentReady(c.s.workspace),
    status: busy ? statusLabel(lastTool?.toolCalls?.at(-1)?.name ?? null, l) : null,
    messages,
  }
}

export async function appChatSend(c: AppCtx, project: Project | null, text: string) {
  if (!agentReady(c.s.workspace)) throw new AppError(409, 'Der Agent ist noch nicht eingerichtet. Bitte im Web unter Einstellungen den KI-Zugang eintragen.')
  const conv = await appConversation(c, project)
  const actor = actorOf(c)
  const m = await queueUserMessage(c.db, actor, conv, text)
  void runTurn(c.db, actor, conv.id).catch(err => console.error('[app-chat]', err))
  return { ok: true, conversationId: conv.id, ...m }
}
