<script setup lang="ts">
import { platformRule } from '~~/shared/utils/social'

interface ClientDraft {
  id: string
  title: string
  kind: string
  subject: string | null
  body: string
  platforms: { platform: string, text: string }[]
  media: { url: string, kind: 'image' | 'video', name: string }[]
  dueDate: string | null
  dueTime: string | null
  targetUrl: string | null
  feedback: { verdict: 'ok' | 'change', comment: string | null, at: string } | null
}
interface ClientBrand { name: string, logoUrl: string | null, accent: string | null, marker?: string | null, font?: string | null }
interface ClientData { brand: ClientBrand | null, project: { name: string, url: string | null }, lang: 'de' | 'en', timezone: string, canReport: boolean, expiresAt: string | null, drafts: ClientDraft[] }

definePageMeta({ layout: false })
const { t, locale, setLocale } = useI18n()
const route = useRoute()
const token = computed(() => String(route.params.token ?? ''))

const { data, error, refresh } = await useFetch<ClientData>(() => `/api/client/${token.value}`, { key: computed(() => `client:${token.value}`) })
if (data.value && data.value.lang !== locale.value) await setLocale(data.value.lang)
const brand = computed(() => data.value?.brand ?? null)
useHead(() => ({
  title: data.value ? `${t('client.page.title')} - ${data.value.project.name}` : t('client.page.title'),
  ...(brand.value ? { titleTemplate: (s?: string) => (s ? `${s} - ${brand.value!.name}` : brand.value!.name) } : {}),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
  link: brand.value?.logoUrl ? [{ rel: 'icon', href: brand.value.logoUrl, key: 'favicon' }] : [],
}))

const brandStyle = computed(() => brandThemeStyle(brand.value))
useHead(() => (brandStyle.value ? { htmlAttrs: { style: brandStyle.value } } : {}))

const loc = computed(() => (locale.value === 'en' ? 'en-GB' : 'de-AT'))
function when(d: ClientDraft) {
  if (!d.dueDate) return t('client.page.unplanned')
  const day = new Intl.DateTimeFormat(loc.value, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d.dueDate}T12:00:00Z`))
  return t('client.page.planned', { date: d.dueTime ? `${day}, ${d.dueTime}` : day })
}
const expires = computed(() => (data.value?.expiresAt ? new Intl.DateTimeFormat(loc.value, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(data.value.expiresAt)) : null))
const host = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

const open = ref<string | null>(null)
const comment = ref('')
const busy = ref(false)
const msg = ref<{ id: string, text: string, bad?: boolean } | null>(null)

function startChange(d: ClientDraft) {
  open.value = open.value === d.id ? null : d.id
  comment.value = ''
  msg.value = null
}

async function send(d: ClientDraft, verdict: 'ok' | 'change') {
  busy.value = true
  msg.value = null
  try {
    const r = await $fetch<{ approved: boolean }>(`/api/client/${token.value}/feedback`, { method: 'POST', body: { draftId: d.id, verdict, comment: verdict === 'change' ? comment.value : null } })
    open.value = null
    comment.value = ''
    msg.value = { id: d.id, text: verdict === 'change' ? t('client.page.thanksChange') : r.approved ? t('client.page.thanksApproved') : t('client.page.thanksOk') }
    await refresh()
  }
  catch (err) {
    const e = err as { statusCode?: number, statusMessage?: string, data?: { statusMessage?: string } }
    msg.value = { id: d.id, text: e.statusCode === 429 ? t('client.page.tooMany') : e.data?.statusMessage ?? e.statusMessage ?? String(err), bad: true }
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="client">
    <template v-if="data">
      <div v-if="brand" class="brandbar">
        <img v-if="brand.logoUrl" :src="brand.logoUrl" :alt="brand.name" class="logo">
        <span v-else class="brandname">{{ brand.name }}</span>
      </div>
      <header class="head">
        <p class="eyebrow">{{ t('client.page.title') }}</p>
        <h1>{{ data.project.name }}</h1>
        <p class="intro">{{ data.drafts.length ? t('client.page.intro') : t('client.page.empty') }}</p>
        <p class="meta">
          <a v-if="data.project.url" :href="data.project.url" target="_blank" rel="noopener">{{ host(data.project.url) }}</a>
          <a v-if="data.canReport" :href="`/api/client/${token}/report`" target="_blank" rel="noopener">{{ t('client.page.report') }}</a>
          <span v-if="expires">{{ t('client.page.expires', { date: expires }) }}</span>
        </p>
      </header>

      <article v-for="d in data.drafts" :key="d.id" class="card">
        <div class="card-top">
          <h2>{{ d.title }}</h2>
          <span class="when">{{ when(d) }}</span>
        </div>
        <p v-if="d.subject" class="subject">{{ d.subject }}</p>
        <p class="body">{{ d.body }}</p>
        <div v-if="d.media.length" class="media">
          <template v-for="m in d.media" :key="m.url">
            <img v-if="m.kind === 'image'" :src="m.url" :alt="m.name" loading="lazy">
            <video v-else :src="m.url" controls preload="metadata" :aria-label="t('client.page.video')" />
          </template>
        </div>
        <details v-if="d.platforms.length" class="variants">
          <summary>{{ t('client.page.variants') }} ({{ d.platforms.length }})</summary>
          <div v-for="v in d.platforms" :key="v.platform" class="variant">
            <span class="pf">{{ platformRule(v.platform).label }}</span>
            <p class="body">{{ v.text }}</p>
          </div>
        </details>
        <p v-if="d.targetUrl" class="target"><span class="dim">{{ t('client.page.target') }}:</span> <a :href="d.targetUrl" target="_blank" rel="noopener">{{ host(d.targetUrl.split('?')[0]!) }}</a></p>

        <p v-if="d.feedback" class="state" :class="d.feedback.verdict">
          {{ d.feedback.verdict === 'ok' ? t('client.page.stateOk') : t('client.page.stateChange') }}<template v-if="d.feedback.comment">: {{ d.feedback.comment }}</template>
        </p>
        <form v-if="open === d.id" class="change" @submit.prevent="send(d, 'change')">
          <label :for="`c-${d.id}`">{{ t('client.page.commentLabel') }}</label>
          <textarea :id="`c-${d.id}`" v-model="comment" class="textarea" rows="3" maxlength="2000" required />
          <div class="acts">
            <button type="submit" class="btn primary" :disabled="busy || !comment.trim()">{{ t('client.page.send') }}</button>
            <button type="button" class="btn ghost" :disabled="busy" @click="open = null">{{ t('client.page.cancel') }}</button>
          </div>
        </form>
        <div v-else class="acts">
          <button type="button" class="btn primary" :disabled="busy" @click="send(d, 'ok')"><Icon name="check" />{{ t('client.page.ok') }}</button>
          <button type="button" class="btn" :disabled="busy" @click="startChange(d)">{{ t('client.page.change') }}</button>
        </div>
        <p v-if="msg?.id === d.id" class="msg" :class="{ bad: msg.bad }" role="status">{{ msg.text }}</p>
      </article>
    </template>
    <div v-else class="head">
      <h1>{{ t('client.page.title') }}</h1>
      <p class="intro">{{ error?.statusCode === 429 ? t('client.page.tooMany') : t('client.page.invalid') }}</p>
    </div>
  </main>
</template>

<style scoped>
.brandbar {
  display: flex;
  align-items: center;
  min-height: 40px;
  margin-bottom: 8px;
}

.logo {
  max-height: 44px;
  max-width: 220px;
  object-fit: contain;
}

.brandname {
  font-size: 17px;
  font-weight: 700;
  color: var(--primary);
}

.client {
  max-width: 680px;
  margin: 0 auto;
  padding: 40px 16px 64px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

h1 {
  margin: 0;
  font-size: 24px;
  font-weight: var(--head-weight);
}

.intro {
  margin: 0;
  color: var(--muted);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--dim);
}

.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
}

.card-top {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

h2 {
  margin: 0;
  font-size: 15px;
  font-weight: var(--head-weight);
}

.when {
  font-size: 13px;
  color: var(--dim);
}

.subject {
  margin: 0;
  font-weight: 600;
}

.body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.media {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.media img,
.media video {
  width: 100%;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--panel2);
}

.variants summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--muted);
}

.variant {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding-left: 12px;
  font-style: italic;
}

.pf {
  font-size: 12px;
  font-weight: 600;
  color: var(--dim);
}

.target {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.state {
  margin: 0;
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 13px;
  background: var(--panel2);
}

.state.ok {
  color: var(--up);
}

.state.change {
  color: var(--warn);
}

.change {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.change label {
  font-size: 13px;
  color: var(--muted);
}

.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.acts .btn {
  min-height: 40px;
}

.msg {
  margin: 0;
  font-size: 13px;
  color: var(--up);
}

.msg.bad {
  color: var(--down);
}

/* Handy */
@media (max-width: 480px) {
  .client {
    padding-top: 24px;
  }

  .acts .btn {
    flex: 1 1 140px;
  }
}
</style>
