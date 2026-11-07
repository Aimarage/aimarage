<script setup lang="ts">
const { boot } = useBoot()
const { base } = useScope()
const { time } = useFormat()
const { t } = useI18n()
const a = computed(() => boot.value?.agent)
const text = computed(() => {
  if (!a.value) return ''
  if (!a.value.enabled) return t('agent.line.off')
  if (!a.value.configured) return t('agent.line.notConfigured')
  if (!a.value.lastRunAt) return t('agent.line.noRun')
  return ''
})
</script>

<template>
  <NuxtLink v-if="a" :to="a.configured || !a.enabled ? `${base}/agent/protokoll` : '/einstellungen/ki'" role="status" class="agentline" :aria-label="t('agent.line.open')">
    <span class="dot" :class="{ off: !a.ready }" />
    <span v-if="text" class="ellipsis">{{ text }}</span>
    <span v-else class="ellipsis">{{ t('agent.line.active') }} <b>{{ time(a.lastRunAt!) }}</b><template v-if="a.draftsToday"> - {{ t('agent.line.drafts', a.draftsToday) }}</template></span>
    <Icon name="chevron-right" />
  </NuxtLink>
</template>

<style scoped>
.agentline {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  min-width: 0;
  font-family: var(--meta);
  font-size: 14px;
  color: var(--muted);
  text-decoration: none;
}

.agentline b {
  color: var(--text);
  font-weight: 600;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 4px var(--primary-soft);
  flex: none;
}

.dot.off {
  background: var(--dim);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dim) 15%, transparent);
}
</style>
