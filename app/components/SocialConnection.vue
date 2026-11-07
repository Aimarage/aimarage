<script setup lang="ts">
import type { OwnApp } from '~/components/AppCredentials.vue'

export interface SocialAccountItem {
  id: string
  platform: string
  name: string
  profileId: string | null
  profileName: string | null
  own?: boolean
}

export interface SocialData {
  provider: string
  providers: { id: string, label: string }[]
  key: { source: 'workspace' | 'env' | 'hosted' | 'none', hint: string | null, setAt: string | null, unreadable: boolean }
  hosted?: boolean
  accounts: SocialAccountItem[]
  profiles: { id: string, name: string }[]
  checkedAt: string | null
  live: boolean
  connections: { id: string, platform: string, name: string, error: string | null, readable: boolean }[]
  apps: Record<string, OwnApp>
  ownProviders: { id: string, label: string, platforms: string[], kind: 'password' | 'token' | 'oauth' }[]
}

const props = defineProps<{
  social: SocialData
  admin: boolean
}>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()

const provider = ref(props.social.provider)
const keyInput = ref('')
watch(() => props.social.provider, (v) => {
  provider.value = v
})
const providerChanged = computed(() => provider.value !== props.social.provider)
const keyOk = computed(() => !providerChanged.value && props.social.key.source !== 'none' && !props.social.key.unreadable)
const keyLine = computed(() => {
  const k = props.social.key
  if (providerChanged.value || k.source === 'none') return t('settings.keyNone')
  if (k.unreadable) return t('settings.keyUnreadable')
  if (k.source === 'workspace') return t('settings.keyStored', { hint: k.hint || '****' })
  if (k.source === 'hosted') return t('settings.keyHosted')
  return t('settings.keyEnv')
})

const busy = ref(false)
async function save() {
  busy.value = true
  try {
    const apiKey = keyInput.value.trim()
    await $fetch('/api/settings', { method: 'PATCH', body: { social: { provider: provider.value, ...(apiKey ? { apiKey } : {}) } } })
    keyInput.value = ''
    toast.push(t('settings.saved'))
    emit('changed')
    if (apiKey) await check()
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
    await $fetch('/api/settings', { method: 'PATCH', body: { social: { removeKey: true } } })
    result.value = null
    toast.push(t('settings.keyRemoved'))
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
}

type CheckRes = { ok: boolean, accounts?: SocialAccountItem[], profiles?: { id: string, name: string }[], ms?: number, code?: string, error?: string }
const result = ref<CheckRes | null>(null)
const checking = ref(false)
async function check() {
  checking.value = true
  result.value = null
  const apiKey = keyInput.value.trim()
  result.value = await $fetch<CheckRes>('/api/settings/social-test', { method: 'POST', body: { provider: provider.value, ...(apiKey ? { apiKey } : {}) } }).catch(e => ({ ok: false, code: 'other', error: String(e) }))
  checking.value = false
  if (result.value.ok) emit('changed')
}
const resultText = computed(() => {
  const r = result.value
  if (!r) return ''
  if (r.ok) return r.accounts?.length || r.profiles?.length ? t('social.checkOk', { p: r.profiles?.length ?? 0, n: r.accounts?.length ?? 0, ms: r.ms }) : t('social.checkEmpty')
  return t(`settings.testErr.${r.code ?? 'other'}`) + (r.error && r.code !== 'no_key' ? ` (${r.error})` : '')
})

</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('social.title') }}</h2></div>
    <form class="panel-body stack" autocomplete="off" @submit.prevent="save">
      <p class="hint">{{ t('social.intro') }}</p>
      <div class="form-grid">
        <label class="field"><span>{{ t('social.service') }}</span>
          <select v-model="provider" class="select" :disabled="!props.admin">
            <option v-for="(p, i) in props.social.providers" :key="p.id" :value="p.id">{{ p.label }}{{ i === 0 ? ` (${t('social.default')})` : '' }}</option>
          </select>
        </label>
      </div>
      <div class="keybox">
        <p class="keyline">
          <Icon :name="keyOk ? 'check' : 'x'" :size="14" :class="keyOk ? 'okc' : 'dim'" />
          <span>{{ keyLine }}</span>
          <button v-if="props.admin && props.social.key.source === 'workspace' && !providerChanged" type="button" class="btn small ghost" @click="removeKey">{{ t('settings.keyRemove') }}</button>
        </p>
        <label v-if="props.admin" class="field"><span>{{ props.social.key.source === 'workspace' && !providerChanged ? t('settings.keyReplace') : t('settings.apiKey') }}</span>
          <input v-model="keyInput" class="input mono" type="password" autocomplete="new-password" spellcheck="false" :placeholder="t('settings.keyPlaceholder')">
        </label>
        <p v-if="providerChanged && props.social.key.source === 'workspace'" class="hint warn">{{ t('social.keyWillDrop') }}</p>
        <p class="hint">{{ t('social.keyInfo') }}</p>
      </div>
      <div v-if="props.admin" class="form-actions">
        <button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button>
        <button type="button" class="btn" :disabled="checking" @click="check">{{ checking ? t('settings.testing') : t('settings.test') }}</button>
      </div>
      <p v-if="result" class="testres" :class="result.ok ? 'ok' : 'bad'" role="status"><Icon :name="result.ok ? 'check' : 'x'" :size="14" /><span>{{ resultText }}</span></p>
    </form>
  </section>

</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.stack .hint {
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

.okc {
  color: var(--up);
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
</style>
