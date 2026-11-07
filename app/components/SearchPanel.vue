<script setup lang="ts">
import { isAccessExpired } from '~~/shared/utils/access'

interface Term { query: string, clicks: number, impressions: number, position: number, page: string | null }
interface SearchData {
  admin: boolean
  appReady: boolean
  google: { property: string | null, connectedAt: string | null, lastSync: string | null, error: string | null } | null
  summary: Summary | null
  bing: { keyReady: boolean, site: string | null, off: boolean, lastSync: string | null, error: string | null }
  bingSummary: Summary | null
}
interface Summary { from: string, to: string, clicks: number, impressions: number, position: number | null, series: number[], top: Term[], chances: Term[], dropped: { page: string, before: number, now: number }[] }

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { num, dayDm, dateTime } = useFormat()
const toast = useToast()
const route = useRoute()

const { data, refresh } = await useFetch<SearchData>(() => `/api/projects/${props.projectId}/search`, { key: `search:${props.projectId}` })
const sites = ref<string[] | null>(null)
const choice = ref('')
const busy = ref(false)
const tab = ref<'google' | 'bing'>(route.query.tab === 'bing' ? 'bing' : 'google')
const bingSites = ref<string[] | null>(null)
const bingChoice = ref('')

if (route.query.googleError) toast.push(String(route.query.googleError), 'error')
onMounted(() => {
  if (route.query.reconnect === 'google' && data.value?.admin && data.value.appReady && data.value.google) connect()
})

async function connect() {
  busy.value = true
  try {
    const r = await $fetch<{ url: string }>(`/api/projects/${props.projectId}/google-start`, { method: 'POST' })
    window.location.href = r.url
  }
  catch (err) {
    toast.error(err)
    busy.value = false
  }
}

async function loadSites() {
  busy.value = true
  try {
    const r = await $fetch<{ sites: string[], suggested: string | null, current: string | null, error: string | null }>(`/api/projects/${props.projectId}/google-sites`)
    if (r.error) toast.push(r.error, 'error')
    sites.value = r.sites
    choice.value = r.current ?? r.suggested ?? r.sites[0] ?? ''
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function saveProperty() {
  if (!choice.value) return
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.projectId}/google-property`, { method: 'PUT', body: { property: choice.value } })
    sites.value = null
    toast.push(t('search.syncQueued'))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function syncNow() {
  try {
    await $fetch(`/api/projects/${props.projectId}/search-sync`, { method: 'POST' })
    toast.push(t('search.syncQueued'))
  }
  catch (err) {
    toast.error(err)
  }
}

async function disconnect() {
  if (!confirm(t('search.disconnectConfirm'))) return
  try {
    await $fetch(`/api/projects/${props.projectId}/google`, { method: 'DELETE' })
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

async function loadBingSites() {
  busy.value = true
  try {
    const r = await $fetch<{ sites: string[], suggested: string | null, current: string | null, error: string | null }>(`/api/projects/${props.projectId}/bing-sites`)
    if (r.error) toast.push(r.error, 'error')
    bingSites.value = r.sites
    bingChoice.value = r.current ?? r.suggested ?? r.sites[0] ?? ''
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function saveBing(site: string | null) {
  if (site === null && !confirm(t('search.bingOffConfirm'))) return
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.projectId}/bing-site`, { method: 'PUT', body: { site } })
    bingSites.value = null
    if (site) toast.push(t('search.syncQueued'))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const g = computed(() => data.value?.google ?? null)
const b = computed(() => data.value?.bing ?? null)
const bingOn = computed(() => !!b.value?.keyReady && !!b.value.site && !b.value.off)
const s = computed(() => (tab.value === 'bing' ? (bingOn.value ? data.value?.bingSummary : null) : (g.value?.property ? data.value?.summary : null)) ?? null)
const synced = computed(() => (tab.value === 'bing' ? b.value?.lastSync : g.value?.lastSync) ?? null)
const showBingPicker = computed(() => !!b.value?.keyReady && !b.value.off && (!b.value.site || bingSites.value !== null))
if (!g.value && data.value?.bing.site && !data.value.bing.off) tab.value = 'bing'
const expired = computed(() => !!g.value?.error && isAccessExpired(g.value.error))
const showPicker = computed(() => !!g.value && !expired.value && (!g.value.property || sites.value !== null))
watchEffect(() => {
  if (data.value?.admin && g.value && !expired.value && !g.value.property && sites.value === null && !busy.value) loadSites()
  if (tab.value === 'bing' && data.value?.admin && b.value?.keyReady && !b.value.off && !b.value.site && bingSites.value === null && !busy.value) loadBingSites()
})
const path = (u: string | null) => {
  if (!u) return ''
  try {
    return new URL(u).pathname
  }
  catch {
    return u
  }
}
const ctr = (x: Term) => (x.impressions ? `${Math.round((x.clicks / x.impressions) * 1000) / 10} %` : '-')
</script>

<template>
  <section v-if="data" class="panel">
    <div class="panel-head">
      <h2>{{ t('search.title') }}</h2>
      <span v-if="s && s.impressions" class="count">{{ dayDm(s.from) }} - {{ dayDm(s.to) }}</span>
      <span class="seg" role="tablist">
        <button v-for="x in (['google', 'bing'] as const)" :key="x" type="button" role="tab" class="segb" :class="{ on: tab === x }" :aria-selected="tab === x" @click="tab = x">{{ x === 'google' ? 'Google' : 'Bing' }}</button>
      </span>
    </div>

    <template v-if="tab === 'google'">
      <div v-if="!g" class="pad">
        <p class="hint">{{ t('search.intro') }}</p>
        <p class="hint">{{ t('search.privacy') }}</p>
        <template v-if="data.admin">
          <button v-if="data.appReady" type="button" class="btn primary" :disabled="busy" @click="connect">{{ t('search.connect') }}</button>
          <p v-else class="hint">{{ t('search.needApp') }} <NuxtLink to="/einstellungen/apps?app=google">{{ t('search.needAppLink') }}</NuxtLink></p>
        </template>
        <p v-else class="hint">{{ t('search.askAdmin') }}</p>
      </div>
      <template v-else>
        <div v-if="expired" class="terr expired">
          <span>{{ t('search.expired') }}</span>
          <button v-if="data.admin && data.appReady" type="button" class="btn small primary" :disabled="busy" @click="connect">{{ t('search.reconnect') }}</button>
          <span v-else-if="!data.admin">{{ t('search.askAdmin') }}</span>
        </div>
        <p v-else-if="g.error" class="terr">{{ g.error }}</p>
        <form v-if="showPicker && data.admin" class="pad pick" @submit.prevent="saveProperty">
          <label class="field">
            <span>{{ t('search.property') }}</span>
            <select v-model="choice" class="select" :disabled="busy || !sites?.length">
              <option v-for="x in sites ?? []" :key="x" :value="x">{{ x }}</option>
            </select>
          </label>
          <p v-if="sites && !sites.length" class="hint">{{ t('search.noSites') }}</p>
          <button type="submit" class="btn primary" :disabled="busy || !choice">{{ t('settings.save') }}</button>
        </form>
      </template>
    </template>

    <template v-else-if="b">
      <div v-if="!b.keyReady" class="pad">
        <p class="hint">{{ t('search.bingIntro') }}</p>
        <p v-if="data.admin" class="hint">{{ t('search.bingNeedKey') }} <NuxtLink to="/einstellungen/apps?app=bing">{{ t('search.bingNeedKeyLink') }}</NuxtLink></p>
        <p v-else class="hint">{{ t('search.askAdmin') }}</p>
      </div>
      <div v-else-if="b.off" class="pad">
        <p class="hint">{{ t('search.bingOff') }}</p>
        <button v-if="data.admin" type="button" class="btn small" :disabled="busy" @click="b.off = false; loadBingSites()">{{ t('search.bingOn') }}</button>
      </div>
      <template v-else>
        <p v-if="b.error" class="terr">{{ b.error }}</p>
        <form v-if="showBingPicker && data.admin" class="pad pick" @submit.prevent="saveBing(bingChoice)">
          <label class="field">
            <span>{{ t('search.bingSite') }}</span>
            <select v-model="bingChoice" class="select" :disabled="busy || !bingSites?.length">
              <option v-for="x in bingSites ?? []" :key="x" :value="x">{{ x }}</option>
            </select>
          </label>
          <p v-if="bingSites && !bingSites.length" class="hint">{{ t('search.bingNoSites') }}</p>
          <button type="submit" class="btn primary" :disabled="busy || !bingChoice">{{ t('settings.save') }}</button>
        </form>
      </template>
    </template>

    <template v-if="s">
      <div class="kpis">
        <div><span class="big mono">{{ num(s.clicks) }}</span><span class="dim">{{ t('search.clicks') }}</span></div>
        <div><span class="big mono">{{ num(s.impressions) }}</span><span class="dim">{{ t('search.impressions') }}</span></div>
        <div><span class="big mono">{{ s.position ?? '-' }}</span><span class="dim">{{ t('search.position') }}</span></div>
        <Sparkline v-if="s.impressions" class="hide-m" :values="s.series" color="var(--primary)" :width="160" :height="32" />
      </div>
      <p v-if="!s.impressions" class="empty">{{ synced ? t('search.empty') : t('search.waiting') }}</p>
      <div v-else class="cols2">
        <div>
          <h3>{{ t('search.top') }}</h3>
          <ol class="terms">
            <li v-for="x in s.top" :key="x.query"><span class="ellipsis">{{ x.query }}</span><span class="mono dim">{{ num(x.clicks) }} / {{ num(x.impressions) }}</span></li>
          </ol>
          <p class="hint small">{{ t('search.topHint') }}</p>
        </div>
        <div>
          <h3>{{ t('search.chances') }}</h3>
          <ol v-if="s.chances.length" class="terms">
            <li v-for="x in s.chances" :key="x.query" :title="x.page ?? ''"><span class="ellipsis">{{ x.query }}</span><span class="mono dim">{{ num(x.impressions) }} · {{ ctr(x) }} · {{ x.position }}</span></li>
          </ol>
          <p v-else class="hint">-</p>
          <p class="hint small">{{ t('search.chancesHint') }}</p>
          <template v-if="s.dropped.length">
            <h3>{{ t('search.dropped') }}</h3>
            <ul class="terms">
              <li v-for="x in s.dropped" :key="x.page"><span class="ellipsis">{{ path(x.page) }}</span><span class="mono dim">{{ x.before }} → {{ x.now }}</span></li>
            </ul>
          </template>
        </div>
      </div>
    </template>

    <div v-if="tab === 'google' && g" class="foot">
      <span class="dim small">{{ g.property }}<template v-if="g.lastSync"> · {{ t('search.synced', { at: dateTime(g.lastSync) }) }}</template> · {{ t('search.delay') }}</span>
      <span v-if="data.admin" class="acts">
        <button v-if="g.property" type="button" class="btn small" @click="syncNow">{{ t('search.sync') }}</button>
        <button v-if="g.property && !showPicker" type="button" class="btn small" :disabled="busy" @click="loadSites">{{ t('search.change') }}</button>
        <button type="button" class="btn small danger" @click="disconnect">{{ t('search.disconnect') }}</button>
      </span>
    </div>
    <div v-else-if="tab === 'bing' && bingOn && b" class="foot">
      <span class="dim small">{{ b.site }}<template v-if="b.lastSync"> · {{ t('search.synced', { at: dateTime(b.lastSync) }) }}</template> · {{ t('search.bingDelay') }}</span>
      <span v-if="data.admin" class="acts">
        <button type="button" class="btn small" @click="syncNow">{{ t('search.sync') }}</button>
        <button v-if="!showBingPicker" type="button" class="btn small" :disabled="busy" @click="loadBingSites">{{ t('search.change') }}</button>
        <button type="button" class="btn small danger" :disabled="busy" @click="saveBing(null)">{{ t('search.bingOffBtn') }}</button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.pad {
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.pad .hint {
  margin: 0;
}

.pick {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
}

.pick .field {
  flex: 1 1 260px;
}

.kpis {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 32px;
  padding: 12px 16px;
}

.kpis > div {
  display: flex;
  flex-direction: column;
  font-size: 12px;
}

.big {
  font-size: 22px;
}

.cols2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 8px 24px;
  padding: 4px 16px 12px;
}

h3 {
  margin: 8px 0 6px;
  font-size: 13px;
  font-weight: var(--head-weight);
}

.terms {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
}

.terms li {
  padding: 3px 0;
}

.terms li > span:first-child {
  display: inline-block;
  max-width: calc(100% - 120px);
  vertical-align: bottom;
}

.terms li > span:last-child {
  float: right;
  font-size: 12px;
}

.small {
  font-size: 12px;
}

.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--line);
  overflow-wrap: anywhere;
}

.acts {
  display: flex;
  gap: 6px;
}

.seg {
  display: inline-flex;
  margin-left: auto;
  border: 1.5px solid var(--text);
  border-radius: 4px;
  overflow: hidden;
}

.segb {
  padding: 4px 12px;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
}

.segb.on {
  background: var(--marker);
  color: var(--on-marker);
  font-weight: 700;
}

.terr {
  margin: 0;
  padding: 8px 16px 0;
  color: var(--down);
  font-size: 12.5px;
}

.expired {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding-bottom: 8px;
  font-size: 13.5px;
}
</style>
