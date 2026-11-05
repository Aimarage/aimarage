<script setup lang="ts">
interface OwnLlm {
  available: boolean
  allowed: boolean
  paused: boolean
  active: boolean
  provider: string | null
  model: string | null
  modelFast: string | null
  key: { set: boolean, hint: string | null, setAt: string | null, unreadable: boolean }
  error: { code: 'auth' | 'quota' | 'model', message: string, at: string, until: string | null, active: boolean } | null
  providers: { id: string, model: string, modelFast: string, region: 'eu' | 'tee' | 'us', baseUrl: string }[]
  usage: { costEur: number, runs: number } | null
}

const props = defineProps<{ admin: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()

const { data, refresh } = await useFetch<OwnLlm>('/api/settings/own-llm', { key: 'own-llm' })

const form = ref({ provider: 'mistral', model: '', modelFast: '' })
const keyInput = ref('')
watchEffect(() => {
  const d = data.value
  if (!d) return
  const p = d.provider ?? d.providers[0]?.id ?? 'mistral'
  const def = d.providers.find(x => x.id === p)
  form.value = { provider: p, model: d.model ?? def?.model ?? '', modelFast: d.modelFast ?? def?.modelFast ?? '' }
})
const preset = computed(() => data.value?.providers.find(p => p.id === form.value.provider))
const providerChanged = computed(() => !!data.value?.provider && form.value.provider !== data.value.provider)
function pick(id: string) {
  form.value.provider = id
  const p = data.value?.providers.find(x => x.id === id)
  if (p) {
    form.value.model = p.model
    form.value.modelFast = p.modelFast
  }
  test.value = null
}
const keyOk = computed(() => !!data.value?.key.set && !data.value.key.unreadable && !providerChanged.value)
const keyLine = computed(() => {
  const k = data.value?.key
  if (!k?.set || providerChanged.value) return t('settings.keyNone')
  if (k.unreadable) return t('settings.keyUnreadable')
  return t('settings.keyStored', { hint: k.hint || '****' })
})

const busy = ref(false)
async function save() {
  busy.value = true
  try {
    const f = form.value
    const apiKey = keyInput.value.trim()
    await $fetch('/api/settings/own-llm', { method: 'PATCH', body: { provider: f.provider, model: f.model.trim(), modelFast: f.modelFast.trim(), ...(apiKey ? { apiKey } : {}) } })
    keyInput.value = ''
    toast.push(t('settings.saved'))
    await refresh()
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
async function remove() {
  if (!confirm(t('ownLlm.removeConfirm'))) return
  try {
    await $fetch('/api/settings/own-llm', { method: 'PATCH', body: { remove: true } })
    test.value = null
    toast.push(t('ownLlm.removed'))
    await refresh()
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
}

type TestRes = { ok: boolean, model?: string, ms?: number, code?: string, error?: string, cleared?: boolean }
const test = ref<TestRes | null>(null)
const testing = ref(false)
async function runTest() {
  testing.value = true
  test.value = null
  const f = form.value
  const apiKey = keyInput.value.trim()
  test.value = await $fetch<TestRes>('/api/settings/own-llm-test', { method: 'POST', body: { provider: f.provider, model: f.model.trim(), ...(apiKey ? { apiKey } : {}) } }).catch(e => ({ ok: false, code: 'other', error: String(e) }))
  testing.value = false
  if (test.value?.cleared) {
    await refresh()
    emit('changed')
  }
}
const testText = computed(() => {
  const r = test.value
  if (!r) return ''
  if (r.ok) return t('settings.testOk', { model: r.model, ms: r.ms })
  return t(`settings.testErr.${r.code ?? 'other'}`) + (r.error && !['no_key', 'no_url', 'no_model'].includes(r.code ?? '') ? ` (${r.error})` : '')
})
</script>

<template>
  <section v-if="data?.available" class="panel">
    <div class="panel-head"><h2>{{ t('ownLlm.title') }}</h2></div>
    <p v-if="!data.allowed" class="panel-body hint">{{ t('ownLlm.paused') }}</p>
    <form v-else class="panel-body stack" autocomplete="off" @submit.prevent="save">
      <p class="hint">{{ t('ownLlm.intro') }}</p>
      <p class="statusline">
        {{ t('settings.status') }}:
        <b :class="data.active && !data.error?.active ? 'okc' : 'dim'">{{ data.active ? t('ownLlm.on', { model: data.model }) : t('ownLlm.off') }}</b>
      </p>
      <p v-if="data.error?.active" class="testres bad" role="alert">
        <Icon name="x" :size="14" />
        <span>{{ t(`ownLlm.error.${data.error.code}`) }}<template v-if="data.error.message"> ({{ data.error.message }})</template></span>
      </p>

      <div class="form-grid">
        <label class="field"><span>{{ t('settings.provider') }}</span>
          <select :value="form.provider" class="select" :disabled="!props.admin" @change="pick(($event.target as HTMLSelectElement).value)">
            <option v-for="p in data.providers" :key="p.id" :value="p.id">{{ t(`ownLlm.providers.${p.id}`) }}</option>
          </select>
        </label>
        <label class="field"><span>{{ t('settings.model') }}</span><input v-model="form.model" class="input mono" :disabled="!props.admin" spellcheck="false" required></label>
        <label class="field"><span>{{ t('ownLlm.modelFast') }}</span><input v-model="form.modelFast" class="input mono" :disabled="!props.admin" spellcheck="false"></label>
      </div>
      <p v-if="preset" class="hint" :class="{ warn: preset.region === 'us' }">
        <Icon :name="preset.region === 'us' ? 'external' : 'check'" :size="13" />
        {{ t(`strong.region.${preset.region}`) }}
      </p>

      <div class="keybox">
        <p class="keyline">
          <Icon :name="keyOk ? 'check' : 'x'" :size="14" :class="keyOk ? 'okc' : 'dim'" />
          <span>{{ keyLine }}</span>
          <button v-if="props.admin && data.key.set" type="button" class="btn small ghost" @click="remove">{{ t('settings.keyRemove') }}</button>
        </p>
        <label v-if="props.admin" class="field"><span>{{ data.key.set && !providerChanged ? t('settings.keyReplace') : t('settings.apiKey') }}</span>
          <input v-model="keyInput" class="input mono" type="password" autocomplete="new-password" spellcheck="false" :placeholder="t('settings.keyPlaceholder')">
        </label>
        <p v-if="providerChanged && data.key.set && !keyInput.trim()" class="hint warn">{{ t('ownLlm.keyWillDrop') }}</p>
      </div>

      <p v-if="data.usage && data.usage.runs" class="hint">{{ t('ownLlm.usage', { eur: data.usage.costEur.toFixed(2), runs: data.usage.runs }) }}</p>
      <p class="hint">{{ t('ownLlm.terms') }}</p>

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
