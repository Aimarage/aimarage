<script setup lang="ts">
const props = withDefaults(defineProps<{ color?: string | null, icon?: string | null, size?: number }>(), { size: 36 })
</script>

<template>
  <span v-if="props.color" class="mark" :style="{ width: `${props.size}px`, height: `${props.size}px`, background: `var(--c-${props.color})`, fontSize: `${Math.round(props.size * 0.36)}px`, borderRadius: `${Math.round(props.size / 4)}px` }">{{ props.icon }}</span>
  <span v-else class="mark all" :style="{ width: `${props.size}px`, height: `${props.size}px`, borderRadius: `${Math.round(props.size / 4)}px` }"><Icon name="grid" :size="Math.round(props.size / 2)" /></span>
</template>

<style scoped>
.mark {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--on-proj);
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1;
}

.mark.all {
  background: var(--panel2);
  box-shadow: inset 0 0 0 1px var(--line2);
  color: var(--text);
}
</style>
