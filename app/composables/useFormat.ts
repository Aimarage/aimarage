import { parseIso, weekday } from '~~/shared/utils/dates'

export function useFormat() {
  const { boot } = useBoot()
  const { t, locale } = useI18n()
  const tz = computed(() => boot.value?.workspace.timezone ?? 'Europe/Vienna')
  const loc = computed(() => (locale.value === 'en' ? 'en-GB' : 'de-AT'))

  const dayShort = (d: string) => t(`days.short.${weekday(d)}`)
  const dayLong = (d: string) => t(`days.long.${weekday(d)}`)
  const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`
  const dayDm = (d: string) => `${dayShort(d)} ${dm(d)}`
  const longDate = (d: string) => new Intl.DateTimeFormat(loc.value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseIso(d))
  const monthYear = (d: string) => new Intl.DateTimeFormat(loc.value, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseIso(d))
  const dayMonth = (d: string) => new Intl.DateTimeFormat(loc.value, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(parseIso(d))
  const time = (iso: string | Date) => new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz.value }).format(new Date(iso))
  const dateTime = (iso: string | Date) => new Intl.DateTimeFormat(loc.value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz.value }).format(new Date(iso))
  const isoDay = (iso: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz.value, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
  const num = (n: number | null | undefined) => (n === null || n === undefined ? '-' : new Intl.NumberFormat(loc.value, { maximumFractionDigits: 1 }).format(n))
  const pct = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${n > 0 ? '+' : ''}${n} %`)
  const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} Min` : ''}` : `${m} Min`)

  return { tz, dayShort, dayLong, dm, dayDm, longDate, monthYear, dayMonth, time, dateTime, isoDay, num, pct, minutes }
}
