<script setup lang="ts">
definePageMeta({ layout: 'bare' })
const { t, locale } = useI18n()
const { refresh } = useBoot()
const route = useRoute()
const router = useRouter()
const passkey = usePasskey()
const offer = usePasskeyOffer()
useHead({ title: t('login.title') })

const { data: cfg } = await useFetch<{ password: boolean, hosted: boolean, mail?: boolean }>('/api/auth/config', { default: () => ({ password: false, hosted: false, mail: true }) })

const step = ref<'email' | 'code' | 'password'>(cfg.value?.password && !cfg.value.hosted && cfg.value.mail === false ? 'password' : 'email')
const email = ref('')
const code = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)
const canPasskey = ref(false)
const local = ref(false)
const emailRef = ref<HTMLInputElement | null>(null)
const codeRef = ref<{ focus: () => void } | null>(null)

function nextPath(): string {
  const n = route.query.next
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/'
}

async function finish() {
  await refresh()
  await navigateTo(nextPath())
}

async function autofill() {
  if (!(await passkey.autofillSupported())) return
  try {
    await passkey.signIn(true)
    await finish()
  }
  catch (err) {
    if (!isPasskeyCancel(err)) error.value = errorText(err, t('login.passkeyFailed'))
  }
}

onMounted(() => {
  local.value = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  canPasskey.value = passkey.supported()
  if (canPasskey.value && step.value === 'email') autofill()
})

onBeforeUnmount(() => passkey.cancel())

async function withPasskey() {
  error.value = ''
  busy.value = true
  try {
    await passkey.signIn(false)
    await finish()
  }
  catch (err) {
    error.value = isPasskeyCancel(err) ? t('login.passkeyCancelled') : errorText(err, t('login.passkeyFailed'))
    if (step.value === 'email') autofill()
  }
  finally {
    busy.value = false
  }
}

async function requestCode() {
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/auth/code/request', { method: 'POST', body: { email: email.value, locale: locale.value } })
    passkey.cancel()
    step.value = 'code'
    code.value = ''
    await nextTick()
    codeRef.value?.focus()
  }
  catch (err) {
    error.value = errorStatus(err) === 429 ? t('login.tooMany') : errorText(err, t('login.failedCode'))
  }
  finally {
    busy.value = false
  }
}

async function verify(value?: string) {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    const res = await $fetch<{ ok: boolean, passkeyOffer?: boolean, needsSignup?: boolean, signupToken?: string }>('/api/auth/code/verify', { method: 'POST', body: { email: email.value, code: value ?? code.value } })
    if (res.needsSignup) {
      if (router.resolve('/registrieren').matched.length) await router.push({ path: '/registrieren', state: { token: res.signupToken ?? '', email: email.value } })
      else error.value = t('login.noAccount')
      return
    }
    offer.value = !!res.passkeyOffer
    await finish()
  }
  catch (err) {
    error.value = errorText(err, t('login.failedCode'))
    code.value = ''
    codeRef.value?.focus()
  }
  finally {
    busy.value = false
  }
}

async function submitPassword() {
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { email: email.value, password: password.value } })
    await finish()
  }
  catch (err) {
    error.value = errorStatus(err) === 429 ? t('login.tooMany') : t('login.failed')
  }
  finally {
    busy.value = false
  }
}

async function goEmail() {
  step.value = 'email'
  error.value = ''
  await nextTick()
  emailRef.value?.focus()
  if (canPasskey.value) autofill()
}

function goPassword() {
  passkey.cancel()
  error.value = ''
  step.value = 'password'
}
</script>

<template>
  <div class="card panel">
    <div class="brand">
      <svg width="28" height="28" viewBox="0 0 22 22" aria-hidden="true"><rect x="1" y="1" width="20" height="20" rx="5" fill="none" stroke="var(--line2)" /><path d="M5 15 L9 9 L12.5 12.5 L17 6" fill="none" stroke="var(--agent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /><circle cx="17" cy="6" r="1.8" fill="var(--agent)" /></svg>
      Aimarage
    </div>

    <form v-if="step === 'email'" class="stack" @submit.prevent="requestCode">
      <h1>{{ t('login.title') }}</h1>
      <label class="field"><span>{{ t('login.email') }}</span><input ref="emailRef" v-model="email" class="input" type="email" inputmode="email" autocomplete="username webauthn" required autofocus></label>
      <button type="submit" class="btn primary" :disabled="busy">{{ t('login.sendCode') }}</button>
      <ClientOnly>
        <button v-if="canPasskey" type="button" class="btn" :disabled="busy" @click="withPasskey"><Icon name="key" />{{ t('login.withPasskey') }}</button>
      </ClientOnly>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button v-if="cfg?.password" type="button" class="link" @click="goPassword">{{ t('login.withPassword') }}</button>
      <ExtSlot name="login-footer" />
    </form>

    <form v-else-if="step === 'code'" class="stack" @submit.prevent="verify()">
      <h1>{{ t('login.codeTitle') }}</h1>
      <p class="hint">{{ t('login.codeSent', { email }) }}</p>
      <CodeInput ref="codeRef" v-model="code" :label="t('login.code')" :disabled="busy" @complete="verify" />
      <button type="submit" class="btn primary" :disabled="busy || code.length !== 6">{{ t('login.submit') }}</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <ClientOnly><p v-if="local" class="hint">{{ t('login.codeLog') }}</p></ClientOnly>
      <div class="links">
        <button type="button" class="link" @click="goEmail">{{ t('login.otherEmail') }}</button>
        <button type="button" class="link" :disabled="busy" @click="requestCode">{{ t('login.resend') }}</button>
      </div>
    </form>

    <form v-else class="stack" @submit.prevent="submitPassword">
      <h1>{{ t('login.title') }}</h1>
      <label class="field"><span>{{ t('login.email') }}</span><input v-model="email" class="input" type="text" autocomplete="username" required autofocus></label>
      <label class="field"><span>{{ t('login.password') }}</span><input v-model="password" class="input" type="password" autocomplete="current-password" required></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="btn primary" :disabled="busy">{{ t('login.submit') }}</button>
      <ClientOnly><p v-if="local" class="hint">{{ t('login.hint') }}</p></ClientOnly>
      <button type="button" class="link" @click="goEmail">{{ t('login.withCode') }}</button>
    </form>
    <ExtSlot name="legal-links" />
  </div>
</template>

<style scoped>
.card {
  width: min(380px, 100%);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.stack p {
  margin: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 15px;
}

h1 {
  font-size: 24px;
  font-weight: 600;
}

.btn {
  min-height: 44px;
}

.links {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.link {
  align-self: flex-start;
  padding: 4px 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.link:hover {
  color: var(--text);
}
</style>
