<script setup lang="ts">
const props = withDefaults(defineProps<{ values: (number | null)[], color: string, width?: number, height?: number }>(), { width: 128, height: 44 })

const geo = computed(() => {
  const vals = props.values.map(v => v ?? null)
  const nums = vals.filter((v): v is number => v !== null)
  if (nums.length < 2) return null
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min || 1
  const step = props.width / (vals.length - 1)
  const pts: [number, number][] = []
  vals.forEach((v, i) => {
    if (v === null) return
    pts.push([i * step, 5 + (1 - (v - min) / span) * (props.height - 8)])
  })
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  const avgY = 5 + (1 - (avg - min) / span) * (props.height - 8)
  const line = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]!
  return { line, area: `${pts[0]![0].toFixed(1)},${props.height} ${line} ${last[0].toFixed(1)},${props.height}`, avgY, last }
})
</script>

<template>
  <svg v-if="geo" :width="props.width" :height="props.height" :viewBox="`0 0 ${props.width} ${props.height}`" aria-hidden="true" class="spark">
    <line x1="0" :x2="props.width" :y1="geo.avgY" :y2="geo.avgY" stroke="var(--line2)" stroke-dasharray="2 3" />
    <polygon :points="geo.area" :fill="props.color" fill-opacity="0.1" />
    <polyline :points="geo.line" fill="none" :stroke="props.color" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    <circle :cx="geo.last[0]" :cy="geo.last[1]" r="2.8" :fill="props.color" />
  </svg>
</template>

<style scoped>
.spark {
  flex: none;
  margin-left: auto;
  overflow: visible;
}
</style>
