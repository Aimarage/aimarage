import { describe, expect, it } from 'vitest'
import { fixOwnDomain } from '../../shared/utils/own-domain'
import { fixTimeClaims, minutesPerDay } from '../../shared/utils/strategy-facts'

describe('Eigene Domain aus der Projekt-Website', () => {
  it('schreibt falsche Endungen um', () => {
    expect(fixOwnDomain('Mehr auf linkbox.com und www.linkbox.com/blog', 'https://www.linkbox.net')).toBe('Mehr auf linkbox.net und www.linkbox.net/blog')
    expect(fixOwnDomain('Blog auf tonebase.de', 'https://tonebase.com/')).toBe('Blog auf tonebase.com')
  })
  it('lässt Richtiges, Fremdes und Verneinungen stehen', () => {
    expect(fixOwnDomain('linkbox.net, mylinkbox.com, linkbox.company', 'https://www.linkbox.net')).toBe('linkbox.net, mylinkbox.com, linkbox.company')
    expect(fixOwnDomain('Domain ist linkbox.net (nicht linkbox.com)', 'https://www.linkbox.net')).toBe('Domain ist linkbox.net (nicht linkbox.com)')
    expect(fixOwnDomain('linkbox.com', null)).toBe('linkbox.com')
  })
})

describe('Zeit aus dem Zeitbudget', () => {
  it('ersetzt erfundene Stundenangaben', () => {
    const t = 'Fokus auf Privacy. Der Takt von ca. 25-30 Stunden/Woche (Social 5x) ist realistisch. Rest bleibt.'
    expect(fixTimeClaims(t, 15)).toBe('Fokus auf Privacy. Der Takt passt in 15 Minuten pro Tag für Prüfen und Freigeben, das Schreiben übernimmt der Agent. Rest bleibt.')
    expect(fixTimeClaims(fixTimeClaims(t, 15), 15)).toBe(fixTimeClaims(t, 15))
    expect(fixTimeClaims('Social-Posts (5 Min) kurz.', 15)).toBe('Social-Posts (5 Min) kurz.')
  })
  it('Standard 15 Minuten, sonst Einstellung der Person', () => {
    expect(minutesPerDay(null, 'u1')).toBe(15)
    expect(minutesPerDay({ timeBudget: { u1: 30 } }, 'u1')).toBe(30)
  })
})
