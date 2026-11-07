<script setup lang="ts">
const props = withDefaults(defineProps<{ accept: string, label: string, hint?: string, multiple?: boolean, disabled?: boolean, busy?: boolean }>(), { hint: '', multiple: true, disabled: false, busy: false })
const emit = defineEmits<{ files: [File[]] }>()
const over = ref(false)
const input = ref<HTMLInputElement | null>(null)

function pick(list: FileList | null | undefined) {
  const files = Array.from(list ?? [])
  if (files.length && !props.disabled) emit('files', props.multiple ? files : files.slice(0, 1))
  if (input.value) input.value.value = ''
}
function onDrop(e: DragEvent) {
  over.value = false
  pick(e.dataTransfer?.files)
}
</script>

<template>
  <label class="drop" :class="{ over, off: props.disabled }" @dragover.prevent="over = !props.disabled" @dragleave="over = false" @drop.prevent="onDrop">
    <Icon name="up" :size="18" />
    <span class="dl"><b>{{ props.busy ? '…' : props.label }}</b><span v-if="props.hint" class="dim">{{ props.hint }}</span></span>
    <input ref="input" type="file" :accept="props.accept" :multiple="props.multiple" :disabled="props.disabled || props.busy" hidden @change="pick(($event.target as HTMLInputElement).files)">
  </label>
</template>

<style scoped>
.drop {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 16px;
  border: 1px dashed var(--line2);
  border-radius: 4px;
  color: var(--muted);
  cursor: pointer;
}

.drop:hover,
.drop.over {
  border-color: var(--primary);
  color: var(--text);
  background: var(--panel2);
}

.drop.off {
  cursor: default;
  opacity: 0.6;
}

.dl {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13.5px;
}

.dl .dim {
  font-size: 12.5px;
}
</style>
