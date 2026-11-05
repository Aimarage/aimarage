<script setup lang="ts">
interface ArmResult { posts: number, mean: number }
interface ExpView {
  id: string
  status: 'vorschlag' | 'laeuft' | 'ausgewertet' | 'abgebrochen' | 'verworfen'
  variable: string
  hypothesis: string
  label: string
  variantA: string
  variantB: string
  metric: string
  startDate: string | null
  endDate: string | null
  extensions: number
  viaStrategy: boolean
  result: { a: ArmResult, b: ArmResult, diff: number | null, verdict: 'besser' | 'schlechter' | 'gleich' | 'zu_wenig' } | null
  decision: string | null
  counts: { a: number, b: number }
}
interface Data { current: ExpView | null, recent: ExpView[], insights: { id: string, text: string }[] }

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { canEdit } = useBoot()
const { dayDm } = useFormat()
const toast = useToast()

const { data, refresh } = await useFetch<Data>(() => `/api/projects/${props.projectId}/experiments`, { key: `experiments:${props.projectId}` })
const busy = ref(false)

async function act(e: ExpView, action: 'start' | 'reject' | 'stop') {
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.projectId}/experiments`, { method: 'POST', body: { experimentId: e.id, action } })
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

const pct = (d: number | null) => (d === null ? '' : `${d >= 0 ? '+' : ''}${Math.round(d * 100)} %`)
const verdictClass = (v: string | undefined) => (v === 'besser' ? 's-erledigt' : v === 'schlechter' ? 's-verworfen' : 's-wartet')
</script>

<template>
  <section v-if="data" class="panel">
    <div class="panel-head"><h2>{{ t('experiments.title') }}</h2></div>
    <div v-if="data.current" class="cur">
      <div class="line">
        <span class="pill" :class="data.current.status === 'laeuft' ? 's-freigegeben' : 's-wartet'">{{ t(`experiments.status.${data.current.status}`) }}</span>
        <span class="grow">{{ data.current.hypothesis }}</span>
      </div>
      <p class="dim small meta">
        <span>A: {{ data.current.variantA }} · B: {{ data.current.variantB }}</span>
        <span v-if="data.current.startDate && data.current.endDate"> · {{ dayDm(data.current.startDate) }} - {{ dayDm(data.current.endDate) }}</span>
        <span v-if="data.current.status === 'laeuft' && data.current.variable !== 'takt'"> · {{ t('experiments.counts', { a: data.current.counts.a, b: data.current.counts.b }) }}</span>
        <span v-if="data.current.extensions"> · {{ t('experiments.extended', { n: data.current.extensions }) }}</span>
      </p>
      <p v-if="data.current.status === 'vorschlag' && data.current.viaStrategy" class="dim small meta">{{ t('experiments.viaStrategy') }}</p>
      <div v-if="canEdit" class="acts">
        <template v-if="data.current.status === 'vorschlag' && !data.current.viaStrategy">
          <button type="button" class="btn primary small" :disabled="busy" @click="act(data.current, 'start')">{{ t('experiments.start') }}</button>
          <button type="button" class="btn ghost small" :disabled="busy" @click="act(data.current, 'reject')">{{ t('experiments.reject') }}</button>
        </template>
        <button v-else-if="data.current.status === 'laeuft'" type="button" class="btn ghost small" :disabled="busy" @click="act(data.current, 'stop')">{{ t('experiments.stop') }}</button>
      </div>
    </div>
    <ul v-if="data.recent.length" class="rows">
      <li v-for="e in data.recent" :key="e.id" class="line">
        <span class="pill" :class="verdictClass(e.result?.verdict)">{{ t(`experiments.verdict.${e.result?.verdict ?? 'zu_wenig'}`) }}</span>
        <span class="grow ellipsis">{{ e.hypothesis }}</span>
        <span v-if="e.result?.diff !== null && e.result?.diff !== undefined" class="mono small">{{ pct(e.result.diff) }}</span>
      </li>
    </ul>
    <template v-if="data.insights.length">
      <h3 class="sub">{{ t('experiments.insights') }}</h3>
      <ul class="rows">
        <li v-for="i in data.insights" :key="i.id" class="line">{{ i.text }}</li>
      </ul>
    </template>
    <p v-if="!data.current && !data.recent.length && !data.insights.length" class="empty">{{ t('experiments.none') }}</p>
  </section>
</template>

<style scoped>
.cur {
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-size: 13.5px;
}

.cur .line {
  padding: 0;
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
}

.meta {
  margin: 6px 0 0;
}

.small {
  font-size: 12px;
}

.acts {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.sub {
  margin: 0;
  padding: 10px 16px 2px;
  font-size: 12px;
  font-weight: 500;
  color: var(--dim);
}

@media (max-width: 600px) {
  .line {
    flex-wrap: wrap;
    gap: 4px 10px;
  }
}
</style>
