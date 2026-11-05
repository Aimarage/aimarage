<script setup lang="ts">
import { platformRule, postIssues, postLength, textFor } from '~~/shared/utils/social'

export interface SocialInfo {
  possible: boolean
  live: boolean
  accounts: { platform: string, name: string, postable: boolean, via: 'own' | 'uploadpost' }[]
  chosen: string[]
  planned: string | null
  posts: { id: string, status: string, mode: string, dryRun: boolean, scheduledAt: string, updatedAt: string, postedAt: string | null, platforms: string[], results: { platform: string, ok: boolean | null, url: string | null, error: string | null }[], error: string | null }[]
}

export interface MediaItem {
  id: string
  name: string
  mime: string
  size: number
}

const props = defineProps<{
  draftId: string
  body: string
  variants: Record<string, string>
  social: SocialInfo
  media: MediaItem[]
  editable: boolean
  projectId?: string | null
}>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const { base } = useScope()
const toast = useToast()
const { dateTime } = useFormat()

const posted = computed(() => new Set(props.social.posts.filter(x => x.status === 'gepostet' || x.status === 'teilweise').flatMap(x => x.results.filter(r => r.ok).map(r => r.platform))))
const picked = ref<string[]>(props.social.chosen.filter(p => !posted.value.has(p)))
watch(() => [props.social.chosen, posted.value] as const, ([v, done]) => (picked.value = v.filter(p => !done.has(p))))
const media = ref<MediaItem[]>([...props.media])
watch(() => props.media, v => (media.value = [...v]))

const rows = computed(() => props.social.accounts.map((a) => {
  const text = textFor(a.platform, props.body, props.variants)
  const rule = platformRule(a.platform)
  return { ...a, rule, text, len: postLength(a.platform, text), issues: postIssues(a.platform, text, media.value) }
}))
const active = computed(() => rows.value.filter(r => picked.value.includes(r.platform)))
const blocking = computed(() => active.value.some(r => r.issues.length))
const needsMedia = computed(() => active.value.some(r => r.issues.includes('image_needed') || r.issues.includes('video_needed')))
const openPost = computed(() => props.social.posts.find(p => p.status === 'geplant' || p.status === 'laeuft') ?? null)

function toggle(p: string) {
  picked.value = picked.value.includes(p) ? picked.value.filter(x => x !== p) : [...picked.value, p]
}

const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
async function upload(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files?.length) return
  const fd = new FormData()
  for (const f of Array.from(files)) fd.append('file', f, f.name)
  busy.value = true
  try {
    const res = await $fetch<{ media: MediaItem[] }>(`/api/drafts/${props.draftId}/media`, { method: 'POST', body: fd })
    media.value = res.media
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}
async function removeMedia(id: string) {
  try {
    const res = await $fetch<{ media: MediaItem[] }>(`/api/drafts/${props.draftId}/media/${id}`, { method: 'DELETE' })
    media.value = res.media
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
}

const picking = ref(false)
const fundus = ref<{ id: string, name: string, kind: 'image' | 'video', description: string, tags: string[] }[] | null>(null)
async function openFundus() {
  picking.value = true
  fundus.value = null
  try {
    fundus.value = (await $fetch<{ items: NonNullable<typeof fundus.value> }>(`/api/projects/${props.projectId}/fundus`, { query: { checked: '1' } })).items
  }
  catch (err) {
    toast.error(err)
    picking.value = false
  }
}
async function takeFundus(id: string) {
  busy.value = true
  try {
    const res = await $fetch<{ media: MediaItem[] }>(`/api/drafts/${props.draftId}/media/fundus`, { method: 'POST', body: { itemId: id } })
    media.value = res.media
    picking.value = false
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function publish(when: 'now' | 'planned') {
  const names = picked.value.map(id => platformRule(id).label).join(', ')
  if (!window.confirm(t(when === 'now' ? 'publish.confirmNow' : 'publish.confirmPlanned', { platforms: names }))) return
  busy.value = true
  try {
    const res = await $fetch<{ at: string, live: boolean }>(`/api/drafts/${props.draftId}/publish`, { method: 'POST', body: { when, platforms: picked.value } })
    toast.push(when === 'now' ? (res.live ? t('publish.sending') : t('publish.dryQueued')) : t('publish.scheduled', { at: dateTime(res.at) }))
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const sendingNow = (p: SocialInfo['posts'][number]) => p.status === 'laeuft' || (p.status === 'geplant' && new Date(p.scheduledAt).getTime() <= Date.now() + 60_000)
let poll: ReturnType<typeof setInterval> | null = null
watch(() => props.social.posts.some(sendingNow), (on) => {
  if (on && !poll) poll = setInterval(() => emit('changed'), 5000)
  if (!on && poll) {
    clearInterval(poll)
    poll = null
  }
}, { immediate: true })
onBeforeUnmount(() => poll && clearInterval(poll))

const statusClass: Record<string, string> = { geplant: 's-geplant', laeuft: 's-entwurf_fertig', gepostet: 's-erledigt', teilweise: 's-wartet', fehler: 's-verworfen', trocken: 's-wartet', abgebrochen: 's-verworfen' }
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('publish.title') }}</h2><span class="count">{{ active.length }}/{{ rows.length }}</span></div>
    <p v-if="!props.social.live" class="dry"><Icon name="x" :size="13" />{{ t('publish.dryHint') }} <NuxtLink to="/einstellungen/veroeffentlichen">{{ t('publish.switchLink') }}</NuxtLink></p>
    <p v-if="!rows.length" class="hint pad">{{ t('publish.noAccounts') }} <NuxtLink :to="`${base}/konten`">{{ t('nav.accounts') }}</NuxtLink></p>

    <ul v-else class="rows">
      <li v-for="r in rows" :key="r.platform" class="prow" :class="{ off: !picked.includes(r.platform) }">
        <label class="pick">
          <input type="checkbox" :checked="picked.includes(r.platform)" :disabled="!r.postable || !props.editable || posted.has(r.platform)" :title="posted.has(r.platform) ? t('publish.alreadyPosted') : undefined" @change="toggle(r.platform)">
          <b>{{ r.rule.label }}</b>
          <span class="dim ellipsis acc">{{ r.name }}<span v-if="r.via === 'uploadpost'" class="us">{{ t('publish.usService') }}</span></span>
          <span class="mono small" :class="{ bad: r.len > r.rule.max }">{{ r.len }}/{{ r.rule.max }}</span>
        </label>
        <p v-if="!r.postable" class="small dim">{{ t('publish.neverAuto') }}</p>
        <p v-else-if="picked.includes(r.platform) && r.issues.length" class="small bad">{{ r.issues.map(i => t(`publish.issue.${i}`)).join(', ') }}</p>
        <p v-else-if="picked.includes(r.platform) && r.rule.note === 'links' && /https?:\/\//.test(r.text)" class="small warnc">{{ t('publish.xLinks') }}</p>
      </li>
    </ul>

    <div v-if="rows.length" class="mediabox" :class="{ need: needsMedia }">
      <p class="mhead"><b>{{ needsMedia ? t('publish.mediaNeeded') : t('publish.media') }}</b><span class="dim small">{{ t('publish.mediaHint') }}</span></p>
      <p v-if="media.length > 1" class="small dim">{{ t('publish.carousel', { n: media.length }) }}</p>
      <ul v-if="media.length" class="thumbs">
        <li v-for="(m, i) in media" :key="m.id">
          <img v-if="m.mime.startsWith('image/')" :src="`/api/media/${props.draftId}/${m.id}`" :alt="m.name">
          <video v-else class="vid" :src="`/api/media/${props.draftId}/${m.id}`" preload="metadata" controls muted playsinline :aria-label="`${t('publish.video')}: ${m.name}`" />
          <span v-if="media.length > 1" class="num mono">{{ i + 1 }}</span>
          <span class="small ellipsis">{{ m.name }} <span class="dim">{{ kb(m.size) }}</span></span>
          <button v-if="props.editable" type="button" class="btn small ghost" :aria-label="t('common.delete')" @click="removeMedia(m.id)"><Icon name="x" :size="12" /></button>
        </li>
      </ul>
      <div v-if="props.editable" class="mbtns">
        <label class="btn small up"><Icon name="plus" :size="12" />{{ t('publish.upload') }}<input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime" multiple hidden @change="upload"></label>
        <button v-if="props.projectId" type="button" class="btn small" :disabled="busy" @click="openFundus"><Icon name="image" :size="12" />{{ t('fundus.pick') }}</button>
      </div>
    </div>

    <AppDialog :open="picking" :title="t('fundus.pick')" @close="picking = false">
      <p v-if="fundus && !fundus.length" class="small dim">{{ t('fundus.pickEmpty') }}</p>
      <ul v-else-if="fundus" class="fgrid">
        <li v-for="f in fundus" :key="f.id">
          <button type="button" class="fpick" :disabled="busy" :title="f.description || f.name" @click="takeFundus(f.id)">
            <img v-if="f.kind === 'image'" :src="`/api/projects/${props.projectId}/fundus/${f.id}/file`" :alt="f.description || f.name" loading="lazy">
            <video v-else :src="`/api/projects/${props.projectId}/fundus/${f.id}/file`" preload="metadata" muted playsinline />
            <span class="small ellipsis">{{ f.description || f.name }}</span>
          </button>
        </li>
      </ul>
    </AppDialog>

    <div v-if="props.editable && rows.length" class="form-actions pad">
      <button type="button" class="btn primary" :disabled="busy || !active.length || blocking" @click="publish('now')"><Icon name="play" :size="13" />{{ t('publish.now') }}</button>
      <button type="button" class="btn" :disabled="busy || !active.length || blocking || !props.social.planned" @click="publish('planned')">{{ t('publish.planned') }}<template v-if="props.social.planned"> ({{ dateTime(props.social.planned) }})</template></button>
    </div>

    <ul v-if="props.social.posts.length" class="rows hist">
      <li v-for="p in props.social.posts" :key="p.id" class="prow">
        <span class="line">
          <span class="pill" :class="statusClass[p.status]">{{ sendingNow(p) ? t('publish.sendingNow') : t(`publish.status.${p.status}`) }}</span>
          <span class="mono small dim">{{ dateTime(p.postedAt ?? p.scheduledAt) }}</span>
          <span class="small dim">{{ t(`publish.mode.${p.mode}`) }}</span>
        </span>
        <span v-for="r in p.results.filter(x => x.ok !== null || p.status !== 'geplant')" :key="r.platform" class="small res">
          {{ platformRule(r.platform).label }}:
          <a v-if="r.url" :href="r.url" target="_blank" rel="noopener noreferrer">{{ t('publish.open') }}</a>
          <span v-else-if="r.ok" class="okc">ok</span>
          <span v-else-if="r.ok === false" class="bad">{{ r.error }}</span>
          <span v-else class="dim">-</span>
        </span>
        <span v-if="p.error && p.status === 'fehler'" class="small bad">{{ p.error }}</span>
      </li>
    </ul>
    <p v-if="openPost" class="hint pad">{{ openPost.status === 'geplant' ? t('publish.waiting', { at: dateTime(openPost.scheduledAt) }) : t('publish.running') }}</p>
  </section>
</template>

<style scoped>
.dry {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 10px 16px;
  background: var(--panel2);
  border-bottom: 1px solid var(--line);
  color: var(--warn);
  font-size: 13px;
}

.prow {
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.prow.off {
  opacity: 0.6;
}

.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13.5px;
}

.acc {
  flex: 1;
  min-width: 0;
}

.small {
  font-size: 12px;
}

.bad {
  color: var(--down);
}

.warnc {
  color: var(--warn);
}

.okc {
  color: var(--up);
}

.mediabox {
  margin: 12px 16px;
  padding: 12px;
  border: 1px dashed var(--line2);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mediabox.need {
  border-color: var(--down);
  background: var(--panel2);
}

.mhead {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 13px;
}

.thumbs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.thumbs li {
  width: 120px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
}

.thumbs img,
.vid {
  width: 120px;
  height: 90px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--panel2);
  display: grid;
  place-items: center;
}

.num {
  position: absolute;
  top: 4px;
  left: 4px;
  min-width: 18px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--panel);
  font-size: 11px;
  text-align: center;
}

.us {
  margin-left: 6px;
  padding: 0 4px;
  border: 1px solid var(--line2);
  border-radius: 4px;
  font-size: 11px;
}

.thumbs .btn {
  position: absolute;
  top: 4px;
  right: 4px;
  background: var(--panel);
}

.up {
  cursor: pointer;
}

.mbtns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.fgrid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.fpick {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.fpick:hover {
  border-color: var(--agent);
}

.fpick img,
.fpick video {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: 7px;
  background: var(--panel2);
}

.pad {
  padding: 12px 16px 16px;
  margin: 0;
}

.hist {
  border-top: 1px solid var(--line);
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.res {
  overflow-wrap: anywhere;
}
</style>
