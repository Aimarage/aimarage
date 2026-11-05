<script setup lang="ts">
interface Cfg { enabled: boolean, kinds: string[], delayMin: number, perDay: number, offProjects: string[] }
interface Access {
  tokens: { id: string, name: string, hint: string, scope: 'read' | 'write', canApprove?: boolean, lastUsedAt: string | null }[]
  mcpUrl: string
  canWrite: boolean
}

const props = defineProps<{ cfg: Cfg, projects: { id: string, name: string, archived: boolean }[], admin: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()
const { dateTime } = useFormat()

const KINDS = ['content', 'social', 'community', 'verzeichnis', 'mail'] as const
const form = ref({ kinds: [...props.cfg.kinds], delayMin: props.cfg.delayMin, perDay: props.cfg.perDay, offProjects: [...props.cfg.offProjects] })
watch(() => props.cfg, c => (form.value = { kinds: [...c.kinds], delayMin: c.delayMin, perDay: c.perDay, offProjects: [...c.offProjects] }))
const busy = ref(false)

async function patch(body: Record<string, unknown>) {
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { mcpApprove: body } })
    emit('changed')
    return true
  }
  catch (err) {
    toast.error(err)
    return false
  }
  finally {
    busy.value = false
  }
}

async function toggle(e: Event) {
  const el = e.target as HTMLInputElement
  if (el.checked && !confirm(t('mcpApprove.confirmOn'))) {
    el.checked = false
    return
  }
  if (!(await patch({ enabled: el.checked }))) el.checked = !el.checked
}

async function save() {
  const f = form.value
  if (f.delayMin === 0 && props.cfg.delayMin !== 0 && !confirm(t('mcpApprove.confirmZero'))) return
  if (await patch({ kinds: f.kinds, delayMin: f.delayMin, zeroDelayOk: f.delayMin === 0, perDay: f.perDay, offProjects: f.offProjects })) toast.push(t('settings.saved'))
}

function setProject(id: string, on: boolean) {
  const off = new Set(form.value.offProjects)
  if (on) off.delete(id)
  else off.add(id)
  form.value.offProjects = [...off]
}

const { data: access, refresh: refreshAccess } = await useFetch<Access>('/api/me/api-access', { key: 'api-access' })
const keys = computed(() => access.value?.tokens.filter(x => x.canApprove) ?? [])
const fresh = ref<string | null>(null)
const command = computed(() => (fresh.value && access.value ? `claude mcp add --transport http aimarage ${access.value.mcpUrl} --header "Authorization: Bearer ${fresh.value}"` : ''))

async function createKey() {
  busy.value = true
  try {
    const r = await $fetch<{ token: string }>('/api/me/api-tokens', { method: 'POST', body: { name: 'Claude Code (freigeben)', scope: 'write', approve: true } })
    fresh.value = r.token
    await refreshAccess()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function revoke(id: string) {
  if (!confirm(t('api.revokeConfirm'))) return
  await $fetch(`/api/me/api-tokens/${id}`, { method: 'DELETE' }).catch(toast.error)
  await refreshAccess()
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast.push(t('api.copied'))
}
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('mcpApprove.title') }}</h2></div>
    <div class="panel-body stack">
      <label class="switch"><input type="checkbox" :checked="props.cfg.enabled" :disabled="!props.admin || busy" @change="toggle"><span><b>{{ t('mcpApprove.switch') }}:</b> {{ props.cfg.enabled ? t('mcpApprove.on') : t('mcpApprove.off') }}</span></label>
      <p class="hint">{{ t('mcpApprove.intro') }}</p>

      <form v-if="props.cfg.enabled" class="stack" @submit.prevent="save">
        <fieldset class="group">
          <legend>{{ t('mcpApprove.kinds') }}</legend>
          <label v-for="k in KINDS" :key="k" class="check"><input v-model="form.kinds" type="checkbox" :value="k" :disabled="!props.admin">{{ t(`mcpApprove.kind.${k}`) }}<span v-if="k === 'mail'" class="dim small">({{ t('mcpApprove.mailHint') }})</span></label>
          <span class="dim small never">{{ t('mcpApprove.never') }}</span>
        </fieldset>
        <fieldset v-if="props.projects.length > 1" class="group">
          <legend>{{ t('mcpApprove.projects') }}</legend>
          <label v-for="p in props.projects.filter(x => !x.archived)" :key="p.id" class="check"><input type="checkbox" :checked="!form.offProjects.includes(p.id)" :disabled="!props.admin" @change="setProject(p.id, ($event.target as HTMLInputElement).checked)">{{ p.name }}</label>
        </fieldset>
        <div class="nums">
          <label class="field"><span>{{ t('mcpApprove.delay') }}</span><input v-model.number="form.delayMin" class="input" type="number" min="0" max="1440" :disabled="!props.admin"></label>
          <label class="field"><span>{{ t('mcpApprove.perDay') }}</span><input v-model.number="form.perDay" class="input" type="number" min="1" max="100" :disabled="!props.admin"></label>
        </div>
        <div v-if="props.admin" class="form-actions"><button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button></div>
      </form>

      <div class="stack">
        <p class="hint">{{ t('mcpApprove.keyHint') }}</p>
        <div v-if="fresh" class="fresh" role="status">
          <p><b>{{ t('api.freshTitle') }}</b> {{ t('api.freshHint') }}</p>
          <p class="mono secret">{{ command }}</p>
          <div class="form-actions">
            <button type="button" class="btn" @click="copy(command)"><Icon name="copy" />{{ t('api.copyCommand') }}</button>
            <button type="button" class="btn ghost" @click="fresh = null">{{ t('api.done') }}</button>
          </div>
        </div>
        <ul v-if="keys.length" class="keys">
          <li v-for="k in keys" :key="k.id">
            <span class="mono dim small">...{{ k.hint }}</span>
            <span class="dim small">{{ k.lastUsedAt ? t('api.used', { at: dateTime(k.lastUsedAt) }) : t('api.unused') }}</span>
            <button type="button" class="btn small ghost danger" @click="revoke(k.id)">{{ t('api.revoke') }}</button>
          </li>
        </ul>
        <div v-if="access?.canWrite" class="form-actions"><button type="button" class="btn" :disabled="busy" @click="createKey">{{ t('mcpApprove.newKey') }}</button></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.stack .hint {
  margin: 0;
}

.switch {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 14px;
}

.switch input,
.check input {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--agent);
}

.group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin: 0;
  padding: 0;
  border: 0;
}

.group legend {
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--muted);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}

.never {
  flex-basis: 100%;
}

.nums {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 12px;
}

.nums .field {
  flex: 0 1 200px;
}

.fresh {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--agent);
  border-radius: 8px;
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

.keys {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.keys li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.small {
  font-size: 12px;
}
</style>
