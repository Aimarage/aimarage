<script setup lang="ts">
import type { TaskState } from '~~/shared/utils/task-state'

const props = defineProps<{ state: TaskState, next?: string | null, userId?: string | null, overdue?: boolean, preview?: boolean }>()
const { t } = useI18n()
const { boot, memberById } = useBoot()
const initials = computed(() => memberById(props.userId)?.initials ?? boot.value?.user.initials ?? '?')
const label = computed(() => [props.next && props.state !== 'done' ? t(`next.${props.next}`) : t(`state.${props.state}`), props.overdue ? t('state.overdue') : '', props.preview ? t('cal.preview') : ''].filter(Boolean).join(', '))
</script>

<template>
  <span class="tm" :class="[`s-${props.state}`, { late: props.overdue }]" :title="label" role="img" :aria-label="label">
    <svg v-if="props.state === 'ai'" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5v7l5.5-3.5z" fill="currentColor" /></svg>
    <svg v-else-if="props.state === 'done'" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8.3 7 10.8l4.6-5.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
    <template v-else>{{ initials }}</template>
  </span>
</template>

<style scoped>
.tm {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
}

.tm svg {
  width: 14px;
  height: 14px;
}

.s-ai {
  background: var(--primary);
  color: var(--on-primary);
}

.s-you {
  background: var(--text);
  color: var(--panel);
}

.s-done {
  background: var(--up);
  color: var(--panel);
}

.late {
  outline: 2px solid var(--down);
  outline-offset: 1px;
}
</style>
