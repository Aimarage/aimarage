import { addDays } from '~~/shared/utils/dates'
import { todoOf, type Todo, type TodoFacts } from '~~/shared/utils/todo'

export interface TodoView {
  todo: Todo
  line: string
  sub: string
  flair: string
}

export function useTodo() {
  const { t } = useI18n()
  const { boot } = useBoot()
  const { dm, time, isoDay, dayShort, dateTime } = useFormat()

  const when = (iso: string) => {
    const day = isoDay(iso)
    const today = boot.value?.today ?? isoDay(new Date())
    if (day === today) return t('todo.today', { time: time(iso) })
    if (day === addDays(today, 1)) return t('todo.tomorrow', { time: time(iso) })
    return t('todo.on', { day: `${dayShort(day)} ${dm(day)}`, time: time(iso) })
  }

  return (f: TodoFacts): TodoView => {
    const todo = todoOf(f)
    const p = { ...todo.params }
    if ('platform' in p && !p.platform) p.platform = t('todo.fallback.platform')
    if ('host' in p && !p.host) p.host = t('todo.fallback.host')
    if (todo.at) p.when = when(todo.at)
    if (todo.doneAt) p.at = dateTime(todo.doneAt)
    if (todo.waitDay) {
      p.day = t(`days.long.${todo.waitDay}`)
      p.dayAdv = t(`todo.dayAdv.${todo.waitDay}`)
    }
    const line = todo.text ?? t(`todo.${todo.key}`, p)
    const why = todo.why ? t(`todo.why.${todo.why}`, { place: p.place ?? '', ...todo.whyParams, ...(p.platform ? { platform: p.platform } : {}) }) : ''
    const min = todo.min > 0 ? t('todo.min', { n: todo.min }) : ''
    const flair = todo.flair ? t('todo.flair', { flair: todo.flair }) : todo.flairRequired ? t('todo.flairRequired', { place: f.place ?? t('todo.fallback.place') }) : ''
    return { todo, line, sub: [why, min].filter(Boolean).join(' · '), flair }
  }
}
