import { eq } from 'drizzle-orm'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'
import { escapeHtml } from '~~/server/mail-templates/layout'
import { readUnsubscribeToken, setMorningMail } from '~~/server/lib/mail-unsubscribe'

// Tagesmail abbestellen ohne Login: GET zeigt einen Knopf (Link-Scanner bestellen nichts ab),
// POST bestellt ab, auch als One-Click aus dem Mailprogramm (List-Unsubscribe-Post).
const TEXT = {
  de: {
    title: 'Tagesmail abbestellen',
    ask: 'Möchtest du die tägliche Mail von Aimarage für {email} abbestellen?',
    button: 'Abbestellen',
    done: 'Erledigt: Die Tagesmail kommt nicht mehr. Wieder einschalten kannst du sie unter Einstellungen > Profil.',
    invalid: 'Dieser Link ist ungültig.',
    open: 'Aimarage öffnen',
  },
  en: {
    title: 'Unsubscribe from the daily mail',
    ask: 'Do you want to stop the daily mail from Aimarage for {email}?',
    button: 'Unsubscribe',
    done: 'Done: you will no longer get the daily mail. You can switch it back on under Settings > Profile.',
    invalid: 'This link is not valid.',
    open: 'Open Aimarage',
  },
}

function page(lang: 'de' | 'en', body: string): string {
  const t = TEXT[lang]
  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(t.title)}</title>
<style>
body { margin: 0; padding: 48px 16px; background: #f6f6f4; color: #222; font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
main { max-width: 420px; margin: 0 auto; padding: 24px; background: #fff; border: 1px solid #e6e6e1; border-radius: 8px; }
h1 { margin: 0 0 12px; font-size: 18px; }
p { margin: 0 0 16px; }
button { padding: 10px 18px; border: 0; border-radius: 6px; background: #111; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
a { color: #111; }
</style></head>
<body><main><h1>${escapeHtml(t.title)}</h1>${body}<p><a href="${escapeHtml(config.appUrl)}">${escapeHtml(t.open)}</a></p></main></body>
</html>
`
}

export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD' && event.method !== 'POST') throw createError({ statusCode: 405 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'X-Robots-Tag', 'noindex')
  const token = String(getQuery(event).t ?? '')
  const userId = readUnsubscribeToken(token)
  const db = await getDb()
  const [user] = userId ? await db.select({ id: schema.users.id, email: schema.users.email, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, userId)) : []
  const lang = user?.locale === 'en' ? 'en' : 'de'
  const t = TEXT[lang]
  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  if (!user) {
    setResponseStatus(event, 404)
    return page(lang, `<p>${escapeHtml(t.invalid)}</p>`)
  }
  if (event.method === 'POST') {
    await setMorningMail(db, user.id, false)
    return page(lang, `<p>${escapeHtml(t.done)}</p>`)
  }
  const action = `/mail/abmelden?t=${encodeURIComponent(token)}`
  return page(lang, `<p>${escapeHtml(t.ask.replace('{email}', user.email))}</p><form method="post" action="${escapeHtml(action)}"><p><button type="submit">${escapeHtml(t.button)}</button></p></form>`)
})
