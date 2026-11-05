import { agentReady } from '../agent'
import { cancelPosts } from '../publish'
import { talkOrQueue } from '../talk'
import { TransitionError, updateTask } from '../tasks'
import { applyDraftAction, DraftStateError } from '../../services/drafts'
import { approveAndSchedule } from '../../services/approve'
import { McpApproveError, stopRelease } from '../mcp-approve'
import { AppError, type AppCtx } from './core'
import { appSafeText, appText } from './safe'
import { langOf, loadDraft, loadTask, toApproval } from './views'

function conflict(err: unknown): never {
  if (err instanceof TransitionError || err instanceof DraftStateError) throw new AppError(409, err.message, err instanceof DraftStateError && err.newerId ? { newerId: err.newerId } : undefined)
  throw err
}

// Freigeben wie im Web. Mails sendet nur das Web (eigener Knopf nach Kontrolle).
export async function appApprove(c: AppCtx, draftId: string) {
  const { draft } = await loadDraft(c, draftId)
  if (draft.kind === 'mail') throw new AppError(409, 'Mails bitte im Web prüfen und senden.')
  try {
    const res = await approveAndSchedule(c.db, c.s.workspace, c.s.user.id, draftId, { via: 'app' })
    if (!res) throw new AppError(404, 'Entwurf nicht gefunden')
    const again = await loadDraft(c, draftId)
    return { ok: true, approval: await toApproval(c, again.task, again.draft, again.project) }
  }
  catch (err) {
    conflict(err)
  }
}

// Freigabe stoppen (z.B. vom KI-Prüfer freigegeben, noch nicht raus): Entwurf wieder offen, wie im Web.
export async function appStop(c: AppCtx, draftId: string) {
  await loadDraft(c, draftId)
  try {
    const r = await stopRelease(c.db, c.s.workspace, c.s.user.id, draftId)
    if (!r) throw new AppError(404, 'Entwurf nicht gefunden')
    const again = await loadDraft(c, draftId)
    return { ok: true, approval: await toApproval(c, again.task, again.draft, again.project) }
  }
  catch (err) {
    if (err instanceof McpApproveError) throw new AppError(err.status, err.message)
    throw err
  }
}

// Ablehnen wie im Web: dropTask = Aufgabe ganz weglassen, sonst schreibt der Agent neu.
export async function appReject(c: AppCtx, draftId: string, reason: string | null, dropTask: boolean | null = null) {
  await loadDraft(c, draftId)
  try {
    const res = await applyDraftAction(c.db, c.s.workspace, c.s.user.id, draftId, 'reject', { reason, dropTask })
    if (!res) throw new AppError(404, 'Entwurf nicht gefunden')
    await cancelPosts(c.db, res.taskId)
    return { ok: true, taskDropped: res.taskDropped }
  }
  catch (err) {
    conflict(err)
  }
}

// Änderungswunsch an den Agenten der Aufgabe (wie "Mit dem Agenten reden" im Web); er schreibt bei Bedarf eine neue Fassung.
export async function appChange(c: AppCtx, draftId: string, wish: string) {
  const { task } = await loadDraft(c, draftId)
  if (!agentReady(c.s.workspace)) throw new AppError(409, 'Der Agent ist noch nicht eingerichtet.')
  const res = await talkOrQueue(c.db, c.s.workspace, task, c.s.user.id, wish)
  if ('queued' in res && res.queued) return { ok: true, queued: true, text: null, revising: true }
  const r = res as { text: string, revising: boolean }
  return { ok: true, queued: false, text: appText(appSafeText(r.text, langOf(c)), langOf(c)), revising: r.revising }
}

export async function appSetDone(c: AppCtx, taskId: string, done: boolean) {
  const t = await loadTask(c, taskId)
  try {
    const row = await updateTask(c.db, t, { status: done ? 'erledigt' : 'geplant' }, { type: 'user', userId: c.s.user.id })
    return { ok: true, status: row.status }
  }
  catch (err) {
    conflict(err)
  }
}
