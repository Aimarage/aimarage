import type { SessionInfo } from './auth'
import type { Db, DbOrTx } from './db'
import type { schema } from './db'
import type { JobRow } from './jobs'

type Workspace = typeof schema.workspaces.$inferSelect

export interface LimitRequest {
  workspaceId: string
  kind: string
  amount?: number
}

export interface ExtensionSchedule {
  type: string
  time: string
  weekday?: number
  weekly?: boolean
}

// Fehler für die Betriebsüberwachung (fehlgeschlagene Jobs, Systemmails). Die Erweiterung entscheidet, was damit passiert.
export interface ErrorReport {
  source: 'job' | 'mail' | 'server' | 'webhook' | 'service'
  message: string
  detail?: Record<string, unknown>
}

// Eigene Marke eines Workspace (White-Label): Kundenlinks, Mails an Kunden und optional die App.
export interface WorkspaceBrand {
  name: string
  logoUrl: string | null
  accent: string | null
  marker: string | null
  font: string | null
  replyTo: string | null
  inApp: boolean
}

// Sperre vor der Nutzung (z.B. neue Fassung der AGB annehmen): API-Aufrufe antworten mit 409 und Hinweis, der Browser leitet auf path um.
export interface AccessGate {
  code: string
  path: string
  // Pfade, die trotz Sperre gehen (Präfixe), z.B. die Seite zum Annehmen.
  allow: string[]
  message: { de: string, en: string }
  // Hinweis für die iPhone-App (dort kann nicht angenommen werden).
  appMessage: { de: string, en: string }
}

export interface Extension {
  name: string
  limits?: { check: (db: DbOrTx, req: LimitRequest) => Promise<void> }
  onSignupVerified?: (db: Db, input: { email: string, userId: string | null }) => Promise<void>
  onWorkspaceCreated?: (db: Db, input: { workspaceId: string, userId: string }) => Promise<void>
  onUserLoggedIn?: (db: Db, input: { userId: string, workspaceId: string }) => Promise<void>
  jobHandlers?: Record<string, (db: Db, job: JobRow) => Promise<void>>
  extraSchedule?: (ws: Workspace) => ExtensionSchedule[]
  bootExtras?: (db: Db, s: SessionInfo) => Promise<Record<string, unknown>>
  systemSchedule?: () => ExtensionSchedule[]
  onError?: (report: ErrorReport) => Promise<void> | void
  brand?: (db: DbOrTx, workspaceId: string) => Promise<WorkspaceBrand | null>
  // Darf der Workspace trotz LLM_SETTINGS_LOCKED einen eigenen KI-Schlüssel nutzen? Synchron, nur aus dem Workspace-Datensatz.
  ownLlm?: (ws: Workspace) => boolean
  accessGate?: (db: DbOrTx, s: SessionInfo) => Promise<AccessGate | null>
  // Arbeitsbereich löschen (z.B. beim Löschen des Kontos des alleinigen Mitglieds) mit dem Ablauf der Erweiterung.
  // true: erledigt (z.B. vorgemerkt mit Frist), sonst löscht der Kern sofort.
  deleteWorkspace?: (db: Db, input: { workspaceId: string, notify: boolean }) => Promise<boolean>
}

const g = globalThis as unknown as { __maExtensions?: Extension[] }

function list(): Extension[] {
  g.__maExtensions ??= []
  return g.__maExtensions
}

export function registerExtension(ext: Extension): void {
  const all = list()
  const i = all.findIndex(e => e.name === ext.name)
  if (i >= 0) all[i] = ext
  else all.push(ext)
}

export function extensions(): readonly Extension[] {
  return list()
}

export function resetExtensions(): void {
  g.__maExtensions = []
}

export async function checkLimit(db: DbOrTx, req: LimitRequest): Promise<void> {
  for (const e of list()) await e.limits?.check(db, req)
}

export async function emitSignupVerified(db: Db, input: { email: string, userId: string | null }): Promise<void> {
  for (const e of list()) await e.onSignupVerified?.(db, input)
}

export async function emitWorkspaceCreated(db: Db, input: { workspaceId: string, userId: string }): Promise<void> {
  for (const e of list()) await e.onWorkspaceCreated?.(db, input)
}

export async function emitUserLoggedIn(db: Db, input: { userId: string, workspaceId: string }): Promise<void> {
  for (const e of list()) await e.onUserLoggedIn?.(db, input)
}

export async function extensionDeleteWorkspace(db: Db, input: { workspaceId: string, notify: boolean }): Promise<boolean> {
  for (const e of list()) if (e.deleteWorkspace && await e.deleteWorkspace(db, input)) return true
  return false
}

export function extensionJobHandler(type: string): ((db: Db, job: JobRow) => Promise<void>) | null {
  for (const e of list()) {
    const h = e.jobHandlers?.[type]
    if (h) return h
  }
  return null
}

export function extensionSchedule(ws: Workspace): ExtensionSchedule[] {
  return list().flatMap(e => e.extraSchedule?.(ws) ?? [])
}

export function extensionSystemSchedule(): ExtensionSchedule[] {
  return list().flatMap(e => e.systemSchedule?.() ?? [])
}

export async function bootExtras(db: Db, s: SessionInfo): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const e of list()) if (e.bootExtras) Object.assign(out, await e.bootExtras(db, s))
  return out
}

// Nie werfen: Überwachung darf den eigentlichen Ablauf nicht stören.
export async function reportError(report: ErrorReport): Promise<void> {
  for (const e of list()) {
    try {
      await e.onError?.(report)
    }
    catch (err) {
      console.error(`[extensions] Fehlerbericht an ${e.name} fehlgeschlagen: ${(err as Error).message}`)
    }
  }
}

// Erste Marke, die eine Erweiterung liefert. Fehler zählen als "keine Marke".
export async function workspaceBrand(db: DbOrTx, workspaceId: string): Promise<WorkspaceBrand | null> {
  for (const e of list()) {
    if (!e.brand) continue
    try {
      const b = await e.brand(db, workspaceId)
      if (b) return b
    }
    catch (err) {
      console.error(`[extensions] Marke von ${e.name} fehlgeschlagen: ${(err as Error).message}`)
    }
  }
  return null
}

// Erste Sperre einer Erweiterung. Fehler sperren nicht (sonst käme niemand mehr hinein).
export async function accessGate(db: DbOrTx, s: SessionInfo): Promise<AccessGate | null> {
  for (const e of list()) {
    if (!e.accessGate) continue
    try {
      const g = await e.accessGate(db, s)
      if (g) return g
    }
    catch (err) {
      console.error(`[extensions] Zugangssperre von ${e.name} fehlgeschlagen: ${(err as Error).message}`)
    }
  }
  return null
}

export function gateAllows(gate: AccessGate, path: string): boolean {
  const p = path.split('?')[0] ?? ''
  return gate.allow.some(a => p === a || p.startsWith(a.endsWith('/') ? a : `${a}/`))
}

export function extensionAllowsOwnLlm(ws: Workspace): boolean {
  return list().some((e) => {
    try {
      return e.ownLlm?.(ws) === true
    }
    catch {
      return false
    }
  })
}
