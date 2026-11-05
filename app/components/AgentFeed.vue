<script setup lang="ts">
interface FeedItem {
  id: string
  at: string
  action: string
  projectId: string | null
  taskId: string | null
  detail: Record<string, unknown>
}

const props = withDefaults(defineProps<{ items: FeedItem[], base: string, limit?: number, title?: boolean }>(), { limit: 4, title: true })
const { t, te } = useI18n()
const { time, isoDay, dayDm } = useFormat()
const { projectColor } = useColors()
const { boot } = useBoot()

const NuxtLink = resolveComponent('NuxtLink')
const shown = computed(() => props.items.slice(0, props.limit))
const since = computed(() => {
  const last = shown.value[shown.value.length - 1]
  if (!last) return ''
  return isoDay(last.at) === boot.value?.today ? t('agent.since', { time: time(last.at) }) : dayDm(isoDay(last.at))
})

function text(f: FeedItem) {
  const key = `agent.feed.${f.action}`
  const title = String(f.detail.title ?? '')
  if (f.action.startsWith('status:')) {
    const st = f.action.slice(7)
    return t('agent.feed.status', { status: te(`status.${st}`) ? t(`status.${st}`) : st, title })
  }
  if (!te(key)) return te(`history.${f.action}`) ? [t(`history.${f.action}`), title].filter(Boolean).join(': ') : t('agent.feed.other', { title })
  const count = Number(f.detail.count ?? 0)
  const change = f.detail.change && te(`strategy.change.${f.detail.change}`) ? t(`strategy.change.${f.detail.change}`) : ''
  return f.action === 'recurrences_planned' ? t(key, count, { named: { count } }) : t(key, { title: String(f.detail.title ?? ''), count, change })
}
const stamp = (f: FeedItem) => (isoDay(f.at) === boot.value?.today ? time(f.at) : dayDm(isoDay(f.at)))
</script>

<template>
  <section aria-labelledby="h-feed" class="panel">
    <div v-if="props.title" class="panel-head">
      <span class="dot" /><h2 id="h-feed">{{ t('agent.title') }}</h2>
      <NuxtLink :to="`${props.base}/agent/protokoll`" class="since mono">{{ since || t('nav.agent') }}</NuxtLink>
    </div>
    <ol v-if="shown.length" class="rows">
      <li v-for="f in shown" :key="f.id">
        <component :is="f.taskId ? NuxtLink : 'div'" :to="f.taskId ? `${props.base}/aufgaben/${f.taskId}` : undefined" class="fl">
          <time class="mono dim t">{{ stamp(f) }}</time>
          <span class="p" :style="{ background: projectColor(f.projectId) }" />
          <span class="ellipsis tx">{{ text(f) }}</span>
        </component>
      </li>
    </ol>
    <p v-else class="empty">{{ t('agent.feedEmpty') }}</p>
  </section>
</template>

<style scoped>
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--agent);
  box-shadow: 0 0 0 4px var(--agent-soft);
  flex: none;
}

.since {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--dim);
  text-decoration: none;
}

.fl {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 16px;
  color: var(--muted);
  text-decoration: none;
}

a.fl:hover {
  background: var(--panel2);
  color: var(--text);
}

.t {
  flex: none;
  font-size: 12px;
  min-width: 40px;
}

.p {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 1px;
}

.tx {
  flex: 1 1 auto;
  font-size: 13px;
}
</style>
