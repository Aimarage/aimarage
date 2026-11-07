import { describe, expect, it } from 'vitest'
import { BRAND_FONT_STACKS, brandThemeStyle, brandThemeVars, darkVariant, textOn } from '../../shared/utils/brand-theme'

describe('Eigene Marke: CSS-Variablen', () => {
  it('ohne Angaben keine Variablen', () => {
    expect(brandThemeVars(null)).toEqual({})
    expect(brandThemeVars({ accent: '', marker: null, font: 'familjen' })).toEqual({})
    expect(brandThemeStyle(undefined)).toBe('')
  })

  it('Hauptfarbe mit lesbarer Schrift und hellerer Variante für den Dunkelmodus', () => {
    const v = brandThemeVars({ accent: '#0A3D62' })
    expect(v['--brand-primary']).toBe('#0a3d62')
    expect(v['--brand-on-primary']).toBe('#ffffff')
    expect(v['--brand-primary-dark']).not.toBe('#0a3d62')
    expect(v['--brand-on-primary-dark']).toBe('#1a2433')
  })

  it('Markerfarbe: dunkle Schrift auf Gelb, helle auf Dunkelrot', () => {
    expect(brandThemeVars({ marker: '#ffe34f' })['--brand-on-marker']).toBe('#1a2433')
    expect(brandThemeVars({ marker: '#7a0019' })['--brand-on-marker']).toBe('#ffffff')
    expect(textOn('#ffffff')).toBe('#1a2433')
  })

  it('Schrift nur aus der Auswahl, fremde Werte und Farben werden ignoriert', () => {
    expect(brandThemeVars({ font: 'serif' })['--brand-font']).toBe(BRAND_FONT_STACKS.serif)
    expect(brandThemeVars({ font: 'x; background: red', accent: 'red;}', marker: 'url(x)' })).toEqual({})
  })

  it('helle Farben bleiben im Dunkelmodus gleich', () => {
    expect(darkVariant('#ffe34f')).toBe('#ffe34f')
  })
})
