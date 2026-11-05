<script setup lang="ts">
interface Issue { code: string, group: string, severity: number, url: string, params: Record<string, string | number> }
interface GroupTask { id: string, code: string, status: string }
interface SeoData {
  running: boolean
  url: string | null
  tasks: Record<string, GroupTask>
  audit: { checkedAt: string, pages: number, linksChecked: number, error: string | null, pagespeed: { score: number, lcp: string | null } | null, issues: Issue[] } | null
}

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { dateTime } = useFormat()
const { canEdit } = useBoot()
const toast = useToast()
const { base } = useScope()

const { data, refresh } = await useFetch<SeoData>(() => `/api/projects/${props.projectId}/seo`, { key: `seo:${props.projectId}` })
const started = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function poll() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => {
    await refresh()
    if (data.value?.running) poll()
    else started.value = false
  }, 4000)
}
onMounted(() => {
  if (data.value?.running) poll()
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

async function run() {
  try {
    await $fetch(`/api/projects/${props.projectId}/seo`, { method: 'POST' })
    started.value = true
    if (data.value) data.value.running = true
    poll()
  }
  catch (err) {
    toast.error(err)
  }
}

const fixing = ref<string | null>(null)
async function fix(group: string) {
  fixing.value = group
  try {
    const res = await $fetch<{ task: GroupTask }>(`/api/projects/${props.projectId}/seo-task`, { method: 'POST', body: { group } })
    if (data.value) data.value.tasks = { ...data.value.tasks, [group]: res.task }
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    fixing.value = null
  }
}

const groups = computed(() => {
  const m = new Map<string, { code: string, group: string, severity: number, items: Issue[] }>()
  for (const i of data.value?.audit?.issues ?? []) {
    const g = m.get(i.code) ?? { code: i.code, group: i.group, severity: i.severity, items: [] }
    g.severity = Math.max(g.severity, i.severity)
    g.items.push(i)
    m.set(i.code, g)
  }
  return [...m.values()].sort((a, b) => b.severity - a.severity)
})
const path = (u: string) => {
  try {
    return new URL(u).pathname || '/'
  }
  catch {
    return u
  }
}
const busy = computed(() => started.value || !!data.value?.running)
</script>

<template>
  <section v-if="data" class="panel">
    <div class="panel-head">
      <h2>{{ t('seo.title') }}</h2>
      <span v-if="data.audit" class="count">{{ t('seo.checked', { at: dateTime(data.audit.checkedAt), n: data.audit.pages }) }}</span>
    </div>
    <p v-if="!data.url" class="empty">{{ t('seo.noUrl') }}</p>
    <template v-else>
      <p v-if="data.audit?.error" class="terr">{{ data.audit.error }}</p>
      <ul v-if="groups.length" class="rows">
        <li v-for="g in groups" :key="g.code">
          <details class="grp">
            <summary>
              <span class="sev" :class="`s${g.severity}`">{{ t(`seo.sev.${g.severity}`) }}</span>
              <span class="ellipsis glabel">{{ t(`seo.code.${g.code}`) }}</span>
              <span class="mono dim">{{ g.items.length }}</span>
              <NuxtLink v-if="data.tasks?.[g.group]" :to="`${base}/aufgaben/${data.tasks[g.group]!.id}`" class="act small" @click.stop>{{ t('seo.task', { code: data.tasks[g.group]!.code }) }} <span class="dim">{{ t(`status.${data.tasks[g.group]!.status}`) }}</span></NuxtLink>
              <button v-else-if="canEdit" type="button" class="btn small act" :disabled="!!fixing" @click.prevent.stop="fix(g.group)">{{ fixing === g.group ? t('seo.fixing') : t('seo.fix') }}</button>
            </summary>
            <p class="hint why">{{ t(`seo.why.${g.code}`) }}</p>
            <ul class="pages">
              <li v-for="i in g.items" :key="i.url">
                <a :href="i.url" target="_blank" rel="noopener noreferrer" class="mono">{{ path(i.url) }}</a>
                <span class="dim">{{ t(`seo.detail.${i.code}`, i.params) }}</span>
              </li>
            </ul>
          </details>
        </li>
      </ul>
      <p v-else-if="data.audit && !data.audit.error" class="empty">{{ t('seo.clean') }}</p>
      <p v-else-if="!data.audit" class="empty">{{ t('seo.never') }}</p>
      <div class="foot">
        <span class="dim small">{{ t('seo.local') }}</span>
        <button v-if="canEdit" type="button" class="btn small" :disabled="busy" @click="run">{{ busy ? t('seo.running') : t('seo.run') }}</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.grp > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 16px;
  cursor: pointer;
  list-style: none;
  font-size: 13.5px;
}

.grp > summary::-webkit-details-marker {
  display: none;
}

.grp > summary:hover {
  background: var(--panel2);
}

.glabel {
  flex: 1 1 auto;
}

.act {
  flex: 0 0 auto;
  white-space: nowrap;
}

.sev {
  flex: 0 0 auto;
  min-width: 64px;
  font-size: 11.5px;
  font-weight: 500;
}

.s3 {
  color: var(--down);
}

.s2 {
  color: var(--warn);
}

.s1 {
  color: var(--dim);
}

.why {
  margin: 0;
  padding: 0 16px 6px 92px;
}

.pages {
  margin: 0;
  padding: 0 16px 10px 92px;
  list-style: none;
  font-size: 12.5px;
}

.pages li {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  padding: 3px 0;
  overflow-wrap: anywhere;
}

.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--line);
}

.small {
  font-size: 12px;
}

.terr {
  margin: 0;
  padding: 8px 16px;
  color: var(--down);
  font-size: 12.5px;
}

@media (max-width: 600px) {
  .why,
  .pages {
    padding-left: 16px;
  }
}
</style>
