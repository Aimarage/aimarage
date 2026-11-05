<script setup lang="ts">
import { RELEASE_KINDS, type ReleaseKind } from '~~/shared/utils/release'

interface Defaults { today: string, start: string, platforms: { id: string, label: string }[], time: string, timeSource: 'data' | 'default', hasBlog: boolean, weekend: { social: boolean, human: boolean }, images: number, documents: { id: string, name: string }[] }
interface PlanTask { kind: string, title: string, date: string, time: string | null, platforms: string[], human: boolean, image: { name: string } | null, shifted: boolean }
interface Plan { tasks: PlanTask[], warnings: string[], items: string[], time: string }

const emit = defineEmits<{ created: [] }>()
const { t } = useI18n()
const { canEdit } = useBoot()
const { project } = useScope()
const { dayDm } = useFormat()
const toast = useToast()

const open = ref(false)
const busy = ref(false)
const defaults = ref<Defaults | null>(null)
const plan = ref<Plan | null>(null)
const form = ref({ title: '', kind: 'album' as ReleaseKind, releaseDate: '', link: '', items: '', documentId: '', platforms: [] as string[], start: '', every: 1, time: '', press: false })

async function start() {
  if (!project.value) return
  plan.value = null
  open.value = true
  try {
    const d = await $fetch<Defaults>(`/api/projects/${project.value.id}/release`)
    defaults.value = d
    form.value = { title: '', kind: 'album', releaseDate: d.start, link: '', items: '', documentId: '', platforms: d.platforms.map(p => p.id), start: '', every: 1, time: d.time, press: false }
  }
  catch (err) {
    toast.error(err)
    open.value = false
  }
}

function body(create: boolean) {
  const f = form.value
  return {
    title: f.title,
    kind: f.kind,
    releaseDate: f.releaseDate,
    link: f.link || null,
    items: f.items || null,
    documentId: f.documentId || null,
    platforms: f.platforms,
    start: f.start || null,
    every: f.every || 1,
    time: f.time || null,
    press: f.press,
    create,
  }
}

async function send(create: boolean) {
  if (!project.value) return
  busy.value = true
  try {
    const res = await $fetch<{ plan: Plan, created?: { code: string }[] }>(`/api/projects/${project.value.id}/release`, { method: 'POST', body: body(create) })
    if (create) {
      toast.push(t('release.created', { n: res.created?.length ?? 0 }))
      open.value = false
      emit('created')
      return
    }
    plan.value = res.plan
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const label = (id: string) => defaults.value?.platforms.find(p => p.id === id)?.label ?? id
</script>

<template>
  <template v-if="canEdit && project">
    <button type="button" class="btn" @click="start">{{ t('release.button') }}</button>
    <AppDialog :open="open" :title="t('release.title')" @close="open = false">
      <form v-if="defaults && !plan" class="rp" @submit.prevent="send(false)">
        <div class="form-grid">
          <label class="field wide"><span>{{ t('release.name') }}</span><input v-model="form.title" class="input" required maxlength="120"></label>
          <label class="field"><span>{{ t('release.kind') }}</span>
            <select v-model="form.kind" class="select"><option v-for="k in RELEASE_KINDS" :key="k" :value="k">{{ t(`release.kinds.${k}`) }}</option></select>
          </label>
          <label class="field"><span>{{ t('release.date') }}</span><input v-model="form.releaseDate" class="input" type="date" required></label>
          <label class="field wide"><span>{{ t('release.link') }}</span><input v-model="form.link" class="input" type="url" placeholder="https://"></label>
          <label class="field wide"><span>{{ form.kind === 'launch' ? t('release.features') : t('release.tracks') }}</span><textarea v-model="form.items" class="textarea" rows="5" :placeholder="t('release.itemsHint')" /></label>
          <label v-if="defaults.documents.length" class="field wide"><span>{{ t('release.document') }}</span>
            <select v-model="form.documentId" class="select">
              <option value="">{{ t('common.none') }}</option>
              <option v-for="d in defaults.documents" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </label>
          <div class="field wide">
            <span>{{ t('release.platforms') }}</span>
            <div v-if="defaults.platforms.length" class="checks">
              <label v-for="p in defaults.platforms" :key="p.id"><input v-model="form.platforms" type="checkbox" :value="p.id"> {{ p.label }}</label>
            </div>
            <small v-else>{{ t('release.noAccounts') }}</small>
          </div>
          <label class="field"><span>{{ t('release.start') }}</span><input v-model="form.start" class="input" type="date"></label>
          <label class="field"><span>{{ t('release.every') }}</span><input v-model.number="form.every" class="input" type="number" min="1" max="7"></label>
          <label class="field"><span>{{ t('release.time') }}</span><input v-model="form.time" class="input" type="time" step="900"><small>{{ defaults.timeSource === 'data' ? t('release.timeData') : t('release.timeDefault') }}</small></label>
          <div class="field">
            <span>{{ t('release.extras') }}</span>
            <label class="one"><input v-model="form.press" type="checkbox"> {{ t('release.press') }}</label>
          </div>
        </div>
        <p class="muted">{{ t('release.note', { images: defaults.images }) }}</p>
        <div class="form-actions">
          <button type="submit" class="btn primary" :disabled="busy">{{ t('release.preview') }}</button>
          <button type="button" class="btn ghost" @click="open = false">{{ t('task.cancel') }}</button>
        </div>
      </form>
      <div v-else-if="plan" class="rp">
        <p v-for="w in plan.warnings" :key="w" class="warn">{{ w }}</p>
        <ul class="plan">
          <li v-for="(x, i) in plan.tasks" :key="i">
            <span class="when">{{ dayDm(x.date) }}{{ x.time ? ` ${x.time}` : '' }}</span>
            <span class="what">
              {{ x.title }}
              <small>{{ [x.platforms.map(label).join(', '), x.human ? t('release.forYou') : '', x.image ? x.image.name : '', x.shifted ? t('release.shifted') : ''].filter(Boolean).join(' · ') }}</small>
            </span>
          </li>
        </ul>
        <div class="form-actions">
          <button type="button" class="btn primary" :disabled="busy || !plan.tasks.length" @click="send(true)">{{ t('release.create', { n: plan.tasks.length }) }}</button>
          <button type="button" class="btn ghost" @click="plan = null">{{ t('release.back') }}</button>
        </div>
      </div>
    </AppDialog>
  </template>
</template>

<style scoped>
.rp {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}

.checks label,
.one {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}

.muted {
  color: var(--muted);
  font-size: 13px;
}

.warn {
  font-size: 13px;
  color: var(--muted);
}

.plan {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}

.plan li {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
  font-size: 14px;
}

.when {
  flex: 0 0 92px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.what {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.what small {
  color: var(--muted);
  font-size: 12px;
}
</style>
