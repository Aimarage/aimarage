// Eigene Marke (Tarif Agentur): Hauptfarbe, Markerfarbe und Schrift als CSS-Variablen.
// Die App liest sie in app/assets/css/main.css (--brand-*), ohne Angabe gelten die Standardwerte.

export const BRAND_FONTS = ['familjen', 'plex', 'system', 'serif'] as const
export type BrandFont = typeof BRAND_FONTS[number]

export const BRAND_FONT_STACKS: Record<BrandFont, string> = {
  familjen: '\'Familjen Grotesk\', -apple-system, \'Helvetica Neue\', system-ui, sans-serif',
  plex: '\'IBM Plex Sans\', system-ui, sans-serif',
  system: 'system-ui, -apple-system, \'Segoe UI\', Roboto, sans-serif',
  serif: 'Charter, \'Iowan Old Style\', Georgia, \'Times New Roman\', serif',
}

export const DEFAULT_PRIMARY = '#1d5e4a'
export const DEFAULT_MARKER = '#ffe34f'

const HEX = /^#[0-9a-f]{6}$/i
const INK = '#1a2433'

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v)
}

export function isBrandFont(v: unknown): v is BrandFont {
  return typeof v === 'string' && (BRAND_FONTS as readonly string[]).includes(v)
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

// Schrift auf der Farbe: weiß oder Tinte, je nachdem was besser lesbar ist.
export function textOn(hex: string): string {
  return contrast(hex, '#ffffff') >= contrast(hex, INK) ? '#ffffff' : INK
}

function mix(hex: string, with_: string, share: number): string {
  const a = rgb(hex)
  const b = rgb(with_)
  return `#${a.map((c, i) => Math.round(c + (b[i]! - c) * share).toString(16).padStart(2, '0')).join('')}`
}

// Für den Dunkelmodus: dunkle Hauptfarben aufhellen, bis sie auf dunklem Grund lesbar sind.
export function darkVariant(hex: string): string {
  let out = hex
  for (let share = 0.15; contrast(out, '#1b2739') < 4.5 && share <= 0.9; share += 0.15) out = mix(hex, '#ffffff', share)
  return out
}

export interface BrandTheme {
  accent?: string | null
  marker?: string | null
  font?: string | null
}

export function brandThemeVars(theme: BrandTheme | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!theme) return out
  if (isHexColor(theme.accent)) {
    const a = theme.accent.toLowerCase()
    const d = darkVariant(a)
    out['--brand-primary'] = a
    out['--brand-on-primary'] = textOn(a)
    out['--brand-primary-dark'] = d
    out['--brand-on-primary-dark'] = textOn(d)
    out['--brand-btn-dark'] = a
    out['--brand-on-btn-dark'] = textOn(a)
  }
  if (isHexColor(theme.marker)) {
    const m = theme.marker.toLowerCase()
    out['--brand-marker'] = m
    out['--brand-on-marker'] = textOn(m)
  }
  if (isBrandFont(theme.font) && theme.font !== 'familjen') out['--brand-font'] = BRAND_FONT_STACKS[theme.font]
  return out
}

export function brandThemeStyle(theme: BrandTheme | null | undefined): string {
  return Object.entries(brandThemeVars(theme)).map(([k, v]) => `${k}: ${v}`).join('; ')
}

// Hell, Dunkel oder wie das System. Gespeichert im Browser (localStorage), gesetzt als data-theme am html-Element.
export const THEME_KEY = 'aimarage-theme'
export const THEME_MODES = ['light', 'dark', 'system'] as const
export type ThemeMode = typeof THEME_MODES[number]

// Läuft im <head> vor dem ersten Zeichnen, damit nichts aufblitzt.
export const THEME_BOOT_SCRIPT = `(function(){try{var m=localStorage.getItem('${'aimarage-theme'}');var d=m==='dark'||(m!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}})()`
