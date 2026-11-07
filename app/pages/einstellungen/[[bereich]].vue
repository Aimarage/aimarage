<script setup lang="ts">
import { legacySettingsPath } from '~/composables/useSettingsNav'
import { BUDGET_CHOICES, BUDGET_DEFAULT } from '~~/shared/utils/time-budget'
import type { SocialData } from '~/components/SocialConnection.vue'
import type { AppIssue, BraveUsage } from '~/components/AppCredentials.vue'

interface Settings {
  workspace: { name: string, timezone: string, agentEnabled: boolean, autoStrategy: boolean, briefingTime: string }
  llm: {
    locked: boolean
    own?: boolean
    eu?: { available: boolean, on: boolean, provider: string | null }
    saved: { provider?: string, baseUrl?: string, model?: string, modelFast?: string, reasoning?: boolean }
    effective: { provider: string, baseUrl: string, model: string, modelFast: string, reasoning: boolean }
    key: { source: 'workspace' | 'env' | 'none', hint: string | null, setAt: string | null, unreadable: boolean, needed: boolean }
    env: { baseUrl: string | null, model: string | null, keyUrl: string | null }
    status: { configured: boolean, reason: string }
    providers: { id: string, baseUrl: string, model: string, needsKey: boolean }[]
  }
  database: string
  workerInline: boolean
  social: SocialData | null
  appIssues?: AppIssue[]
  braveUsage?: BraveUsage | null
  services?: { braveEur: number, zernioEur: number, xEur?: number, totalEur: number, limitEur: number | null } | null
  connected: { live: boolean }
  sendLive: boolean
  outboundLocked?: boolean
  mcpApprove: { enabled: boolean, kinds: string[], delayMin: number, perDay: number, offProjects: string[] }
  aiReviewer: { enabled: boolean, ask: boolean, by: string | null, at: string | null, model: string | null }
  projects: { id: string, name: string, archived: boolean }[]
  members: { id: string, name: string, email: string, role: string, initials: string }[]
}

const { t, te, setLocale } = useI18n()
const { boot, isAdmin, refresh: refreshBoot } = useBoot()
const toast = useToast()
const route = useRoute()

definePageMeta({ middleware: [to => (to.params.bereich ? undefined : legacySettingsPath(to.query) ?? '/einstellungen/profil')] })

const settingsNav = useSettingsNav()
const bereich = computed(() => String(route.params.bereich ?? ''))
const item = computed(() => settingsNav.items.value.find(i => i.id === bereich.value) ?? null)
function elsewhere() {
  if (!bereich.value) return null
  if (!item.value) return '/einstellungen/profil'
  return item.value.to !== `/einstellungen/${item.value.id}` ? item.value.to : null
}
const away = elsewhere()
if (away) await navigateTo(away, { replace: true })
watch(item, () => {
  const to = elsewhere()
  if (to) navigateTo(to, { replace: true })
})
const tab = computed(() => item.value?.id ?? '')
useHead({ title: () => item.value?.label ?? t('settings.title') })

const { data, refresh } = await useFetch<Settings>('/api/settings', { key: 'settings' })

const stepUp = useStepUp()
const profile = ref({ name: boot.value?.user.name ?? '', locale: boot.value?.user.locale ?? 'de', minutesPerDay: boot.value?.user.minutesPerDay ?? BUDGET_DEFAULT, currentPassword: '', newPassword: '' })
async function saveProfile() {
  try {
    const p = profile.value
    await $fetch('/api/me', { method: 'PATCH', body: { name: p.name, locale: p.locale, minutesPerDay: Number(p.minutesPerDay) } })
    await setLocale(p.locale as 'de' | 'en')
    toast.push(t('settings.saved'))
    await refreshBoot()
  }
  catch (err) {
    toast.error(err)
  }
}
async function savePassword() {
  try {
    const p = profile.value
    await stepUp.run<unknown>(() => $fetch<unknown>('/api/me' as string, { method: 'PATCH', body: { currentPassword: p.currentPassword || undefined, newPassword: p.newPassword } }))
    profile.value.currentPassword = ''
    profile.value.newPassword = ''
    toast.push(t('settings.passwordChanged'))
    await refreshBoot()
  }
  catch (err) {
    if (!isPasskeyCancel(err)) toast.error(err)
  }
}

const { data: ical, refresh: refreshIcal } = await useFetch<{ url: string | null }>('/api/me/calendar-token', { key: 'ical' })
async function newIcal() {
  await $fetch('/api/me/calendar-token', { method: 'POST' })
  await refreshIcal()
}
async function copyIcal() {
  if (!ical.value?.url) return
  await navigator.clipboard.writeText(ical.value.url).catch(() => {})
  toast.push(t('approvals.copied'))
}

const llm = ref({ provider: 'phala', baseUrl: '', model: '', agentEnabled: true, autoStrategy: true, eu: false })
const keyInput = ref('')
watchEffect(() => {
  if (!data.value) return
  const e = data.value.llm.effective
  llm.value = { provider: e.provider, baseUrl: e.baseUrl, model: e.model, agentEnabled: data.value.workspace.agentEnabled, autoStrategy: data.value.workspace.autoStrategy, eu: !!data.value.llm.eu?.on }
})
const euShown = computed(() => !!data.value?.llm.eu && (data.value.llm.eu.available || data.value.llm.eu.on))
const euSaved = computed(() => !!data.value?.llm.eu?.on)
const providerForm = computed(() => !!data.value && !data.value.llm.locked && !euSaved.value && !llm.value.eu)
const preset = computed(() => data.value?.llm.providers.find(p => p.id === llm.value.provider))
function pickProvider(p: string) {
  llm.value.provider = p
  const pr = data.value?.llm.providers.find(x => x.id === p)
  if (pr) {
    llm.value.baseUrl = pr.baseUrl
    llm.value.model = pr.model
  }
  test.value = null
}
const norm = (u: string) => u.trim().replace(/\/+$/, '')
const urlChanged = computed(() => !!data.value && norm(llm.value.baseUrl) !== norm(data.value.llm.effective.baseUrl))
const keyWillDrop = computed(() => urlChanged.value && data.value?.llm.key.source === 'workspace' && !keyInput.value.trim())
const needsKey = computed(() => preset.value?.needsKey || (llm.value.provider === 'custom' && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(llm.value.baseUrl)))
const keyOk = computed(() => !!data.value && !urlChanged.value && data.value.llm.key.source !== 'none' && !data.value.llm.key.unreadable)
const keyLine = computed(() => {
  const k = data.value?.llm.key
  if (!k || urlChanged.value) return needsKey.value ? t('settings.keyNone') : t('settings.keyNotNeeded')
  if (k.unreadable) return t('settings.keyUnreadable')
  if (k.source === 'workspace') return t('settings.keyStored', { hint: k.hint || '****' })
  if (k.source === 'env') return t('settings.keyEnv')
  return needsKey.value ? t('settings.keyNone') : t('settings.keyNotNeeded')
})
const busy = ref(false)
async function saveLlm() {
  busy.value = true
  try {
    const l = llm.value
    const apiKey = keyInput.value.trim()
    const eu = euShown.value && l.eu !== euSaved.value ? { llmEu: l.eu } : {}
    const body = !providerForm.value ? { agentEnabled: l.agentEnabled, autoStrategy: l.autoStrategy, ...eu } : { agentEnabled: l.agentEnabled, autoStrategy: l.autoStrategy, ...eu, llm: { provider: l.provider, baseUrl: norm(l.baseUrl), model: l.model.trim(), modelFast: l.model.trim(), ...(apiKey ? { apiKey } : {}) } }
    await $fetch('/api/settings', { method: 'PATCH', body })
    keyInput.value = ''
    toast.push(t('settings.saved'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
async function removeKey() {
  if (!confirm(t('settings.keyRemoveConfirm'))) return
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { llm: { removeKey: true } } })
    test.value = null
    toast.push(t('settings.keyRemoved'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    toast.error(err)
  }
}
type TestRes = { ok: boolean, model?: string, ms?: number, code?: string, error?: string }
const test = ref<TestRes | null>(null)
const testing = ref(false)
async function testLlm() {
  testing.value = true
  test.value = null
  const l = llm.value
  const apiKey = keyInput.value.trim()
  test.value = await $fetch<TestRes>('/api/settings/llm-test', { method: 'POST', body: { provider: l.provider, baseUrl: norm(l.baseUrl), model: l.model.trim(), ...(apiKey ? { apiKey } : {}) } }).catch(e => ({ ok: false, code: 'other', error: String(e) }))
  testing.value = false
}
const testText = computed(() => {
  const r = test.value
  if (!r) return ''
  if (r.ok) return t('settings.testOk', { model: r.model, ms: r.ms })
  const key = `settings.testErr.${r.code ?? 'other'}`
  return t(key) + (r.error && !['no_key', 'no_url', 'no_model'].includes(r.code ?? '') ? ` (${r.error})` : '')
})

const ws = ref({ name: '', timezone: '' })
watchEffect(() => {
  if (data.value) ws.value = { name: data.value.workspace.name, timezone: data.value.workspace.timezone }
})
const isOwner = computed(() => boot.value?.role === 'owner')
interface MailTestRes { ok: boolean, delivery?: string, to: string, error?: string }
const mailRes = ref<MailTestRes | null>(null)
const mailSending = ref(false)
async function sendTestMail() {
  mailSending.value = true
  mailRes.value = null
  try {
    mailRes.value = await $fetch<MailTestRes>('/api/settings/mail-test' as string, { method: 'POST' })
  }
  catch (err) {
    toast.error(err)
  }
  mailSending.value = false
}
const mailText = computed(() => {
  const r = mailRes.value
  if (!r) return ''
  if (!r.ok) return t('settings.mailTestRes.error', { to: r.to, error: r.error ?? '' })
  return t(`settings.mailTestRes.${r.delivery}`, { to: r.to })
})

interface PlanItem { id: string, name: string, role: string, members: number }
const accOpen = ref(false)
const accEmail = ref('')
const accBusy = ref(false)
const accPlan = ref<{ leave: PlanItem[], remove: PlanItem[], blocked: PlanItem[] } | null>(null)
const dataPage = computed(() => settingsNav.items.value.some(i => i.id === 'daten'))
async function openAccountDelete() {
  try {
    accPlan.value = await $fetch<{ leave: PlanItem[], remove: PlanItem[], blocked: PlanItem[] }>('/api/me/delete' as string)
    accEmail.value = ''
    accOpen.value = true
  }
  catch (err) {
    toast.error(err)
  }
}
async function deleteAccount() {
  accBusy.value = true
  try {
    await stepUp.run<unknown>(() => $fetch<unknown>('/api/me/delete' as string, { method: 'POST', body: { email: accEmail.value } }))
    window.location.href = '/login'
  }
  catch (err) {
    if (!isPasskeyCancel(err)) toast.error(err)
  }
  finally {
    accBusy.value = false
  }
}

async function saveWs() {
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: ws.value })
    toast.push(t('settings.saved'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    toast.error(err)
  }
}
</script>

<template>
  <div v-if="data" class="page">
    <div class="page-head"><h1>{{ item?.label }}</h1></div>

    <section v-if="tab === 'profil'" class="panel">
      <form class="panel-body stack" @submit.prevent="saveProfile">
        <div class="form-grid">
          <label class="field"><span>{{ t('settings.name') }}</span><input v-model="profile.name" class="input" required></label>
          <label class="field"><span>{{ t('settings.language') }}</span><select v-model="profile.locale" class="select"><option value="de">Deutsch</option><option value="en">English</option></select></label>
          <label class="field"><span>{{ t('settings.timeBudget') }}</span><select v-model.number="profile.minutesPerDay" class="select"><option v-for="m in BUDGET_CHOICES" :key="m" :value="m">{{ t('settings.timeBudgetMin', { n: m }) }}</option></select></label>
        </div>
        <p class="hint">{{ t('settings.timeBudgetHint') }}</p>
        <div class="form-actions"><button type="submit" class="btn primary">{{ t('settings.save') }}</button></div>
      </form>
      <MorningMailSwitch />
    </section>

    <section v-if="tab === 'profil'" class="panel">
      <div class="panel-head"><h2>{{ t('settings.accountDelete.title') }}</h2></div>
      <div class="panel-body stack">
        <p class="hint">{{ t('settings.accountDelete.hint') }}</p>
        <div class="form-actions"><button type="button" class="btn danger" @click="openAccountDelete">{{ t('settings.accountDelete.button') }}</button></div>
      </div>
    </section>
    <AppDialog v-if="accOpen && accPlan" :open="accOpen" :title="t('settings.accountDelete.confirmTitle')" @close="accOpen = false">
      <form class="stack confirm" @submit.prevent="deleteAccount">
        <template v-if="accPlan.blocked.length">
          <p class="warn">{{ t('settings.accountDelete.blocked', { names: accPlan.blocked.map(w => w.name).join(', ') }) }}</p>
          <div class="form-actions">
            <NuxtLink to="/einstellungen/team" class="btn primary">{{ t('settings.accountDelete.toTeam') }}</NuxtLink>
            <button type="button" class="btn" @click="accOpen = false">{{ t('common.cancel') }}</button>
          </div>
        </template>
        <template v-else>
          <p class="warn">{{ t('settings.accountDelete.warn') }}</p>
          <p v-if="accPlan.leave.length">{{ t('settings.accountDelete.leave', { names: accPlan.leave.map(w => w.name).join(', ') }) }}</p>
          <p v-if="accPlan.remove.length">{{ t(dataPage ? 'settings.accountDelete.removeHosted' : 'settings.accountDelete.remove', { names: accPlan.remove.map(w => w.name).join(', ') }) }}</p>
          <label class="field"><span>{{ t('settings.accountDelete.label', { email: boot?.user.email ?? '' }) }}</span><input v-model="accEmail" class="input" type="email" autocomplete="off" required></label>
          <div class="form-actions">
            <button type="submit" class="btn danger" :disabled="accBusy || accEmail.trim().toLowerCase() !== (boot?.user.email ?? '').toLowerCase()">{{ t('settings.accountDelete.confirm') }}</button>
            <button type="button" class="btn" @click="accOpen = false">{{ t('common.cancel') }}</button>
          </div>
        </template>
      </form>
    </AppDialog>

    <section v-if="tab === 'sicherheit'" class="panel">
      <div class="panel-body stack">
        <EmailChange />
        <PasskeyList />
        <SessionList />
      </div>
    </section>

    <section v-if="tab === 'sicherheit' && boot?.auth.password && boot?.user.hasPassword" class="panel">
      <div class="panel-head"><h2>{{ t('settings.passwordTitle') }}</h2></div>
      <form class="panel-body stack" @submit.prevent="savePassword">
        <div class="form-grid">
          <label class="field"><span>{{ t('settings.currentPassword') }}</span><input v-model="profile.currentPassword" class="input" type="password" required autocomplete="current-password"></label>
          <label class="field"><span>{{ t('settings.newPassword') }}</span><input v-model="profile.newPassword" class="input" type="password" required minlength="8" autocomplete="new-password"></label>
        </div>
        <div class="form-actions"><button type="submit" class="btn primary">{{ t('settings.passwordSave') }}</button></div>
      </form>
    </section>

    <section v-if="tab === 'kalender'" class="panel">
      <div class="panel-body stack">
        <p class="hint">{{ t('settings.icalHint') }}</p>
        <p v-if="ical?.url" class="mono ical-url">{{ ical.url }}</p>
        <div class="form-actions">
          <button v-if="ical?.url" type="button" class="btn" @click="copyIcal"><Icon name="copy" />{{ t('approvals.copy') }}</button>
          <button type="button" class="btn" @click="newIcal">{{ ical?.url ? t('settings.icalRenew') : t('settings.icalCreate') }}</button>
        </div>
      </div>
    </section>

    <ApiAccess v-if="tab === 'api'" />
    <McpLog v-if="tab === 'api'" />

    <section v-if="tab === 'ki'" class="panel">
      <div class="panel-head"><h2>{{ t('settings.aiAccess') }}</h2></div>
      <form class="panel-body stack" autocomplete="off" @submit.prevent="saveLlm">
        <p class="statusline">
          {{ t('settings.status') }}:
          <b :class="data.llm.status.configured ? 'okc' : 'noc'">{{ data.llm.status.configured ? t('settings.statusOk') : t('settings.statusNo') }}</b>
          <span v-if="data.llm.status.configured" class="dim"> - {{ data.llm.effective.model }}</span>
        </p>
        <p v-if="data.llm.locked" class="hint">{{ data.llm.own ? t('ownLlm.lockedOwn') : t('settings.llmLocked') }}</p>
        <label v-if="euShown" class="check"><input v-model="llm.eu" type="checkbox" :disabled="!isAdmin || data.llm.own"> {{ t('settings.euOnly') }}</label>
        <p v-if="euShown" class="hint">{{ t('settings.euOnlyHint', { provider: data.llm.eu?.provider ? t(`settings.providers.${data.llm.eu.provider}`) : t('settings.euOnlyNone') }) }}</p>
        <div v-if="providerForm" class="form-grid">
          <label class="field"><span>{{ t('settings.provider') }}</span>
            <select :value="llm.provider" class="select" :disabled="!isAdmin" @change="pickProvider(($event.target as HTMLSelectElement).value)">
              <option v-for="p in data.llm.providers" :key="p.id" :value="p.id">{{ t(`settings.providers.${p.id}`) }}</option>
            </select>
          </label>
          <label class="field"><span>{{ t('settings.model') }}</span><input v-model="llm.model" class="input mono" :disabled="!isAdmin" spellcheck="false" required></label>
          <label class="field wide"><span>{{ t('settings.baseUrl') }}</span><input v-model="llm.baseUrl" class="input mono" type="url" :disabled="!isAdmin" spellcheck="false" required></label>
        </div>
        <p v-if="providerForm && te(`settings.providerHint.${llm.provider}`)" class="hint">{{ t(`settings.providerHint.${llm.provider}`) }}</p>

        <div v-if="providerForm" class="keybox">
          <p class="keyline">
            <Icon :name="keyOk ? 'check' : 'x'" :size="14" :class="keyOk ? 'okc' : 'dim'" />
            <span>{{ keyLine }}</span>
            <button v-if="isAdmin && data.llm.key.source === 'workspace' && !urlChanged" type="button" class="btn small ghost" @click="removeKey">{{ t('settings.keyRemove') }}</button>
          </p>
          <label v-if="isAdmin" class="field"><span>{{ data.llm.key.source === 'workspace' && !urlChanged ? t('settings.keyReplace') : t('settings.apiKey') }}</span>
            <input v-model="keyInput" class="input mono" type="password" autocomplete="new-password" spellcheck="false" :placeholder="needsKey ? t('settings.keyPlaceholder') : t('settings.keyOptional')">
          </label>
          <p v-if="keyWillDrop" class="hint warn">{{ t('settings.keyWillDrop') }}</p>
          <p class="hint">{{ t('settings.keyInfo') }}</p>
        </div>

        <label class="check"><input v-model="llm.agentEnabled" type="checkbox" :disabled="!isAdmin"> {{ t('settings.agentEnabled') }}</label>
        <label class="check"><input v-model="llm.autoStrategy" type="checkbox" :disabled="!isAdmin"> {{ t('settings.autoStrategy') }}</label>
        <p class="hint">{{ t('settings.autoStrategyHint') }}</p>
        <div v-if="isAdmin" class="form-actions">
          <button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button>
          <button v-if="providerForm" type="button" class="btn" :disabled="testing" @click="testLlm">{{ testing ? t('settings.testing') : t('settings.test') }}</button>
        </div>
        <p v-if="test" class="testres" :class="test.ok ? 'ok' : 'bad'" role="status"><Icon :name="test.ok ? 'check' : 'x'" :size="14" /><span>{{ testText }}</span></p>
      </form>
    </section>

    <StrongModel v-if="tab === 'ki' && !data.llm.locked" :admin="isAdmin" />
    <OwnLlmKey v-if="tab === 'ki' && data.llm.locked" :admin="isAdmin" @changed="refresh(); refreshBoot()" />
    <OutboundSwitches v-if="tab === 'veroeffentlichen'" :live="data.connected.live" :send-live="data.sendLive" :locked="data.outboundLocked" :admin="isAdmin" @changed="refresh" />
    <AppCredentials v-if="tab === 'apps' && data.social" :apps="data.social.apps" :issues="data.appIssues ?? []" :providers="data.social.ownProviders" :brave="data.braveUsage ?? null" :services="data.services ?? null" @changed="refresh" />
    <SocialConnection v-if="tab === 'apps' && data.social" :social="data.social" :admin="isAdmin" @changed="refresh" />

    <AiReviewer v-if="tab === 'veroeffentlichen'" :cfg="data.aiReviewer" :delay-min="data.mcpApprove.delayMin" :per-day="data.mcpApprove.perDay" :admin="isAdmin" @changed="refresh" />
    <ClaudeApprove v-if="tab === 'veroeffentlichen'" :cfg="data.mcpApprove" :projects="data.projects" :admin="isAdmin" @changed="refresh" />

    <template v-if="tab === 'arbeitsbereich'">
      <section class="panel">
        <form class="panel-body stack" @submit.prevent="saveWs">
          <div class="form-grid">
            <label class="field"><span>{{ t('settings.workspaceName') }}</span><input v-model="ws.name" class="input" :disabled="!isAdmin" required></label>
            <label class="field"><span>{{ t('settings.timezone') }}</span><input v-model="ws.timezone" class="input" :disabled="!isAdmin" required></label>
          </div>
          <div v-if="isAdmin" class="form-actions"><button type="submit" class="btn primary">{{ t('settings.save') }}</button></div>
        </form>
      </section>
      <ExtSlot name="settings-workspace" />
      <section v-if="isOwner" class="panel">
        <div class="panel-head"><h2>{{ t('settings.mailTitle') }}</h2></div>
        <div class="panel-body stack">
          <p class="hint">{{ t('settings.mailHint') }}</p>
          <div class="form-actions"><button type="button" class="btn" :disabled="mailSending" @click="sendTestMail">{{ t('settings.mailTest') }}</button></div>
          <p v-if="mailRes" class="testres" :class="mailRes.ok ? 'ok' : 'bad'" role="status"><Icon :name="mailRes.ok ? 'check' : 'x'" :size="14" /><span>{{ mailText }}</span></p>
        </div>
      </section>
      <section v-if="isOwner && dataPage" class="panel">
        <div class="panel-head"><h2>{{ t('settings.wsDelete.title') }}</h2></div>
        <div class="panel-body stack">
          <p class="hint">{{ t('settings.wsDelete.hint') }}</p>
          <div class="form-actions"><NuxtLink to="/einstellungen/daten" class="btn danger">{{ t('settings.wsDelete.button') }}</NuxtLink></div>
        </div>
      </section>
    </template>

    <section v-if="tab === 'team'" class="panel">
      <ul class="rows">
        <li v-for="m in data.members" :key="m.id" class="prow">
          <span class="avatar">{{ m.initials }}</span>
          <span class="row-title">{{ m.name }} <span class="dim small">{{ m.email }}</span></span>
          <span class="pill">{{ t(`settings.role.${m.role}`) }}</span>
        </li>
      </ul>
      <p class="hint pad">{{ t('settings.membersSingle') }}</p>
    </section>

    <component :is="item.component" v-if="item?.component" />
  </div>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.check input {
  width: 18px;
  height: 18px;
  accent-color: var(--primary);
}

.statusline {
  margin: 0;
}

.keybox {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel2);
}

.keybox .hint {
  margin: 0;
}

.keyline {
  margin: 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13.5px;
}

.keyline .btn {
  margin-left: auto;
}

.warn {
  color: var(--down);
}

.testres {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 13.5px;
  overflow-wrap: anywhere;
}

.testres svg {
  flex: none;
  margin-top: 3px;
}

.testres.ok {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 10%, transparent);
}

.testres.bad {
  color: var(--down);
  background: color-mix(in srgb, var(--down) 10%, transparent);
}

.okc {
  color: var(--up);
}

.noc {
  color: var(--down);
}

.prow {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 0 16px;
}

.small {
  font-size: 12px;
}

.avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--panel2);
  border: 1px solid var(--line2);
  font-size: 11px;
  font-weight: 600;
  flex: none;
}

.ical-url {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.pad {
  padding: 0 16px 14px;
  margin: 0;
}

.confirm {
  max-width: 440px;
}

.confirm p {
  margin: 0;
}
</style>
