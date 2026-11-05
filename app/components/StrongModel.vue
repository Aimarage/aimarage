<script setup lang="ts">
interface Strong {
  enabled: boolean
  provider: string
  baseUrl: string
  model: string
  key: { source: string, own: boolean, shared: boolean, hint: string | null, unreadable: boolean, needed: boolean }
  active: boolean
  status: { configured: boolean, reason: string }
  standardModel: string
  steps: string[]
  providers: { id: string, baseUrl: string, model: string, needsKey: boolean, region: 'eu' | 'tee' | 'us' | 'local' | 'other', price: { in: number, out: number } | null }[]
}

const props = defineProps<{ admin: boolean }>()
const { t } = useI18n()
const toast = useToast()

const { data, refresh } = await useFetch<Strong>('/api/settings/llm-strong', { key: 'llm-strong' })

const form = ref({ enabled: false, provider: 'mistral', baseUrl: '', model: '' })
const keyInput = ref('')
watchEffect(() => {
  if (!data.value) return
  form.value = { enabled: data.value.enabled, provider: data.value.provider, baseUrl: data.value.baseUrl, model: data.value.model }
})
const preset = computed(() => data.value?.providers.find(p => p.id === form.value.provider))
const norm = (u: string) => u.trim().replace(/\/+$/, '')
const urlChanged = computed(() => !!data.value && norm(form.value.baseUrl) !== norm(data.value.baseUrl))
function pick(id: string) {
  form.value.provider = id
  const p = data.value?.providers.find(x => x.id === id)
  if (p) {
    form.value.baseUrl = p.baseUrl
    form.value.model = p.model
  }
  test.value = null
}
const keyLine = computed(() => {
  const k = data.value?.key
  if (!k || urlChanged.value) return t('strong.keyNone')
  if (k.unreadable) return t('settings.keyUnreadable')
  if (k.own) return t('settings.keyStored', { hint: k.hint || '****' })
  if (k.shared) return t('strong.keyShared')
  return k.needed ? t('strong.keyNone') : t('settings.keyNotNeeded')
})
const keyOk = computed(() => !!data.value && !urlChanged.value && (data.value.key.own || data.value.key.shared))

const busy = ref(false)
async function save() {
  busy.value = true
  try {
    const f = form.value
    const apiKey = keyInput.value.trim()
    await $fetch('/api/settings/llm-strong', { method: 'PATCH', body: { enabled: f.enabled, provider: f.provider, baseUrl: norm(f.baseUrl), model: f.model.trim(), ...(apiKey ? { apiKey } : {}) } })
    keyInput.value = ''
    toast.push(t('settings.saved'))
    await refresh()
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
    await $fetch('/api/settings/llm-strong', { method: 'PATCH', body: { removeKey: true } })
    toast.push(t('settings.keyRemoved'))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

type TestRes = { ok: boolean, model?: string, ms?: number, code?: string, error?: string }
const test = ref<TestRes | null>(null)
const testing = ref(false)
async function runTest() {
  testing.value = true
  test.value = null
  const f = form.value
  const apiKey = keyInput.value.trim()
  test.value = await $fetch<TestRes>('/api/settings/llm-strong-test', { method: 'POST', body: { provider: f.provider, baseUrl: norm(f.baseUrl), model: f.model.trim(), ...(apiKey ? { apiKey } : {}) } }).catch(e => ({ ok: false, code: 'other', error: String(e) }))
  testing.value = false
}
const testText = computed(() => {
  const r = test.value
  if (!r) return ''
  if (r.ok) return t('settings.testOk', { model: r.model, ms: r.ms })
  return t(`settings.testErr.${r.code ?? 'other'}`) + (r.error && !['no_key', 'no_url', 'no_model'].includes(r.code ?? '') ? ` (${r.error})` : '')
})
const price = (p: { in: number, out: number } | null) => p ? t('strong.price', { in: p.in.toFixed(2), out: p.out.toFixed(2) }) : ''
</script>

<template>
  <section v-if="data" class="panel">
    <div class="panel-head"><h2>{{ t('strong.title') }}</h2></div>
    <form class="panel-body stack" autocomplete="off" @submit.prevent="save">
      <p class="hint">{{ t('strong.intro', { model: data.standardModel }) }}</p>
      <label class="check"><input v-model="form.enabled" type="checkbox" :disabled="!props.admin"> {{ t('strong.enabled') }}</label>
      <p class="statusline">
        {{ t('settings.status') }}:
        <b :class="data.active ? 'okc' : 'dim'">{{ data.active ? t('strong.on', { model: data.model }) : t('strong.off') }}</b>
      </p>

      <div class="form-grid">
        <label class="field"><span>{{ t('settings.provider') }}</span>
          <select :value="form.provider" class="select" :disabled="!props.admin" @change="pick(($event.target as HTMLSelectElement).value)">
            <option v-for="p in data.providers" :key="p.id" :value="p.id">{{ t(`strong.providers.${p.id}`) }}</option>
          </select>
        </label>
        <label class="field"><span>{{ t('settings.model') }}</span><input v-model="form.model" class="input mono" :disabled="!props.admin" spellcheck="false" required></label>
        <label class="field wide"><span>{{ t('settings.baseUrl') }}</span><input v-model="form.baseUrl" class="input mono" type="url" :disabled="!props.admin" spellcheck="false" required></label>
      </div>
      <p v-if="preset" class="hint" :class="{ warn: preset.region === 'us' }">
        <Icon :name="preset.region === 'us' ? 'external' : 'check'" :size="13" />
        {{ t(`strong.region.${preset.region}`) }}<template v-if="preset.price && form.model === preset.model"> - {{ price(preset.price) }}</template>
      </p>

      <div class="keybox">
        <p class="keyline">
          <Icon :name="keyOk ? 'check' : 'x'" :size="14" :class="keyOk ? 'okc' : 'dim'" />
          <span>{{ keyLine }}</span>
          <button v-if="props.admin && data.key.own && !urlChanged" type="button" class="btn small ghost" @click="removeKey">{{ t('settings.keyRemove') }}</button>
        </p>
        <label v-if="props.admin" class="field"><span>{{ data.key.own && !urlChanged ? t('settings.keyReplace') : t('settings.apiKey') }}</span>
          <input v-model="keyInput" class="input mono" type="password" autocomplete="new-password" spellcheck="false" :placeholder="t('settings.keyPlaceholder')">
        </label>
      </div>

      <p class="hint">{{ t('strong.steps') }}: {{ data.steps.map(s => t(`strong.step.${s}`)).join(', ') }}. {{ t('strong.fallback') }}</p>

      <div v-if="props.admin" class="form-actions">
        <button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button>
        <button type="button" class="btn" :disabled="testing" @click="runTest">{{ testing ? t('settings.testing') : t('settings.test') }}</button>
      </div>
      <p v-if="test" class="testres" :class="test.ok ? 'ok' : 'bad'" role="status"><Icon :name="test.ok ? 'check' : 'x'" :size="14" /><span>{{ testText }}</span></p>
    </form>
  </section>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.stack > .hint {
  margin: 0;
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
  accent-color: var(--agent);
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
  border-radius: 8px;
  background: var(--panel2);
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
  border-radius: 8px;
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
</style>
