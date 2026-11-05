<script setup lang="ts">
import type { StrategyChange, StrategyChannel } from '~~/server/db/schema'
import type { GoalItem } from '~/components/GoalList.vue'
import type { ChannelDetail, ChannelStat } from '~/components/StrategyRows.vue'

interface StrategyView {
  id: string
  version: number
  status: string
  kind: string
  summary: string | null
  channels: StrategyChannel[]
  changes: StrategyChange[]
  byAgent: boolean
  createdAt: string
  decidedAt: string | null
}

interface Data {
  today: string
  project: { id: string, slug: string, name: string, setup: { state: string, analysis: { positioning?: string, audiences?: string[], competitors?: { name: string, url?: string | null, note?: string | null }[], communities?: string[], keywords?: string[] } | null, site: { title?: string | null } | null, budget: string | null, plan: string | null } } | null
  details: Record<string, ChannelDetail>
  rethinking: boolean
  goals: GoalItem[]
  active: StrategyView | null
  pending: StrategyView | null
  history: StrategyView[]
  stats: Record<string, ChannelStat>
  lastReview: { at: string, text: string } | null
}

const { t } = useI18n()
const { project, base, query, isAll } = useScope()
const { boot, canEdit, refresh: refreshBoot } = useBoot()
const { dayDm, isoDay } = useFormat()
const toast = useToast()
useHead({ title: t('strategy.title') })

const previewMode = computed(() => boot.value?.workspace.preview === 'used')
const { data, refresh } = await useFetch<Data>('/api/strategy', { query, key: computed(() => `strategy:${query.value.project ?? 'alle'}`), immediate: !previewMode.value })
const goals = computed(() => (data.value?.goals ?? []).filter(g => g.active || showArchived.value))
const showArchived = ref(false)
const archivedCount = computed(() => (data.value?.goals ?? []).filter(g => !g.active).length)

const adding = ref(false)
const ng = ref({ label: '', target: '', deadline: '', mode: 'sum' as 'sum' | 'last' | 'month' })
async function addGoal() {
  try {
    await $fetch('/api/goals', { method: 'POST', body: { project: project.value!.slug, label: ng.value.label, targetValue: ng.value.target ? Number(ng.value.target.replace(',', '.')) : null, deadline: ng.value.deadline || null, mode: ng.value.mode } })
    ng.value = { label: '', target: '', deadline: '', mode: 'sum' }
    adding.value = false
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

async function change(c: { key: string, weight?: number, active?: boolean }) {
  try {
    const r = await $fetch<{ created: number }>('/api/strategy', { method: 'PATCH', body: { project: project.value!.slug, ...c } })
    toast.push(t('strategy.changed', { n: r.created }))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

const reviewing = ref(false)
async function review() {
  reviewing.value = true
  try {
    await $fetch('/api/agent/run', { method: 'POST', body: { job: 'strategy_review' } })
    toast.push(t('strategy.reviewStarted'))
    setTimeout(async () => {
      await Promise.all([refresh(), refreshBoot()])
      reviewing.value = false
    }, 4000)
  }
  catch (err) {
    reviewing.value = false
    toast.error(err)
  }
}

const analysis = computed(() => data.value?.project?.setup.analysis ?? null)

const startingRethink = ref(false)
const rethinking = computed(() => startingRethink.value || !!data.value?.rethinking)
let poll: ReturnType<typeof setTimeout> | undefined
function schedulePoll() {
  clearTimeout(poll)
  if (rethinking.value) {
    poll = setTimeout(async () => {
      await refresh()
      startingRethink.value = false
      if (!data.value?.rethinking) await refreshBoot()
      schedulePoll()
    }, 5000)
  }
}
watch(rethinking, schedulePoll, { immediate: true })
onBeforeUnmount(() => clearTimeout(poll))
async function rethink() {
  startingRethink.value = true
  try {
    await $fetch('/api/strategy/rethink', { method: 'POST', body: { project: project.value!.slug } })
    toast.push(t('strategy.rethinkStarted'))
  }
  catch (err) {
    startingRethink.value = false
    toast.error(err)
  }
}
const historyRows = computed(() => (data.value?.history ?? []).flatMap(h => h.changes.map((c, i) => ({ key: `${h.id}-${i}`, at: h.decidedAt ?? h.createdAt, version: h.version, status: h.status, byAgent: h.byAgent, kind: h.kind, c }))).slice(0, 20))
</script>

<template>
  <div v-if="previewMode" class="page">
    <div class="page-head"><div><p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p><h1>{{ t('strategy.title') }}</h1></div></div>
    <PreviewTeaser v-if="project" :project-id="project.id" />
  </div>
  <div v-else-if="data" class="page">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('strategy.title') }}</h1>
      </div>
      <div v-if="!isAll" class="actions">
        <NuxtLink :to="`${base}/agent`" class="btn"><Icon name="chat" />{{ t('strategy.discuss') }}</NuxtLink>
        <button v-if="canEdit && data.active" type="button" class="btn" :disabled="reviewing || rethinking" @click="review"><Icon name="play" :size="12" />{{ t('strategy.reviewNow') }}</button>
        <button v-if="canEdit && boot?.agent.ready && data.project?.setup.state !== 'onboarding'" type="button" class="btn primary" :disabled="rethinking" @click="rethink"><Icon name="agent" :size="14" />{{ rethinking ? t('strategy.rethinking') : t('strategy.rethink') }}</button>
      </div>
    </div>

    <NuxtLink v-if="data.pending && data.project?.setup.state !== 'onboarding'" :to="`${base}/freigaben/vorschlag/${data.pending.id}`" class="panel notice">
      <span class="dot" /> {{ t('strategy.pendingNotice', { n: data.pending.changes.length || data.pending.channels.length }) }}<Icon name="chevron-right" />
    </NuxtLink>
    <div v-if="data.project?.setup.state === 'onboarding' && data.pending" class="panel">
      <div class="panel-head"><h2>{{ t('strategy.proposal') }}</h2></div>
      <div class="pad16"><StrategyCard :id="data.pending.id" :embedded="false" editable @decided="() => refresh()" /></div>
    </div>

    <p v-if="rethinking" class="panel notice"><span class="dot" />{{ t('strategy.rethinkingLong') }}</p>

    <section class="panel">
      <div class="panel-head">
        <h2>{{ t('goals.title') }}</h2><span class="count">{{ data.goals.filter(g => g.active).length }}</span>
        <button v-if="archivedCount" type="button" class="btn ghost small push" @click="showArchived = !showArchived">{{ showArchived ? t('goals.hideArchived') : t('goals.showArchived', { n: archivedCount }) }}</button>
        <button v-if="canEdit && !isAll" type="button" class="btn small" :class="{ push: !archivedCount }" @click="adding = !adding"><Icon name="plus" :size="12" />{{ t('goals.add') }}</button>
      </div>
      <form v-if="adding" class="addgoal" @submit.prevent="addGoal">
        <label class="field grow"><span>{{ t('goals.label') }}</span><input v-model="ng.label" class="input" required maxlength="120" :placeholder="t('goals.labelPh')"></label>
        <label class="field"><span>{{ t('goals.target') }}</span><input v-model="ng.target" class="input mono" inputmode="decimal"></label>
        <label class="field"><span>{{ t('goals.deadline') }}</span><input v-model="ng.deadline" class="input" type="date"></label>
        <label class="field"><span>{{ t('goals.mode') }}</span><select v-model="ng.mode" class="select"><option value="sum">{{ t('goals.modes.sum') }}</option><option value="last">{{ t('goals.modes.last') }}</option><option value="month">{{ t('goals.modes.month') }}</option></select></label>
        <button type="submit" class="btn primary">{{ t('goals.add') }}</button>
      </form>
      <GoalList v-if="goals.length" :goals="goals" :show-project="isAll" :editable="!isAll" @changed="refresh" />
      <p v-else class="empty">{{ t('goals.empty') }}</p>
    </section>

    <template v-if="!isAll">
      <section v-if="analysis?.positioning || analysis?.audiences?.length || data.project?.setup.budget" class="panel">
        <dl class="facts profile">
          <template v-if="analysis?.positioning"><dt>{{ t('strategy.message') }}</dt><dd class="msg">{{ analysis.positioning }}</dd></template>
          <template v-if="analysis?.audiences?.length"><dt>{{ t('strategy.audiences') }}</dt><dd><span v-for="(a, i) in analysis.audiences.slice(0, 3)" :key="i" class="aud">{{ a }}</span></dd></template>
          <template v-if="data.project?.setup.budget"><dt>{{ t('strategy.budget') }}</dt><dd>{{ data.project.setup.budget }}</dd></template>
        </dl>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>{{ t('strategy.channels') }}</h2>
          <span v-if="data.active" class="count">v{{ data.active.version }}</span>
          <span v-if="data.lastReview" class="dim small push mono">{{ t('strategy.lastReview', { day: dayDm(isoDay(data.lastReview.at)) }) }}</span>
        </div>
        <p v-if="data.active?.summary" class="summary">{{ data.active.summary }}</p>
        <p v-if="data.lastReview?.text" class="summary review">{{ data.lastReview.text }}</p>
        <StrategyRows v-if="data.active" :channels="data.active.channels" :goals="data.goals" :stats="data.stats" :details="data.details" :base="base" :mode="canEdit ? 'live' : 'view'" @change="change" />
        <p v-else class="empty">{{ t('strategy.none') }}</p>
      </section>

      <section v-if="historyRows.length" class="panel">
        <div class="panel-head"><h2>{{ t('strategy.history') }}</h2></div>
        <ul class="rows">
          <li v-for="h in historyRows" :key="h.key" class="hr">
            <span class="mono dim d">{{ dayDm(isoDay(h.at)) }}</span>
            <OwnerBadge v-if="h.byAgent" owner="agent" />
            <span class="ellipsis grow"><b>{{ h.c.name }}</b> {{ t(`strategy.change.${h.c.change}`) }}<span class="dim"> - {{ h.c.reason }}</span></span>
            <span v-if="h.status === 'verworfen'" class="pill s-verworfen">{{ t('strategy.status.verworfen') }}</span>
          </li>
        </ul>
      </section>

      <ExperimentsPanel v-if="data.project" :key="`exp-${data.project.id}`" :project-id="data.project.id" />

      <section v-if="analysis && (analysis.competitors?.length || analysis.communities?.length || analysis.keywords?.length)" class="panel">
        <details>
          <summary class="panel-head sum-head"><h2>{{ t('strategy.knowledge') }}</h2><Icon name="chevron-down" /></summary>
          <dl class="facts">
            <template v-if="analysis.competitors?.length"><dt>{{ t('strategy.competitors') }}</dt><dd>{{ analysis.competitors.map(c => c.name).join(', ') }}</dd></template>
            <template v-if="analysis.communities?.length"><dt>{{ t('strategy.communities') }}</dt><dd>{{ analysis.communities.join(', ') }}</dd></template>
            <template v-if="analysis.keywords?.length"><dt>{{ t('strategy.keywords') }}</dt><dd>{{ analysis.keywords.join(', ') }}</dd></template>
          </dl>
        </details>
      </section>
    </template>
    <p v-else class="hint">{{ t('strategy.pickProject') }}</p>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  color: var(--text);
  text-decoration: none;
  border-left: 3px solid var(--agent);
}

.notice:hover {
  background: var(--panel2);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--agent);
  box-shadow: 0 0 0 4px var(--agent-soft);
}

.push {
  margin-left: auto;
}

.pad16 {
  padding: 16px;
}

.small {
  font-size: 11.5px;
}

.addgoal {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel2);
}

.addgoal .field {
  flex: 0 1 150px;
}

.addgoal .grow {
  flex: 1 1 220px;
}

.summary {
  margin: 0;
  padding: 12px 16px 0;
  color: var(--muted);
  font-size: 13.5px;
  max-width: 80ch;
}

.summary.review {
  padding-top: 6px;
  border-left: 2px solid var(--agent);
  margin: 10px 16px 0;
  padding: 0 0 0 10px;
}

.summary + :deep(.rows),
.summary.review + :deep(.rows) {
  margin-top: 12px;
  border-top: 1px solid var(--line);
}

.hr {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 16px;
  font-size: 13.5px;
}

.hr .d {
  flex: none;
  min-width: 64px;
  font-size: 12px;
}

.grow {
  flex: 1 1 auto;
}

details > summary {
  list-style: none;
  cursor: pointer;
}

details > summary::-webkit-details-marker {
  display: none;
}

details:not([open]) .sum-head {
  border-bottom: 0;
}

.sum-head svg {
  margin-left: auto;
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 16px;
  margin: 0;
  padding: 14px 16px;
  font-size: 13.5px;
}

.facts dt {
  color: var(--dim);
}

.facts dd {
  margin: 0;
}

.profile .msg {
  font-weight: 500;
  max-width: 70ch;
}

.aud {
  display: block;
}

/* Handy */
@media (max-width: 600px) {
  .facts {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .facts dd {
    margin-bottom: 8px;
  }

  .addgoal .field {
    flex: 1 1 130px;
  }
}
</style>
