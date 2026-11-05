<script setup lang="ts">
const props = defineProps<{ projectId: string, admin: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()

const { data, refresh } = await useFetch<{ questions: string[] }>(() => `/api/projects/${props.projectId}/geo`, { key: `geo:${props.projectId}` })
const text = ref('')
watch(() => data.value?.questions, q => (text.value = (q ?? []).join('\n')), { immediate: true })
const busy = ref(false)

async function run(fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
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
function save() {
  return run(async () => {
    await $fetch(`/api/projects/${props.projectId}/geo`, { method: 'PUT', body: { questions: text.value.split('\n').map(x => x.trim()).filter(Boolean) } })
    toast.push(t('settings.saved'))
  })
}
function suggest() {
  return run(async () => {
    await $fetch(`/api/projects/${props.projectId}/geo-questions`, { method: 'POST' })
  })
}
function check() {
  return run(async () => {
    await $fetch(`/api/projects/${props.projectId}/geo-check`, { method: 'POST' })
    toast.push(t('geo.queued'))
  })
}
</script>

<template>
  <form class="geo" @submit.prevent="save">
    <p class="hint">{{ t('geo.help') }}</p>
    <label class="field">
      <span>{{ t('geo.questionsLabel') }}</span>
      <textarea v-model="text" class="textarea" rows="5" :disabled="!admin || busy" :placeholder="t('geo.placeholder')" />
    </label>
    <div v-if="admin" class="form-actions">
      <button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button>
      <button type="button" class="btn" :disabled="busy" @click="suggest">{{ t('geo.suggest') }}</button>
      <button type="button" class="btn" :disabled="busy || !data?.questions.length" @click="check">{{ t('geo.check') }}</button>
    </div>
  </form>
</template>

<style scoped>
.geo {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hint {
  margin: 0;
  font-size: 13px;
}
</style>
