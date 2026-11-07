<script setup lang="ts">
import { TASK_STATES } from '~~/shared/utils/task-state'

const props = defineProps<{ preview?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <span class="sl" role="list" :aria-label="t('state.legend')">
    <span v-for="s in TASK_STATES" :key="s" class="it" role="listitem"><TaskMark :state="s" />{{ t(`state.${s}`) }}</span>
    <span class="it" role="listitem"><span class="bar late" aria-hidden="true" />{{ t('state.overdue') }}</span>
    <span v-if="props.preview" class="it" role="listitem"><span class="bar dashed" aria-hidden="true" />{{ t('state.preview') }}</span>
  </span>
</template>

<style scoped>
.sl {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
}

.it {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.bar {
  flex: none;
  width: 16px;
  height: 12px;
  border-radius: 3px;
  background: var(--panel2);
}

.bar.late {
  box-shadow: inset 0 0 0 1.5px var(--down);
}

.bar.dashed {
  border: 1px dashed var(--line2);
  box-sizing: border-box;
}
</style>
