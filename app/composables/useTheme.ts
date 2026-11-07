import { THEME_KEY, THEME_MODES, type ThemeMode } from '~~/shared/utils/brand-theme'

let media: MediaQueryList | null = null

function resolved(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return media?.matches ? 'dark' : 'light'
}

export function useTheme() {
  const mode = useState<ThemeMode>('theme-mode', () => 'system')
  const current = useState<'light' | 'dark'>('theme-current', () => 'light')

  function apply() {
    current.value = resolved(mode.value)
    document.documentElement.setAttribute('data-theme', current.value)
  }

  function set(m: ThemeMode) {
    mode.value = m
    try {
      if (m === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, m)
    }
    catch {}
    apply()
  }

  function toggle() {
    set(current.value === 'dark' ? 'light' : 'dark')
  }

  function init() {
    if (!import.meta.client || media) return
    media = window.matchMedia('(prefers-color-scheme: dark)')
    let saved: string | null = null
    try {
      saved = localStorage.getItem(THEME_KEY)
    }
    catch {}
    mode.value = (THEME_MODES as readonly string[]).includes(saved ?? '') ? saved as ThemeMode : 'system'
    apply()
    media.addEventListener('change', () => {
      if (mode.value === 'system') apply()
    })
  }

  return { mode, current, set, toggle, init }
}
