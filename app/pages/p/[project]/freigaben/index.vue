<script setup lang="ts">
import { daysUntil } from '~~/shared/utils/dates'
import type { TodoFacts } from '~~/shared/utils/todo'
import { platformRule } from '~~/shared/utils/social'

type Act = 'info' | 'mail' | 'sendMail' | 'approve' | 'article' | 'reply' | 'self'
interface Approval {
  draftId: string
  taskId: string
  code: string
  title: string
  projectId: string | null
  category: string
  kind: 'post' | 'mail' | 'article' | 'text'
  platform: string | null
  version: number
  byAgent: boolean
  aiGenerated?: boolean
  createdAt: string
  dueDate: string | null
  dueTime: string | null
  overdue: boolean
  action: Act
  subject: string | null
  infoNeeded: boolean
  client: 'ok' | 'change' | null
  todo: TodoFacts
}

const { t } = useI18n()
const { boot, projectById, canEdit, refresh: refreshBoot } = useBoot()
const { project, base, query } = useScope()
const { projectColor } = useColors()
const { time, isoDay, dayDm, dayShort } = useFormat()
useHead({ title: t('approvals.title') })

interface Proposal { id: string, projectId: string, projectName: string, count: number, summary: string | null, createdAt: string, changes: { name: string, change: string }[] }
interface Trust { projectId: string, projectName: string, kind: string }
interface ExpProposal { id: string, projectId: string, projectName: string, hypothesis: string, label: string, createdAt: string }
interface Stale { projectId: string, projectName: string, slug: string, reason: 'old' | 'before', label: string, old: string | null, proposalId: string | null }
interface Out { draftId: string, taskId: string, code: string, title: string, projectId: string | null, kind: Approval['kind'], platform: string | null, at: string | null, byClaude: boolean, byReviewer?: boolean, goesOut: boolean, running: boolean }
interface Soon { draftId: string, taskId: string, code: string, title: string, projectId: string | null, kind: Approval['kind'], platform: string | null, dueDate: string | null, dueTime: string | null, visibleFrom: string | null, open: boolean, overdue: boolean, todo: TodoFacts }
interface Done { draftId: string, taskId: string, title: string, projectId: string | null, kind: Approval['kind'], platform: string | null, at: string }
const { data, refresh } = await useFetch<{ items: Approval[], proposals: Proposal[], trust: Trust[], outgoing: Out[], done: Done[], experiments: ExpProposal[], stale: Stale[], soon: Soon[], claude: Soon[] }>('/api/approvals', { query, key: computed(() => `approvals:${query.value.project ?? 'alle'}`), default: () => ({ items: [], proposals: [], trust: [], outgoing: [], done: [], experiments: [], stale: [], soon: [], claude: [] }) })
const toast = useToast()
const busy = ref(false)
async function trust(s: Trust, accept: boolean) {
  busy.value = true
  try {
    await $fetch(`/api/projects/${s.projectId}/trust`, { method: 'POST', body: { kind: s.kind, accept } })
    if (accept) toast.push(t('autonomy.switched', { kind: t(`autonomy.kinds.${s.kind}`) }))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
const rethinking = ref<string[]>([])
async function rethink(x: Stale) {
  busy.value = true
  try {
    await $fetch('/api/strategy/rethink', { method: 'POST', body: { project: x.slug } })
    rethinking.value.push(x.projectId)
    toast.push(t('strategy.rethinkStarted'))
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
async function experiment(e: ExpProposal, action: 'start' | 'reject') {
  busy.value = true
  try {
    await $fetch(`/api/projects/${e.projectId}/experiments`, { method: 'POST', body: { experimentId: e.id, action } })
    toast.push(t(`experiments.done.${action}`))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
async function stop(h: Out) {
  busy.value = true
  try {
    await $fetch(`/api/drafts/${h.draftId}/stop`, { method: 'POST' })
    toast.push(t('approvals.stopped'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
const today = computed(() => boot.value?.today ?? isoDay(new Date()))
const icon = (k: Approval['kind']) => (k === 'mail' ? 'mail' : k === 'post' ? 'post' : 'doc')
const platformName = (p: string) => (p === 'forum' ? t('approvals.forum') : platformRule(p).label)
const todoFor = useTodo()
function todoLine(a: Approval | Soon) {
  const f = a.todo
  const open = 'action' in a ? a.action !== 'self' && a.action !== 'sendMail' : a.open
  return todoFor({ ...f, info: 'infoNeeded' in a ? a.infoNeeded : false, draft: open ? 'open' : 'approved', platform: a.platform && a.platform !== 'mail' ? platformName(a.platform) : null }).line
}
function dueLabel(a: Pick<Approval, 'dueDate' | 'dueTime' | 'overdue'>) {
  if (!a.dueDate) return ''
  const d = daysUntil(today.value, a.dueDate)
  if (a.overdue && d < 0) return t('approvals.due.late')
  const at = a.dueTime ? ` ${a.dueTime}` : ''
  if (d === 0) return `${t('approvals.due.today')}${at}`
  if (d === 1) return `${t('approvals.due.tomorrow')}${at}`
  return `${d < 7 ? dayShort(a.dueDate) : dayDm(a.dueDate)}${at}`
}
const isLate = (a: Approval) => a.overdue
function when(iso: string) {
  const day = isoDay(iso)
  const d = daysUntil(today.value, day)
  const label = d === 0 ? t('approvals.due.today') : d === 1 ? t('approvals.due.tomorrow') : d > 1 && d < 7 ? dayShort(day) : dayDm(day)
  return `${label} ${time(iso)}`
}
function outLabel(o: Out) {
  if (o.running) return t('approvals.goesNow')
  if (!o.at) return ''
  if ((o.byClaude || o.byReviewer) && !o.goesOut) return t('approvals.releaseManual', { time: when(o.at) })
  return t('approvals.goesAt', { when: when(o.at) })
}
const q = ref('')
const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, '')
const sorted = computed(() => [...data.value.items].sort((a, b) => {
  if (a.infoNeeded !== b.infoNeeded) return a.infoNeeded ? -1 : 1
  if (a.dueDate !== b.dueDate) return !a.dueDate ? 1 : !b.dueDate ? -1 : a.dueDate < b.dueDate ? -1 : 1
  return (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') || a.createdAt.localeCompare(b.createdAt)
}))
const items = computed(() => {
  const n = norm(q.value)
  if (!n) return sorted.value
  return sorted.value.filter(a => [a.title, a.code, projectById(a.projectId)?.name ?? ''].some(f => norm(f).includes(n)))
})
const todoCount = computed(() => data.value.items.length + data.value.proposals.length)

// ?abschnitt=dran|claude|bald (Links vom Dashboard): Abschnitt aufklappen und hinscrollen.
const route = useRoute()
async function openSection() {
  const id = route.query.abschnitt
  if (typeof id !== 'string' || !['dran', 'claude', 'bald'].includes(id)) return
  await nextTick()
  const el = document.getElementById(`abschnitt-${id}`)
  if (!el) return
  if (el instanceof HTMLDetailsElement) el.open = true
  el.scrollIntoView({ block: 'start' })
}
onMounted(openSection)
watch(() => route.query.abschnitt, openSection)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('approvals.title') }}</h1>
      </div>
    </div>
    <section id="abschnitt-dran" class="panel">
      <div class="panel-head">
        <h2>{{ t('approvals.todo') }}</h2><span class="count">{{ todoCount }}</span>
        <label v-if="data.items.length > 8" class="search"><Icon name="search" /><input v-model="q" class="input" type="search" :placeholder="t('approvals.search')" :aria-label="t('approvals.search')"></label>
      </div>
      <ul v-if="items.length || data.proposals.length" class="rows">
        <li v-for="a in items" :key="a.draftId">
          <NuxtLink :to="`${base}/freigaben/${a.draftId}`" class="row-link item">
            <PlatformMark v-if="a.platform" :platform="a.platform" />
            <span v-else class="kind dim" :title="t(`kind.${a.kind}`)"><Icon :name="icon(a.kind)" /></span>
            <span class="text">
              <span class="act">{{ a.title }}</span>
              <span class="sub"><span class="sq" :style="{ background: projectColor(a.projectId) }" /><span class="sub-title">{{ todoLine(a) }}</span><span v-if="a.aiGenerated" class="ai">· {{ t('approvals.aiDraft') }}</span><span v-if="!project" class="hide-m">· {{ projectById(a.projectId)?.name }}</span></span>
            </span>
            <span v-if="a.client" class="pill" :class="a.client === 'ok' ? 's-erledigt' : 's-wartet'">{{ t(a.client === 'ok' ? 'approvals.clientOk' : 'approvals.clientChange') }}</span>
            <span class="when" :class="{ late: isLate(a) }">{{ dueLabel(a) }}</span>
          </NuxtLink>
        </li>
        <li v-for="p in data.proposals" :key="p.id">
          <NuxtLink :to="`${base}/freigaben/vorschlag/${p.id}`" class="row-link item">
            <span class="kind dim"><Icon name="target" /></span>
            <span class="text">
              <span class="act">{{ t('approvals.act.proposal') }}</span>
              <span class="sub"><span class="sq" :style="{ background: projectColor(p.projectId) }" /><span class="sub-title">{{ p.changes.length ? p.changes.map(c => `${c.name} ${t(`strategy.change.${c.change}`)}`).join(', ') : (p.summary ?? p.projectName) }}</span></span>
            </span>
          </NuxtLink>
        </li>
      </ul>
      <p v-if="q && !items.length && data.items.length" class="empty">{{ t('approvals.noMatch') }}</p>
      <p v-else-if="!todoCount" class="empty">{{ t(data.claude.length || data.soon.some(o => o.open) ? 'dash.nothingDue' : 'approvals.nothing') }}</p>
    </section>
    <section v-for="s in data.trust" :key="`${s.projectId}:${s.kind}`" class="panel trust">
      <p>{{ t('autonomy.suggestLine', { kind: t(`autonomy.kinds.${s.kind}`), project: s.projectName, n: 5 }) }}</p>
      <div class="trust-acts">
        <button type="button" class="btn primary small" :disabled="busy" @click="trust(s, true)">{{ t('autonomy.yes') }}</button>
        <button type="button" class="btn ghost small" :disabled="busy" @click="trust(s, false)">{{ t('autonomy.no') }}</button>
      </div>
    </section>
    <section v-for="x in data.stale" :key="`stale:${x.projectId}`" class="panel trust">
      <p>{{ t(`strategy.stale.${x.reason}`, { project: x.projectName, release: x.label, old: x.old ?? '' }) }}</p>
      <div class="trust-acts">
        <NuxtLink v-if="x.proposalId" :to="`${base}/freigaben/vorschlag/${x.proposalId}`" class="btn primary small">{{ t('strategy.stale.proposal') }}</NuxtLink>
        <button v-if="canEdit && boot?.agent.ready" type="button" class="btn small" :class="{ primary: !x.proposalId }" :disabled="busy || rethinking.includes(x.projectId)" @click="rethink(x)">{{ rethinking.includes(x.projectId) ? t('strategy.rethinking') : t('strategy.rethink') }}</button>
      </div>
    </section>
    <section v-for="e in data.experiments" :key="e.id" class="panel trust">
      <p>{{ t('experiments.proposalLine', { project: e.projectName, text: e.hypothesis }) }}</p>
      <div class="trust-acts">
        <button type="button" class="btn primary small" :disabled="busy" @click="experiment(e, 'start')">{{ t('experiments.start') }}</button>
        <button type="button" class="btn ghost small" :disabled="busy" @click="experiment(e, 'reject')">{{ t('experiments.reject') }}</button>
      </div>
    </section>
    <details v-if="data.claude.length" id="abschnitt-claude" class="panel fold">
      <summary class="panel-head"><Icon name="chevron-right" class="caret" /><h2>{{ t('approvals.claudeTitle') }}</h2><span class="count">{{ data.claude.length }}</span></summary>
      <p class="fold-hint">{{ t('approvals.claudeHint') }}</p>
      <ul class="rows">
        <li v-for="o in data.claude" :key="o.draftId">
          <NuxtLink :to="`${base}/freigaben/${o.draftId}`" class="row-link item">
            <PlatformMark v-if="o.platform" :platform="o.platform" />
            <span v-else class="kind dim"><Icon :name="icon(o.kind)" /></span>
            <span class="text">
              <span class="act">{{ o.title }}</span>
              <span class="sub"><span class="sq" :style="{ background: projectColor(o.projectId) }" /><span class="sub-title">{{ todoLine(o) }}</span><span v-if="!project" class="hide-m">· {{ projectById(o.projectId)?.name }}</span></span>
            </span>
            <span class="when" :class="{ late: o.overdue }">{{ dueLabel(o) }}</span>
          </NuxtLink>
        </li>
      </ul>
    </details>
    <details v-if="data.soon.length" id="abschnitt-bald" class="panel fold">
      <summary class="panel-head"><Icon name="chevron-right" class="caret" /><h2>{{ t('todo.soon') }}</h2><span class="count">{{ data.soon.length }}</span></summary>
      <ul class="rows">
        <li v-for="o in data.soon" :key="o.draftId">
          <NuxtLink :to="`${base}/freigaben/${o.draftId}`" class="row-link item">
            <PlatformMark v-if="o.platform" :platform="o.platform" />
            <span v-else class="kind dim"><Icon :name="icon(o.kind)" /></span>
            <span class="text">
              <span class="act">{{ o.title }}</span>
              <span class="sub"><span class="sq" :style="{ background: projectColor(o.projectId) }" /><span class="sub-title">{{ todoLine(o) }}</span></span>
            </span>
            <span class="when">{{ dueLabel(o) }}</span>
          </NuxtLink>
        </li>
      </ul>
    </details>
    <details v-if="data.outgoing.length" class="panel fold">
      <summary class="panel-head"><Icon name="chevron-right" class="caret" /><h2>{{ t('approvals.outgoing') }}</h2><span class="count">{{ data.outgoing.length }}</span></summary>
      <ul class="rows">
        <li v-for="o in data.outgoing" :key="o.draftId" class="held">
          <NuxtLink :to="`${base}/freigaben/${o.draftId}`" class="row-link item">
            <PlatformMark v-if="o.platform" :platform="o.platform" />
            <span v-else class="kind dim"><Icon :name="icon(o.kind)" /></span>
            <span class="text">
              <span class="act">{{ o.title }}</span>
              <span class="sub"><span class="sq" :style="{ background: projectColor(o.projectId) }" /><span class="sub-title">{{ outLabel(o) }}</span><span v-if="o.byClaude" class="claude">· {{ t('approvals.viaClaude') }}</span><span v-else-if="o.byReviewer" class="claude">· {{ t('approvals.viaReviewer') }}</span></span>
            </span>
          </NuxtLink>
          <button v-if="canEdit && !o.running" type="button" class="btn small" :disabled="busy" @click="stop(o)">{{ t('approvals.stop') }}</button>
        </li>
      </ul>
    </details>
    <details v-if="data.done.length" class="panel fold">
      <summary class="panel-head"><Icon name="chevron-right" class="caret" /><h2>{{ t('approvals.doneTitle') }}</h2><span class="count">{{ data.done.length }}</span></summary>
      <ul class="rows">
        <li v-for="d in data.done" :key="d.draftId">
          <NuxtLink :to="`${base}/freigaben/${d.draftId}`" class="row-link item">
            <PlatformMark v-if="d.platform" :platform="d.platform" />
            <span v-else class="kind dim"><Icon :name="icon(d.kind)" /></span>
            <span class="text">
              <span class="act dim">{{ d.title }}</span>
            </span>
            <span class="when">{{ dayDm(isoDay(d.at)) }}</span>
          </NuxtLink>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.trust {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding: 14px 16px;
}

.trust p {
  flex: 1 1 320px;
  margin: 0;
  font-size: 14px;
}

.trust-acts {
  display: flex;
  gap: 8px;
}

.held {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 12px;
}

.held .row-link {
  flex: 1;
  min-width: 0;
}

.kind,
.chev {
  display: inline-flex;
}

.item {
  gap: 12px;
  padding-top: 8px;
  padding-bottom: 8px;
}

.text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.act {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.act.dim {
  font-weight: 400;
}

.sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--muted);
}

.sub-title {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai {
  flex: none;
  white-space: nowrap;
}

.claude {
  flex: none;
  color: var(--dim);
}

.when {
  flex: none;
  font-family: var(--meta);
  font-size: 12px;
  color: var(--dim);
}

.when.late {
  color: var(--down);
  font-weight: 600;
}

/* Zuklappbare Bereiche */
[id^='abschnitt-'] {
  scroll-margin-top: 16px;
}

.fold > summary {
  cursor: pointer;
  list-style: none;
  border-bottom: 0;
}

.fold > summary::-webkit-details-marker {
  display: none;
}

.fold[open] > summary {
  border-bottom: 1px solid var(--line);
}

.caret {
  color: var(--dim);
  transition: transform 0.15s;
}

.fold[open] .caret {
  transform: rotate(90deg);
}

.fold-hint {
  margin: 0;
  padding: 10px 16px 0;
  font-size: 13px;
  color: var(--muted);
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding-left: 10px;
  border: 1px solid var(--line2);
  border-radius: 4px;
  background: var(--panel);
  color: var(--dim);
}

.search .input {
  border: 0;
  min-width: 140px;
  padding-left: 0;
}

/* Handy */
@media (max-width: 600px) {
  .search {
    flex: 1 1 140px;
    margin-left: 0;
  }
}
</style>
