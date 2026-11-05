<script setup lang="ts">
export interface FundusEntry {
  id: string
  name: string
  mime: string
  kind: 'image' | 'video'
  size: number
  description: string
  tags: string[]
  checked: boolean
  source: string | null
  taskId: string | null
  usedCount: number
  createdAt: string
}

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { canEdit } = useBoot()
const toast = useToast()

const items = ref<FundusEntry[]>([])
const busy = ref(false)
const markChecked = ref(true)
const filter = ref<'all' | 'open'>('all')
const shown = computed(() => (filter.value === 'open' ? items.value.filter(i => !i.checked) : items.value))
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime'

async function load() {
  try {
    items.value = (await $fetch<{ items: FundusEntry[] }>(`/api/projects/${props.projectId}/fundus`)).items
  }
  catch (err) {
    toast.error(err)
  }
}
onMounted(load)
watch(() => props.projectId, load)

async function upload(files: File[]) {
  const fd = new FormData()
  for (const f of files) fd.append('file', f, f.name)
  fd.append('checked', markChecked.value ? '1' : '0')
  busy.value = true
  try {
    const res = await $fetch<{ items: FundusEntry[] }>(`/api/projects/${props.projectId}/fundus`, { method: 'POST', body: fd })
    items.value = [...res.items, ...items.value]
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function save(i: FundusEntry, patch: Partial<Pick<FundusEntry, 'description' | 'tags' | 'checked'>>) {
  try {
    const res = await $fetch<{ item: FundusEntry }>(`/api/projects/${props.projectId}/fundus/${i.id}`, { method: 'PATCH', body: patch })
    Object.assign(i, res.item)
  }
  catch (err) {
    toast.error(err)
  }
}

function saveDescription(i: FundusEntry, e: Event) {
  const v = (e.target as HTMLTextAreaElement).value.trim()
  if (v !== i.description) void save(i, { description: v })
}

function saveTags(i: FundusEntry, e: Event) {
  const tags = (e.target as HTMLInputElement).value.split(',').map(x => x.trim()).filter(Boolean)
  if (tags.join(',') !== i.tags.join(',')) void save(i, { tags })
}

async function remove(i: FundusEntry) {
  if (!window.confirm(t('fundus.removeConfirm', { name: i.name }))) return
  try {
    await $fetch(`/api/projects/${props.projectId}/fundus/${i.id}`, { method: 'DELETE' })
    items.value = items.value.filter(x => x.id !== i.id)
  }
  catch (err) {
    toast.error(err)
  }
}

const src = (i: FundusEntry) => `/api/projects/${props.projectId}/fundus/${i.id}/file`
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>{{ t('fundus.title') }}</h2>
      <span class="count">{{ items.filter(i => i.checked).length }}/{{ items.length }}</span>
      <div v-if="items.some(i => !i.checked)" class="seg fl" role="group" :aria-label="t('fundus.filter')">
        <button type="button" :aria-pressed="filter === 'all'" @click="filter = 'all'">{{ t('fundus.all') }}</button>
        <button type="button" :aria-pressed="filter === 'open'" @click="filter = 'open'">{{ t('fundus.unchecked') }}</button>
      </div>
    </div>
    <div v-if="canEdit" class="pad up">
      <FileDrop :accept="ACCEPT" :label="t('fundus.drop')" :hint="t('fundus.dropHint')" :busy="busy" @files="upload" />
      <label class="chk small"><input v-model="markChecked" type="checkbox"> {{ t('fundus.markChecked') }}</label>
    </div>
    <p v-if="!shown.length" class="empty">{{ t('fundus.empty') }}</p>
    <ul v-else class="grid">
      <li v-for="i in shown" :key="i.id" class="card" :class="{ off: !i.checked }">
        <img v-if="i.kind === 'image'" :src="src(i)" :alt="i.description || i.name" loading="lazy">
        <video v-else :src="src(i)" preload="metadata" controls muted playsinline :aria-label="i.description || i.name" />
        <div class="cb">
          <label class="chk"><input type="checkbox" :checked="i.checked" :disabled="!canEdit" @change="save(i, { checked: ($event.target as HTMLInputElement).checked })"> {{ t('fundus.checked') }}</label>
          <button v-if="canEdit" type="button" class="btn small ghost" :aria-label="t('common.delete')" @click="remove(i)"><Icon name="x" :size="12" /></button>
        </div>
        <textarea class="input desc" rows="2" :value="i.description" :placeholder="t('fundus.description')" :aria-label="t('fundus.description')" :disabled="!canEdit" maxlength="500" @change="saveDescription(i, $event)" />
        <input class="input tags" :value="i.tags.join(', ')" :placeholder="t('fundus.tags')" :aria-label="t('fundus.tags')" :disabled="!canEdit" @change="saveTags(i, $event)">
        <span class="small dim ellipsis">{{ i.name }}<template v-if="i.usedCount"> · {{ t('fundus.used', i.usedCount) }}</template></span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.pad {
  padding: 12px 16px;
  margin: 0;
}

.up {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 0;
}

.fl {
  margin-left: auto;
}

.chk {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.small {
  font-size: 12px;
}

.grid {
  list-style: none;
  margin: 0;
  padding: 4px 16px 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 14px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.card img,
.card video {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: 6px;
  background: var(--panel2);
}

.card.off img,
.card.off video {
  opacity: 0.55;
}

.cb {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.desc {
  min-height: 52px;
  font-size: 13px;
  resize: vertical;
}

.tags {
  min-height: 32px;
  font-size: 12.5px;
}
</style>
