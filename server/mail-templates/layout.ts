export type MailLocale = 'de' | 'en'

export type MailBlock =
  | { p: string }
  | { code: string }
  | { link: string, label: string }
  | { small: string }
  | { h: string }

export interface MailContent {
  subject: string
  blocks: MailBlock[]
}

export interface RenderedMail {
  subject: string
  text: string
  html: string
}

const FOOTER: Record<MailLocale, string> = {
  de: 'Diese Mail wurde automatisch von Aimarage gesendet.',
  en: 'This email was sent automatically by Aimarage.',
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function paragraphHtml(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, '<br>')
}

function blockText(b: MailBlock): string {
  if ('code' in b) return `    ${b.code}`
  if ('link' in b) return `${b.label}:\n${b.link}`
  if ('small' in b) return b.small
  if ('h' in b) return `${b.h}\n${'='.repeat(Math.min(b.h.length, 40))}`
  return b.p
}

function blockHtml(b: MailBlock): string {
  if ('code' in b) return `<p style="margin:24px 0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;letter-spacing:6px;font-weight:600;color:#111">${escapeHtml(b.code)}</p>`
  if ('link' in b) return `<p style="margin:24px 0"><a href="${escapeHtml(b.link)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(b.label)}</a></p>`
  if ('small' in b) return `<p style="margin:16px 0;font-size:13px;color:#666">${paragraphHtml(b.small)}</p>`
  if ('h' in b) return `<p style="margin:28px 0 8px;font-size:17px;font-weight:700;color:#111">${escapeHtml(b.h)}</p>`
  return `<p style="margin:16px 0">${paragraphHtml(b.p)}</p>`
}

// Mit eigener Marke (White-Label): Name der Marke im Kopf, keine Aimarage-Fußzeile.
export interface MailBrand {
  name: string
}

export function renderMail(content: MailContent, locale: MailLocale, brand: MailBrand | null = null): RenderedMail {
  const body = content.blocks.map(blockText).join('\n\n')
  const text = brand ? `${body}\n` : `${body}\n\n-- \n${FOOTER[locale]}\n`
  const head = brand ? brand.name : 'Aimarage'
  const html = `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(content.subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f4">
<div style="max-width:520px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#222">
<p style="margin:0 0 24px;font-size:17px;font-weight:700;letter-spacing:.2px;color:#111">${escapeHtml(head)}</p>
<div style="background:#fff;border:1px solid #e6e6e1;border-radius:8px;padding:8px 24px">
${content.blocks.map(blockHtml).join('\n')}
</div>
${brand ? '' : `<p style="margin:20px 0 0;font-size:12px;color:#888">${escapeHtml(FOOTER[locale])}</p>\n`}</div>
</body>
</html>
`
  return { subject: content.subject, text, html }
}
