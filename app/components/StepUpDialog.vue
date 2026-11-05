<script setup lang="ts">
const { t } = useI18n()
const { boot } = useBoot()
const stepUp = useStepUp()
const passkey = usePasskey()
const busy = ref(false)
const error = ref('')
const sent = ref(false)
const code = ref('')
const password = ref('')
const codeRef = ref<{ focus: () => void } | null>(null)
const canPasskey = computed(() => (boot.value?.user.passkeys ?? 0) > 0 && import.meta.client && passkey.supported())
const canPassword = computed(() => !!boot.value?.auth.password && !!boot.value?.user.hasPassword)

watch(() => stepUp.open.value, (o) => {
  if (!o) return
  error.value = ''
  sent.value = false
  code.value = ''
  password.value = ''
})

async function attempt(fn: () => Promise<unknown>) {
  error.value = ''
  busy.value = true
  try {
    await fn()
    stepUp.done(true)
  }
  catch (err) {
    if (!isPasskeyCancel(err)) error.value = errorText(err, t('stepUp.failed'))
  }
  finally {
    busy.value = false
  }
}

async function sendCode() {
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/auth/step-up', { method: 'POST', body: { method: 'code-request' } })
    sent.value = true
    await nextTick()
    codeRef.value?.focus()
  }
  catch (err) {
    error.value = errorText(err, t('stepUp.failed'))
  }
  finally {
    busy.value = false
  }
}

function withCode(value?: string) {
  return attempt(() => $fetch<unknown>('/api/auth/step-up' as string, { method: 'POST', body: { method: 'code', code: value ?? code.value } }))
}

function withPassword() {
  return attempt(() => $fetch<unknown>('/api/auth/step-up' as string, { method: 'POST', body: { method: 'password', password: password.value } }))
}
</script>

<template>
  <AppDialog v-if="stepUp.open.value" :open="stepUp.open.value" :title="t('stepUp.title')" @close="stepUp.done(false)">
    <div class="su">
      <p class="lead">{{ t('stepUp.lead') }}</p>
      <button v-if="canPasskey" type="button" class="btn primary" :disabled="busy" @click="attempt(passkey.confirm)"><Icon name="key" />{{ t('stepUp.passkey') }}</button>
      <template v-if="!sent">
        <button type="button" class="btn" :disabled="busy" @click="sendCode"><Icon name="mail" />{{ t('stepUp.sendCode') }}</button>
      </template>
      <form v-else class="su-form" @submit.prevent="withCode()">
        <p class="hint">{{ t('stepUp.codeSent', { email: boot?.user.email }) }}</p>
        <CodeInput ref="codeRef" v-model="code" :label="t('login.code')" :disabled="busy" @complete="withCode" />
        <button type="submit" class="btn primary" :disabled="busy || code.length !== 6">{{ t('stepUp.confirm') }}</button>
      </form>
      <form v-if="canPassword" class="su-form" @submit.prevent="withPassword">
        <label class="field"><span>{{ t('login.password') }}</span><input v-model="password" class="input" type="password" autocomplete="current-password" required></label>
        <button type="submit" class="btn" :disabled="busy || !password">{{ t('stepUp.confirm') }}</button>
      </form>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
  </AppDialog>
</template>

<style scoped>
.su {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 400px;
}

.su p {
  margin: 0;
}

.su-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
</style>
