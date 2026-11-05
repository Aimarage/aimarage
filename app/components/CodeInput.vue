<script setup lang="ts">
const model = defineModel<string>({ default: '' })
const emit = defineEmits<{ complete: [code: string] }>()
const props = withDefaults(defineProps<{ length?: number, label?: string, disabled?: boolean }>(), { length: 6, label: 'Code', disabled: false })
const inputs = ref<HTMLInputElement[]>([])
const digits = computed(() => Array.from({ length: props.length }, (_, i) => model.value[i] ?? ''))

function commit(value: string) {
  const next = value.slice(0, props.length)
  model.value = next
  if (next.length === props.length && /^\d+$/.test(next)) emit('complete', next)
}

function setAt(i: number, v: string) {
  const arr = digits.value.slice()
  arr[i] = v
  commit(arr.join(''))
}

function onInput(i: number, e: Event) {
  const el = e.target as HTMLInputElement
  const v = el.value.replace(/\D/g, '')
  if (v.length > 1) {
    inputs.value[Math.min(props.length - 1, v.length)]?.focus()
    commit(v)
    return
  }
  setAt(i, v)
  el.value = v
  if (v && i < props.length - 1) inputs.value[i + 1]?.focus()
}

function onKey(i: number, e: KeyboardEvent) {
  if (e.key === 'Backspace' && !digits.value[i] && i > 0) inputs.value[i - 1]?.focus()
  if (e.key === 'ArrowLeft' && i > 0) inputs.value[i - 1]?.focus()
  if (e.key === 'ArrowRight' && i < props.length - 1) inputs.value[i + 1]?.focus()
}

function onPaste(e: ClipboardEvent) {
  const v = (e.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, props.length)
  if (!v) return
  e.preventDefault()
  inputs.value[Math.min(props.length - 1, v.length)]?.focus()
  commit(v)
}

defineExpose({ focus: () => inputs.value[0]?.focus() })
</script>

<template>
  <div class="code" role="group" :aria-label="label">
    <input
      v-for="(d, i) in digits"
      :key="i"
      :ref="el => { if (el) inputs[i] = el as HTMLInputElement }"
      :value="d"
      class="input"
      inputmode="numeric"
      :autocomplete="i === 0 ? 'one-time-code' : 'off'"
      maxlength="6"
      :disabled="disabled"
      :aria-label="`${label} ${i + 1}`"
      @input="onInput(i, $event)"
      @keydown="onKey(i, $event)"
      @paste="onPaste"
      @focus="($event.target as HTMLInputElement).select()"
    >
  </div>
</template>

<style scoped>
.code {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.code .input {
  min-height: 48px;
  padding: 0;
  text-align: center;
  font-size: 20px !important;
  font-family: var(--mono);
}
</style>
