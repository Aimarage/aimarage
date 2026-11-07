<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 22 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true" class="app-logo"><rect x="2" y="2" width="20" height="20" rx="3" fill="var(--marker)" /><path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="var(--on-marker)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
</template>

<style scoped>
.app-logo {
  flex: none;
}
</style>
