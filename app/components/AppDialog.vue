<script setup lang="ts">
const props = defineProps<{ open: boolean, title: string }>()
const emit = defineEmits<{ close: [] }>()
const el = ref<HTMLDialogElement | null>(null)
const { t } = useI18n()

watch(() => props.open, (o) => {
  if (!el.value) return
  if (o && !el.value.open) el.value.showModal()
  if (!o && el.value.open) el.value.close()
}, { flush: 'post' })
onMounted(() => {
  if (props.open) el.value?.showModal()
})
</script>

<template>
  <dialog ref="el" class="dlg" :aria-label="props.title" @close="emit('close')" @cancel.prevent="emit('close')">
    <div class="dlg-head">
      <h2>{{ props.title }}</h2>
      <button type="button" class="icon-btn" :aria-label="t('common.close')" @click="emit('close')"><Icon name="x" /></button>
    </div>
    <div class="dlg-body">
      <slot />
    </div>
  </dialog>
</template>

<style scoped>
.dlg {
  width: min(680px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  padding: 0;
  border: 1px solid var(--line2);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  box-shadow: var(--shadow);
}

.dlg::backdrop {
  background: var(--overlay);
}

.dlg-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px 12px 20px;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 1;
}

.dlg-head h2 {
  flex: 1 1 auto;
  font-size: 16px;
  font-weight: 600;
}

.dlg-body {
  padding: 20px;
}
</style>
