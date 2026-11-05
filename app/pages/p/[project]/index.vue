<script setup lang="ts">
import { daysUntil, minutesOf, weekday } from '~~/shared/utils/dates'
import type { Waiting } from '~~/shared/utils/task-state'
import type { TaskItem } from '~~/server/services/views'
import type { GoalItem } from '~/components/GoalList.vue'
import type { AccessProblem } from '~~/shared/utils/access'
import type { ReviewerRelease } from '~/components/ReviewerReleases.vue'
import type { AutoStrategyNote } from '~/components/AutoStrategyNotes.vue'

type DoneKey = 'posted' | 'mails' | 'drafted' | 'checked' | 'approved' | 'done' | 'moved' | 'dropped'
const DONE_KEYS: DoneKey[] = ['posted', 'mails', 'drafted', 'checked', 'approved', 'done', 'moved', 'dropped']

interface Dashboard {
  today: string
  now: string
  kpis: { projectId: string, key: string, label: string, value: number | null, prev: number | null, change: number | null, series: (number | null)[] }[]
  kpiDay: string
  status: { approvals: number, approvalId?: string | null, later?: Waiting | null, approvedUntil?: string | null, overdue: number, minutes: number, afterCheck?: { title: string, time: string | null, min: number }[], claudeChecking?: number, access?: AccessProblem[], budget: number, visitors: number | null, visitorsChange: number | null }
  done: Record<'ai' | 'claude' | 'you', Record<DoneKey, number>>
  today_tasks: TaskItem[]
  feed: { id: string, at: string, action: string, projectId: string | null, taskId: string | null, detail: Record<string, unknown> }[]
  campaignStart: string | null
  goals: GoalItem[]
  goalsTotal: number
  reviewer?: ReviewerRelease[]
  autoStrategy?: AutoStrategyNote[]
}

const { t } = useI18n()
const { boot, refresh: refreshBoot } = useBoot()
const { project, isAll, base, query } = useScope()
const { longDate, dayLong, dayDm, dayShort, num, pct, tz } = useFormat()
const toast = useToast()
const nowDate = useNow()
useHead({ title: computed(() => project.value?.name ?? t('nav.allProjects')) })


const { data, refresh } = await useFetch<Dashboard>('/api/dashboard', { query, key: computed(() => `dash:${query.value.project ?? 'alle'}`) })
const cal = useCalendar()
const laterText = computed(() => {
  const w = data.value?.status.later
  if (!w || !data.value) return ''
  const k = w.next ? daysUntil(data.value.today, w.next) : 0
  const day = !w.next || k < 1 ? '' : k === 1 ? t('approvals.due.tomorrow') : k < 7 ? dayShort(w.next) : dayDm(w.next)
  return `${t('dash.laterWaiting', w.approvals, { named: { n: w.approvals } })}${w.info ? t('dash.laterInfo', w.info, { named: { n: w.info } }) : ''}${day ? t('dash.laterNext', { day }) : ''}`
})

const greeting = computed(() => {
  const h = Math.floor(minutesOf(new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz.value }).format(nowDate.value)) / 60)
  const key = h < 11 ? 'morning' : h < 18 ? 'day' : 'evening'
  return t(`dash.greeting.${key}`, { name: boot.value?.user.name ?? '' })
})

const doneList = computed(() => {
  const d = data.value?.done
  if (!d) return ''
  return (['ai', 'claude', 'you'] as const).map((by) => {
    const parts = DONE_KEYS.filter(k => d[by][k] > 0).map(k => t(`dash.done.${k}`, d[by][k], { named: { n: d[by][k] } }))
    return parts.length ? `${parts.join(', ')} (${t(`dash.by.${by}`)})` : ''
  }).filter(Boolean).join('; ')
})

async function reload() {
  await Promise.all([refresh(), cal.refresh(), refreshBoot()])
}

async function markDone(id: string, box?: HTMLInputElement) {
  try {
    const r = await $fetch<{ closed: boolean, items: { text: string, done: boolean }[] }>(`/api/tasks/${id}/check`, { method: 'POST', body: { orDone: true } })
    if (!r.closed) {
      if (box) box.checked = false
      toast.push(t('task.checkOpenOne', { what: r.items.filter(i => !i.done).slice(0, 3).map(i => i.text).join('; ') }), 'error')
    }
    else if (r.items.length) toast.push(t('task.checkOk'))
    await Promise.all([refresh(), cal.refresh(), refreshBoot()])
  }
  catch (err) {
    if (box) box.checked = false
    toast.error(err)
  }
}
</script>

<template>
  <div v-if="data" class="page">
    <section aria-labelledby="h-brief" class="brief">
      <p class="date mono">{{ longDate(data.today) }}</p>
      <h1 id="h-brief">{{ greeting }}</h1>
      <p v-if="doneList" class="ai-done">{{ t('dash.sinceYesterday', { list: doneList }) }} <NuxtLink :to="`${base}/verlauf`">{{ t('dash.history') }}</NuxtLink></p>
      <p class="status">
        <span v-if="data.status.minutes">{{ t('dash.forYou', data.status.minutes, { named: { min: data.status.minutes } }) }}</span>
        <template v-else-if="data.status.later">{{ t(weekday(data.today) >= 6 ? 'dash.nothingDueWeekend' : 'dash.nothingDue') }}{{ ' ' }}<NuxtLink :to="`${base}/freigaben`" class="strong-link">{{ laterText }}</NuxtLink>.</template>
        <span v-else>{{ t('dash.forYouNothing') }}</span>
        <template v-for="a in data.status.access ?? []" :key="a.key">{{ ' ' }}<NuxtLink :to="a.path" class="late-link">{{ t('dash.accessLine', { what: a.what, project: a.projectName ? ` (${a.projectName})` : '' }) }}</NuxtLink></template>
        <span v-if="data.status.claudeChecking">{{ ' ' }}{{ t('dash.claudeChecking', data.status.claudeChecking, { named: { n: data.status.claudeChecking } }) }}</span>
        <span v-for="a in data.status.afterCheck ?? []" :key="a.title">{{ ' ' }}{{ a.time ? t('dash.afterCheckAt', { time: a.time, title: a.title }) : t('dash.afterCheck', { title: a.title }) }}</span>
        <i18n-t v-if="data.status.approvals" keypath="dash.draftsLine" tag="span" scope="global">
          <template #drafts>{{ ' ' }}<NuxtLink :to="data.status.approvalId ? `${base}/freigaben/${data.status.approvalId}` : `${base}/freigaben`" class="strong-link">{{ t('dash.draftsWaiting', data.status.approvals) }}</NuxtLink></template>
        </i18n-t>
        <span v-if="data.status.approvedUntil && data.status.approvedUntil > data.today">{{ ' ' }}{{ t('dash.approvedUntil', { date: dayDm(data.status.approvedUntil) }) }}</span>
        <template v-if="data.status.overdue">{{ ' ' }}<NuxtLink :to="`${base}/aufgaben?scope=overdue`" class="late-link">{{ t('dash.overdueLine', data.status.overdue) }}</NuxtLink></template>
        {{ ' ' }}
        <i18n-t v-if="data.status.visitors !== null" :plural="data.status.visitors" :keypath="data.status.visitorsChange !== null && data.status.visitors >= 10 ? 'dash.visitorsLine' : 'dash.visitorsLineNoChange'" tag="span" scope="global">
          <template #n><b class="mono">{{ num(data.status.visitors) }}</b></template>
          <template #pct><span class="mono chg" :class="(data.status.visitorsChange ?? 0) >= 0 ? 'up' : 'down'">{{ pct(data.status.visitorsChange) }}</span></template>
          <template #day>{{ dayLong(data.kpiDay) }}</template>
        </i18n-t>
        <span v-else-if="data.campaignStart && data.campaignStart > data.today">{{ t('dash.campaignStarts', { date: dayDm(data.campaignStart) }) }}</span>
        <NuxtLink v-else :to="`${base}/berichte`">{{ t('dash.noVisitors') }}</NuxtLink>
      </p>
      <InboxLines />
    </section>

    <FirstSteps v-if="isAll" />

    <KpiStrip :kpis="data.kpis" :day="data.kpiDay" :all="isAll" :to="`${base}/berichte`" />

    <CalendarBoard
      :items="cal.data.value?.items ?? []"
      :view="cal.view.value"
      :anchor="cal.anchor.value"
      :today="data.today"
      :color-by="isAll ? 'project' : 'category'"
      :base="base"
      @update:view="cal.setView"
      @update:anchor="(a: string) => (cal.anchor.value = a)"
    />

    <div class="split">
      <TodayList class="today" :access="data.status.access ?? []" :items="data.today_tasks" :today="data.today" :base="base" @done="markDone" />
      <div class="side-col">
        <AutoStrategyNotes :items="data.autoStrategy ?? []" @undone="reload" />
        <ReviewerReleases :items="data.reviewer ?? []" @stopped="reload" />
        <section v-if="data.goals.length" aria-labelledby="h-goals" class="panel">
          <div class="panel-head"><h2 id="h-goals">{{ t('goals.title') }}</h2><NuxtLink :to="`${base}/strategie`" class="more mono">{{ data.goalsTotal > data.goals.length ? t('goals.allN', { n: data.goalsTotal }) : t('nav.strategy') }}</NuxtLink></div>
          <GoalList :goals="data.goals" :show-project="isAll" :to="`${base}/strategie`" compact />
        </section>
        <AgentFeed :items="data.feed" :base="base" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.late-link {
  color: var(--down);
}

.brief {
  margin-bottom: 8px;
}

.date {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--dim);
}

h1 {
  margin: 0;
  font-size: 32px;
  line-height: 1.12;
  font-weight: 600;
  letter-spacing: -0.022em;
}

.ai-done {
  margin: 14px 0 0;
  max-width: 64ch;
  color: var(--text);
  font-size: 16px;
  line-height: 1.55;
}

.status {
  margin: 6px 0 0;
  max-width: 58ch;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.55;
}

.status b {
  color: var(--text);
  font-weight: 500;
}

.strong-link {
  color: var(--text);
  font-weight: 500;
  text-decoration-color: var(--agent);
  text-underline-offset: 4px;
}

.chg {
  white-space: nowrap;
}

.chg.up {
  color: var(--up);
}

.chg.down {
  color: var(--down);
}

.split {
  display: flex;
  flex-wrap: wrap;
  gap: 32px;
  align-items: flex-start;
}

.today {
  flex: 999 1 520px;
}

.side-col {
  flex: 1 1 340px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.more {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--dim);
  text-decoration: none;
}

/* Handy */
@media (max-width: 600px) {
  h1 {
    font-size: 25px;
  }

  .split {
    gap: 24px;
  }

  .today,
  .side-col {
    flex-basis: 100%;
  }
}
</style>
