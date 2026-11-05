<script setup lang="ts">
import { safeHttpUrl } from '~~/shared/utils/url'

interface HistoryData {
  days: number
  from: string
  to: string
  total: number
  perDay: { day: string, n: number }[]
  entries: { taskId: string, code: string, title: string, projectId: string | null, category: string, at: string, day: string, links: { platform: string | null, label: string, url: string }[] }[]
}

const { t } = useI18n()
const { project, base, query } = useScope()
const { dayLong, dayMonth, dayDm, time } = useFormat()
const { projectColor } = useColors()
useHead({ title: t('historyPage.title') })

const days = ref(30)
const { data } = await useFetch<HistoryData>('/api/history', { query: computed(() => ({ ...query.value, days: days.value })), key: computed(() => `history:${query.value.project ?? 'alle'}:${days.value}`) })

const groups = computed(() => {
  const m = new Map<string, HistoryData['entries']>()
  for (const e of data.value?.entries ?? []) m.set(e.day, [...(m.get(e.day) ?? []), e])
  return [...m.entries()].map(([day, items]) => ({ day, items }))
})
const barMax = computed(() => Math.max(1, ...(data.value?.perDay.map(d => d.n) ?? [1])))
const linksOf = (e: HistoryData['entries'][number]) => e.links.map(l => ({ ...l, href: safeHttpUrl(l.url) })).filter(l => l.href)
</script>

<template>
  <div v-if="data" class="page">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('historyPage.title') }}</h1>
      </div>
      <div class="actions">
        <div class="seg" role="group" :aria-label="t('historyPage.period')">
          <button v-for="d in [7, 30, 90]" :key="d" type="button" :aria-pressed="days === d" @click="days = d">{{ t('historyPage.days', { n: d }) }}</button>
        </div>
      </div>
    </div>

    <section class="bars-wrap">
      <div class="bars-head"><span>{{ t('historyPage.perDay') }}</span><span class="count">{{ t('historyPage.entries', data.total) }}</span></div>
      <div class="bars" :class="{ dense: data.perDay.length > 45 }">
        <span v-for="d in data.perDay" :key="d.day" class="bar" :title="t('historyPage.barTitle', { day: dayDm(d.day), n: d.n })">
          <span class="fill" :class="{ zero: !d.n }" :style="{ height: d.n ? `${Math.max(8, (d.n / barMax) * 100)}%` : undefined }" />
        </span>
      </div>
    </section>

    <p v-if="!groups.length" class="empty">{{ t('historyPage.empty') }}</p>

    <section v-for="g in groups" :key="g.day" class="day">
      <h2 class="day-head">{{ dayLong(g.day) }}, {{ dayMonth(g.day) }}<span class="count">{{ g.items.length }}</span></h2>
      <ul class="rows panel">
        <li v-for="e in g.items" :key="`${e.taskId}-${e.at}`" class="entry">
          <span class="mono dim at">{{ time(e.at) }}</span>
          <span v-if="!project" class="sq" :style="{ background: projectColor(e.projectId) }" />
          <NuxtLink :to="`${base}/aufgaben/${e.taskId}`" class="title ellipsis">{{ e.title }}</NuxtLink>
          <span class="links">
            <a v-for="l in linksOf(e)" :key="l.url" :href="l.href!" target="_blank" rel="noopener noreferrer" :title="l.url">{{ l.label }}</a>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* Balken */
.bars-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bars-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 13px;
  color: var(--muted);
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 56px;
}

.bars.dense {
  gap: 1px;
}

.bar {
  flex: 1 1 0;
  height: 100%;
  display: flex;
  align-items: flex-end;
}

.fill {
  display: block;
  width: 100%;
  border-radius: 2px;
  background: var(--agent);
  opacity: 0.75;
}

.fill.zero {
  height: 2px;
  background: var(--line);
  opacity: 1;
}

/* Tage */
.day {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.day-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
}

.entry {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 48px;
  padding: 0 16px;
  font-size: 14px;
}

.at {
  flex: none;
  width: 40px;
  font-size: 12px;
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text);
  text-decoration: none;
}

.title:hover {
  text-decoration: underline;
}

.links {
  flex: none;
  display: flex;
  gap: 12px;
  font-size: 12px;
}

.links a {
  color: var(--dim);
}

.links a:hover {
  color: var(--text);
}

@media (max-width: 600px) {
  .entry {
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 10px 16px;
  }

  .title {
    flex-basis: calc(100% - 60px);
  }

  .links {
    padding-left: 52px;
    flex-wrap: wrap;
  }
}
</style>
