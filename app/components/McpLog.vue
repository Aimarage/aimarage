<script setup lang="ts">
interface Call { id: number, at: string, user: string | null, key: string, tokenId: string | null, client: string | null, ip: string | null, via: 'mcp' | 'rest', tool: string, project: string | null, args: Record<string, string>, ok: boolean, denied: boolean, error: string | null, bytes: number, ms: number }
interface Log { calls: Call[], admin: boolean, days: number }

const { t } = useI18n()
const toast = useToast()
const { dateTime } = useFormat()
const { data } = await useFetch<Log>('/api/me/mcp-log', { key: 'mcp-log' })
const more = ref<Call[]>([])
const done = ref(false)
const calls = computed(() => [...(data.value?.calls ?? []), ...more.value])

const argText = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(', ')
const size = (n: number) => (n >= 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${n} B`)

async function loadMore() {
  const last = calls.value.at(-1)
  if (!last) return
  try {
    const r = await $fetch<Log>('/api/me/mcp-log', { query: { before: last.id } })
    more.value.push(...r.calls)
    if (r.calls.length < 100) done.value = true
  }
  catch (err) {
    toast.error(err)
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('mcpLog.title') }}</h2></div>
    <div class="panel-body">
      <p class="hint">{{ data?.admin ? t('mcpLog.introAdmin', { n: data.days }) : t('mcpLog.intro', { n: data?.days ?? 90 }) }}</p>
    </div>
    <p v-if="!calls.length" class="panel-body dim small">{{ t('mcpLog.empty') }}</p>
    <ul v-else class="rows">
      <li v-for="c in calls" :key="c.id" class="crow">
        <div class="line">
          <span class="mono small">{{ dateTime(c.at) }}</span>
          <b class="mono">{{ c.tool }}</b>
          <span v-if="c.project" class="tag">{{ c.project }}</span>
          <span class="tag" :class="c.ok ? 'ok' : 'bad'">{{ c.ok ? t('mcpLog.ok') : c.denied ? t('mcpLog.denied') : t('mcpLog.failed') }}</span>
          <span class="dim small">{{ size(c.bytes) }}, {{ c.ms }} ms</span>
        </div>
        <div class="line dim small">
          <span>{{ c.key }}<template v-if="data?.admin && c.user"> ({{ c.user }})</template></span>
          <span v-if="c.client">{{ c.client }}</span>
          <span v-if="c.ip" class="mono">{{ c.ip }}</span>
          <span v-if="Object.keys(c.args).length" class="args">{{ argText(c.args) }}</span>
          <span v-if="c.error" class="err">{{ c.error }}</span>
        </div>
      </li>
    </ul>
    <div v-if="calls.length >= 100 && !done" class="panel-body"><button type="button" class="btn small ghost" @click="loadMore">{{ t('mcpLog.more') }}</button></div>
  </section>
</template>

<style scoped>
.crow {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 16px;
}

.line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.tag {
  font-size: 12px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
}

.tag.ok {
  border-color: var(--up);
}

.tag.bad {
  border-color: var(--warn);
  color: var(--warn);
}

.args {
  overflow-wrap: anywhere;
}

.err {
  color: var(--warn);
}

.small {
  font-size: 12px;
}
</style>
