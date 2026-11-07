<script setup lang="ts">
const props = defineProps<{ live: boolean, sendLive: boolean, admin: boolean, locked?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()
const { base } = useScope()

const busy = ref(false)
async function set(key: 'publishLive' | 'sendLive', v: boolean) {
  if (v && !confirm(t(key === 'publishLive' ? 'conn.liveConfirm' : 'mailbox.liveConfirm'))) return
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { [key]: v } })
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('settings.outbound') }}</h2></div>
    <div class="panel-body stack">
      <label class="switch"><input type="checkbox" :checked="props.live" :disabled="!props.admin || busy || props.locked" @change="set('publishLive', ($event.target as HTMLInputElement).checked)"><span><b>{{ t('conn.liveTitle') }}:</b> {{ props.live ? t('conn.liveOn') : t('conn.liveOff') }}</span></label>
      <label class="switch"><input type="checkbox" :checked="props.sendLive" :disabled="!props.admin || busy || props.locked" @change="set('sendLive', ($event.target as HTMLInputElement).checked)"><span><b>{{ t('mailbox.liveTitle') }}:</b> {{ props.sendLive ? t('mailbox.liveOn') : t('mailbox.liveOff') }}</span></label>
      <p v-if="props.locked" class="error">{{ t('settings.outboundLocked') }}</p>
      <p class="hint"><Icon name="link" :size="13" /> {{ t('settings.accountsMoved') }} <NuxtLink :to="`${base}/konten`">{{ t('nav.accounts') }}</NuxtLink></p>
    </div>
  </section>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.switch {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 14px;
}

.switch input {
  width: 18px;
  height: 18px;
  flex: none;
  margin-top: 1px;
  accent-color: var(--primary);
}

.hint {
  margin: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
