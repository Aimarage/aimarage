import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'
import { agentDoc, helpBaseUrl, helpExcerpt, helpMarkdown, helpSectionUrl, looksLikeHelpQuestion, parseHelp, pickHelp, publicDoc, renderSection, withAppUrl, type HelpDoc, type HelpLang } from '../../shared/utils/help'

const cache = new Map<HelpLang, HelpDoc>()
const publicCache = new Map<HelpLang, HelpDoc>()

export function helpFile(lang: HelpLang): string {
  return join(process.env.HELP_DIR || join(process.cwd(), 'shared', 'help'), `aimarage-hilfe.${lang}.md`)
}

export function helpDoc(lang: HelpLang): HelpDoc {
  const hit = cache.get(lang)
  if (hit) return hit
  const file = helpFile(lang)
  const raw = existsSync(file) ? parseHelp(withAppUrl(readFileSync(file, 'utf8'), config.appUrl, helpBaseUrl(config.appUrl, lang, config.hosted))) : { intro: '', sections: [] }
  const doc = agentDoc({ ...raw, sections: raw.sections.filter(s => config.hosted || !s.hosted) })
  if (doc.sections.length) cache.set(lang, doc)
  return doc
}

export function publicHelpDoc(lang: HelpLang): HelpDoc {
  const hit = publicCache.get(lang)
  if (hit) return hit
  const file = helpFile(lang)
  const raw = existsSync(file) ? parseHelp(withAppUrl(readFileSync(file, 'utf8'), config.appUrl, helpBaseUrl(config.appUrl, lang, config.hosted))) : { intro: '', sections: [] }
  const doc = publicDoc({ ...raw, sections: raw.sections.filter(s => config.hosted || !s.hosted) })
  if (doc.sections.length) publicCache.set(lang, doc)
  return doc
}

export function helpLang(locale: string | null | undefined): HelpLang {
  return locale === 'en' ? 'en' : 'de'
}

function both(): HelpDoc[] {
  return [helpDoc('de'), helpDoc('en')]
}

export function helpSections(query: string, lang: HelpLang, slug: string, max = 2): string[] {
  const doc = helpDoc(lang)
  return pickHelp(query, both(), max)
    .map(p => doc.sections.find(s => s.id === p.id))
    .filter(s => !!s)
    .map(s => renderSection(s, slug))
}

export function helpForMessage(text: string, lang: HelpLang, slug: string): string {
  if (!looksLikeHelpQuestion(text)) return ''
  const parts = helpSections(text, lang, slug, 2)
  return parts.length ? parts.join('\n\n') : ''
}

export function readHelp(topic: string, lang: HelpLang, slug: string) {
  const doc = helpDoc(lang)
  const parts = topic.trim() ? helpSections(topic, lang, slug, 3) : []
  if (parts.length) return { sections: parts }
  const exact = doc.sections.find(s => s.id === topic.trim().toLowerCase())
  if (exact) return { sections: [renderSection(exact, slug)] }
  return { intro: doc.intro, topics: doc.sections.map(s => ({ id: s.id, title: s.title })), note: 'Kein passender Abschnitt. Mit topic = id einen Abschnitt lesen.' }
}

export function helpPage(lang: HelpLang) {
  const doc = publicHelpDoc(lang)
  return {
    lang,
    appUrl: config.appUrl,
    intro: doc.intro,
    sections: doc.sections.map(s => ({ id: s.id, title: s.title, path: s.path, keywords: s.keywords, excerpt: helpExcerpt(s.body), body: s.body })),
  }
}

export function helpMarkdownText(lang: HelpLang, id?: string): string | null {
  return helpMarkdown(publicHelpDoc(lang), (sid, ext) => helpSectionUrl(config.appUrl, sid, lang, ext), lang, id)
}
