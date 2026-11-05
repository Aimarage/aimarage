<script setup lang="ts">
import type { GoalItem } from '~/components/GoalList.vue'
interface UtmNumbers { visits: number, signups: number, interests: number, purchases: number, netCents: number }
interface Traffic {
  configured: boolean
  lastSync: string | null
  errors: { projectId: string, error: string }[]
  totals: UtmNumbers
  sources: (UtmNumbers & { source: string, campaigns: (UtmNumbers & { campaign: string, medium: string, task: { id: string, code: string, title: string, projectId: string | null } | null })[] })[]
}

interface Reports {
  traffic: Traffic
  from: string
  to: string
  days: number
  metrics: { projectId: string, key: string, label: string, series: (number | null)[], last: number | null, sum: number, hasData: boolean }[]
  done: { category: string, n: number }[]
  results: { channel: string, category: string, metric: string, total: number, n: number }[]
  goals: GoalItem[]
  reports: { id: string, kind: string, periodStart: string, periodEnd: string, text: string | null }[]
  channels: { id: string, projectId: string | null, group: string, name: string, status: 'offen' | 'eingereicht' | 'live' | 'abgelehnt', url: string | null }[]
  recent: { id: string, code: string, title: string, projectId: string | null, category: string, doneAt: string | null, postedUrl: string | null }[]
}

const { t, locale } = useI18n()
const { boot, canEdit } = useBoot()
const { project, base, query } = useScope()
const { num, dayDm, isoDay } = useFormat()
const { projectColor, categoryColor } = useColors()
const toast = useToast()
useHead({ title: t('reports.title') })

const days = ref(30)
const { data, refresh } = await useFetch<Reports>('/api/reports', { query: computed(() => ({ ...query.value, days: days.value })), key: computed(() => `reports:${query.value.project ?? 'alle'}:${days.value}`) })

const projects = computed(() => (project.value ? [project.value] : boot.value?.projects ?? []))
const entry = ref({ projectId: '', key: '', day: '', value: '' as string | number })
watchEffect(() => {
  if (!entry.value.projectId && projects.value[0]) entry.value.projectId = projects.value[0].id
  const p = projects.value.find(x => x.id === entry.value.projectId)
  if (p && !p.kpis.some(k => k.key === entry.value.key)) entry.value.key = p.kpis[0]?.key ?? ''
  if (!entry.value.day && data.value) entry.value.day = data.value.to
})
const entryKpis = computed(() => projects.value.find(p => p.id === entry.value.projectId)?.kpis ?? [])

async function save() {
  if (entry.value.value === '') return
  try {
    await $fetch('/api/metrics', { method: 'POST', body: { projectId: entry.value.projectId, key: entry.value.key, day: entry.value.day, value: Number(entry.value.value) } })
    entry.value.value = ''
    toast.push(t('reports.saved'))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

const channelGroups = computed(() => {
  const m = new Map<string, Reports['channels']>()
  for (const c of data.value?.channels ?? []) {
    const key = `${c.projectId ?? 'alle'}|${c.group}`
    m.set(key, [...(m.get(key) ?? []), c])
  }
  return [...m.entries()].map(([key, items]) => ({ key, projectId: items[0]!.projectId, group: items[0]!.group, items }))
})
const liveCount = computed(() => data.value?.channels.filter(c => c.status === 'live').length ?? 0)

async function setChannel(id: string, status: string) {
  try {
    await $fetch(`/api/channels/${id}`, { method: 'PATCH', body: { status } })
    const c = data.value?.channels.find(x => x.id === id)
    if (c) c.status = status as never
  }
  catch (err) {
    toast.error(err)
  }
}

const money = (cents: number) => new Intl.NumberFormat(locale.value === 'en' ? 'en-GB' : 'de-AT', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)
const settingsLink = computed(() => (project.value ? `${base.value}/einstellungen` : null))

const doneMax = computed(() => Math.max(1, ...(data.value?.done.map(d => d.n) ?? [1])))
</script>

<template>
  <div v-if="data" class="page">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('reports.title') }}</h1>
      </div>
      <div class="actions">
        <a v-if="project" :href="`/api/projects/${project.id}/report-print`" target="_blank" rel="noopener" class="btn small" :title="t('reports.pdfHint')"><Icon name="doc" />{{ t('reports.pdf') }}</a>
        <div class="seg" role="group" :aria-label="t('reports.period')">
          <button v-for="d in [7, 30, 90]" :key="d" type="button" :aria-pressed="days === d" @click="days = d">{{ t('reports.days', { n: d }) }}</button>
        </div>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>{{ t('reports.metrics') }}</h2><span class="count">{{ dayDm(data.from) }} - {{ dayDm(data.to) }}</span></div>
      <ul v-if="data.metrics.some(m => m.hasData)" class="rows">
        <li v-for="m in data.metrics" :key="`${m.projectId}-${m.key}`" class="mrow">
          <span class="sq" :style="{ background: projectColor(m.projectId) }" />
          <span class="ellipsis lbl">{{ project ? '' : `${boot?.projects.find(p => p.id === m.projectId)?.name} - ` }}{{ m.label }}</span>
          <Sparkline class="hide-m" :values="m.series" :color="projectColor(m.projectId)" :width="160" :height="32" />
          <span class="mono val" :title="t('reports.last')">{{ num(m.last) }}</span>
          <span class="mono dim sum" :title="t('reports.sum')">&Sigma; {{ num(m.sum) }}</span>
        </li>
      </ul>
      <p v-else class="empty">{{ t('reports.noData') }}</p>
      <form v-if="canEdit && projects.length" class="entry" @submit.prevent="save">
        <strong class="entry-title">{{ t('reports.enter') }}</strong>
        <select v-if="!project" v-model="entry.projectId" class="select" :aria-label="t('task.project')"><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select>
        <select v-model="entry.key" class="select" :aria-label="t('reports.metric')"><option v-for="k in entryKpis" :key="k.key" :value="k.key">{{ k.label }}</option></select>
        <input v-model="entry.day" class="input" type="date" :aria-label="t('reports.day')">
        <input v-model="entry.value" class="input" type="number" min="0" step="any" :placeholder="t('reports.value')" :aria-label="t('reports.value')">
        <button type="submit" class="btn">{{ t('reports.save') }}</button>
      </form>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>{{ t('reports.traffic.title') }}</h2>
        <span v-if="data.traffic.sources.length" class="count">{{ t('reports.traffic.sum', { visits: num(data.traffic.totals.visits), signups: num(data.traffic.totals.signups), purchases: num(data.traffic.totals.purchases) }) }}</span>
      </div>
      <p v-for="e in data.traffic.errors" :key="e.projectId" class="terr">{{ project ? '' : `${boot?.projects.find(p => p.id === e.projectId)?.name}: ` }}{{ e.error }}</p>
      <div v-if="data.traffic.sources.length" class="utm">
        <div class="urow uhead" aria-hidden="true">
          <span />
          <span>{{ t('reports.traffic.visits') }}</span>
          <span><span class="hide-m">{{ t('reports.traffic.signups') }}</span><span class="only-m">{{ t('reports.traffic.signupsShort') }}</span></span>
          <span>{{ t('reports.traffic.purchases') }}</span>
          <span>{{ t('reports.traffic.revenue') }}</span>
        </div>
        <details v-for="s in data.traffic.sources" :key="s.source" class="usrc">
          <summary class="urow">
            <span class="ellipsis uname">{{ s.source }}</span>
            <span class="mono" :title="t('reports.traffic.visits')">{{ num(s.visits) }}</span>
            <span class="mono" :title="t('reports.traffic.signups')">{{ num(s.signups) }}</span>
            <span class="mono" :title="t('reports.traffic.purchases')">{{ num(s.purchases) }}</span>
            <span class="mono" :title="t('reports.traffic.revenue')">{{ s.netCents ? money(s.netCents) : '-' }}</span>
          </summary>
          <ul class="ucamp">
            <li v-for="c in s.campaigns" :key="`${c.medium}|${c.campaign}`" class="urow">
              <span class="ellipsis uname">
                <NuxtLink v-if="c.task" :to="`${base}/aufgaben/${c.task.id}`" class="ulink"><span class="mono">{{ c.task.code }}</span> {{ c.task.title }}</NuxtLink>
                <template v-else><span class="mono">{{ c.campaign || t('reports.traffic.noCampaign') }}</span></template>
                <span v-if="c.medium" class="dim"> · {{ c.medium }}</span>
              </span>
              <span class="mono">{{ num(c.visits) }}</span>
              <span class="mono">{{ num(c.signups) }}</span>
              <span class="mono">{{ num(c.purchases) }}</span>
              <span class="mono">{{ c.netCents ? money(c.netCents) : '-' }}</span>
            </li>
          </ul>
        </details>
      </div>
      <p v-else-if="data.traffic.configured" class="empty">{{ t('reports.traffic.empty') }}</p>
      <p v-else class="empty">
        {{ t('reports.traffic.off') }}
        <NuxtLink v-if="settingsLink" :to="settingsLink">{{ t('reports.traffic.setup') }}</NuxtLink>
      </p>
    </section>

    <SearchPanel v-if="project" :key="`s-${project.id}`" :project-id="project.id" />
    <SeoPanel v-if="project" :key="`seo-${project.id}`" :project-id="project.id" />
    <GeoPanel v-if="project" :key="`geo-${project.id}`" :project-id="project.id" />
    <BestTimesPanel v-if="project" :key="`bt-${project.id}`" :project-id="project.id" />

    <div class="cols">
      <section class="panel grow">
        <div class="panel-head"><h2>{{ t('reports.done') }}</h2></div>
        <ul v-if="data.done.length" class="rows">
          <li v-for="d in data.done" :key="d.category" class="bar-row">
            <span class="ellipsis bl">{{ t(`cat.${d.category}`) }}</span>
            <span class="bar"><span :style="{ width: `${(d.n / doneMax) * 100}%`, background: categoryColor(d.category as never) }" /></span>
            <span class="mono">{{ d.n }}</span>
          </li>
        </ul>
        <p v-else class="empty">-</p>
      </section>
      <section class="panel grow">
        <div class="panel-head"><h2>{{ t('reports.results') }}</h2></div>
        <table v-if="data.results.length" class="tbl">
          <thead><tr><th>{{ t('reports.channel') }}</th><th>{{ t('reports.metric') }}</th><th class="r">{{ t('reports.sum') }}</th><th class="r">{{ t('reports.count') }}</th></tr></thead>
          <tbody><tr v-for="(r, i) in data.results" :key="i"><td>{{ r.channel }}</td><td>{{ r.metric }}</td><td class="r mono">{{ num(r.total) }}</td><td class="r mono">{{ r.n }}</td></tr></tbody>
        </table>
        <p v-else class="empty">{{ t('reports.noResults') }}</p>
      </section>
    </div>

    <div class="cols">
      <section v-if="data.goals.length" class="panel grow">
        <div class="panel-head"><h2>{{ t('reports.goals') }}</h2></div>
        <GoalList :goals="data.goals" :show-project="!project" :to="`${base}/strategie`" compact />
      </section>
      <section class="panel grow">
        <div class="panel-head"><h2>{{ t('reports.recent') }}</h2></div>
        <ul v-if="data.recent.length" class="rows">
          <li v-for="r in data.recent" :key="r.id">
            <NuxtLink :to="`${base}/aufgaben/${r.id}`" class="row-link">
              <span class="sq" :style="{ background: projectColor(r.projectId) }" />
              <span class="row-title">{{ r.title }}</span>
              <span class="row-meta">{{ r.doneAt ? dayDm(isoDay(r.doneAt)) : '' }}</span>
            </NuxtLink>
          </li>
        </ul>
        <p v-else class="empty">-</p>
      </section>
    </div>

    <section v-if="data.channels.length" class="panel">
      <div class="panel-head"><h2>{{ t('reports.channels') }}</h2><span class="count">{{ t('reports.channelsLive', { n: liveCount, total: data.channels.length }) }}</span></div>
      <details v-for="g in channelGroups" :key="g.key" class="rep">
        <summary><span class="sq" :style="{ background: projectColor(g.projectId) }" /> {{ project ? '' : `${boot?.projects.find(p => p.id === g.projectId)?.name ?? t('task.allProjects')} - ` }}{{ g.group }} <span class="dim mono small">{{ g.items.filter(i => i.status === 'live').length }}/{{ g.items.length }}</span></summary>
        <ul class="rows ch-list">
          <li v-for="c in g.items" :key="c.id" class="ch">
            <span class="ellipsis grow2">{{ c.name }}</span>
            <select class="select ch-sel" :value="c.status" :disabled="!canEdit" :aria-label="c.name" @change="setChannel(c.id, ($event.target as HTMLSelectElement).value)">
              <option v-for="st in ['offen', 'eingereicht', 'live', 'abgelehnt']" :key="st" :value="st">{{ t(`reports.channelStatus.${st}`) }}</option>
            </select>
          </li>
        </ul>
      </details>
    </section>

    <section v-if="data.reports.length" class="panel">
      <div class="panel-head"><h2>{{ t('reports.weekly') }}</h2></div>
      <details v-for="r in data.reports" :key="r.id" class="rep">
        <summary>{{ dayDm(r.periodStart) }} - {{ dayDm(r.periodEnd) }}</summary>
        <div class="rep-text">{{ r.text }}</div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.mrow {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 52px;
  padding: 0 16px;
}

.lbl {
  flex: 1 1 auto;
}

.mrow :deep(.spark) {
  margin-left: 0;
}

.val {
  min-width: 56px;
  text-align: right;
  font-size: 16px;
}

.sum {
  min-width: 72px;
  text-align: right;
  font-size: 12px;
}

.entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--line);
}

.entry-title {
  font-size: 13px;
  margin-right: 4px;
}

.entry .select,
.entry .input {
  width: auto;
  flex: 1 1 130px;
}

.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-start;
}

.grow {
  flex: 1 1 360px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 0 16px;
  font-size: 13px;
}

.bl {
  flex: 0 0 100px;
}

.bar {
  flex: 1 1 auto;
  height: 8px;
  border-radius: 4px;
  background: var(--panel2);
  overflow: hidden;
}

.bar span {
  display: block;
  height: 100%;
  border-radius: 4px;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.tbl th,
.tbl td {
  padding: 9px 16px;
  text-align: left;
  border-bottom: 1px solid var(--line);
}

.tbl tr:last-child td {
  border-bottom: 0;
}

.tbl th {
  font-weight: 500;
  color: var(--dim);
  font-size: 12px;
}

.r {
  text-align: right !important;
}

@media (max-width: 600px) {
  .tbl th,
  .tbl td {
    padding: 8px 8px;
  }

  .tbl th:first-child,
  .tbl td:first-child {
    padding-left: 16px;
  }
}

.ch {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  font-size: 13.5px;
}

.grow2 {
  flex: 1 1 auto;
}

.ch-sel {
  width: auto;
  min-height: 32px;
  padding: 4px 8px;
  font-size: 13px;
}

.ch-list {
  margin-top: 8px;
}

.small {
  font-size: 11.5px;
}

.rep summary .sq {
  vertical-align: middle;
}

.rep {
  border-top: 1px solid var(--line);
  padding: 12px 16px;
}

.rep:first-of-type {
  border-top: 0;
}

.rep summary {
  cursor: pointer;
  font-weight: 500;
}

.terr {
  margin: 0;
  padding: 0 16px 8px;
  color: var(--down);
  font-size: 12.5px;
}

.urow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(4, 84px);
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 16px;
  font-size: 13.5px;
}

.urow > span:not(:first-child) {
  text-align: right;
}

.uhead {
  min-height: 28px;
  color: var(--dim);
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}

.usrc {
  border-bottom: 1px solid var(--line);
}

.usrc:last-child {
  border-bottom: 0;
}

.usrc > summary {
  cursor: pointer;
  list-style: none;
}

.usrc > summary::-webkit-details-marker {
  display: none;
}

.usrc > summary:hover {
  background: var(--panel2);
}

.uname {
  font-weight: 500;
}

.ucamp {
  margin: 0;
  padding: 4px 0 8px;
  list-style: none;
  background: var(--panel2);
}

.ucamp .urow {
  min-height: 36px;
  font-size: 12.5px;
}

.ucamp .uname {
  font-weight: 400;
  padding-left: 12px;
}

.ulink {
  color: inherit;
}

@media (max-width: 600px) {
  .urow {
    grid-template-columns: minmax(0, 1fr) repeat(4, 52px);
    gap: 4px;
    padding: 0 12px;
    font-size: 12.5px;
  }

  .uhead {
    font-size: 10.5px;
  }

  .ucamp .uname {
    padding-left: 4px;
  }
}

.rep-text {
  white-space: pre-wrap;
  margin-top: 8px;
  color: var(--muted);
  font-size: 13.5px;
}
</style>
