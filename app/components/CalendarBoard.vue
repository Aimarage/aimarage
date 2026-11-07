<script setup lang="ts">
import { addDays, addMonths, eachDay, minutesOf, startOfMonth, startOfWeek, timeOf, weekday } from '~~/shared/utils/dates'
import type { CalView } from '~~/shared/utils/domain'
import { platformRule } from '~~/shared/utils/social'
import type { TaskItem } from '~~/server/services/views'

const props = withDefaults(defineProps<{
  items: TaskItem[]
  view: CalView
  anchor: string
  today: string
  colorBy: 'category' | 'project'
  base: string
  hourHeight?: number
  startHour?: number
  endHour?: number
  draggable?: boolean
  legend?: boolean
  headingTag?: string
}>(), { hourHeight: 30, startHour: 7, endHour: 19, draggable: false, legend: true, headingTag: 'h2' })

const emit = defineEmits<{
  'update:view': [CalView]
  'update:anchor': [string]
  'move': [id: string, date: string, time: string | null]
}>()

const { t } = useI18n()
const { dayShort, dayLong, dm, monthYear, dayMonth } = useFormat()
const { projectColor, categoryColor } = useColors()
const { boot } = useBoot()
const nowDate = useNow()
const { tz } = useFormat()

const NuxtLink = resolveComponent('NuxtLink')

const days = computed(() => {
  if (props.view === 'day') return [props.anchor]
  if (props.view === 'week') return eachDay(startOfWeek(props.anchor), addDays(startOfWeek(props.anchor), 6))
  const first = startOfMonth(props.anchor)
  const last = addDays(addMonths(first, 1), -1)
  return eachDay(startOfWeek(first), addDays(startOfWeek(last), 6))
})

const title = computed(() => {
  if (props.view === 'day') return `${dayLong(props.anchor)}, ${dayMonth(props.anchor)}`
  if (props.view === 'month') return monthYear(props.anchor)
  const from = days.value[0]!
  const to = days.value[6]!
  const sameMonth = from.slice(5, 7) === to.slice(5, 7)
  return t('cal.weekTitle', { from: sameMonth ? `${Number(from.slice(8, 10))}.` : dayMonth(from), to: dayMonth(to) })
})

function shift(dir: number) {
  if (props.view === 'day') emit('update:anchor', addDays(props.anchor, dir))
  else if (props.view === 'week') emit('update:anchor', addDays(props.anchor, dir * 7))
  else emit('update:anchor', addMonths(startOfMonth(props.anchor), dir))
}

const color = (it: TaskItem) => (props.colorBy === 'project' ? projectColor(it.projectId) : categoryColor(it.category))

const byDay = computed(() => {
  const m = new Map<string, TaskItem[]>()
  for (const it of props.items) {
    if (!it.dueDate) continue
    const list = m.get(it.dueDate) ?? []
    list.push(it)
    m.set(it.dueDate, list)
  }
  for (const list of m.values()) list.sort((a, b) => (a.dueTime ?? '').localeCompare(b.dueTime ?? '') || a.title.localeCompare(b.title))
  return m
})

const hours = computed(() => {
  let start = props.startHour
  let end = props.endHour
  for (const d of days.value) {
    for (const it of byDay.value.get(d) ?? []) {
      if (!it.dueTime) continue
      const s = Math.floor(minutesOf(it.dueTime) / 60)
      const e = Math.ceil((minutesOf(it.dueTime) + it.durationMin) / 60)
      if (s < start) start = Math.max(0, s)
      if (e > end) end = Math.min(24, e)
    }
  }
  return { start, end }
})

const gridHeight = computed(() => (hours.value.end - hours.value.start) * props.hourHeight)

interface Placed { item: TaskItem, top: number, height: number, left: number, width: number }

function placeDay(d: string): Placed[] {
  const timed = (byDay.value.get(d) ?? []).filter(i => i.dueTime)
  const ev = timed.map(i => ({ item: i, s: minutesOf(i.dueTime!), e: minutesOf(i.dueTime!) + Math.max(i.durationMin, 20) }))
  ev.sort((a, b) => a.s - b.s || b.e - a.e)
  const out: Placed[] = []
  let cluster: { ev: typeof ev[number], lane: number }[] = []
  let clusterEnd = -1
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map(c => c.lane + 1))
    for (const c of cluster) {
      const top = (c.ev.s - hours.value.start * 60) * props.hourHeight / 60 + 1
      const height = Math.max(18, (c.ev.e - c.ev.s) * props.hourHeight / 60 - 3)
      out.push({ item: c.ev.item, top, height, left: c.lane / lanes, width: 1 / lanes })
    }
    cluster = []
  }
  for (const e of ev) {
    if (cluster.length && e.s >= clusterEnd) flush()
    const used = new Set(cluster.filter(c => c.ev.e > e.s).map(c => c.lane))
    let lane = 0
    while (used.has(lane)) lane++
    cluster.push({ ev: e, lane })
    clusterEnd = Math.max(clusterEnd, e.e)
  }
  if (cluster.length) flush()
  return out
}

const placed = computed(() => new Map(days.value.map(d => [d, placeDay(d)])))
const allDay = (d: string) => (byDay.value.get(d) ?? []).filter(i => !i.dueTime)

const cols = computed(() => {
  if (props.view === 'day') return '44px minmax(0, 1fr)'
  return '44px repeat(5, minmax(0, 1fr)) repeat(2, minmax(0, 0.5fr))'
})

const nowMinutes = computed(() => {
  const s = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz.value }).format(nowDate.value)
  return minutesOf(s)
})
const nowTop = computed(() => {
  const m = nowMinutes.value - hours.value.start * 60
  if (m < 0 || m > (hours.value.end - hours.value.start) * 60) return null
  return m * props.hourHeight / 60
})

const MARKS = ['forum', 'mail', 'blog', 'directory', 'external']
function itemLabel(it: TaskItem) {
  const when = it.dueTime ? `${it.dueTime} bis ${timeOf(minutesOf(it.dueTime) + it.durationMin)}` : t('cal.allDay')
  const mark = it.platform && !MARKS.includes(it.platform) ? platformRule(it.platform).label : ''
  return [it.title, mark, it.noTarget ? t('where.noTarget') : '', when, it.published ? t('cal.published') : (it.state === 'done' ? t('state.done') : t(`next.${it.next}`)), it.overdue ? t('state.overdue') : '', it.preview ? t('cal.preview') : ''].filter(Boolean).join(', ')
}

const done = (it: TaskItem) => it.state === 'done'

function chipStyle(it: TaskItem) {
  const c = color(it)
  const late = it.overdue ? { boxShadow: 'inset 0 0 0 1.5px var(--down)' } : {}
  if (it.preview) return { background: `color-mix(in srgb, ${c} 6%, var(--panel))`, border: `1px dashed color-mix(in srgb, ${c} 55%, transparent)` }
  if (it.milestone && !done(it)) return { background: c, color: 'var(--on-proj)', fontWeight: 600, ...late }
  return { background: `color-mix(in srgb, ${c} ${done(it) ? 8 : 17}%, var(--panel))`, ...late }
}

const href = (it: TaskItem) => (it.preview ? undefined : `${props.base}/aufgaben/${it.id}`)

const mobileDays = computed(() => {
  if (props.view === 'day') return [props.anchor]
  if (props.view === 'week') {
    const from = days.value.includes(props.today) ? props.today : days.value[0]!
    return days.value.filter(d => d >= from && (byDay.value.get(d)?.length || d === props.today))
  }
  return days.value.filter(d => d.slice(0, 7) === props.anchor.slice(0, 7) && (byDay.value.get(d)?.length ?? 0) > 0)
})

const monthWeeks = computed(() => {
  const out: string[][] = []
  for (let i = 0; i < days.value.length; i += 7) out.push(days.value.slice(i, i + 7))
  return out
})

const legendItems = computed(() => {
  if (props.colorBy === 'project') {
    const list = (boot.value?.projects ?? []).map(p => ({ key: p.id, label: p.name, color: `var(--c-${p.color})` }))
    return [...list, { key: 'alle', label: t('task.allProjects'), color: 'var(--t-all)' }]
  }
  const cats = ['community', 'content', 'outreach', 'verzeichnis', 'social', 'launch', 'bericht', 'messen'] as const
  return cats.map(c => ({ key: c, label: t(`cat.${c}`), color: categoryColor(c) }))
})

const hasPreview = computed(() => props.items.some(i => i.preview))

const dragId = ref<string | null>(null)
const dropTarget = ref<string | null>(null)

function onDragStart(e: DragEvent, it: TaskItem) {
  if (!props.draggable || it.preview) return
  dragId.value = it.id
  e.dataTransfer?.setData('text/plain', it.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDragEnd() {
  dragId.value = null
  dropTarget.value = null
}
function onDragOver(e: DragEvent, key: string) {
  if (!dragId.value) return
  e.preventDefault()
  dropTarget.value = key
}
function onDropTimed(e: DragEvent, d: string) {
  if (!dragId.value) return
  e.preventDefault()
  const el = e.currentTarget as HTMLElement
  const y = e.clientY - el.getBoundingClientRect().top
  const mins = Math.round((hours.value.start * 60 + (y / props.hourHeight) * 60) / 15) * 15
  emit('move', dragId.value, d, timeOf(Math.min(23 * 60 + 45, Math.max(0, mins))))
  onDragEnd()
}
function onDropAllDay(e: DragEvent, d: string) {
  if (!dragId.value) return
  e.preventDefault()
  emit('move', dragId.value, d, null)
  onDragEnd()
}
function onDropMonth(e: DragEvent, d: string) {
  if (!dragId.value) return
  e.preventDefault()
  const it = props.items.find(i => i.id === dragId.value)
  emit('move', dragId.value, d, it?.dueTime ?? null)
  onDragEnd()
}
</script>

<template>
  <section class="cal panel" :aria-label="title">
    <div class="cal-head">
      <component :is="props.headingTag" class="cal-title">{{ title }}</component>
      <div class="ctrl">
        <div role="group" :aria-label="t('cal.view')" class="seg">
          <button v-for="v in (['day', 'week', 'month'] as const)" :key="v" type="button" :aria-pressed="props.view === v" @click="emit('update:view', v)">{{ t(`cal.${v}`) }}</button>
        </div>
        <button type="button" class="nav-btn" :aria-label="t('cal.prev')" @click="shift(-1)"><Icon name="chevron-left" /></button>
        <button type="button" class="today-btn" @click="emit('update:anchor', props.today)">{{ t('cal.today') }}</button>
        <button type="button" class="nav-btn" :aria-label="t('cal.next')" @click="shift(1)"><Icon name="chevron-right" /></button>
      </div>
    </div>

    <div v-if="props.view !== 'month'" class="desk">
      <div class="grid-row head-row" :style="{ gridTemplateColumns: cols }">
        <div />
        <div v-for="d in days" :key="d" class="dhead" :class="{ today: d === props.today }">
          <span class="dn">{{ props.view === 'day' ? dayLong(d) : dayShort(d) }}</span>
          <span class="dd mono">{{ weekday(d) >= 6 && props.view === 'week' ? `${Number(d.slice(8, 10))}.` : dm(d) }}</span>
        </div>
      </div>
      <div class="grid-row allday" :style="{ gridTemplateColumns: cols }">
        <div class="adlabel mono">{{ t('cal.allDay') }}</div>
        <div v-for="d in days" :key="d" class="adcell" :class="{ today: d === props.today, drop: dropTarget === `ad:${d}` }" @dragover="onDragOver($event, `ad:${d}`)" @dragleave="dropTarget = null" @drop="onDropAllDay($event, d)">
          <component :is="it.preview ? 'span' : NuxtLink" v-for="it in allDay(d)" :key="it.id" :to="href(it)" class="chip" :class="{ done: done(it), late: it.overdue, preview: it.preview, dragging: dragId === it.id }" :style="chipStyle(it)" :aria-label="itemLabel(it)" :title="itemLabel(it)" :draggable="props.draggable && !it.preview" @dragstart="onDragStart($event, it)" @dragend="onDragEnd">
            <PlatformMark v-if="it.platform" :platform="it.platform" :size="14" :missing="it.noTarget" />
            <span class="ct ellipsis">{{ it.title }}</span>
            <span v-if="it.published" class="pub" role="img" :title="t('cal.published')" :aria-label="t('cal.published')"><Icon name="check" :size="12" /></span>
            <TaskMark v-else :state="it.state" :next="it.next" :user-id="it.assigneeUserId" :preview="it.preview" />
          </component>
        </div>
      </div>
      <div class="timed" :style="{ height: `${gridHeight}px` }">
        <div v-for="h in hours.end - hours.start - 1" :key="h" class="hline" :style="{ top: `${h * props.hourHeight}px` }" />
        <div class="tgrid" :style="{ gridTemplateColumns: cols }">
          <div class="hours">
            <span v-for="h in hours.end - hours.start - 1" :key="h" class="hl mono" :style="{ top: `${h * props.hourHeight - 7}px` }">{{ String(hours.start + h).padStart(2, '0') }}</span>
          </div>
          <div v-for="d in days" :key="d" class="tcol" :class="{ today: d === props.today, drop: dropTarget === `t:${d}` }" @dragover="onDragOver($event, `t:${d}`)" @dragleave="dropTarget = null" @drop="onDropTimed($event, d)">
            <template v-if="d === props.today && nowTop !== null">
              <div aria-hidden="true" class="nowline" :style="{ top: `${nowTop}px` }" />
              <div aria-hidden="true" class="nowdot" :style="{ top: `${nowTop - 3}px` }" />
            </template>
            <component :is="p.item.preview ? 'span' : NuxtLink" v-for="p in placed.get(d)" :key="p.item.id" :to="href(p.item)" class="ev" :class="{ done: done(p.item), late: p.item.overdue, preview: p.item.preview, dragging: dragId === p.item.id, short: p.height < 26 }" :style="{ ...chipStyle(p.item), top: `${p.top}px`, height: `${p.height}px`, left: `calc(${p.left * 100}% + 4px)`, width: `calc(${p.width * 100}% - 8px)` }" :aria-label="itemLabel(p.item)" :title="itemLabel(p.item)" :draggable="props.draggable && !p.item.preview" @dragstart="onDragStart($event, p.item)" @dragend="onDragEnd">
              <PlatformMark v-if="p.item.platform" :platform="p.item.platform" :size="14" :missing="p.item.noTarget" />
              <span class="ct ellipsis">{{ p.item.title }}</span>
              <span v-if="p.item.published" class="pub" role="img" :title="t('cal.published')" :aria-label="t('cal.published')"><Icon name="check" :size="12" /></span>
              <TaskMark v-else :state="p.item.state" :next="p.item.next" :user-id="p.item.assigneeUserId" :preview="p.item.preview" />
            </component>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="desk month">
      <div class="mgrid mhead">
        <div v-for="d in days.slice(0, 7)" :key="d" class="mh">{{ dayShort(d) }}</div>
      </div>
      <div v-for="(w, wi) in monthWeeks" :key="wi" class="mgrid">
        <div v-for="d in w" :key="d" class="mcell" :class="{ other: d.slice(0, 7) !== props.anchor.slice(0, 7), today: d === props.today, drop: dropTarget === `m:${d}` }" @dragover="onDragOver($event, `m:${d}`)" @dragleave="dropTarget = null" @drop="onDropMonth($event, d)">
          <button type="button" class="mday mono" @click="emit('update:anchor', d); emit('update:view', 'day')">{{ Number(d.slice(8, 10)) }}</button>
          <component :is="it.preview ? 'span' : NuxtLink" v-for="it in (byDay.get(d) ?? []).slice(0, 3)" :key="it.id" :to="href(it)" class="chip" :class="{ done: done(it), late: it.overdue, preview: it.preview }" :style="chipStyle(it)" :aria-label="itemLabel(it)" :draggable="props.draggable && !it.preview" @dragstart="onDragStart($event, it)" @dragend="onDragEnd">
            <PlatformMark v-if="it.platform" :platform="it.platform" :size="14" :missing="it.noTarget" />
            <span class="ct ellipsis">{{ it.title }}</span>
            <span v-if="it.published" class="pub" role="img" :title="t('cal.published')" :aria-label="t('cal.published')"><Icon name="check" :size="12" /></span>
            <TaskMark v-else :state="it.state" :next="it.next" :user-id="it.assigneeUserId" :preview="it.preview" />
          </component>
          <button v-if="(byDay.get(d)?.length ?? 0) > 3" type="button" class="more" @click="emit('update:anchor', d); emit('update:view', 'day')">{{ t('cal.more', { n: byDay.get(d)!.length - 3 }) }}</button>
        </div>
      </div>
    </div>

    <div class="mob">
      <div v-if="!mobileDays.length" class="empty">{{ t('cal.empty') }}</div>
      <div v-for="d in mobileDays" :key="d" class="mday-block">
        <div class="mday-head">
          <span class="mdn" :class="{ today: d === props.today }">{{ d === props.today ? t('cal.todayLabel', { day: dayLong(d) }) : dayLong(d) }}</span>
          <span class="mono dim">{{ dm(d) }}</span>
        </div>
        <div v-if="!(byDay.get(d)?.length)" class="hint">{{ t('cal.empty') }}</div>
        <component :is="it.preview ? 'div' : NuxtLink" v-for="it in byDay.get(d) ?? []" :key="it.id" :to="href(it)" class="mrow">
          <span class="mtime mono" :class="{ late: it.overdue }">{{ it.dueTime ?? t('cal.allDay') }}</span>
          <span class="mchip" :class="{ done: done(it), late: it.overdue, preview: it.preview }" :style="chipStyle(it)">
            <PlatformMark v-if="it.platform" :platform="it.platform" :size="14" :missing="it.noTarget" />
            <span class="ct ellipsis">{{ it.title }}</span>
            <span v-if="it.published" class="pub" role="img" :title="t('cal.published')" :aria-label="t('cal.published')"><Icon name="check" :size="12" /></span>
            <TaskMark v-else :state="it.state" :next="it.next" :user-id="it.assigneeUserId" :preview="it.preview" />
          </span>
        </component>
      </div>
    </div>

    <div v-if="props.legend" class="legend">
      <StateLegend :preview="hasPreview" />
      <span class="cats">
        <span v-for="l in legendItems" :key="l.key" class="lg"><span class="sq" :style="{ background: l.color, width: '7px', height: '7px' }" />{{ l.label }}</span>
      </span>
    </div>
  </section>
</template>

<style scoped>
/* Kopf */
.cal {
  overflow: hidden;
}

.cal-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}

.cal-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.005em;
}

.ctrl {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.ctrl .seg {
  margin-right: 10px;
}

.nav-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin: -8px -4px;
  padding: 8px 4px;
  box-sizing: content-box;
  border-radius: 4px;
  border: 0;
  background: transparent;
  background-clip: content-box;
  color: var(--muted);
  cursor: pointer;
}

.nav-btn:hover {
  background-color: var(--panel2);
  color: var(--text);
}

.today-btn {
  height: 28px;
  margin: -8px 0;
  padding: 8px 6px;
  box-sizing: content-box;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
}

.today-btn:hover {
  color: var(--text);
}

/* Wochenraster */
.grid-row {
  display: grid;
  border-bottom: 1px solid var(--line);
}

.dhead {
  padding: 10px 8px 8px;
  border-left: 1px solid var(--line);
  white-space: nowrap;
  overflow: hidden;
}

.dhead .dn {
  font-size: 13px;
  font-weight: 600;
}

.dhead .dd {
  font-size: 12px;
  margin-left: 4px;
}

.dhead.today {
  background: var(--primary-soft);
  color: var(--primary);
}

.adlabel {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 6px;
  font-size: 10px;
  color: var(--dim);
}

.adcell {
  padding: 5px 4px;
  border-left: 1px solid var(--line);
  min-height: 34px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.adcell.today,
.tcol.today {
  background: var(--primary-soft);
}

.drop {
  outline: 2px dashed var(--primary);
  outline-offset: -3px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 4px 0 7px;
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 11.5px;
  min-width: 0;
  flex: none;
}

.ct {
  flex: 1 1 auto;
}

.timed {
  position: relative;
}

.hline {
  position: absolute;
  left: 44px;
  right: 0;
  border-top: 1px solid var(--line);
}

.tgrid {
  position: absolute;
  inset: 0;
  display: grid;
}

.hours {
  position: relative;
}

.hl {
  position: absolute;
  right: 8px;
  font-size: 10.5px;
  color: var(--dim);
}

.tcol {
  position: relative;
  border-left: 1px solid var(--line);
  min-width: 0;
}

.ev {
  position: absolute;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 5px 4px 0 7px;
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 12px;
  line-height: 1.3;
  overflow: hidden;
  z-index: 1;
}

.ev.short {
  align-items: center;
  padding-top: 0;
}

.ev:hover,
.chip:hover {
  filter: brightness(0.97);
  color: inherit;
  z-index: 2;
}

.done {
  color: var(--muted) !important;
  font-weight: 400 !important;
}

.pub {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  color: var(--up);
}

.mtime.late {
  color: var(--down);
}

.preview {
  color: var(--muted) !important;
  cursor: default;
}

.dragging {
  opacity: 0.4;
}

[draggable='true'] {
  cursor: grab;
}

.nowline {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--primary);
  z-index: 3;
  pointer-events: none;
}

.nowdot {
  position: absolute;
  left: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  z-index: 3;
  pointer-events: none;
}

/* Monat */
.mgrid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border-bottom: 1px solid var(--line);
}

.mh {
  padding: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}

.mh + .mh,
.mcell + .mcell {
  border-left: 1px solid var(--line);
}

.mcell {
  min-height: 112px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mcell.other {
  background: color-mix(in srgb, var(--bg2) 40%, transparent);
}

.mcell.other .mday {
  color: var(--dim);
}

.mcell.today {
  background: var(--primary-soft);
}

.mcell.today .mday {
  color: var(--primary);
  font-weight: 600;
}

.mday {
  align-self: flex-start;
  border: 0;
  background: transparent;
  padding: 2px 4px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  border-radius: 4px;
}

.mday:hover {
  background: var(--panel2);
}

.more {
  border: 0;
  background: transparent;
  text-align: left;
  font-size: 11.5px;
  color: var(--muted);
  padding: 0 4px;
  cursor: pointer;
}

/* Legende */
.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 16px;
  font-size: 12px;
  color: var(--muted);
}

.lg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.cats {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  color: var(--dim);
}

/* Handy */
.mob {
  display: none;
}

.mday-block {
  padding: 14px 16px;
  border-top: 1px solid var(--line);
}

.mday-block:first-child {
  border-top: 0;
}

.mday-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.mdn {
  font-size: 14px;
  font-weight: 600;
}

.mdn.today {
  color: var(--primary);
}

.mrow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  text-decoration: none;
  color: var(--text);
}

.mtime {
  flex: none;
  width: 48px;
  font-size: 12px;
  color: var(--dim);
}

.mchip {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 8px 0 10px;
  border-radius: 4px;
  font-size: 13px;
}

@media (max-width: 600px) {
  .desk {
    display: none;
  }

  .mob {
    display: block;
  }

  .legend {
    border-top: 1px solid var(--line);
  }

  .cats {
    display: none;
  }

  .ctrl .seg {
    margin-right: 2px;
  }
}
</style>
