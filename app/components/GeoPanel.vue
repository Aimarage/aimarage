<script setup lang="ts">
interface GeoAnswer { question: string, model: string, label: string, mentioned: boolean, position: number | null, competitors: string[], error?: string | null }
interface GeoWeb { question: string, rank: number | null, top: string[], error?: string | null }
export interface GeoLast { week: string, checkedAt: string, answers: GeoAnswer[], web: GeoWeb[], summary: { asked: number, mentioned: number, models: string[], webAsked: number, webHits: number, competitors: string[] }, costEur: number }
interface GeoData { questions: string[], generatedAt: string | null, editedAt: string | null, last: GeoLast | null }

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { dateTime } = useFormat()
const { isAdmin } = useBoot()
const { base } = useScope()
const toast = useToast()

const { data } = await useFetch<GeoData>(() => `/api/projects/${props.projectId}/geo`, { key: `geo:${props.projectId}` })
const busy = ref(false)

const rows = computed(() => {
  const last = data.value?.last
  if (!last) return []
  const qs = [...new Set([...last.answers.map(a => a.question), ...last.web.map(w => w.question)])]
  return qs.map((q) => {
    const answers = last.answers.filter(a => a.question === q)
    const web = last.web.find(w => w.question === q) ?? null
    const marks = answers.map(a => `${a.label.split(/[\s-]/)[0]} ${a.error ? '?' : a.mentioned ? (a.position ? `#${a.position}` : t('geo.yes')) : '-'}`)
    return { q, marks: marks.join(' · '), web: web ? (web.error ? null : web.rank ? `#${web.rank}` : '-') : null, title: answers.map(a => `${a.label}: ${a.error ?? (a.competitors.join(', ') || '-')}`).join('\n') }
  })
})
const cost = (v: number) => `${v.toFixed(3).replace('.', ',')} €`

async function check() {
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.projectId}/geo-check`, { method: 'POST' })
    toast.push(t('geo.queued'))
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="data" class="panel">
    <div class="panel-head">
      <h2>{{ t('geo.title') }}</h2>
      <span v-if="data.last" class="count">{{ t('geo.mentioned', { n: data.last.summary.mentioned, total: data.last.summary.asked }) }}<template v-if="data.last.summary.webAsked"> · {{ t('geo.web', { n: data.last.summary.webHits, total: data.last.summary.webAsked }) }}</template></span>
    </div>
    <ul v-if="rows.length" class="rows">
      <li v-for="r in rows" :key="r.q" class="line" :title="r.title">
        <span class="ellipsis grow">{{ r.q }}</span>
        <span class="mono dim small">{{ r.marks }}</span>
        <span v-if="r.web !== null" class="mono dim small web">{{ t('geo.webShort') }} {{ r.web }}</span>
      </li>
    </ul>
    <p v-else class="empty">{{ data.questions.length ? t('geo.waiting') : t('geo.noQuestions') }}</p>
    <p v-if="data.last?.summary.competitors.length" class="comp dim small">{{ t('geo.competitors') }}: {{ data.last.summary.competitors.join(', ') }}</p>
    <div class="foot">
      <span class="dim small"><template v-if="data.last">{{ dateTime(data.last.checkedAt) }} · {{ data.last.summary.models.join(', ') }} · {{ cost(data.last.costEur) }}</template></span>
      <span v-if="isAdmin" class="acts">
        <NuxtLink :to="`${base}/einstellungen`" class="btn small">{{ t('geo.questions') }}</NuxtLink>
        <button type="button" class="btn small" :disabled="busy" @click="check">{{ t('geo.check') }}</button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  font-size: 13.5px;
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
}

.small {
  font-size: 12px;
}

.web {
  flex: 0 0 auto;
}

.comp {
  margin: 0;
  padding: 8px 16px 0;
}

.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 16px 12px;
}

.acts {
  display: flex;
  gap: 6px;
}

@media (max-width: 600px) {
  .line {
    flex-wrap: wrap;
    gap: 2px 10px;
  }

  .grow {
    flex: 1 1 100%;
  }
}
</style>
