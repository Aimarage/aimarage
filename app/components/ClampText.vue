<script setup lang="ts">
import { splitLinks } from '~~/shared/utils/url'

const props = withDefaults(defineProps<{ text: string, lines?: number, more?: string, less?: string }>(), { lines: 4, more: '', less: '' })
const { t } = useI18n()
const open = ref(false)
const box = ref<HTMLElement | null>(null)
const parts = computed(() => splitLinks(props.text))
const over = ref(props.text.split('\n').length > props.lines || props.text.length > props.lines * 70)

function measure() {
  const el = box.value
  if (!el || open.value) return
  over.value = el.scrollHeight > el.clientHeight + 2
}
let ro: ResizeObserver | undefined
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && box.value) {
    ro = new ResizeObserver(measure)
    ro.observe(box.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())
watch(() => props.text, () => {
  open.value = false
  nextTick(measure)
})
</script>

<template>
  <div class="clamp">
    <p ref="box" class="clamp-text" :class="{ cut: !open && over }" :style="{ '--lines': lines }"><template v-for="(part, i) in parts" :key="i"><a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.text }}</a><template v-else>{{ part.text }}</template></template></p>
    <button v-if="over" type="button" class="clamp-toggle" :aria-expanded="open" @click="open = !open">{{ open ? (less || t('common.showLess')) : (more || t('common.showMore')) }}</button>
  </div>
</template>

<style scoped>
.clamp-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.clamp-text.cut {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--lines);
  line-clamp: var(--lines);
  overflow: hidden;
  mask-image: linear-gradient(to bottom, #000 60%, transparent);
}

.clamp-text a {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.clamp-toggle {
  margin-top: 4px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.clamp-toggle:hover {
  color: var(--text);
}
</style>
