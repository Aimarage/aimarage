<script setup lang="ts">
import { briefingPoints } from '~~/shared/utils/digest'
interface AgentData {
  today: string
  runs: { id: string, job: string, status: string, startedAt: string, finishedAt: string | null, model: string | null, tokensIn: number, tokensOut: number, costEur: number, summary: string | null }[]
  feed: { id: string, at: string, action: string, projectId: string | null, taskId: string | null, detail: Record<string, unknown> }[]
  jobs: { type: string, status: string, taskId: string | null }[]
  schedule: { type: string, time: string, weekday?: number, weekly?: boolean }[]
  briefing: { date: string, text: string | null, content: Record<string, unknown> } | null
}

const { t } = useI18n()
const { boot, canEdit, refresh: refreshBoot } = useBoot()
const { base } = useScope()
const { dateTime, dayDm } = useFormat()
const toast = useToast()
useHead({ title: t('agent.protocol') })

const { data, refresh } = await useFetch<AgentData>('/api/agent', { key: 'agent' })
let poll: ReturnType<typeof setInterval> | undefined
onMounted(() => (poll = setInterval(() => data.value?.jobs.length && refresh(), 3000)))
onBeforeUnmount(() => clearInterval(poll))

async function run(job: string) {
  try {
    await $fetch('/api/agent/run', { method: 'POST', body: { job } })
    toast.push(t('agent.started'))
    await refresh()
    setTimeout(async () => {
      await refresh()
      await refreshBoot()
    }, 2500)
  }
  catch (err) {
    toast.error(err)
  }
}

const briefing = computed(() => data.value?.briefing?.content as { todayCount?: number, approvals?: number, overdue?: number, todayMinutes?: number, followups?: string[] } | undefined)
const cost = (n: number) => (n ? `${n.toFixed(4)} EUR` : '-')
</script>

<template>
  <div v-if="data" class="page">
    <div class="page-head">
      <div>
        <p class="crumbs"><NuxtLink :to="`${base}/agent`">{{ t('agent.title') }}</NuxtLink></p>
        <h1>{{ t('agent.protocol') }}</h1>
      </div>
    </div>

    <p v-if="!boot?.agent.configured" class="panel notice">{{ t('agent.notConfiguredText') }} <NuxtLink to="/einstellungen/ki">{{ t('settings.title') }}</NuxtLink></p>

    <section v-if="data.briefing" class="panel">
      <div class="panel-head"><h2>{{ t('agent.briefing') }}</h2><span class="count">{{ dayDm(data.briefing.date) }}</span></div>
      <div class="panel-body brief">
        <ul v-if="data.briefing.text" class="facts"><li v-for="(b, i) in briefingPoints(data.briefing.text)" :key="i">{{ b }}</li></ul>
        <ul v-if="briefing" class="facts">
          <li>{{ t('dash.draftsWaiting', briefing.approvals ?? 0) }}</li>
          <li>{{ t('dash.today') }}: {{ briefing.todayCount ?? 0 }}<template v-if="briefing.todayMinutes">, ca. {{ briefing.todayMinutes }} Min</template></li>
          <li v-if="briefing.overdue">{{ t('dash.overdue') }}: {{ briefing.overdue }}</li>
          <li v-for="f in briefing.followups ?? []" :key="f">{{ f }}</li>
        </ul>
      </div>
    </section>

    <div class="cols">
      <AgentFeed class="grow" :items="data.feed" :base="base" :limit="30" />
      <section class="panel grow">
        <div class="panel-head"><h2>{{ t('agent.schedule') }}</h2></div>
        <ul class="rows">
          <li v-for="s in data.schedule" :key="s.type" class="sch">
            <span class="mono dim">{{ s.weekly ? `${t('days.short.1')} ` : s.weekday ? `${t(`days.short.${s.weekday}`)} ` : '' }}{{ s.time }}</span>
            <span class="ellipsis grow2">{{ t(`agent.jobsNames.${s.type}`) }}</span>
            <span v-if="data.jobs.some(j => j.type === s.type)" class="pill s-entwurf_fertig">{{ t('agent.runStatus.running') }}</span>
            <button v-else-if="canEdit" type="button" class="btn small" @click="run(s.type)"><Icon name="play" :size="12" />{{ t('agent.runNow') }}</button>
          </li>
        </ul>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>{{ t('agent.runs') }}</h2><span class="count">{{ data.runs.length }}</span></div>
      <table v-if="data.runs.length" class="tbl">
        <thead><tr><th>{{ t('reports.day') }}</th><th>Job</th><th class="hide-m">{{ t('settings.status') }}</th><th class="hide-m">{{ t('agent.tokens') }}</th><th class="hide-m">{{ t('agent.cost') }}</th></tr></thead>
        <tbody>
          <tr v-for="r in data.runs" :key="r.id">
            <td class="mono nowrap">{{ dateTime(r.startedAt) }}</td>
            <td><b>{{ t(`agent.jobsNames.${r.job}`) }}</b><div class="dim small">{{ r.summary }}</div></td>
            <td class="hide-m"><span class="pill" :class="r.status === 'ok' ? 's-erledigt' : r.status === 'error' ? 's-wartet' : ''">{{ t(`agent.runStatus.${r.status}`) }}</span></td>
            <td class="hide-m mono small">{{ r.tokensIn + r.tokensOut || '-' }}</td>
            <td class="hide-m mono small">{{ cost(r.costEur) }}<div v-if="r.model" class="dim">{{ r.model }}</div></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">{{ t('agent.noRuns') }}</p>
    </section>
  </div>
</template>

<style scoped>
.notice {
  margin: 0;
  padding: 14px 16px;
  color: var(--muted);
  border-left: 3px solid var(--agent);
}

.brief p {
  margin: 0 0 10px;
}

.facts {
  margin: 0;
  padding-left: 18px;
  color: var(--muted);
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

.sch {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 0 16px;
  font-size: 13.5px;
}

.sch .mono {
  min-width: 70px;
  font-size: 12px;
}

.grow2 {
  flex: 1 1 auto;
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
  vertical-align: top;
}

.tbl th {
  font-weight: 500;
  color: var(--dim);
  font-size: 12px;
}

.small {
  font-size: 12px;
}

.nowrap {
  white-space: nowrap;
  font-size: 12px;
}
</style>
