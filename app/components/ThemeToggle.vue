<script setup lang="ts">
const { t } = useI18n()
const theme = useTheme()
onMounted(theme.init)
const label = computed(() => (theme.current.value === 'dark' ? t('theme.toLight') : t('theme.toDark')))
</script>

<template>
  <button type="button" class="mode" :aria-label="label" :title="label" @click="theme.toggle()">
    <svg v-if="theme.current.value === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></svg>
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" /></svg>
  </button>
</template>

<style scoped>
.mode {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
}

.mode:hover {
  border-color: var(--dim);
}

.mode svg {
  width: 19px;
  height: 19px;
}
</style>
