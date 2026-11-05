import { addDays, addMonths, startOfMonth, startOfWeek } from '~~/shared/utils/dates'
import type { CalView } from '~~/shared/utils/domain'
import type { TaskItem } from '~~/server/services/views'

export function rangeFor(view: CalView, anchor: string): { from: string, to: string } {
  if (view === 'day') return { from: anchor, to: anchor }
  if (view === 'week') return { from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 6) }
  const first = startOfMonth(anchor)
  const last = addDays(addMonths(first, 1), -1)
  return { from: startOfWeek(first), to: addDays(startOfWeek(last), 6) }
}

export function useCalendar() {
  const { boot } = useBoot()
  const { query } = useScope()
  const view = useState<CalView>('cal-view', () => boot.value?.user.prefs.calView ?? 'week')
  const anchor = useState<string>('cal-anchor', () => {
    const today = boot.value?.today ?? new Date().toISOString().slice(0, 10)
    const start = boot.value?.campaignStart
    return start && start > today ? start : today
  })
  const range = computed(() => rangeFor(view.value, anchor.value))

  const { data, refresh, pending } = useFetch<{ from: string, to: string, items: TaskItem[] }>('/api/calendar', {
    query: computed(() => ({ ...query.value, from: range.value.from, to: range.value.to })),
    key: computed(() => `cal:${query.value.project ?? 'alle'}:${range.value.from}:${range.value.to}`),
    default: () => ({ from: '', to: '', items: [] }),
  })

  async function setView(v: CalView) {
    view.value = v
    if (boot.value) boot.value.user.prefs = { ...boot.value.user.prefs, calView: v }
    await $fetch('/api/me', { method: 'PATCH', body: { prefs: { calView: v } } }).catch(() => {})
  }

  return { view, anchor, range, data, refresh, pending, setView }
}
