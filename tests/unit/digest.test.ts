import { describe, expect, it } from 'vitest'
import { briefingPoints, mailExcerpt, parseMailDesc, splitOrder, statusItems } from '../../shared/utils/digest'

const MAIL = `Eingegangene Mail von Mr Mello's LoFi Beats <mrmelloslofibeats@gmail.com>, Betreff "The Bunnies Have Been Busy! 🐰":
Hello, music lovers! 👋🎧

Welcome to Week 3 of *Notes from Mr Mello*! We hope your weekend is filled
with good music.

🟢 *Spotify:*
https://open.spotify.com/album/5mooj5TZh3qHZIi7WPtAuB

[image: Bobby Dazzler]

[image: soundcloud] <https://soundcloud.com/mrmelloslofi>

IMPORTANT: The contents of this email and any attachments are confidential.`

describe('Kurzfassungen', () => {
  it('erkennt eingegangene Mails und kürzt Signatur, Bilder und Links weg', () => {
    const m = parseMailDesc(MAIL)!
    expect(m.who).toBe("Mr Mello's LoFi Beats")
    expect(m.subject).toBe('The Bunnies Have Been Busy! 🐰')
    const x = mailExcerpt(m.body)
    expect(x).toContain('Hello, music lovers!')
    expect(x).toContain('Welcome to Week 3 of Notes from Mr Mello! We hope your weekend is filled with good music.')
    expect(x).not.toMatch(/image:|IMPORTANT|https?:/)
    expect(parseMailDesc('Normale Beschreibung')).toBeNull()
  })

  it('kürzt lange Mails am Wortende', () => {
    const x = mailExcerpt('wort '.repeat(200), 50)
    expect(x.length).toBeLessThanOrEqual(54)
    expect(x.endsWith(' ...')).toBe(true)
  })

  it('trennt den kopierfertigen Auftrag ab', () => {
    const r = splitOrder('SEO-Prüfung: 3 Seiten.\n\nAuftrag für Claude Code oder Entwickler (kopieren):\nIm Code der Website: x\n- /a')
    expect(r.text).toBe('SEO-Prüfung: 3 Seiten.')
    expect(r.order).toBe('Im Code der Website: x\n- /a')
    expect(splitOrder('ohne').order).toBeNull()
  })

  it('macht aus erledigt/offen eine Checkliste, offene zuerst', () => {
    const r = statusItems('Stand der Seiten:\nErledigt: Startseite; Impressum\nOffen: Blog\n- [x] Sitemap\n- [ ] Robots')!
    expect(r.rest).toBe('Stand der Seiten:')
    expect(r.items).toEqual([
      { text: 'Blog', done: false },
      { text: 'Robots', done: false },
      { text: 'Startseite', done: true },
      { text: 'Impressum', done: true },
      { text: 'Sitemap', done: true },
    ])
    expect(statusItems('Ganz normaler Text ohne Status.')).toBeNull()
  })

  it('zeigt das Briefing als höchstens 3 Stichpunkte', () => {
    expect(briefingPoints('- Eins\n- Zwei\n- Drei\n- Vier')).toEqual(['Eins', 'Zwei', 'Drei'])
    expect(briefingPoints('Heute 2 Entwürfe. Dann der Blog. Danach Pause! Und mehr.')).toEqual(['Heute 2 Entwürfe.', 'Dann der Blog.', 'Danach Pause!'])
    expect(briefingPoints(null)).toEqual([])
  })
})
