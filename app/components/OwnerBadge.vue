<script setup lang="ts">
const props = defineProps<{ owner: 'agent' | 'human' | 'none', userId?: string | null, solid?: boolean }>()
const { memberById } = useBoot()
const { t } = useI18n()
const member = computed(() => memberById(props.userId))
const label = computed(() => (props.owner === 'agent' ? t('cal.owner.agent') : member.value?.name ?? t('cal.owner.none')))
</script>

<template>
  <span v-if="props.owner === 'agent'" class="ob agent" :title="label">{{ t('cal.owner.badge') }}</span>
  <span v-else-if="member" class="ob" :class="{ solid: props.solid }" :title="label">{{ member.initials }}</span>
</template>

<style scoped>
.ob {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--panel2);
  box-shadow: inset 0 0 0 1px var(--line2);
  color: var(--text);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
}

.ob.agent {
  background: var(--primary);
  box-shadow: none;
  color: var(--on-primary);
  font-size: 8.5px;
}

.ob.solid {
  background: rgba(255, 255, 255, 0.25);
  box-shadow: none;
  color: var(--on-proj);
}
</style>
