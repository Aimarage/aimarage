<script setup lang="ts">
import type { StatusItem } from '~~/shared/utils/digest'

defineProps<{ items: StatusItem[] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="status-list">
    <li v-for="(it, i) in items" :key="i" :class="{ done: it.done }">
      <Icon v-if="it.done" name="check" :size="14" class="mark" :aria-label="t('common.stateDone')" />
      <span v-else class="ring" role="img" :aria-label="t('common.stateOpen')" />
      <span class="what">{{ it.text }}</span>
    </li>
  </ul>
</template>

<style scoped>
.status-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
  font-size: 14px;
}

.status-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.what {
  min-width: 0;
  overflow-wrap: anywhere;
}

.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--muted);
  border-radius: 50%;
  transform: translateY(1px);
}

.mark {
  flex: none;
  color: var(--up);
  transform: translateY(2px);
}

.done .what {
  color: var(--dim);
  text-decoration: line-through;
}
</style>
