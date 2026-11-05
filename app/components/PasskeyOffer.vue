<script setup lang="ts">
const { t, locale } = useI18n()
const offer = usePasskeyOffer()
const seen = usePasskeyOfferSeen()
const passkey = usePasskey()
const { refresh } = useBoot()
const toast = useToast()
const busy = ref(false)
const error = ref('')
const { boot } = useBoot()
const open = computed(() => offer.value && import.meta.client && passkey.supported())

watch(offer, (v) => {
  if (v) seen.value = true
}, { immediate: true })

onMounted(() => {
  watch(() => boot.value?.user.passkeyOffer, (v) => {
    if (v && !seen.value) offer.value = true
  }, { immediate: true })
})

async function setup() {
  error.value = ''
  busy.value = true
  try {
    await passkey.register(deviceName(locale.value))
    offer.value = false
    toast.push(t('security.passkeyAdded'))
    await refresh()
  }
  catch (err) {
    if (!isPasskeyCancel(err)) error.value = errorText(err, t('security.passkeyFailed'))
  }
  finally {
    busy.value = false
  }
}

async function later() {
  offer.value = false
  await $fetch('/api/me/passkey-prompt', { method: 'POST' }).catch(() => {})
}
</script>

<template>
  <AppDialog v-if="open" :open="open" :title="t('passkeyOffer.title')" @close="offer = false">
    <div class="offer">
      <p>{{ t('passkeyOffer.lead') }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="form-actions">
        <button type="button" class="btn primary" :disabled="busy" @click="setup"><Icon name="key" />{{ t('passkeyOffer.setup') }}</button>
        <button type="button" class="btn ghost" :disabled="busy" @click="later">{{ t('passkeyOffer.later') }}</button>
      </div>
    </div>
  </AppDialog>
</template>

<style scoped>
.offer {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 440px;
}

.offer p {
  margin: 0;
}
</style>
