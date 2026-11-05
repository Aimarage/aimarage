<script setup lang="ts">
const props = defineProps<{ cfg: { enabled: boolean, ask: boolean, by: string | null, at: string | null, model: string | null }, delayMin: number, perDay: number, admin: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const toast = useToast()
const { refresh: refreshBoot } = useBoot()

const busy = ref(false)
const chosenAt = computed(() => (props.cfg.at ? new Date(props.cfg.at).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' }) : null))
async function toggle(e: Event) {
  const el = e.target as HTMLInputElement
  if (!confirm(t(el.checked ? 'aiReviewer.confirmOn' : 'aiReviewer.confirmOff'))) {
    el.checked = !el.checked
    return
  }
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { aiReviewer: { enabled: el.checked } } })
    emit('changed')
    if (props.cfg.ask) await refreshBoot()
  }
  catch (err) {
    el.checked = !el.checked
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head"><h2>{{ t('aiReviewer.title') }}</h2></div>
    <div class="panel-body stack">
      <label class="switch"><input type="checkbox" :checked="props.cfg.enabled" :disabled="!props.admin || busy" @change="toggle"><span><b>{{ t('aiReviewer.switch') }}:</b> {{ props.cfg.enabled ? t('aiReviewer.on') : t('aiReviewer.off') }}</span></label>
      <p class="hint">{{ t('aiReviewer.intro') }}</p>
      <p v-if="props.cfg.ask" class="hint dim">{{ t('aiReviewer.pending') }}</p>
      <p v-else-if="chosenAt" class="hint dim">{{ props.cfg.by ? t('aiReviewer.chosen', { name: props.cfg.by, date: chosenAt }) : t('aiReviewer.chosenAt', { date: chosenAt }) }}</p>
      <p v-if="!props.admin" class="hint dim">{{ t('aiReviewer.adminOnly') }}</p>
      <p v-if="props.cfg.enabled && props.cfg.model" class="hint dim">{{ t('aiReviewer.model', { model: props.cfg.model }) }} · {{ t('aiReviewer.limits', { delay: props.delayMin, perDay: props.perDay }) }}</p>
      <p v-else-if="props.cfg.enabled" class="hint dim">{{ t('aiReviewer.noModel') }}</p>
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
  accent-color: var(--agent);
}

.hint {
  margin: 0;
}
</style>
