<script setup lang="ts">
const { t } = useI18n()
const { boot, refresh } = useBoot()
const toast = useToast()
const stepUp = useStepUp()
const editing = ref(false)
const email = ref('')
const code = ref('')
const sent = ref(false)
const busy = ref(false)
const codeRef = ref<{ focus: () => void } | null>(null)

function start() {
  editing.value = true
  sent.value = false
  email.value = ''
  code.value = ''
}

async function request() {
  busy.value = true
  try {
    await stepUp.run<unknown>(() => $fetch<unknown>('/api/me/email/request' as string, { method: 'POST', body: { email: email.value } }))
    sent.value = true
    await nextTick()
    codeRef.value?.focus()
  }
  catch (err) {
    if (!isPasskeyCancel(err)) toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function verify(value?: string) {
  if (busy.value) return
  busy.value = true
  try {
    await $fetch('/api/me/email/verify', { method: 'POST', body: { email: email.value, code: value ?? code.value } })
    editing.value = false
    toast.push(t('security.emailChanged'))
    await refresh()
  }
  catch (err) {
    code.value = ''
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="block">
    <h3>{{ t('security.email') }}</h3>
    <div class="cur">
      <span class="ellipsis">{{ boot?.user.email }}</span>
      <button v-if="!editing" type="button" class="btn small" @click="start">{{ t('security.change') }}</button>
    </div>
    <form v-if="editing && !sent" class="step" @submit.prevent="request">
      <label class="field"><span>{{ t('security.newEmail') }}</span><input v-model="email" class="input" type="email" autocomplete="email" required></label>
      <div class="form-actions">
        <button type="submit" class="btn primary" :disabled="busy">{{ t('security.sendCode') }}</button>
        <button type="button" class="btn ghost" @click="editing = false">{{ t('common.cancel') }}</button>
      </div>
    </form>
    <form v-if="editing && sent" class="step" @submit.prevent="verify()">
      <p class="hint">{{ t('security.codeSentTo', { email }) }}</p>
      <CodeInput ref="codeRef" v-model="code" :label="t('login.code')" :disabled="busy" @complete="verify" />
      <div class="form-actions">
        <button type="submit" class="btn primary" :disabled="busy || code.length !== 6">{{ t('security.confirm') }}</button>
        <button type="button" class="btn ghost" @click="editing = false">{{ t('common.cancel') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.block h3 {
  font-size: 14px;
  font-weight: var(--head-weight);
}

.block p {
  margin: 0;
}

.cur {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
}

.step {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 380px;
}
</style>
