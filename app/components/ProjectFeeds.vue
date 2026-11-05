<script setup lang="ts">
export interface FeedInfo { url: string, title: string | null, prefix: string | null, addedAt: string, syncedAt: string | null, error: string | null, newest: string | null }
interface FeedItem { title: string | null, link: string, status: string, createdAt: string, taskId: string | null, code: string | null }
interface CheckResult { ok: boolean, created: number, tasks: string[], feeds: { url: string, entries: number, created: number, error: string | null }[] }

const props = defineProps<{ projectId: string, admin: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const { dateTime } = useFormat()
const { base } = useScope()
const toast = useToast()

const { data, refresh } = await useFetch<{ feeds: FeedInfo[], recent: FeedItem[] }>(() => `/api/projects/${props.projectId}/feeds`, { key: `feeds-${props.projectId}` })
const url = ref('')
const busy = ref(false)
const result = ref<CheckResult | null>(null)

const short = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '')

async function run(fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
    await refresh()
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
function add() {
  return run(async () => {
    const r = await $fetch<{ entries: number }>(`/api/projects/${props.projectId}/feeds`, { method: 'POST', body: { url: url.value.trim() } })
    toast.push(t('feeds.added', { n: r.entries }))
    url.value = ''
  })
}
function remove(f: FeedInfo) {
  if (!confirm(t('feeds.removeConfirm', { url: short(f.url) }))) return
  return run(async () => {
    await $fetch(`/api/projects/${props.projectId}/feeds`, { method: 'DELETE', query: { url: f.url } })
  })
}
function check() {
  result.value = null
  return run(async () => {
    result.value = await $fetch<CheckResult>(`/api/projects/${props.projectId}/feeds-check`, { method: 'POST' })
  })
}
</script>

<template>
  <div class="feeds">
    <p class="hint">{{ t('feeds.help') }}</p>
    <ul v-if="data?.feeds.length" class="list">
      <li v-for="f in data.feeds" :key="f.url" class="line">
        <span class="mono ellipsis grow" :title="f.url">{{ short(f.url) }}</span>
        <span v-if="f.error" class="bad ellipsis">{{ f.error }}</span>
        <span v-else class="dim ellipsis">{{ f.syncedAt ? t('feeds.synced', { at: dateTime(f.syncedAt) }) : t('feeds.waiting') }}</span>
        <button v-if="admin" type="button" class="icon-btn" :disabled="busy" :aria-label="t('feeds.remove')" @click="remove(f)"><Icon name="x" /></button>
      </li>
    </ul>
    <form v-if="admin" class="add" @submit.prevent="add">
      <input v-model="url" class="input mono" type="text" required maxlength="500" :placeholder="t('feeds.placeholder')">
      <button type="submit" class="btn" :disabled="busy || !url.trim()">{{ t('feeds.add') }}</button>
      <button v-if="data?.feeds.length" type="button" class="btn" :disabled="busy" @click="check">{{ t('feeds.check') }}</button>
    </form>
    <p v-if="result" class="check" :class="result.ok ? 'ok' : 'bad'">{{ result.created ? t('feeds.created', { n: result.created, codes: result.tasks.join(', ') }, result.created) : t('feeds.nothing') }}<template v-for="f in result.feeds" :key="f.url"><template v-if="f.error"> · {{ short(f.url) }}: {{ f.error }}</template></template></p>
    <template v-if="data?.recent.length">
      <p class="sub dim">{{ t('feeds.recent') }}</p>
      <ul class="list">
        <li v-for="r in data.recent" :key="r.link" class="line">
          <a :href="r.link" target="_blank" rel="noopener" class="ellipsis grow">{{ r.title || short(r.link) }}</a>
          <NuxtLink v-if="r.taskId && r.code" :to="`${base}/aufgaben/${r.taskId}`" class="mono small">{{ r.code }}</NuxtLink>
          <span v-else class="dim small">{{ t(`feeds.status.${r.status}`) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.feeds {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hint,
.check,
.sub {
  margin: 0;
  font-size: 13px;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.line {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
  font-size: 13px;
}

.line + .line {
  border-top: 1px solid var(--line);
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
}

.line > .dim,
.line > .bad {
  flex: 0 1 auto;
  max-width: 45%;
}

.icon-btn {
  display: inline-flex;
  padding: 4px;
  border: 0;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
}

.icon-btn:hover {
  color: var(--down);
}

.add {
  display: flex;
  gap: 8px;
}

.add .input {
  flex: 1 1 auto;
}

.small {
  font-size: 12px;
}

.ok {
  color: var(--up);
}

.bad {
  color: var(--down);
}

@media (max-width: 600px) {
  .add {
    flex-wrap: wrap;
  }

  .add .input {
    flex: 1 1 100%;
  }
}
</style>
