import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import nodemailer from 'nodemailer'
import type { DbOrTx } from './db'
import { enqueueJob } from './jobs'
import { isSystemMailTemplate, renderSystemMail, type RenderedMail, type SystemMailTemplate, type SystemMailVars } from '../mail-templates'

export type SystemMailDelivery = 'smtp' | 'dev-mailbox' | 'log'

export interface SystemMailMessage {
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html: string
  headers: Record<string, string>
}

export interface SystemMailTransport {
  sendMail: (msg: SystemMailMessage) => Promise<unknown>
}

export class SystemMailError extends Error {}

function env(name: string, fallback = ''): string {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

export const systemMailConfig = {
  get smtpUrl() {
    return env('SMTP_URL')
  },
  get from() {
    if (env('MAIL_FROM')) return env('MAIL_FROM')
    if (['1', 'true'].includes(env('HOSTED').toLowerCase())) return 'Aimarage <noreply@aimarage.com>'
    let host = 'localhost'
    try {
      host = new URL(env('APP_URL', 'http://localhost')).hostname
    }
    catch {}
    return `Aimarage <noreply@${host}>`
  },
  get replyTo() {
    return env('MAIL_REPLY_TO')
  },
  get devMailbox() {
    return ['1', 'true'].includes(env('DEV_MAILBOX').toLowerCase())
  },
  get devMailboxDir() {
    return resolve(env('DEV_MAILBOX_DIR', './data/dev-mailbox'))
  },
}

const TEST_DOMAIN = /@([^@]+\.)?(local|localhost|test|invalid|example|example\.(com|org|net))$/i

export function isTestMailAddress(to: string): boolean {
  return TEST_DOMAIN.test(to.trim())
}

export function systemMailRoute(to: string, opts: { smtp: boolean, devMailbox: boolean }): { smtp: boolean, mailbox: boolean, log: boolean } {
  const smtp = opts.smtp && !isTestMailAddress(to)
  const mailbox = opts.devMailbox
  return { smtp, mailbox, log: !smtp && !mailbox }
}

let transport: SystemMailTransport | null = null
let transportOverride: SystemMailTransport | null = null

export function setSystemMailTransport(t: SystemMailTransport | null): void {
  transportOverride = t
}

function smtpTransport(): SystemMailTransport | null {
  if (transportOverride) return transportOverride
  const url = systemMailConfig.smtpUrl
  if (!url) return null
  transport ??= nodemailer.createTransport(url)
  return transport
}

async function storeDev(msg: SystemMailMessage, alsoSmtp: boolean): Promise<void> {
  const dir = systemMailConfig.devMailboxDir
  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  const stored = { ...msg, id, channel: 'email', sentAt: new Date().toISOString(), headers: { ...msg.headers, ...(alsoSmtp ? { 'X-Aimarage-Copy': 'also sent by SMTP' } : {}) } }
  await writeFile(join(dir, `${Date.now()}-${id}.json`), JSON.stringify(stored, null, 2))
  console.log(`[dev-mailbox] ${msg.to}: ${msg.subject}`)
}

function logMail(msg: SystemMailMessage): void {
  console.log(`[system-mail] kein SMTP_URL gesetzt, Mail nur im Log\nAn: ${msg.to}\nBetreff: ${msg.subject}\n\n${msg.text}`)
}

const ADDRESS = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/

export async function sendSystemMail<K extends SystemMailTemplate>(to: string, template: K, vars: SystemMailVars[K], locale: string | null | undefined = 'de', opts: DeliverOptions = {}): Promise<SystemMailDelivery> {
  if (!isSystemMailTemplate(template)) throw new SystemMailError(`Unbekannte Mailvorlage: ${String(template)}`)
  return deliverSystemMail(to, template, renderSystemMail(template, vars, locale), opts)
}

export interface DeliverOptions {
  fromName?: string | null
  replyTo?: string | null
  // Zusätzliche Header, z.B. List-Unsubscribe der Tagesmail.
  headers?: Record<string, string>
}

// Absendername austauschen, die Adresse aus MAIL_FROM bleibt (z.B. noreply@aimarage.com).
export function fromWithName(from: string, name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!clean) return from
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from.trim()
  return `"${clean}" <${addr}>`
}

const EXTRA_HEADERS = new Set(['list-unsubscribe', 'list-unsubscribe-post'])

function safeHeaders(h: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) if (EXTRA_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) out[k] = v.slice(0, 500)
  return out
}

// Versand einer fertig gerenderten Mail, z.B. für Vorlagen aus Erweiterungen.
export async function deliverSystemMail(to: string, template: string, r: RenderedMail, opts: DeliverOptions = {}): Promise<SystemMailDelivery> {
  const addr = to.trim()
  if (!ADDRESS.test(addr) || addr.length > 254) throw new SystemMailError('Ungültige Empfängeradresse')
  const ownReply = opts.replyTo?.trim()
  const replyTo = ownReply && ADDRESS.test(ownReply) ? ownReply : systemMailConfig.replyTo
  const msg: SystemMailMessage = {
    from: fromWithName(systemMailConfig.from, opts.fromName),
    to: addr,
    ...(replyTo ? { replyTo } : {}),
    subject: r.subject,
    text: r.text,
    html: r.html,
    headers: { ...safeHeaders(opts.headers), 'X-Aimarage-Template': template, 'Auto-Submitted': 'auto-generated' },
  }
  const t = smtpTransport()
  const route = systemMailRoute(addr, { smtp: !!t, devMailbox: systemMailConfig.devMailbox })
  if (route.smtp && t) {
    try {
      await t.sendMail(msg)
    }
    catch (err) {
      throw new SystemMailError(`SMTP fehlgeschlagen: ${(err as Error).message}`)
    }
  }
  if (route.mailbox) await storeDev(msg, route.smtp)
  if (route.log) logMail(msg)
  return route.smtp ? 'smtp' : route.mailbox ? 'dev-mailbox' : 'log'
}

export async function queueSystemMail<K extends SystemMailTemplate>(db: DbOrTx, to: string, template: K, vars: SystemMailVars[K], locale: string | null | undefined = 'de', opts: { workspaceId?: string | null, dedupeKey?: string, runAt?: Date, maxAttempts?: number, headers?: Record<string, string> } = {}): Promise<boolean> {
  return enqueueJob(db, 'system_mail', {
    workspaceId: opts.workspaceId ?? null,
    payload: { to, template, vars: vars as unknown as Record<string, unknown>, locale: locale ?? 'de', ...(opts.headers ? { headers: opts.headers } : {}) },
    dedupeKey: opts.dedupeKey,
    runAt: opts.runAt,
    maxAttempts: opts.maxAttempts ?? 5,
  })
}

export async function runSystemMailJob(payload: Record<string, unknown>): Promise<SystemMailDelivery> {
  const template = String(payload.template ?? '')
  if (!isSystemMailTemplate(template)) throw new SystemMailError(`Unbekannte Mailvorlage: ${template}`)
  const vars = (payload.vars && typeof payload.vars === 'object' ? payload.vars : {}) as SystemMailVars[typeof template]
  const headers = payload.headers && typeof payload.headers === 'object' ? safeHeaders(payload.headers as Record<string, unknown>) : undefined
  return sendSystemMail(String(payload.to ?? ''), template, vars, payload.locale ? String(payload.locale) : 'de', headers ? { headers } : {})
}
