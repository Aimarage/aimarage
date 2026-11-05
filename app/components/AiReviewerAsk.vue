<script setup lang="ts">
const { t } = useI18n()
const toast = useToast()
const { boot, refresh, isAdmin } = useBoot()

const show = computed(() => isAdmin.value && !!boot.value?.workspace.reviewerAsk)
const busy = ref(false)
async function answer(enabled: boolean) {
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { aiReviewer: { enabled } } })
    toast.push(t(enabled ? 'aiReviewer.askSavedYes' : 'aiReviewer.askSavedNo'))
    await refresh()
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
  <section v-if="show" class="panel ask">
    <div class="panel-head"><h2>{{ t('aiReviewer.askTitle') }}</h2></div>
    <div class="panel-body body">
      <p class="hint">{{ t('aiReviewer.askText') }}</p>
      <p class="hint dim">{{ t('aiReviewer.askResp') }}</p>
      <div class="form-actions">
        <button type="button" class="btn ghost" :disabled="busy" @click="answer(false)">{{ t('aiReviewer.askNo') }}</button>
        <button type="button" class="btn primary" :disabled="busy" @click="answer(true)">{{ t('aiReviewer.askYes') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hint {
  margin: 0;
}
</style>
