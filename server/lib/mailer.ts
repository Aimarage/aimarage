import { randomUUID } from 'node:crypto'
import type { ProjectMail } from '../db/schema'
import { assertMailServer } from './site'

export interface MailPasswords {
  imap: string
  smtp: string
}

export interface FetchedMail {
  uid: number
  source: Buffer
}

export interface OutMessage {
  from: string
  to: string
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string | null
  // Text von der KI erzeugt: Kopfzeile AI-Disclosure (maschinenlesbar, Art. 50 Abs. 2 KI-VO)
  aiGenerated?: boolean
}

export interface MailBackend {
  verifyImap: (cfg: ProjectMail['imap'], pass: string) => Promise<void>
  verifySmtp: (cfg: ProjectMail['smtp'], pass: string) => Promise<void>
  fetchNew: (cfg: ProjectMail['imap'], pass: string, since: { uid: number | null, uidValidity: string | null, sinceDate: Date }) => Promise<{ uidValidity: string, messages: FetchedMail[] }>
  send: (cfg: ProjectMail['smtp'], pass: string, msg: OutMessage) => Promise<{ messageId: string, raw: Buffer }>
  appendSent: (cfg: ProjectMail['imap'], pass: string, raw: Buffer) => Promise<void>
  markSeen: (cfg: ProjectMail['imap'], pass: string, uids: number[], uidValidity: string) => Promise<void>
}

const MAX_FETCH = 50

async function imapClient(cfg: ProjectMail['imap'], pass: string) {
  await assertMailServer('imap', cfg.host, cfg.port)
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass }, logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 })
  await client.connect()
  return client
}

async function smtpTransport(cfg: ProjectMail['smtp'], pass: string) {
  await assertMailServer('smtp', cfg.host, cfg.port)
  const nodemailer = (await import('nodemailer')).default
  return nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, requireTLS: !cfg.secure && cfg.port === 587, auth: { user: cfg.user, pass }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 })
}

export const realBackend: MailBackend = {
  async verifyImap(cfg, pass) {
    const c = await imapClient(cfg, pass)
    await c.logout().catch(() => {})
  },
  async verifySmtp(cfg, pass) {
    const t = await smtpTransport(cfg, pass)
    try {
      await t.verify()
    }
    finally {
      t.close()
    }
  },
  async fetchNew(cfg, pass, since) {
    const c = await imapClient(cfg, pass)
    const out: FetchedMail[] = []
    let uidValidity = ''
    try {
      const lock = await c.getMailboxLock('INBOX', { readOnly: true })
      try {
        const box = c.mailbox
        uidValidity = box ? String(box.uidValidity) : ''
        const sameBox = since.uid && since.uidValidity === uidValidity
        const range = sameBox ? { uid: `${since.uid! + 1}:*` } : { since: since.sinceDate }
        const uids = ((await c.search(range, { uid: true })) || []).filter(u => !sameBox || u > since.uid!).slice(-MAX_FETCH)
        if (uids.length) {
          for await (const m of c.fetch(uids, { uid: true, source: true }, { uid: true })) {
            if (m.source) out.push({ uid: m.uid, source: m.source })
          }
        }
      }
      finally {
        lock.release()
      }
    }
    finally {
      await c.logout().catch(() => {})
    }
    return { uidValidity, messages: out.sort((a, b) => a.uid - b.uid) }
  },
  async send(cfg, pass, msg) {
    const t = await smtpTransport(cfg, pass)
    try {
      const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default
      const domain = (/@([^>\s]+)/.exec(msg.from)?.[1] ?? 'localhost').toLowerCase()
      const messageId = `<${randomUUID()}@${domain}>`
      const options = { from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, messageId, ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo, references: msg.references ?? msg.inReplyTo } : {}), ...(msg.aiGenerated ? { headers: { 'AI-Disclosure': 'mode=ai-originated' } } : {}) }
      const raw = await new MailComposer(options).compile().build()
      await t.sendMail({ envelope: { from: addressOf(msg.from), to: [addressOf(msg.to)] }, raw })
      return { messageId, raw }
    }
    finally {
      t.close()
    }
  },
  async appendSent(cfg, pass, raw) {
    const c = await imapClient(cfg, pass)
    try {
      const sent = pickSentFolder(await c.list())
      if (!sent) throw new Error('Kein Gesendet-Ordner im Postfach gefunden')
      await c.append(sent, raw, ['\\Seen'])
    }
    finally {
      await c.logout().catch(() => {})
    }
  },
  // Setzt nur das Flag \Seen, nie löschen oder verschieben. Bei geänderter UIDVALIDITY nichts tun.
  async markSeen(cfg, pass, uids, uidValidity) {
    if (!uids.length) return
    const c = await imapClient(cfg, pass)
    try {
      const lock = await c.getMailboxLock('INBOX')
      try {
        const box = c.mailbox
        if (!box || String(box.uidValidity) !== uidValidity) return
        await c.messageFlagsAdd(uids.map(String).join(','), ['\\Seen'], { uid: true })
      }
      finally {
        lock.release()
      }
    }
    finally {
      await c.logout().catch(() => {})
    }
  },
}

const SENT_NAMES = ['sent', 'gesendet', 'inbox.sent', 'inbox/sent', 'inbox.gesendet', 'inbox/gesendet', 'sent items', 'sent messages', 'sent mail', 'gesendete objekte', 'gesendete elemente', 'gesendete nachrichten']

// Gesendet-Ordner: zuerst SPECIAL-USE \Sent, dann bekannte Namen (Pfad oder Name), zuletzt was mit Sent/Gesendet beginnt.
export function pickSentFolder(boxes: { path: string, name: string, specialUse?: string | null, flags?: Set<string> | null }[]): string | null {
  const special = boxes.find(b => b.specialUse === '\\Sent' || b.flags?.has('\\Sent'))
  if (special) return special.path
  for (const n of SENT_NAMES) {
    const hit = boxes.find(b => b.path.toLowerCase() === n) ?? boxes.find(b => b.name.toLowerCase() === n)
    if (hit) return hit.path
  }
  return boxes.find(b => /^(sent|gesendet)/i.test(b.name))?.path ?? null
}

const UNREACHABLE = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|Connection timeout|Greeting never received/i

export function mailServerUnreachable(err: unknown): boolean {
  const e = err as { code?: string, message?: string } | null
  if (!e) return false
  if (['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(e.code ?? '')) return true
  return ['ESOCKET', 'ECONNECTION', undefined, ''].includes(e.code) && UNREACHABLE.test(e.message ?? '')
}

export function addressOf(s: string): string {
  return (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase()
}
