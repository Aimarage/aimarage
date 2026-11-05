<script setup lang="ts">
const { t } = useI18n()
const { boot } = useBoot()
const toast = useToast()
const on = ref(!boot.value?.user.prefs.morningMailOff)

async function save() {
  try {
    await $fetch('/api/me', { method: 'PATCH', body: { prefs: { morningMailOff: !on.value } } })
    if (boot.value) boot.value.user.prefs = { ...boot.value.user.prefs, morningMailOff: !on.value }
    toast.push(t('settings.saved'))
  }
  catch (err) {
    on.value = !on.value
    toast.error(err)
  }
}
</script>

<template>
  <div class="panel-body stack morning">
    <label class="check"><input v-model="on" type="checkbox" @change="save"> {{ t('settings.morningMail') }}</label>
    <p class="hint">{{ t('settings.morningMailHint') }}</p>
  </div>
</template>

<style scoped>
.morning {
  border-top: 1px solid var(--line);
}
</style>
