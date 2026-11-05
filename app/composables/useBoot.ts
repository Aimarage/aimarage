import type { BootData } from '~~/server/services/boot'

export type Boot = BootData
export type BootProject = BootData['projects'][number]
export type BootMember = BootData['members'][number]

export function useBoot() {
  const boot = useState<Boot | null>('boot', () => null)
  const loaded = useState<boolean>('boot-loaded', () => false)
  const clockOffset = useState<number>('clock-offset', () => 0)

  async function refresh() {
    const fetcher = import.meta.server ? useRequestFetch() : $fetch
    try {
      const res = await fetcher<Boot | { user: null }>('/api/me')
      boot.value = res.user ? res as Boot : null
      if (boot.value) clockOffset.value = new Date(boot.value.now).getTime() - Date.now()
    }
    catch {
      boot.value = null
    }
    loaded.value = true
  }

  const projectBySlug = (slug: string | undefined) => boot.value?.projects.find(p => p.slug === slug) ?? null
  const projectById = (id: string | null | undefined) => (id ? boot.value?.projects.find(p => p.id === id) ?? null : null)
  const memberById = (id: string | null | undefined) => (id ? boot.value?.members.find(m => m.id === id) ?? null : null)
  const canEdit = computed(() => !!boot.value && boot.value.role !== 'viewer')
  const isAdmin = computed(() => boot.value?.role === 'owner' || boot.value?.role === 'admin')

  return { boot, loaded, clockOffset, refresh, projectBySlug, projectById, memberById, canEdit, isAdmin }
}

export function useNow() {
  const { clockOffset } = useBoot()
  const tick = useState<number>('now-tick', () => Date.now())
  if (import.meta.client) {
    onMounted(() => {
      const t = setInterval(() => (tick.value = Date.now()), 60_000)
      onBeforeUnmount(() => clearInterval(t))
    })
  }
  return computed(() => new Date(tick.value + clockOffset.value))
}
