<script setup lang="ts">
import type { MailInfo } from '~/components/MailForm.vue'
import type { ListeningInfo } from '~/components/ProjectListening.vue'
import { isTransient } from '~~/shared/utils/access'

export interface AccountItem {
  id: string
  platform: string
  name: string | null
  handle: string | null
  error: string | null
  expiresAt: string | null
  via?: 'own' | 'uploadpost' | 'zernio'
  options?: { categoryId: string, privacy: 'public' | 'unlisted' | 'private', synthetic: boolean } | null
}

export interface AccountsProject {
  id: string
  slug: string
  name: string
  color: string
  icon: string
  accounts: AccountItem[]
  mail: MailInfo | null
  mailFrom: string | null
  mailError: string | null
  listening: ListeningInfo
}

export interface AccountsData {
  admin: boolean
  live: boolean
  sendLive: boolean
  apps: Record<string, boolean>
  projects: AccountsProject[]
  hosted?: { zernio: boolean, platforms: string[], used: number, limit: number | null }
  spare: { id: string, platform: string, name: string }[]
  unassigned: { id: string, platform: string, name: string }[]
}

const props = defineProps<{ data: AccountsData, project: AccountsProject }>()
const emit = defineEmits<{ changed: [] }>()
const { t, tm, rt } = useI18n()
const toast = useToast()
const route = useRoute()
const router = useRouter()

const PLATFORMS: { id: string, provider: string, kind: 'password' | 'token' | 'oauth', alt?: string }[] = [
  { id: 'facebook', provider: 'meta', kind: 'oauth' },
  { id: 'instagram', provider: 'meta', kind: 'oauth', alt: 'instagram' },
  { id: 'youtube', provider: 'youtube', kind: 'oauth' },
  { id: 'tiktok', provider: 'tiktok', kind: 'oauth' },
  { id: 'telegram', provider: 'telegram', kind: 'token' },
  { id: 'x', provider: 'x', kind: 'oauth' },
  { id: 'threads', provider: 'threads', kind: 'oauth' },
  { id: 'linkedin', provider: 'linkedin', kind: 'oauth' },
  { id: 'bluesky', provider: 'bluesky', kind: 'password' },
  { id: 'mastodon', provider: 'mastodon', kind: 'token' },
]
const LINKS: Record<string, string> = {
  bluesky: 'https://bsky.app/settings/app-passwords',
  mastodon: 'https://mastodon.social/settings/applications/new',
  telegram: 'https://t.me/BotFather',
}

type Row = { key: string, first: boolean, platform: typeof PLATFORMS[number], acc: AccountItem | null }
const rows = computed(() => PLATFORMS.flatMap((p): Row[] => {
  const list = props.project.accounts.filter(a => a.platform === p.id)
  return list.length ? list.map((a, i) => ({ key: `${p.id}:${a.id}`, first: i === 0, platform: p, acc: a })) : [{ key: p.id, first: true, platform: p, acc: null }]
}))
const label = (id: string) => t(`accounts.platforms.${id}`)
const who = (a: AccountItem) => (a.handle && !/^\d+$/.test(a.handle) ? `@${a.handle.replace(/^@/, '')}` : a.name)
const transient = (a: AccountItem | null) => !!a?.error && a.error !== 'unreadable' && isTransient(a.error)
function status(a: AccountItem) {
  if (transient(a)) {
    const code = /\b(5\d\d|429)\b/.exec(a.error!)?.[1]
    return `${t('accounts.transient')}${code ? ` (${code})` : ''}`
  }
  if (a.error) return a.error === 'unreadable' ? t('settings.keyUnreadable') : a.error
  const w = who(a)
  const line = w ? t('accounts.connectedAs', { who: w }) : t('accounts.connected')
  if (a.via === 'zernio') return `${line} (${t('accounts.viaZernio')})`
  return a.via === 'uploadpost' ? `${line} (${t('accounts.viaUs')})` : line
}

const { boot } = useBoot()
const hostedFor = (id: string) => !!props.data.hosted?.zernio && props.data.hosted.platforms.includes(id)
const hostedFull = computed(() => props.data.hosted?.limit != null && props.data.hosted.used >= props.data.hosted.limit)
function startHosted(platform: string) {
  return run(async () => {
    const res = await $fetch<{ url: string }>(`/api/connect/zernio/start?project=${props.project.id}&platform=${platform}`)
    window.location.href = res.url
  })
}

const YT_CATEGORIES = ['10', '22', '24', '1', '27', '28', '26', '25', '20']
const YT_PRIVACY = ['public', 'unlisted', 'private']
function saveYt(a: AccountItem, patch: Record<string, string | boolean>) {
  return run(async () => {
    await $fetch(`/api/connections/${a.id}/options`, { method: 'PATCH', body: patch })
    toast.push(t('settings.saved'))
    emit('changed')
  })
}

const open = ref<string | null>(null)
const f = ref<Record<string, string>>({})
function toggle(key: string) {
  f.value = {}
  open.value = open.value === key ? null : key
}
const initial = String(route.query.connect ?? '')
if (initial) {
  const p = PLATFORMS.find(x => x.id === initial || x.provider === initial)
  open.value = initial === 'mail' ? 'mail' : p?.id ?? null
}

const reuse = (platform: string) => props.data.spare.filter(s => s.platform === platform && !props.project.accounts.some(a => a.id === s.id))

const busy = ref(false)
async function run(fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

function connectDirect(p: typeof PLATFORMS[number]) {
  return run(async () => {
    const res = await $fetch<{ ok: boolean, name?: string, error?: string }>('/api/connections', { method: 'POST', body: { provider: p.provider, projectId: props.project.id, ...f.value } })
    if (!res.ok) {
      toast.push(res.error ?? t('common.error'), 'error')
      return
    }
    toast.push(t('conn.connected', { names: res.name }))
    open.value = null
    emit('changed')
  })
}

const ways = (p: typeof PLATFORMS[number]) => (p.alt ? [p.alt, p.provider] : [p.provider])

function startOAuth(provider: string) {
  return run(async () => {
    const res = await $fetch<{ url: string }>(`/api/connect/${provider}/start?project=${props.project.id}`)
    window.location.href = res.url
  })
}

function pasteCode(provider: string) {
  return run(async () => {
    const res = await $fetch<{ ok: boolean, names?: string[], error?: string }>(`/api/connect/${provider}/code`, { method: 'POST', body: { url: f.value[`paste_${provider}`] ?? '' } })
    if (!res.ok) {
      toast.push(res.error ?? t('common.error'), 'error')
      return
    }
    toast.push(t('conn.connected', { names: res.names?.join(', ') }))
    open.value = null
    emit('changed')
  })
}

function recheck(a: AccountItem) {
  return run(async () => {
    const res = await $fetch<{ ok: boolean, error?: string }>(`/api/connections/${encodeURIComponent(a.id)}/check`, { method: 'POST' })
    if (res.ok) toast.push(t('accounts.recheckOk'))
    else toast.push(res.error ?? t('common.error'), 'error')
    emit('changed')
  })
}

function assign(id: string) {
  return run(async () => {
    await $fetch(`/api/projects/${props.project.id}/accounts`, { method: 'POST', body: { id } })
    open.value = null
    emit('changed')
  })
}

function disconnect(a: AccountItem, platform: string) {
  if (!confirm(t('accounts.disconnectConfirm', { what: who(a) ?? label(platform) }))) return
  return run(async () => {
    await $fetch(`/api/projects/${props.project.id}/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' })
    emit('changed')
  })
}

function removeMail() {
  if (!confirm(t('mailbox.removeConfirm'))) return
  return run(async () => {
    await $fetch(`/api/projects/${props.project.id}/mail`, { method: 'DELETE' })
    emit('changed')
  })
}

function saveMarkSeen(markSeen: boolean) {
  return run(async () => {
    await $fetch(`/api/projects/${props.project.id}/mail-options`, { method: 'PUT', body: { markSeen } })
    emit('changed')
  })
}

function onFocus() {
  emit('changed')
}
onMounted(() => {
  window.addEventListener('focus', onFocus)
  if (route.query.connected) toast.push(t('conn.connected', { names: String(route.query.connected) }))
  if (route.query.connectError) toast.push(String(route.query.connectError), 'error')
  if (route.query.connected || route.query.connectError || route.query.connect) router.replace({ query: {} })
})
onBeforeUnmount(() => window.removeEventListener('focus', onFocus))
</script>

<template>
  <section class="panel">
    <p v-if="props.data.hosted?.zernio && props.data.hosted.limit != null" class="help limitline">{{ t('accounts.hostedLimit', { used: props.data.hosted.used, limit: props.data.hosted.limit }) }}</p>
    <ul class="rows">
      <li v-for="r in rows" :key="r.key">
        <div class="arow">
          <PlatformMark :platform="r.platform.id" :size="26" />
          <span class="aname">{{ label(r.platform.id) }}</span>
          <span class="astate ellipsis" :class="r.acc ? (transient(r.acc) ? 'warnc' : r.acc.error ? 'bad' : 'okc') : 'dim'" :title="r.acc?.error ?? undefined">{{ r.acc ? status(r.acc) : t('accounts.notConnected') }}</span>
          <span v-if="props.data.admin" class="acts">
            <button v-if="r.acc?.error && r.acc.error !== 'unreadable'" type="button" class="btn small" :disabled="busy" @click="recheck(r.acc)">{{ t('accounts.recheck') }}</button>
            <button v-if="r.acc?.error && !transient(r.acc)" type="button" class="btn small" @click="toggle(r.platform.id)">{{ t('accounts.reconnect') }}</button>
            <button v-if="r.acc?.via === 'uploadpost' && r.first && r.platform.kind === 'oauth'" type="button" class="btn small" :aria-expanded="open === r.platform.id" @click="toggle(r.platform.id)">{{ open === r.platform.id ? t('common.cancel') : t('accounts.connectOwn') }}</button>
            <button v-if="r.acc" type="button" class="btn small ghost danger" :disabled="busy" @click="disconnect(r.acc, r.platform.id)">{{ t('accounts.disconnect') }}</button>
            <button v-else type="button" class="btn small" :aria-expanded="open === r.platform.id" @click="toggle(r.platform.id)">{{ open === r.platform.id ? t('common.cancel') : t('conn.connect') }}</button>
          </span>
        </div>

        <div v-if="r.acc?.options && props.data.admin" class="yopts">
          <label class="field"><span>{{ t('accounts.yt.category') }}</span>
            <select class="select" :value="r.acc.options.categoryId" :disabled="busy" @change="saveYt(r.acc, { categoryId: ($event.target as HTMLSelectElement).value })">
              <option v-for="c in YT_CATEGORIES" :key="c" :value="c">{{ t(`accounts.yt.cat.c${c}`) }}</option>
            </select>
          </label>
          <label class="field"><span>{{ t('accounts.yt.privacy') }}</span>
            <select class="select" :value="r.acc.options.privacy" :disabled="busy" @change="saveYt(r.acc, { privacy: ($event.target as HTMLSelectElement).value })">
              <option v-for="v in YT_PRIVACY" :key="v" :value="v">{{ t(`accounts.yt.priv.${v}`) }}</option>
            </select>
          </label>
          <label class="check"><input type="checkbox" :checked="r.acc.options.synthetic" :disabled="busy" @change="saveYt(r.acc, { synthetic: ($event.target as HTMLInputElement).checked })">{{ t('accounts.yt.synthetic') }}</label>
        </div>

        <div v-if="open === r.platform.id && (!r.acc || r.acc.error || r.acc.via === 'uploadpost') && r.first" class="aform">
          <p class="help">
            {{ t(`accounts.help.${r.platform.id}`) }}
            <a v-if="LINKS[r.platform.id]" :href="LINKS[r.platform.id]" target="_blank" rel="noopener noreferrer">{{ LINKS[r.platform.id]!.replace('https://', '') }}</a>
          </p>
          <p v-if="r.platform.id === 'bluesky'" class="help strong">{{ t('accounts.appPasswordNote') }}</p>
          <p class="help">{{ t(boot?.features.hosted ? 'accounts.thirdPartyHosted' : 'accounts.thirdParty') }}</p>
          <ol v-if="r.platform.id === 'telegram'" class="help steps">
            <li v-for="(step, i) in tm('accounts.telegramSteps')" :key="i">{{ rt(step) }}</li>
          </ol>
          <ol v-if="r.platform.id === 'youtube'" class="help steps">
            <li v-for="(step, i) in tm('accounts.youtubeSteps')" :key="i">{{ rt(step) }}</li>
          </ol>

          <div v-if="reuse(r.platform.id).length" class="reuse">
            <span class="dim">{{ t('accounts.reuse') }}</span>
            <button v-for="s in reuse(r.platform.id)" :key="s.id" type="button" class="btn small" :disabled="busy" @click="assign(s.id)">{{ s.name }}</button>
          </div>

          <form v-if="r.platform.kind !== 'oauth'" class="form-grid" autocomplete="off" @submit.prevent="connectDirect(r.platform)">
            <template v-if="r.platform.id === 'bluesky'">
              <label class="field"><span>{{ t('conn.f.handle') }}</span><input v-model="f.identifier" class="input" autocapitalize="off" spellcheck="false" required></label>
              <label class="field"><span>{{ t('conn.f.appPassword') }}</span><input v-model="f.password" class="input mono" type="password" autocomplete="new-password" placeholder="xxxx-xxxx-xxxx-xxxx" required></label>
            </template>
            <template v-else-if="r.platform.id === 'mastodon'">
              <label class="field"><span>{{ t('conn.f.instance') }}</span><input v-model="f.url" class="input" autocapitalize="off" spellcheck="false" required></label>
              <label class="field"><span>{{ t('conn.f.token') }}</span><input v-model="f.token" class="input mono" type="password" autocomplete="new-password" required></label>
            </template>
            <template v-else-if="r.platform.id === 'telegram'">
              <label class="field"><span>{{ t('conn.f.botToken') }}</span><input v-model="f.token" class="input mono" type="password" autocomplete="new-password" placeholder="123456789:ABC..." required></label>
              <label class="field"><span>{{ t('conn.f.tgChat') }}</span><input v-model="f.chat" class="input" autocapitalize="off" spellcheck="false" placeholder="@kanalname" required></label>
            </template>
            <div class="form-actions wide"><button type="submit" class="btn primary" :disabled="busy">{{ t('conn.connect') }}</button></div>
          </form>

          <template v-else>
            <div v-if="hostedFor(r.platform.id)" class="way">
              <p class="help">{{ t('accounts.hostedHelp') }}</p>
              <p v-if="hostedFull" class="help strong">{{ t('accounts.hostedLimitFull') }} <NuxtLink v-if="boot?.role === 'owner'" to="/abo#zusatzkonten">{{ t('accounts.hostedExtra') }}</NuxtLink></p>
              <div v-else class="form-actions"><button type="button" class="btn primary" :disabled="busy" @click="startHosted(r.platform.id)"><Icon name="external" :size="14" />{{ t('accounts.hostedConnect') }}</button></div>
            </div>
            <div v-for="prov in ways(r.platform).filter(x => !hostedFor(r.platform.id) || props.data.apps[x])" :key="prov" class="way">
              <p v-if="ways(r.platform).length > 1" class="help strong">{{ t(`accounts.way.${prov}`) }}</p>
              <p v-if="ways(r.platform).length > 1" class="help">{{ t(`accounts.wayHelp.${prov}`) }}</p>
              <p v-if="!props.data.apps[prov]" class="help">{{ t('accounts.appMissing') }} <NuxtLink :to="`/einstellungen/apps?app=${prov === 'youtube' ? 'google' : prov}`">{{ t('accounts.appLink') }}</NuxtLink></p>
              <template v-else>
                <div class="form-actions"><button type="button" class="btn primary" :disabled="busy" @click="startOAuth(prov)"><Icon name="external" :size="14" />{{ t(`accounts.login.${prov}`) }}</button></div>
                <form class="form-grid" autocomplete="off" @submit.prevent="pasteCode(prov)">
                  <label class="field wide"><span>{{ t('accounts.pasteLabel') }}</span><input v-model="f[`paste_${prov}`]" class="input mono" placeholder="https://...?code=..."></label>
                  <div class="form-actions wide"><button type="submit" class="btn" :disabled="busy || !f[`paste_${prov}`]">{{ t('conn.pasteBtn') }}</button></div>
                </form>
              </template>
            </div>
            <p v-if="r.platform.id === 'x'" class="help">{{ t('conn.xCost') }}</p>
            <details v-if="r.platform.id === 'x'" class="manual">
              <summary>{{ t('accounts.more') }}</summary>
              <form class="form-grid" autocomplete="off" @submit.prevent="connectDirect(r.platform)">
                <p class="help wide">{{ t('accounts.xManual') }} <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener noreferrer">developer.x.com</a></p>
                <label class="field"><span>{{ t('conn.f.consumerKey') }}</span><input v-model="f.consumerKey" class="input mono" required></label>
                <label class="field"><span>{{ t('conn.f.consumerSecret') }}</span><input v-model="f.consumerSecret" class="input mono" type="password" autocomplete="new-password" required></label>
                <label class="field"><span>{{ t('conn.f.accessToken') }}</span><input v-model="f.token" class="input mono" required></label>
                <label class="field"><span>{{ t('conn.f.accessSecret') }}</span><input v-model="f.tokenSecret" class="input mono" type="password" autocomplete="new-password" required></label>
                <div class="form-actions wide"><button type="submit" class="btn" :disabled="busy">{{ t('conn.connect') }}</button></div>
              </form>
            </details>
          </template>
        </div>
      </li>

      <li>
        <div class="arow">
          <PlatformMark platform="mail" :size="26" />
          <span class="aname">{{ t('accounts.mail') }}</span>
          <span class="astate ellipsis" :class="props.project.mailError ? 'bad' : props.project.mailFrom ? 'okc' : 'dim'">{{ props.project.mailError ?? (props.project.mailFrom ? t('accounts.connectedAs', { who: props.project.mailFrom }) : t('accounts.notConnected')) }}</span>
          <span v-if="props.data.admin" class="acts">
            <template v-if="props.project.mail">
              <button type="button" class="btn small ghost" :aria-expanded="open === 'mail'" @click="toggle('mail')">{{ open === 'mail' ? t('common.cancel') : t('task.edit') }}</button>
              <button type="button" class="btn small ghost danger" :disabled="busy" @click="removeMail">{{ t('accounts.disconnect') }}</button>
            </template>
            <button v-else type="button" class="btn small" :aria-expanded="open === 'mail'" @click="toggle('mail')">{{ open === 'mail' ? t('common.cancel') : t('conn.connect') }}</button>
          </span>
        </div>
        <div v-if="props.data.admin && props.project.mail && open !== 'mail'" class="mail-opts">
          <label class="check" :title="t('inbox.markSeenHint')"><input type="checkbox" :checked="props.project.mail.markSeen !== false" :disabled="busy" @change="saveMarkSeen(($event.target as HTMLInputElement).checked)"> {{ t('inbox.markSeen') }}</label>
          <NuxtLink :to="`/p/${props.project.slug}/postfach`">{{ t('inbox.open') }}</NuxtLink>
        </div>
        <MailForm v-if="open === 'mail'" :project-id="props.project.id" :mail="props.project.mail" @saved="open = null; emit('changed')" />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.limitline {
  margin: 0;
  padding: 12px 16px 0;
}

.mail-opts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 0 16px 12px 54px;
  font-size: 13px;
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
  flex: 0 0 96px;
  font-weight: 500;
}

.astate {
  flex: 1 1 140px;
  min-width: 0;
  font-size: 12.5px;
}

.acts {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.bad {
  color: var(--down);
}

.okc {
  color: var(--up);
}

.warnc {
  color: var(--warn);
}

.aform {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px 16px;
  background: var(--panel2);
  border-top: 1px solid var(--line);
}

.help {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.help.strong {
  color: var(--text);
  font-weight: 500;
}

.help.steps {
  padding-left: 18px;
  display: grid;
  gap: 4px;
}

.reuse {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  font-size: 13px;
}

.wide {
  grid-column: 1 / -1;
  margin: 0;
}

.yopts {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 14px;
  padding: 0 16px 12px 54px;
  font-size: 13px;
}

.yopts .field {
  min-width: 150px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 8px;
}

.way {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.way + .way {
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.manual {
  font-size: 13px;
}

.manual summary {
  width: fit-content;
  cursor: pointer;
  color: var(--muted);
}

.manual[open] summary {
  margin-bottom: 12px;
}

/* Handy */
@media (max-width: 600px) {
  .aname {
    flex: 1 1 auto;
  }

  .astate {
    order: 3;
    flex-basis: 100%;
    padding-left: 38px;
  }

  .yopts {
    padding-left: 16px;
  }
}
</style>
