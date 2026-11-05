<script setup lang="ts">
export interface OwnApp {
  clientId: string
  hasSecret: boolean
  hint: string | null
  redirectUri: string
  user?: string
  hasKey?: boolean
  keyHint?: string | null
  redirectIgnored?: string
}

export interface AppIssue { app: string, what: string, project: string | null, path: string, message: string }

export interface BraveUsage { source: 'own' | 'hosted' | null, perDay: number | null, blockedToday: number, today: number, month: number, last30: number, byPurpose: { purpose: string, calls: number }[], usdMonth: number, usdLast30: number, usdPer1000: number, freeUsdPerMonth: number }

const props = withDefaults(defineProps<{
  apps: Record<string, OwnApp>
  providers: { id: string, label: string, kind: string }[]
  issues?: AppIssue[]
  brave?: BraveUsage | null
  services?: { braveEur: number, zernioEur: number, xEur?: number, totalEur: number, limitEur: number | null } | null
}>(), { issues: () => [], brave: null, services: null })
const hostedBrave = computed(() => props.brave?.source === 'hosted')
const purposeLabel = (p: string) => (te(`settings.braveUse.p.${p}`) ? t(`settings.braveUse.p.${p}`) : p)
const issuesOf = (id: string) => props.issues.filter(i => i.app === id)
const emit = defineEmits<{ changed: [] }>()
const { t, te, tm, rt } = useI18n()
const toast = useToast()
const route = useRoute()

const LINKS: Record<string, { label: string, url: string }[]> = {
  meta: [{ label: 'developers.facebook.com/apps', url: 'https://developers.facebook.com/apps/' }, { label: 'Instagram: Profi-Konto', url: 'https://help.instagram.com/502981923235522' }],
  instagram: [{ label: 'developers.facebook.com/apps', url: 'https://developers.facebook.com/apps/' }, { label: 'Instagram: Profi-Konto', url: 'https://help.instagram.com/502981923235522' }],
  threads: [{ label: 'developers.facebook.com/apps', url: 'https://developers.facebook.com/apps/' }],
  linkedin: [{ label: 'linkedin.com/developers/apps/new', url: 'https://www.linkedin.com/developers/apps/new' }],
  tiktok: [{ label: 'developers.tiktok.com/apps', url: 'https://developers.tiktok.com/apps/' }],
  x: [{ label: 'developer.x.com', url: 'https://developer.x.com/en/portal/dashboard' }],
  reddit: [{ label: 'reddit.com/prefs/apps', url: 'https://www.reddit.com/prefs/apps' }],
  brave: [{ label: 'api-dashboard.search.brave.com', url: 'https://api-dashboard.search.brave.com/' }],
  bing: [{ label: 'bing.com/webmasters', url: 'https://www.bing.com/webmasters/' }],
  google: [{ label: 'Search Console API', url: 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com' }, { label: 'YouTube Data API v3', url: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' }, { label: 'search.google.com/search-console', url: 'https://search.google.com/search-console' }],
}
const list = computed(() => [...props.providers.filter(p => p.kind === 'oauth' && p.id !== 'youtube'), { id: 'brave', label: 'Brave Search', kind: 'key' }, { id: 'reddit', label: 'Reddit', kind: 'read' }, { id: 'google', label: 'Google (Search Console, YouTube)', kind: 'google' }, { id: 'bing', label: 'Bing Webmaster Tools', kind: 'key' }])
const keyOnly = (id: string) => id === 'brave' || id === 'bing'
const steps = (p: string) => ((tm(`conn.guide.${p}`) as unknown[]) ?? []).map(x => rt(x as never))
const ready = (id: string) => !!((keyOnly(id) || props.apps[id]?.clientId) && props.apps[id]?.hasSecret)

const open = ref<string | null>(null)
const f = ref({ clientId: '', clientSecret: '', redirectUri: '', user: '', apiKey: '' })
function toggle(id: string) {
  const app = props.apps[id]
  f.value = { clientId: app?.clientId ?? '', clientSecret: '', redirectUri: app?.redirectUri ?? '', user: app?.user ?? '', apiKey: '' }
  open.value = open.value === id ? null : id
}
if (route.query.app && list.value.some(p => p.id === route.query.app)) toggle(String(route.query.app))

const busy = ref(false)
async function save(id: string) {
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { app: { provider: id, clientId: keyOnly(id) ? '' : f.value.clientId, ...(f.value.clientSecret ? { clientSecret: f.value.clientSecret } : {}), ...(id === 'reddit' ? { user: f.value.user } : { redirectUri: f.value.redirectUri }), ...(id === 'google' && f.value.apiKey ? { apiKey: f.value.apiKey } : {}) } } })
    toast.push(t('conn.appSaved'))
    open.value = null
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('settings.apps') }}</h2></div>
    <p class="hint pad">{{ t('settings.appsHint') }}</p>
    <ul class="rows">
      <li v-for="p in list" :key="p.id">
        <div class="arow">
          <span class="aname">{{ p.label }}</span>
          <span v-if="ready(p.id) && issuesOf(p.id).length" class="astate bad">{{ t('settings.appBroken') }}</span>
          <span v-else-if="p.id === 'brave' && hostedBrave" class="astate okc">{{ t('settings.appHosted') }}</span>
          <span v-else class="astate" :class="ready(p.id) ? 'okc' : 'dim'">{{ ready(p.id) ? t('settings.appReady') : t('settings.appMissing') }}</span>
          <button type="button" class="btn small" :aria-expanded="open === p.id" @click="toggle(p.id)">{{ open === p.id ? t('common.cancel') : t('task.edit') }}</button>
        </div>
        <div v-if="p.id === 'brave' && props.brave && (ready('brave') || hostedBrave || props.brave.last30)" class="usage">
          <p v-if="hostedBrave">{{ t('settings.braveHosted', { n: props.brave.perDay ?? '-' }) }}</p>
          <p v-if="hostedBrave && props.brave.blockedToday">{{ t('settings.braveBlocked', { n: props.brave.blockedToday }) }}</p>
          <p v-if="props.services">{{ props.services.limitEur != null ? t('settings.services', { total: props.services.totalEur.toFixed(2), limit: props.services.limitEur.toFixed(0), brave: props.services.braveEur.toFixed(2), zernio: props.services.zernioEur.toFixed(2), x: (props.services.xEur ?? 0).toFixed(2) }) : t('settings.servicesNoLimit', { total: props.services.totalEur.toFixed(2), brave: props.services.braveEur.toFixed(2), zernio: props.services.zernioEur.toFixed(2), x: (props.services.xEur ?? 0).toFixed(2) }) }}</p>
          <p>{{ t('settings.braveUse.line', { today: props.brave.today, month: props.brave.month, usdMonth: props.brave.usdMonth.toFixed(2), last30: props.brave.last30, usd30: props.brave.usdLast30.toFixed(2) }) }}</p>
          <p v-if="props.brave.byPurpose.length" class="dim">{{ props.brave.byPurpose.map(b => `${purposeLabel(b.purpose)} ${b.calls}`).join(' · ') }}</p>
          <p v-if="!hostedBrave" class="dim">{{ t('settings.braveUse.price', { usd: props.brave.usdPer1000, free: props.brave.freeUsdPerMonth }) }}</p>
        </div>
        <ul v-if="issuesOf(p.id).length" class="issues">
          <li v-for="i in issuesOf(p.id)" :key="i.path + i.what"><NuxtLink :to="i.path">{{ t('settings.appIssue', { what: i.what, project: i.project ? ` (${i.project})` : '' }) }}</NuxtLink> <span class="dim">{{ i.message }}</span></li>
          <li v-if="p.id === 'google' && issuesOf(p.id).some(i => /abgelaufen|widerrufen|neu verbinden/i.test(i.message))" class="dim">{{ t('settings.googleTesting') }}</li>
        </ul>
        <form v-if="open === p.id" class="aform" autocomplete="off" @submit.prevent="save(p.id)">
          <ol class="steps"><li v-for="(s, i) in steps(p.id)" :key="i">{{ s }}</li></ol>
          <p v-if="p.id === 'google'" class="hint">{{ t('search.privacy') }}</p>
          <p class="links"><a v-for="l in LINKS[p.id] ?? []" :key="l.url" :href="l.url" target="_blank" rel="noopener noreferrer">{{ l.label }}</a></p>
          <div class="form-grid">
            <label v-if="!keyOnly(p.id)" class="field"><span>{{ t('conn.f.clientId') }}</span><input v-model="f.clientId" class="input mono" required></label>
            <label class="field"><span>{{ p.id === 'brave' ? t('conn.f.braveKey') : p.id === 'bing' ? t('conn.f.bingKey') : t('conn.f.clientSecret') }}<template v-if="props.apps[p.id]?.hasSecret"> ({{ t('settings.keyStored', { hint: props.apps[p.id]?.hint ?? '' }) }})</template></span><input v-model="f.clientSecret" class="input mono" type="password" autocomplete="new-password" :required="!props.apps[p.id]?.hasSecret"></label>
            <label v-if="p.id === 'reddit'" class="field"><span>{{ t('conn.f.redditUser') }}</span><input v-model="f.user" class="input mono" autocapitalize="off" spellcheck="false"></label>
            <label v-else-if="!keyOnly(p.id)" class="field wide"><span>{{ t('conn.f.redirect') }}</span><input v-model="f.redirectUri" class="input mono"></label>
            <p v-if="props.apps[p.id]?.redirectIgnored" class="hint wide">{{ t('conn.redirectIgnored', { old: props.apps[p.id]?.redirectIgnored, now: props.apps[p.id]?.redirectUri }) }}</p>
            <p v-if="p.id === 'instagram' && !f.redirectUri.startsWith('https:')" class="hint wide">{{ t('conn.httpsNote') }}</p>
            <label v-if="p.id === 'google'" class="field wide"><span>{{ t('search.psKey') }}<template v-if="props.apps.google?.hasKey"> ({{ t('settings.keyStored', { hint: props.apps.google?.keyHint ?? '' }) }})</template></span><input v-model="f.apiKey" class="input mono" type="password" autocomplete="new-password"><small class="dim">{{ t('search.psKeyHint') }}</small></label>
          </div>
          <div class="form-actions"><button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button></div>
        </form>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.pad {
  margin: 0;
  padding: 12px 16px;
}

.arow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  min-height: 52px;
  padding: 8px 16px;
  font-size: 13.5px;
}

.aname {
  flex: 1 1 auto;
  font-weight: 500;
}

.astate {
  font-size: 12.5px;
}

.okc {
  color: var(--up);
}

.bad {
  color: var(--down);
}

.issues {
  margin: 0;
  padding: 0 16px 10px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.usage {
  padding: 0 16px 10px;
  font-size: 13px;
}

.usage p {
  margin: 0 0 2px;
}

.issues a {
  color: var(--down);
}

.aform {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px 16px;
  background: var(--panel2);
  border-top: 1px solid var(--line);
  font-size: 13px;
}

.steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--muted);
}

.links {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  overflow-wrap: anywhere;
}

.wide {
  grid-column: 1 / -1;
}
</style>
