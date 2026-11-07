<script setup lang="ts">
import { GOAL_METRICS, suggestGoals, type GoalSuggestion } from '~~/shared/utils/plan'

interface Progress {
  steps: { key: string, state: 'wait' | 'run' | 'ok' | 'skip' | 'error', note?: string | null }[]
  done: boolean
}

const { t } = useI18n()
const { boot, refresh, isAdmin } = useBoot()
const toast = useToast()
const route = useRoute()
useHead({ title: t('project.new') })
if (!isAdmin.value) throw createError({ statusCode: 403, statusMessage: 'Keine Berechtigung' })

const projectId = ref<string | null>(null)
const hosted = computed(() => !!boot.value?.features.hosted)
const foldersOn = computed(() => !!boot.value?.features.folders)
const saas = computed(() => (boot.value?.extensions as { saas?: { status?: string | null } } | undefined)?.saas ?? null)
const paused = computed(() => !!boot.value?.workspace.paused)
const previewing = computed(() => paused.value && !!projectId.value)
const blocked = computed(() => paused.value && boot.value?.workspace.preview !== 'available' && !previewing.value)
const pausedNoSub = computed(() => !saas.value?.status || saas.value.status === 'none')
const chatMode = computed(() => !!boot.value?.agent.ready && route.query.form !== '1' && !paused.value)

const DOC_ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md'
const docs = ref<File[]>([])
function addDocs(files: File[]) {
  for (const f of files) if (!docs.value.some(d => d.name === f.name && d.size === f.size)) docs.value.push(f)
}

type Step = 1 | 2 | 3 | 4 | 5
const step = ref<Step>(1)
const STEPS: Step[] = [1, 2, 3, 4, 5]
const form = ref({ url: '', description: '', name: '', folder: '' })
interface GoalRow { label: string, target: string, deadline: string, metricKey: string, mode: 'sum' | 'last' | 'month' }
const goals = ref<GoalRow[]>([])
const yearEnd = computed(() => `${(boot.value?.today ?? '2026-01-01').slice(0, 4)}-12-31`)
const suggestions = computed(() => suggestGoals(`${form.value.description} ${form.value.url}`).filter(s => !goals.value.some(g => g.metricKey === s.metricKey)))

function addSuggestion(s: GoalSuggestion) {
  goals.value.push({ label: s.label, target: String(s.target), deadline: yearEnd.value, metricKey: s.metricKey, mode: s.mode })
}
function addEmpty() {
  goals.value.push({ label: '', target: '', deadline: yearEnd.value, metricKey: '', mode: 'sum' })
}
function pickMetric(g: GoalRow, key: string) {
  const m = GOAL_METRICS.find(x => x.key === key)
  g.metricKey = key
  if (m) {
    g.mode = m.mode
    if (!g.label) g.label = m.label
  }
}

const slug = ref<string | null>(null)
const progress = ref<Progress | null>(null)
const proposalId = ref<string | null>(null)
const teaserReady = ref(false)
const busy = ref(false)
let poll: ReturnType<typeof setTimeout> | undefined

async function start() {
  busy.value = true
  try {
    const f = form.value
    const res = await $fetch<{ id: string, slug: string }>('/api/onboarding', {
      method: 'POST',
      body: {
        url: f.url,
        description: f.description || null,
        name: f.name || null,
        folder: (foldersOn.value && f.folder) || null,
        defer: docs.value.length > 0,
        goals: goals.value.filter(g => g.label.trim()).map(g => ({ label: g.label.trim(), targetValue: g.target ? Number(g.target.replace(/\./g, '').replace(',', '.')) : null, deadline: g.deadline || null, metricKey: g.metricKey || null, mode: g.mode })),
      },
    })
    projectId.value = res.id
    slug.value = res.slug
    if (docs.value.length) {
      try {
        const fd = new FormData()
        for (const d of docs.value) fd.append('file', d, d.name)
        await $fetch(`/api/projects/${res.id}/documents`, { method: 'POST', body: fd })
      }
      catch (err) {
        toast.error(err)
      }
      await $fetch(`/api/onboarding/${res.id}/start`, { method: 'POST' })
    }
    step.value = 4
    await refresh()
    track()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function track() {
  if (!projectId.value) return
  try {
    const r = await $fetch<{ progress: Progress | null, proposalId: string | null, teaser?: unknown }>(`/api/onboarding/${projectId.value}`)
    progress.value = r.progress
    if (r.progress?.done && r.proposalId) {
      proposalId.value = r.proposalId
      return
    }
    if (r.progress?.done && r.teaser) {
      teaserReady.value = true
      return
    }
  }
  catch {}
  poll = setTimeout(track, 1200)
}
onBeforeUnmount(() => clearTimeout(poll))

async function decided(e: { action: 'approve' | 'reject', slug: string }) {
  await refresh()
  if (e.action === 'approve') await navigateTo(`/p/${e.slug}/kalender`)
}

function onProject(s: string) {
  slug.value = s
}

const canNext1 = computed(() => form.value.url.trim().length > 3)
</script>

<template>
  <div class="page onb" :class="{ chatmode: chatMode }">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ t('project.new') }}</p>
        <h1>{{ chatMode ? t('onboarding.chatTitle') : t('onboarding.formTitle') }}</h1>
      </div>
      <div class="actions">
        <NuxtLink v-if="chatMode && !slug" to="/projekte/neu?form=1" class="btn ghost small">{{ t('onboarding.useForm') }}</NuxtLink>
        <NuxtLink v-else-if="boot?.agent.ready && !paused && step < 4" to="/projekte/neu" class="btn ghost small">{{ t('onboarding.useChat') }}</NuxtLink>
      </div>
    </div>

    <section v-if="blocked" class="panel panel-body paused">
      <h2>{{ pausedNoSub ? t('onboarding.pausedTrial') : t('onboarding.pausedSub') }}</h2>
      <p class="hint">{{ pausedNoSub ? t('onboarding.pausedTrialText') : t('onboarding.pausedSubText') }}</p>
      <div v-if="hosted" class="form-actions"><NuxtLink to="/abo" class="btn primary">{{ t('onboarding.pausedButton') }}</NuxtLink></div>
    </section>

    <template v-else-if="chatMode">
      <AiReviewerAsk v-if="slug" />
      <section class="panel box">
        <ChatView onboarding @project="onProject" />
      </section>
    </template>

    <template v-else>
      <ol class="steps mono" :aria-label="t('onboarding.progress')">
        <li v-for="s in STEPS" :key="s" :class="{ on: s === step, done: s < step }">{{ s }} {{ t(s === 3 && !foldersOn ? 'onboarding.step3Docs' : `onboarding.step${s}`) }}</li>
      </ol>
      <p v-if="paused && boot?.workspace.preview === 'available' && step < 4" class="hint">{{ t('onboarding.previewHint') }}</p>
      <p v-else-if="!boot?.agent.ready && hosted" class="hint">{{ t('onboarding.noAgentHosted') }}</p>
      <p v-else-if="!boot?.agent.ready" class="hint">{{ t('onboarding.noAgent') }} <NuxtLink to="/einstellungen/ki">{{ t('chat.setupAccess') }}</NuxtLink></p>

      <form v-if="step === 1" class="panel panel-body stack" @submit.prevent="step = 2">
        <label class="field"><span>{{ t('onboarding.url') }}</span><input v-model="form.url" class="input" inputmode="url" placeholder="example.com" required autofocus></label>
        <label class="field"><span>{{ t('onboarding.what') }}</span><textarea v-model="form.description" class="textarea" rows="3" :placeholder="t('onboarding.whatPh')" maxlength="2000" /></label>
        <details class="opt"><summary>{{ t('onboarding.nameOpt') }}</summary><label class="field"><span>{{ t('project.name') }}</span><input v-model="form.name" class="input" maxlength="60"></label></details>
        <div class="form-actions"><button type="submit" class="btn primary" :disabled="!canNext1">{{ t('onboarding.next') }}</button></div>
      </form>

      <form v-if="step === 2" class="panel stack0" @submit.prevent="step = 3">
        <div class="panel-head"><h2>{{ t('goals.title') }}</h2><span class="hint">{{ t('onboarding.goalsHint') }}</span></div>
        <ul v-if="goals.length" class="rows">
          <li v-for="(g, i) in goals" :key="i" class="grow-row">
            <input v-model="g.label" class="input lbl" :placeholder="t('goals.labelPh')" :aria-label="t('goals.label')" maxlength="120">
            <input v-model="g.target" class="input mono num" inputmode="decimal" :placeholder="t('goals.target')" :aria-label="t('goals.target')">
            <input v-model="g.deadline" class="input dt" type="date" :aria-label="t('goals.deadline')">
            <select :value="g.metricKey" class="select met" :aria-label="t('goals.metric')" @change="pickMetric(g, ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('goals.metricAuto') }}</option>
              <option v-for="m in GOAL_METRICS" :key="m.key" :value="m.key">{{ m.label }}</option>
            </select>
            <button type="button" class="icon-btn" :aria-label="t('strategy.remove')" @click="goals.splice(i, 1)"><Icon name="x" /></button>
          </li>
        </ul>
        <div class="panel-body sugg">
          <span class="dim">{{ t('onboarding.suggest') }}</span>
          <button v-for="s in suggestions" :key="s.metricKey" type="button" class="chip" @click="addSuggestion(s)"><Icon name="plus" :size="12" />{{ s.label }}</button>
          <button type="button" class="chip" @click="addEmpty"><Icon name="plus" :size="12" />{{ t('onboarding.ownGoal') }}</button>
        </div>
        <div class="panel-body form-actions">
          <button type="button" class="btn ghost" @click="step = 1">{{ t('onboarding.back') }}</button>
          <button type="submit" class="btn primary">{{ t('onboarding.next') }}</button>
        </div>
      </form>

      <form v-if="step === 3" class="panel panel-body stack" @submit.prevent="start">
        <label v-if="foldersOn" class="field"><span>{{ t('onboarding.folder') }}</span><input v-model="form.folder" class="input mono" placeholder="~/Projekte/meine-website"><small>{{ t('onboarding.folderHint') }}</small></label>
        <p v-else-if="paused" class="hint">{{ t('onboarding.docsLocked') }}</p>
        <div v-else class="field">
          <span>{{ t('onboarding.docs') }}</span>
          <FileDrop :accept="DOC_ACCEPT" :label="t('onboarding.docsPick')" :hint="t('onboarding.docsHint')" @files="addDocs" />
          <ul v-if="docs.length" class="doclist">
            <li v-for="(d, i) in docs" :key="`${d.name}-${d.size}`"><Icon name="doc" :size="13" class="dim" /><span class="ellipsis grow">{{ d.name }}</span><button type="button" class="icon-btn" :aria-label="t('onboarding.docsRemove')" @click="docs.splice(i, 1)"><Icon name="x" /></button></li>
          </ul>
        </div>
        <div class="form-actions">
          <button type="button" class="btn ghost" @click="step = 2">{{ t('onboarding.back') }}</button>
          <button type="submit" class="btn primary" :disabled="busy">{{ t('onboarding.analyze') }}</button>
        </div>
      </form>

      <section v-if="step === 4 && !proposalId && !teaserReady" class="panel">
        <div class="panel-head"><span class="dot" /><h2>{{ t('onboarding.analyzing') }}</h2></div>
        <ul class="rows prog">
          <li v-for="s in progress?.steps ?? []" :key="s.key" :class="`ps-${s.state}`">
            <span class="pi"><Icon v-if="s.state === 'ok'" name="check" :size="12" /><Icon v-else-if="s.state === 'error'" name="x" :size="12" /></span>
            <span class="ellipsis grow">{{ t(`onboarding.steps.${s.key}`) }}</span>
            <span class="dim mono note">{{ s.note ?? (s.state === 'run' ? t('onboarding.running') : '') }}</span>
          </li>
          <li v-if="!progress" class="ps-run"><span class="pi" /><span>{{ t('onboarding.queued') }}</span></li>
        </ul>
      </section>

      <PreviewTeaser v-if="teaserReady && projectId" :project-id="projectId" />

      <AiReviewerAsk v-if="proposalId" />
      <section v-if="proposalId" class="panel">
        <div class="panel-head"><h2>{{ t('onboarding.step5') }}</h2><span class="hint">{{ t('onboarding.strategyHint') }}</span></div>
        <div class="pad16"><StrategyCard :id="proposalId" :embedded="false" editable @decided="decided" /></div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.onb {
  max-width: 820px;
  gap: 20px;
}

.box {
  height: calc(100vh - 230px);
  min-height: 460px;
  overflow: hidden;
}

.steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--dim);
}

.steps .on {
  color: var(--text);
  font-weight: 600;
}

.steps .done {
  color: var(--up);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.opt summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 8px;
}

.grow-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
}

.grow-row .lbl {
  flex: 1 1 200px;
}

.grow-row .num {
  flex: 0 0 90px;
}

.grow-row .dt {
  flex: 0 0 150px;
}

.grow-row .met {
  flex: 0 1 190px;
}

.sugg {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--line);
  font-size: 13px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
}

.chip:hover {
  color: var(--text);
  border-color: var(--primary);
}

.form-actions.panel-body {
  border-top: 1px solid var(--line);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 4px var(--primary-soft);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.prog li {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 16px;
  font-size: 13.5px;
}

.ps-wait {
  color: var(--dim);
}

.pi {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--line2);
  flex: none;
}

.ps-ok .pi {
  border-color: var(--up);
  color: var(--up);
}

.ps-run .pi {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.ps-error .pi {
  border-color: var(--down);
  color: var(--down);
}

.grow {
  flex: 1 1 auto;
}

.note {
  font-size: 11.5px;
  text-align: right;
}

.pad16 {
  padding: 16px;
}

.paused {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.paused h2 {
  margin: 0;
}

.doclist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.doclist li {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Handy */
@media (max-width: 600px) {
  .grow-row .lbl {
    flex-basis: 100%;
  }

  .grow-row .num {
    flex: 1 1 80px;
  }

  .grow-row .dt {
    flex: 1 1 140px;
  }

  .box {
    height: calc(100dvh - 250px);
  }
}
</style>
