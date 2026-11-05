<script setup lang="ts">
interface PageItem { url: string, title: string | null, chars: number, linked: boolean }

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { canEdit } = useBoot()
const toast = useToast()
const { dm, isoDay } = useFormat()

const url = ref<string | null>(null)
const pages = ref<PageItem[]>([])
const fetchedAt = ref<string | null>(null)
const open = ref(false)
const queued = ref(false)

async function load() {
  try {
    const res = await $fetch<{ url: string | null, fetchedAt: string | null, pages: PageItem[] }>(`/api/projects/${props.projectId}/site-pages`)
    url.value = res.url
    pages.value = res.pages
    fetchedAt.value = res.fetchedAt
  }
  catch (err) {
    toast.error(err)
  }
}
onMounted(load)
watch(() => props.projectId, () => {
  queued.value = false
  void load()
})

async function refresh() {
  try {
    await $fetch(`/api/projects/${props.projectId}/site-pages`, { method: 'POST' })
    queued.value = true
    toast.push(t('sitePages.queued'))
  }
  catch (err) {
    toast.error(err)
  }
}

const linked = computed(() => pages.value.filter(p => p.linked).length)
</script>

<template>
  <section v-if="url" class="panel">
    <div class="panel-head"><h2>{{ t('sitePages.title') }}</h2><span class="count">{{ pages.length }}</span></div>
    <div class="pad line">
      <p class="sub">
        <template v-if="pages.length">{{ t('sitePages.summary', { n: pages.length, linked, date: dm(isoDay(fetchedAt!)) }) }}</template>
        <template v-else>{{ t('sitePages.none') }}</template>
      </p>
      <button v-if="pages.length" type="button" class="btn small ghost" :aria-expanded="open" @click="open = !open">{{ open ? t('sitePages.hide') : t('sitePages.show') }}</button>
      <button v-if="canEdit" type="button" class="btn small" :disabled="queued" @click="refresh">{{ t('sitePages.refresh') }}</button>
    </div>
    <ul v-if="open" class="rows">
      <li v-for="p in pages" :key="p.url" class="page-row">
        <a :href="p.url" target="_blank" rel="noopener" class="ellipsis">{{ p.title || p.url }}</a>
        <span class="meta dim mono">{{ p.linked ? t('sitePages.linked') : '' }} {{ p.chars }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.pad {
  padding: 12px 16px;
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sub {
  flex: 1 1 auto;
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.page-row {
  padding: 6px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
}

.page-row a {
  flex: 1 1 auto;
  min-width: 0;
}

.meta {
  font-size: 11.5px;
  white-space: nowrap;
}
</style>
