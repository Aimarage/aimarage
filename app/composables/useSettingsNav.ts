import type { SettingsGroup, SettingsSection } from '~/utils/extensions'

export const SETTINGS_GROUPS: SettingsGroup[] = ['me', 'ai', 'links', 'company', 'ops']

export const CORE_SECTIONS: { id: string, group: SettingsGroup, icon: string, order: number }[] = [
  { id: 'profil', group: 'me', icon: 'edit', order: 10 },
  { id: 'sicherheit', group: 'me', icon: 'key', order: 20 },
  { id: 'ki', group: 'ai', icon: 'agent', order: 10 },
  { id: 'veroeffentlichen', group: 'ai', icon: 'send', order: 20 },
  { id: 'apps', group: 'ai', icon: 'link', order: 30 },
  { id: 'api', group: 'links', icon: 'external', order: 10 },
  { id: 'kalender', group: 'links', icon: 'calendar', order: 20 },
  { id: 'arbeitsbereich', group: 'company', icon: 'settings', order: 10 },
  { id: 'team', group: 'company', icon: 'users', order: 20 },
]

export const LEGACY_TABS: Record<string, string> = { profile: 'profil', agent: 'ki', workspace: 'arbeitsbereich', projects: 'profil' }

export function legacySettingsPath(query: Record<string, unknown>): string | null {
  const tab = typeof query.tab === 'string' ? query.tab : null
  if (!tab) return null
  if (tab === 'agent' && typeof query.app === 'string') return `/einstellungen/apps?app=${encodeURIComponent(query.app)}`
  return `/einstellungen/${LEGACY_TABS[tab] ?? 'profil'}`
}

export interface SettingsItem { id: string, group: SettingsGroup, to: string, icon: string, label: string, component?: SettingsSection['component'] }

export function useSettingsNav() {
  const { t } = useI18n()
  const { project } = useScope()
  const route = useRoute()

  const items = computed<SettingsItem[]>(() => {
    const ext = settingsExtSections()
    const core: (SettingsSection & { label: string })[] = CORE_SECTIONS.map(c => ({ ...c, label: t(`settings.nav.${c.id}`) }))
    const merged = new Map<string, SettingsSection>()
    for (const c of core) merged.set(c.id, c)
    for (const e of ext) merged.set(e.id, { ...e, label: t(e.label) })
    return [...merged.values()].filter(s => !s.show || s.show()).sort((a, b) => SETTINGS_GROUPS.indexOf(a.group) - SETTINGS_GROUPS.indexOf(b.group) || a.order - b.order).map(s => ({ id: s.id, group: s.group, to: s.to ?? `/einstellungen/${s.id}`, icon: s.icon, label: s.label, component: s.component }))
  })

  const groups = computed(() => SETTINGS_GROUPS.map(g => ({ id: g, label: t(`settings.groups.${g}`), items: items.value.filter(i => i.group === g) })).filter(g => g.items.length))

  const active = computed(() => {
    const p = route.path
    return items.value.find(i => p === i.to || p.startsWith(`${i.to}/`)) ?? null
  })
  const inSettings = computed(() => route.path === '/einstellungen' || route.path.startsWith('/einstellungen/') || !!active.value)

  const back = computed(() => (project.value ? { to: `/p/${project.value.slug}`, label: t('settings.back', { name: project.value.name }) } : { to: '/', label: t('settings.backHome') }))

  return { items, groups, active, inSettings, back }
}
