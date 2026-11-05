<script setup lang="ts">
const { t } = useI18n()
const { boot, canEdit } = useBoot()
const { project, base } = useScope()
const toast = useToast()
const open = ref(false)
const busy = ref(false)
const form = ref(emptyTaskForm(null, null, ''))

function start() {
  form.value = emptyTaskForm(project.value?.slug ?? null, boot.value?.user.id ?? null, boot.value?.today ?? '')
  open.value = true
}

async function submit() {
  busy.value = true
  try {
    const { followUpOn: _f, ...body } = formToBody(form.value)
    const res = await $fetch<{ id: string }>('/api/tasks', { method: 'POST', body })
    open.value = false
    toast.push(t('tasks.created'))
    await navigateTo(`${base.value}/aufgaben/${res.id}`)
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
  <template v-if="canEdit">
    <button type="button" class="btn primary" @click="start"><Icon name="plus" />{{ t('tasks.new') }}</button>
    <AppDialog :open="open" :title="t('tasks.new')" @close="open = false">
      <TaskForm v-if="open" v-model="form" :busy="busy" :submit-label="t('tasks.new')" @submit="submit" @cancel="open = false" />
    </AppDialog>
  </template>
</template>
