<script setup lang="ts">
export interface DocItem {
  id: string
  name: string
  type: string
  size: number
  chars: number
  summary: string | null
  facts: { text: string, saved: boolean }[]
  status: 'neu' | 'fertig' | 'fehler'
  error: string | null
  createdAt: string
}

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { canEdit } = useBoot()
const toast = useToast()
const { dm, isoDay } = useFormat()

const docs = ref<DocItem[]>([])
const accept = ref('.pdf,.docx,.xlsx,.csv,.txt,.md')
const maxMb = ref(20)
const busy = ref(false)
const open = ref<string | null>(null)
const removing = ref<DocItem | null>(null)
const removeFacts = ref(true)
let timer: ReturnType<typeof setTimeout> | undefined
let alive = true

async function load() {
  clearTimeout(timer)
  try {
    const res = await $fetch<{ documents: DocItem[], accept: string, maxMb: number }>(`/api/projects/${props.projectId}/documents`)
    docs.value = res.documents
    accept.value = res.accept
    maxMb.value = res.maxMb
  }
  catch (err) {
    toast.error(err)
  }
  if (alive && docs.value.some(d => d.status === 'neu')) timer = setTimeout(load, 4000)
}
onMounted(load)
onBeforeUnmount(() => {
  alive = false
  clearTimeout(timer)
})
watch(() => props.projectId, load)

async function upload(files: File[]) {
  const fd = new FormData()
  for (const f of files) fd.append('file', f, f.name)
  busy.value = true
  try {
    const res = await $fetch<{ documents: DocItem[] }>(`/api/projects/${props.projectId}/documents`, { method: 'POST', body: fd })
    toast.push(t('docs.added', res.documents.length))
    await load()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function remember(d: DocItem, index: number) {
  try {
    await $fetch(`/api/projects/${props.projectId}/documents/${d.id}/fact`, { method: 'POST', body: { index } })
    d.facts[index]!.saved = true
    toast.push(t('talk.remembered'))
  }
  catch (err) {
    toast.error(err)
  }
}

function askRemove(d: DocItem) {
  removing.value = d
  removeFacts.value = true
}

async function confirmRemove() {
  const d = removing.value
  if (!d) return
  try {
    await $fetch(`/api/projects/${props.projectId}/documents/${d.id}`, { method: 'DELETE', query: d.facts.some(f => f.saved) && removeFacts.value ? { facts: '1' } : {} })
    docs.value = docs.value.filter(x => x.id !== d.id)
    removing.value = null
  }
  catch (err) {
    toast.error(err)
  }
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('docs.title') }}</h2><span class="count">{{ docs.length }}</span></div>
    <div v-if="canEdit" class="pad">
      <FileDrop :accept="accept" :label="t('docs.drop')" :hint="t('docs.dropHint', { mb: maxMb })" :busy="busy" @files="upload" />
    </div>
    <p v-if="!docs.length" class="empty">{{ t('docs.empty') }}</p>
    <ul v-else class="rows">
      <li v-for="d in docs" :key="d.id" class="doc">
        <div class="line">
          <Icon name="doc" class="dim" />
          <button type="button" class="name ellipsis" :aria-expanded="open === d.id" @click="open = open === d.id ? null : d.id">{{ d.name }}</button>
          <span class="meta dim mono">{{ d.type.toUpperCase() }} · {{ kb(d.size) }} · {{ dm(isoDay(d.createdAt)) }}</span>
          <a class="btn small ghost" :href="`/api/projects/${props.projectId}/documents/${d.id}/file`" :aria-label="t('docs.download')"><Icon name="down" :size="12" /></a>
          <button v-if="canEdit" type="button" class="btn small ghost" :aria-label="t('common.delete')" @click="askRemove(d)"><Icon name="x" :size="12" /></button>
        </div>
        <p v-if="d.status === 'neu'" class="sub dim">{{ t('docs.reading') }}</p>
        <p v-else-if="d.error" class="sub bad">{{ d.error }}</p>
        <p v-if="d.summary" class="sub">{{ d.summary }}</p>
        <div v-if="open === d.id || d.facts.some(f => !f.saved)" class="facts">
          <div v-for="(f, i) in d.facts" :key="i" class="fact" :class="{ saved: f.saved }">
            <span class="ft">{{ f.text }}</span>
            <span v-if="f.saved" class="dim small">{{ t('talk.saved') }}</span>
            <button v-else-if="canEdit" type="button" class="btn small" @click="remember(d, i)">{{ t('talk.remember') }}</button>
          </div>
          <p v-if="open === d.id" class="sub dim small">{{ t('docs.chars', { n: d.chars }) }}</p>
        </div>
      </li>
    </ul>

    <AppDialog :open="!!removing" :title="t('docs.removeTitle')" @close="removing = null">
      <p class="dtext">{{ t('docs.removeText', { name: removing?.name ?? '' }) }}</p>
      <label v-if="removing?.facts.some(f => f.saved)" class="chk"><input v-model="removeFacts" type="checkbox"> {{ t('docs.removeFacts') }}</label>
      <div class="form-actions">
        <button type="button" class="btn danger" @click="confirmRemove">{{ t('common.delete') }}</button>
        <button type="button" class="btn ghost" @click="removing = null">{{ t('common.cancel') }}</button>
      </div>
    </AppDialog>
  </section>
</template>

<style scoped>
.pad {
  padding: 12px 16px;
}

.doc {
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.meta {
  font-size: 11.5px;
  white-space: nowrap;
}

.sub {
  margin: 0 0 0 26px;
  font-size: 13px;
  line-height: 1.5;
}

.small {
  font-size: 12px;
}

.bad {
  color: var(--down);
}

.facts {
  margin-left: 26px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.facts .sub {
  margin: 0;
}

.fact {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px dashed var(--line2);
  border-radius: 4px;
  font-size: 13px;
}

.fact.saved {
  border-style: solid;
  border-color: var(--line);
  color: var(--muted);
}

.ft {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dtext {
  margin: 0 0 12px;
  font-size: 14px;
}

.chk {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 13.5px;
}

@media (max-width: 600px) {
  .meta {
    display: none;
  }
}
</style>
