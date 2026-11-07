<script setup lang="ts">
import { API_PERMS, daysLeft, TOKEN_DAYS, TOKEN_DAYS_DEFAULT, TOKEN_WARN_DAYS, type ApiPerm } from '~~/shared/utils/api-perms'

interface Token { id: string, name: string, hint: string, scope: 'read' | 'write', canApprove?: boolean, perms: ApiPerm[], projectIds: string[] | null, expiresAt: string | null, reviewNeeded: boolean, lastClient: string | null, createdAt: string, lastUsedAt: string | null, owner?: string | null }
interface Access {
  tokens: Token[]
  others: Token[]
  grants: { id: string, name: string, scope: 'read' | 'write', createdAt: string, lastUsedAt: string | null }[]
  projects: { id: string, name: string }[]
  mcpUrl: string
  apiUrl: string
  canWrite: boolean
  admin: boolean
}

const { t } = useI18n()
const toast = useToast()
const { dateTime, dayDm } = useFormat()
const { data, refresh } = await useFetch<Access>('/api/me/api-access', { key: 'api-access' })

const WRITE: ApiPerm[] = ['draft', 'strategy', 'agent', 'approve']
const name = ref('Claude Code')
const perms = ref<ApiPerm[]>(['read'])
const projects = ref<string[]>([])
const days = ref<number>(TOKEN_DAYS_DEFAULT)
const busy = ref(false)
const fresh = ref<string | null>(null)
const editing = ref<string | null>(null)
const edit = ref<{ perms: ApiPerm[], projects: string[] }>({ perms: [], projects: [] })

const command = computed(() => fresh.value && data.value ? `claude mcp add --transport http aimarage ${data.value.mcpUrl} --header "Authorization: Bearer ${fresh.value}"` : '')
const projectName = (id: string) => data.value?.projects.find(p => p.id === id)?.name ?? '?'
const disabledPerm = (p: ApiPerm) => p === 'read' || (WRITE.includes(p) && !data.value?.canWrite)

function toggle(list: ApiPerm[], p: ApiPerm, on: boolean): ApiPerm[] {
  const set = new Set(list)
  if (on) set.add(p)
  else set.delete(p)
  if (set.has('approve')) set.add('draft')
  return API_PERMS.filter(x => x === 'read' || set.has(x))
}

function expiry(x: Token): { text: string, warn: boolean } {
  const left = daysLeft(x.expiresAt)
  if (left === null) return { text: t('api.noExpiry'), warn: true }
  return { text: t('api.expires', { at: dayDm(x.expiresAt!.slice(0, 10)), n: Math.max(0, left) }), warn: left <= TOKEN_WARN_DAYS }
}

async function create() {
  busy.value = true
  try {
    const r = await $fetch<{ id: string, token: string }>('/api/me/api-tokens', { method: 'POST', body: { name: name.value, perms: perms.value, projects: projects.value.length ? projects.value : null, days: days.value } })
    fresh.value = r.token
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function patch(id: string, body: Record<string, unknown>) {
  try {
    await $fetch(`/api/me/api-tokens/${id}`, { method: 'PATCH', body })
    toast.push(t('settings.saved'))
    editing.value = null
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

function startEdit(x: Token) {
  editing.value = x.id
  edit.value = { perms: [...x.perms], projects: [...(x.projectIds ?? [])] }
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast.push(t('api.copied'))
}

async function revoke(id: string) {
  if (!confirm(t('api.revokeConfirm'))) return
  await $fetch(`/api/me/api-tokens/${id}`, { method: 'DELETE' }).catch(toast.error)
  await refresh()
}

async function disconnect(id: string) {
  if (!confirm(t('api.disconnectConfirm'))) return
  await $fetch(`/api/me/oauth-grants/${id}`, { method: 'DELETE' }).catch(toast.error)
  await refresh()
}
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('api.title') }}</h2><NuxtLink to="/hilfe/mcp" class="guide">{{ t('help.guide') }}</NuxtLink></div>
    <div v-if="data" class="panel-body stack">
      <p class="hint">{{ t('api.intro') }}</p>
      <dl class="urls">
        <dt>MCP</dt><dd class="mono">{{ data.mcpUrl }}</dd>
        <dt>REST</dt><dd class="mono">{{ data.apiUrl }} <a :href="`${data.apiUrl}/openapi.json`" target="_blank" rel="noopener">OpenAPI</a></dd>
      </dl>

      <div v-if="fresh" class="fresh" role="status">
        <p><b>{{ t('api.freshTitle') }}</b> {{ t('api.freshHint') }}</p>
        <p class="mono secret">{{ fresh }}</p>
        <div class="form-actions">
          <button type="button" class="btn" @click="copy(fresh)"><Icon name="copy" />{{ t('api.copyToken') }}</button>
          <button type="button" class="btn" @click="copy(command)"><Icon name="copy" />{{ t('api.copyCommand') }}</button>
          <button type="button" class="btn ghost" @click="fresh = null">{{ t('api.done') }}</button>
        </div>
      </div>

      <form class="stack" @submit.prevent="create">
        <div class="newtok">
          <label class="field"><span>{{ t('api.name') }}</span><input v-model="name" class="input" maxlength="60" required></label>
          <label class="field"><span>{{ t('api.validity') }}</span>
            <select v-model.number="days" class="select">
              <option v-for="d in TOKEN_DAYS" :key="d" :value="d">{{ t('api.days', { n: d }) }}</option>
            </select>
          </label>
        </div>
        <fieldset class="group">
          <legend>{{ t('api.scope') }}</legend>
          <label v-for="p in API_PERMS" :key="p" class="check"><input type="checkbox" :checked="perms.includes(p)" :disabled="disabledPerm(p)" @change="perms = toggle(perms, p, ($event.target as HTMLInputElement).checked)"><span><b>{{ t(`api.perm.${p}`) }}</b> <span class="dim small">{{ t(`api.permHint.${p}`) }}</span></span></label>
        </fieldset>
        <fieldset v-if="data.projects.length > 1" class="group">
          <legend>{{ t('api.projects') }}</legend>
          <span class="dim small">{{ t('api.projectsHint') }}</span>
          <label v-for="p in data.projects" :key="p.id" class="check"><input v-model="projects" type="checkbox" :value="p.id">{{ p.name }}</label>
        </fieldset>
        <div class="form-actions"><button type="submit" class="btn primary" :disabled="busy">{{ t('api.create') }}</button></div>
      </form>
      <p class="hint">{{ t('api.safety') }}</p>
    </div>
    <ul v-if="data && (data.tokens.length || data.grants.length)" class="rows">
      <li v-for="x in data.tokens" :key="x.id" class="trow">
        <div class="line">
          <span class="tname">{{ x.name }}</span>
          <span class="mono dim small">...{{ x.hint }}</span>
          <span v-for="p in x.perms" :key="p" class="tag">{{ t(`api.perm.${p}`) }}</span>
          <span class="tag" :class="{ 'warn-tag': !x.projectIds }">{{ x.projectIds ? x.projectIds.map(projectName).join(', ') : t('api.allProjects') }}</span>
        </div>
        <div class="line dim small">
          <span :class="{ 'warn-text': expiry(x).warn }">{{ expiry(x).text }}</span>
          <span>{{ x.lastUsedAt ? t('api.used', { at: dateTime(x.lastUsedAt) }) : t('api.unused') }}<template v-if="x.lastClient"> - {{ x.lastClient }}</template></span>
        </div>
        <p v-if="x.reviewNeeded" class="review small" role="status">{{ t('api.reviewNeeded') }}
          <button type="button" class="btn small" @click="patch(x.id, { perms: x.perms })">{{ t('api.reviewOk') }}</button>
        </p>
        <div v-if="editing === x.id" class="stack edit">
          <fieldset class="group">
            <legend>{{ t('api.scope') }}</legend>
            <label v-for="p in API_PERMS" :key="p" class="check"><input type="checkbox" :checked="edit.perms.includes(p)" :disabled="disabledPerm(p)" @change="edit.perms = toggle(edit.perms, p, ($event.target as HTMLInputElement).checked)">{{ t(`api.perm.${p}`) }}</label>
          </fieldset>
          <fieldset v-if="data.projects.length > 1" class="group">
            <legend>{{ t('api.projects') }}</legend>
            <label v-for="p in data.projects" :key="p.id" class="check"><input v-model="edit.projects" type="checkbox" :value="p.id">{{ p.name }}</label>
          </fieldset>
          <div class="form-actions">
            <button type="button" class="btn primary small" @click="patch(x.id, { perms: edit.perms, projects: edit.projects.length ? edit.projects : null })">{{ t('settings.save') }}</button>
            <button type="button" class="btn ghost small" @click="editing = null">{{ t('api.cancel') }}</button>
          </div>
        </div>
        <div class="line actions">
          <button v-if="editing !== x.id" type="button" class="btn small ghost" @click="startEdit(x)">{{ t('api.edit') }}</button>
          <button type="button" class="btn small ghost" @click="patch(x.id, { extendDays: TOKEN_DAYS_DEFAULT })">{{ t('api.extend', { n: TOKEN_DAYS_DEFAULT }) }}</button>
          <button type="button" class="btn small ghost danger" @click="revoke(x.id)">{{ t('api.revoke') }}</button>
        </div>
      </li>
      <li v-for="g in data.grants" :key="g.id" class="trow">
        <div class="line">
          <span class="tname">{{ g.name }}</span>
          <span class="dim small">OAuth</span>
          <span class="tag">{{ g.scope === 'write' ? t('api.scopeWriteShort') : t('api.scopeReadShort') }}</span>
          <span class="dim small meta">{{ g.lastUsedAt ? t('api.used', { at: dateTime(g.lastUsedAt) }) : t('api.unused') }}</span>
          <button type="button" class="btn small ghost danger" @click="disconnect(g.id)">{{ t('api.disconnect') }}</button>
        </div>
      </li>
    </ul>
    <template v-if="data?.admin && data.others.length">
      <div class="panel-body"><h3 class="sub">{{ t('api.othersTitle') }}</h3></div>
      <ul class="rows">
        <li v-for="x in data.others" :key="x.id" class="trow">
          <div class="line">
            <span class="tname">{{ x.name }}</span>
            <span class="dim small">{{ x.owner }}</span>
            <span v-for="p in x.perms" :key="p" class="tag">{{ t(`api.perm.${p}`) }}</span>
            <span class="dim small meta">{{ expiry(x).text }} - {{ x.lastUsedAt ? t('api.used', { at: dateTime(x.lastUsedAt) }) : t('api.unused') }}<template v-if="x.lastClient"> - {{ x.lastClient }}</template></span>
            <button type="button" class="btn small ghost danger" @click="revoke(x.id)">{{ t('api.revoke') }}</button>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.guide {
  margin-left: auto;
  font-size: 13px;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.stack .hint {
  margin: 0;
}

.urls {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 13.5px;
}

.urls dt {
  color: var(--muted);
}

.urls dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.fresh {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--primary);
  border-radius: 4px;
  background: var(--panel2);
}

.fresh p {
  margin: 0;
  font-size: 13.5px;
}

.secret {
  overflow-wrap: anywhere;
  user-select: all;
}

.newtok {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 12px;
}

.newtok .field {
  flex: 1 1 180px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
}

.check {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13.5px;
}

.trow {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px;
}

.line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.actions {
  gap: 4px;
}

.tname {
  font-weight: 600;
}

.tag {
  font-size: 12px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
}

.warn-tag {
  border-color: var(--warn);
}

.warn-text {
  color: var(--warn);
}

.review {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 3px;
  background: var(--marker-soft);
}

.edit {
  gap: 10px;
}

.sub {
  margin: 0;
  font-size: 14px;
}

.meta {
  flex: 1 1 140px;
}

.small {
  font-size: 12px;
}
</style>
