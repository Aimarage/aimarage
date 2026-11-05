import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { helpDoc, helpForMessage, helpMarkdownText, helpPage, publicHelpDoc, readHelp } from '../../server/lib/help'
import { config } from '../../server/lib/config'
import { fold, helpBaseUrl, helpBlocks, helpExcerpt, looksLikeHelpQuestion, parseHelp, pickHelp, publicDoc, withAppUrl } from '../../shared/utils/help'

const de = helpDoc('de')
const en = helpDoc('en')
const top = (q: string) => pickHelp(q, [de, en], 2)[0]?.id

describe('Aimarage-Hilfe: Aufbau', () => {
  it('liest Abschnitte mit Id, Pfad und Stichworten', () => {
    const doc = parseHelp('# Titel\nEinleitung\n\n## Freigaben {#freigaben}\nPfad: /p/<projekt>/freigaben\nStichworte: Freigabe, Du bist dran\n\nText eins.\n\n## Kalender {#kalender}\nText zwei.')
    expect(doc.intro).toBe('Einleitung')
    expect(doc.sections.map(s => s.id)).toEqual(['freigaben', 'kalender'])
    expect(doc.sections[0]).toMatchObject({ title: 'Freigaben', path: '/p/<projekt>/freigaben', keywords: ['freigabe', 'du bist dran'], body: 'Text eins.' })
    expect(doc.sections[1]!.path).toBeNull()
  })

  it('de und en haben dieselben Abschnitte, jeder mit Stichworten und Text', () => {
    expect(de.sections.length).toBeGreaterThan(15)
    expect(en.sections.map(s => s.id)).toEqual(de.sections.map(s => s.id))
    for (const s of [...de.sections, ...en.sections]) {
      expect(s.keywords.length, s.id).toBeGreaterThan(0)
      expect(s.body.length, s.id).toBeGreaterThan(40)
    }
  })

  it('nur normale Bindestriche', () => {
    for (const lang of ['de', 'en']) expect(readFileSync(`shared/help/aimarage-hilfe.${lang}.md`, 'utf8')).not.toMatch(/[–—]/)
  })

  it('jede Hauptseite im Menü kommt in der Hilfe vor', () => {
    const layout = readFileSync('app/layouts/default.vue', 'utf8')
    const pages = [...layout.matchAll(/\$\{base\.value\}\/([a-z-]+)/g)].map(m => m[1]!)
    expect(pages).toContain('freigaben')
    for (const page of [...new Set([...pages, 'einstellungen'])]) {
      for (const doc of [de, en]) {
        const paths = doc.sections.map(s => `${s.path ?? ''}\n${s.body}`).join('\n')
        expect(paths, `${page} fehlt`).toContain(`/p/<projekt>/${page}`)
      }
    }
  })

  it('Hilfe steht im Menü und in der Hilfe', () => {
    expect(readFileSync('app/layouts/default.vue', 'utf8')).toContain('to="/hilfe"')
    for (const doc of [de, en]) expect(doc.sections.map(s => s.body).join('\n')).toContain('(/hilfe)')
  })
})

describe('Aimarage-Hilfe: Abschnittsauswahl', () => {
  it('findet den passenden Abschnitt zu typischen Fragen', () => {
    expect(top('Was mache ich hier?')).toBe('ueberblick')
    expect(top('Was heißt "Claude prüft"?')).toBe('claude')
    expect(top('Wie verbinde ich Bluesky?')).toBe('konten')
    expect(top('Warum steht die Aufgabe nicht unter "Du bist dran"?')).toBe('du-bist-dran')
    expect(top('Was ist die Einspruchsfrist?')).toBe('einspruchsfrist')
    expect(top('Wie ändere ich mein Zeitbudget?')).toBe('zeitbudget')
    expect(top('How do I connect Bluesky?')).toBe('konten')
    expect(top('Was ist Mitreden?')).toBe('mitreden')
    expect(top('Why do I post YouTube comments myself?')).toBe('mitreden')
    expect(top('What is the objection period?')).toBe('einspruchsfrist')
    expect(top('Wo schalte ich das Posten ein?')).toBe('hauptschalter')
    expect(top('Wie richte ich MCP ein?')).toBe('mcp')
    expect(top('How do I set up MCP in Cursor?')).toBe('mcp')
    expect(top('Was bedeutet Info nötig?')).toBe('info-noetig')
    expect(top('Was steht diese Woche an?')).toBeUndefined()
    expect(top('Mach mehr Social Media')).toBeUndefined()
  })

  it('normalisiert Umlaute und Satzzeichen', () => {
    expect(fold('Was heißt „Claude prüft"?')).toBe('was heisst claude prueft')
  })

  it('erkennt Fragen und lässt Aufträge ohne Frage weg', () => {
    expect(looksLikeHelpQuestion('Wie ändere ich mein Zeitbudget')).toBe(true)
    expect(looksLikeHelpQuestion('Freigaben?')).toBe(true)
    expect(looksLikeHelpQuestion('Verschieb BMX-COM-002 auf Freitag')).toBe(false)
    expect(helpForMessage('Leg eine Aufgabe für die Freigaben an', 'de', 'linkbox')).toBe('')
  })

  it('lädt nur die passenden Abschnitte, mit Projekt-Link', () => {
    const text = helpForMessage('Was ist die Einspruchsfrist?', 'de', 'linkbox')
    expect(text).toContain('### ')
    expect(text).not.toContain('<projekt>')
    expect(text.length).toBeLessThan(3000)
    expect(helpForMessage('Wie verbinde ich Bluesky?', 'de', 'linkbox')).toContain('/p/linkbox/konten')
    expect(helpForMessage('Hallo?', 'de', 'linkbox')).toBe('')
  })

  it('read_help ohne Treffer liefert das Inhaltsverzeichnis, mit Id genau einen Abschnitt', () => {
    const toc = readHelp('', 'de', 'alle') as { topics: { id: string }[] }
    expect(toc.topics.length).toBe(de.sections.length)
    const one = readHelp('zeitbudget', 'en', 'alle') as { sections: string[] }
    expect(one.sections[0]).toContain('###')
  })
})

describe('Aimarage-Hilfe: Hilfeseite', () => {
  it('zerlegt Markdown in sichere Blöcke', () => {
    const blocks = helpBlocks('Text mit `code` und https://example.com/x.\n\n### Schritte\n\n1. eins\n2. zwei\n\n```\nclaude mcp add <x>\n```\n\n3. drei\n- a\n- b\n\n<script>alert(1)</script>')
    expect(blocks.map(b => b.t)).toEqual(['p', 'h', 'ol', 'code', 'ol', 'ul', 'p'])
    expect(blocks[0]).toEqual({ t: 'p', parts: [{ t: 'text', v: 'Text mit ' }, { t: 'code', v: 'code' }, { t: 'text', v: ' und ' }, { t: 'link', v: 'https://example.com/x', href: 'https://example.com/x' }, { t: 'text', v: '.' }] })
    expect(blocks[1]).toMatchObject({ t: 'h', v: 'Schritte', id: 'schritte' })
    expect(blocks[3]).toEqual({ t: 'code', v: 'claude mcp add <x>' })
    expect(blocks[4]).toMatchObject({ t: 'ol', start: 3 })
    expect(blocks[6]).toEqual({ t: 'p', parts: [{ t: 'text', v: '<script>alert(1)</script>' }] })
    expect(helpBlocks('Link javascript:alert(1)')[0]).toEqual({ t: 'p', parts: [{ t: 'text', v: 'Link javascript:alert(1)' }] })
  })

  it('Kurzbeschreibung ohne Markdown und höchstens 160 Zeichen', () => {
    for (const s of [...de.sections, ...en.sections]) {
      const x = helpExcerpt(s.body)
      expect(x.length, s.id).toBeLessThanOrEqual(164)
      expect(x, s.id).not.toMatch(/`|^#/)
    }
  })

  it('MCP-Anleitung mit APP_URL statt Platzhalter', () => {
    for (const lang of ['de', 'en'] as const) {
      const page = helpPage(lang)
      expect(page.appUrl).toBe(config.appUrl)
      const mcp = page.sections.find(s => s.id === 'mcp')!
      expect(mcp.path).toBe('/einstellungen/api')
      expect(mcp.body).toContain(`claude mcp add --transport http aimarage ${config.appUrl}/mcp`)
      expect(mcp.body).toContain(`${helpBaseUrl(config.appUrl, lang, config.hosted)}/mcp.md`)
      expect(JSON.stringify(page)).not.toContain('{APP_URL}')
    }
  })

  it('liefert Markdown für alle Abschnitte und je Id', () => {
    const one = helpMarkdownText('de', 'mcp')!
    expect(one.startsWith('# Claude und andere KI-Assistenten verbinden (MCP)')).toBe(true)
    expect(one).not.toMatch(/^(Pfad|Stichworte):/m)
    expect(helpMarkdownText('en', 'gibt-es-nicht')).toBeNull()
    const all = helpMarkdownText('en')!
    expect(all).toContain(`${config.appUrl}/hilfe/mcp?lang=en`)
    expect(all.match(/^## /gm)!.length).toBe(en.sections.length)
  })

  it('Hilfe-Adresse: gehostet auf aimarage.com, Self-Host in der App', () => {
    expect(helpBaseUrl('https://app.aimarage.com', 'de', true)).toBe('https://aimarage.com/hilfe')
    expect(helpBaseUrl('https://app.aimarage.com', 'en', true)).toBe('https://aimarage.com/en/help')
    expect(helpBaseUrl('https://mein.example/', 'de', false)).toBe('https://mein.example/hilfe')
    expect(helpBaseUrl('https://mein.example', 'en', false)).toBe('https://mein.example/en/help')
    expect(withAppUrl('{HELP_URL}/mcp.md {APP_URL}/mcp', 'https://a.b/', 'https://aimarage.com/hilfe')).toBe('https://aimarage.com/hilfe/mcp.md https://a.b/mcp')
    for (const lang of ['de', 'en']) expect(readFileSync(`shared/help/aimarage-hilfe.${lang}.md`, 'utf8')).not.toContain('{APP_URL}/hilfe')
  })

  it('hosted-Abschnitte nur in der gehosteten Version', () => {
    expect(de.sections.some(s => s.id === 'abo')).toBe(config.hosted)
  })

  it('Interna nur für den Agenten, nicht öffentlich', () => {
    const doc = parseHelp('## A {#a}\nStichworte: a\n\nText.\n\nIntern: Geheim 5 USD.\n\n## B {#b}\nÖffentlich: nein\nStichworte: b\n\nNur intern.')
    expect(publicDoc(doc).sections.map(x => x.id)).toEqual(['a'])
    expect(publicDoc(doc).sections[0]!.body).toBe('Text.')
    const secrets = ['0,015 USD', '0.015 USD', '5 USD je 1000', '5 USD per 1000', '20 Ablehnungen', '20 rejections', 'Personenname', 'personal name', 'manueller Abrechnung', 'manual billing', 'in Vorbereitung', 'in preparation', 'Agentur 800 EUR', 'Agency 800 EUR', 'Intern:']
    for (const lang of ['de', 'en'] as const) {
      const pub = JSON.stringify(helpPage(lang)) + helpMarkdownText(lang)! + helpMarkdownText(lang, 'api-mcp')!
      const agent = helpDoc(lang).sections.map(x => x.body).join('\n')
      for (const x of secrets) expect(pub, x).not.toContain(x)
      expect(agent).not.toContain('Intern:')
      for (const x of lang === 'de' ? ['in Vorbereitung', '20 Ablehnungen', '5 USD je 1000'] : ['in preparation', '20 rejections', '5 USD per 1000']) expect(agent).toContain(x)
      expect(publicHelpDoc(lang).sections.length).toBe(helpDoc(lang).sections.length)
    }
  })
})
