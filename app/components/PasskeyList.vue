<script setup lang="ts">
interface Passkey { id: string, name: string, deviceType: string, backedUp: boolean, createdAt: string, lastUsedAt: string | null }

const { t, locale } = useI18n()
const { dateTime } = useFormat()
const { refresh: refreshBoot } = useBoot()
const toast = useToast()
const stepUp = useStepUp()
const passkey = usePasskey()
const { data, refresh } = await useFetch<{ passkeys: Passkey[] }>('/api/me/passkeys', { key: 'my-passkeys' })
const supported = ref(false)
const busy = ref(false)
onMounted(() => (supported.value = passkey.supported()))

async function add() {
  busy.value = true
  try {
    await passkey.register(deviceName(locale.value))
    toast.push(t('security.passkeyAdded'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    if (!isPasskeyCancel(err)) toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function rename(p: Passkey) {
  const name = prompt(t('security.passkeyRename'), p.name)?.trim()
  if (!name || name === p.name) return
  try {
    await $fetch(`/api/me/passkeys/${p.id}`, { method: 'PATCH', body: { name } })
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

async function remove(p: Passkey) {
  if (!confirm(t('security.passkeyRemoveConfirm', { name: p.name }))) return
  try {
    await stepUp.run<unknown>(() => $fetch<unknown>(`/api/me/passkeys/${p.id}` as string, { method: 'DELETE' }))
    toast.push(t('security.passkeyRemoved'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    if (!isPasskeyCancel(err)) toast.error(err)
  }
}
</script>

<template>
  <div class="block">
    <h3>{{ t('security.passkeys') }}</h3>
    <p class="hint">{{ t('security.passkeysHint') }}</p>
    <ul v-if="data?.passkeys.length" class="rows">
      <li v-for="p in data.passkeys" :key="p.id" class="line">
        <Icon name="key" class="dim" />
        <span class="grow">
          <span class="ellipsis">{{ p.name }}</span>
          <span class="dim small">{{ p.lastUsedAt ? t('security.lastUsed', { at: dateTime(p.lastUsedAt) }) : t('security.created', { at: dateTime(p.createdAt) }) }}</span>
        </span>
        <button type="button" class="btn small ghost" @click="rename(p)">{{ t('security.rename') }}</button>
        <button type="button" class="btn small ghost" @click="remove(p)">{{ t('security.remove') }}</button>
      </li>
    </ul>
    <p v-else class="hint">{{ t('security.noPasskeys') }}</p>
    <div class="form-actions">
      <button v-if="supported" type="button" class="btn" :disabled="busy" @click="add"><Icon name="plus" />{{ t('security.addPasskey') }}</button>
      <span v-else class="hint">{{ t('security.noWebauthn') }}</span>
    </div>
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
  font-weight: 600;
}

.block p {
  margin: 0;
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.small {
  font-size: 12px;
}
</style>
