export interface MailDesc {
  who: string
  from: string
  subject: string
  body: string
}

const MAIL_HEAD = /^Eingegangene Mail von (.+?) <([^>]*)>, Betreff "([\s\S]*?)":\n/

export function parseMailDesc(desc: string | null | undefined): MailDesc | null {
  if (!desc) return null
  const m = MAIL_HEAD.exec(desc)
  if (!m) return null
  return { who: m[1]!.trim(), from: m[2]!.trim(), subject: m[3]!.trim(), body: desc.slice(m[0].length).trim() }
}

const SIGN_OFF = /^(--\s*|_{3,}|(mit )?(freundlichen|herzlichen|lieben|besten|viele|liebe|beste|schöne) grüße?n?\b.*|lg|vg|mfg|(best|kind|warm) regards\b.*|regards,?|cheers,?|greets,?|best,?|thanks,?|thank you,?|sent from my .*|von meinem .* gesendet)$/i
const DISCLAIMER = /^(important|confidential|disclaimer|notice)\b|^this (e-?mail|message)\b.*(confidential|intended)|^(diese|die) (e-?mail|nachricht)\b.*(vertraulich|bestimmt)/i
const JUNK = /^\[image:[^\]]*\]|^<?https?:\/\/\S+>?$|^\S+@\S+\.\S+$|^[\w.-]+\.(com|de|at|net|org|io)\/?$/i

function letters(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length
}

export function mailExcerpt(body: string, max = 280): string {
  const out: string[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(para.join(' '))
    para = []
  }
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim().replace(/\*([^*\n]+)\*/g, '$1')
    if (!line) {
      flush()
      continue
    }
    if (SIGN_OFF.test(line) || DISCLAIMER.test(line)) break
    if (JUNK.test(line) || line.startsWith('>') || letters(line.replace(/https?:\/\/\S+/g, '')) < 3) continue
    para.push(line.replace(/\s*<?https?:\/\/\S+>?/g, '').trim())
  }
  flush()
  const text = out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')} ...`
}

export const ORDER_HEAD = 'Auftrag für Claude Code oder Entwickler (kopieren):'

export function splitOrder(desc: string): { text: string, order: string | null } {
  const i = desc.indexOf(ORDER_HEAD)
  if (i < 0) return { text: desc, order: null }
  const order = desc.slice(i + ORDER_HEAD.length).trim()
  return { text: desc.slice(0, i).trim(), order: order || null }
}

export interface StatusItem {
  text: string
  done: boolean
}

const BOX = /^\s*(?:[-*]\s*)?\[([ xX])\]\s*(.+)$/
const LABEL = /^\s*(?:[-*]\s*)?(erledigt|fertig|done|noch offen|offen|open|todo|to do)\s*:\s*(.+)$/i
const TAIL = /^\s*[-*]\s*(.+?)\s*(?:\((erledigt|offen|done|open)\)|[-:]\s*(erledigt|offen|done|open))\s*\.?$/i
const DONE_WORD = /^(erledigt|fertig|done)$/i

function pieces(s: string): string[] {
  return s.split(/;\s*/).flatMap(p => (p.includes(',') && p.split(',').every(x => x.trim().length <= 60) ? p.split(',') : [p])).map(p => p.trim().replace(/\.$/, '')).filter(Boolean)
}

export function statusItems(text: string): { items: StatusItem[], rest: string } | null {
  const items: StatusItem[] = []
  const rest: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const box = BOX.exec(line)
    if (box) {
      items.push({ text: box[2]!.trim(), done: box[1] !== ' ' })
      continue
    }
    const label = LABEL.exec(line)
    if (label) {
      const done = DONE_WORD.test(label[1]!)
      for (const p of pieces(label[2]!)) items.push({ text: p, done })
      continue
    }
    const tail = TAIL.exec(line)
    if (tail) {
      items.push({ text: tail[1]!.trim(), done: DONE_WORD.test(tail[2] ?? tail[3] ?? '') })
      continue
    }
    rest.push(line)
  }
  if (!items.length) return null
  return { items: [...items.filter(i => !i.done), ...items.filter(i => i.done)], rest: rest.join('\n').trim() }
}

export function briefingPoints(text: string | null | undefined, max = 3): string[] {
  if (!text?.trim()) return []
  const lines = text.split(/\r?\n/).map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)
  const list = lines.length > 1 ? lines : lines.flatMap(l => l.split(/(?<=[.!?])\s+(?=\p{Lu})/u))
  return list.map(s => s.trim()).filter(Boolean).slice(0, max)
}
