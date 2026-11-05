<script setup lang="ts">
import { platformRule, postLength, textFor } from '~~/shared/utils/social'

const props = defineProps<{ platforms: string[], body: string, variants: Record<string, string> }>()
const { t } = useI18n()
const tab = ref('')
const shown = computed(() => (props.platforms.includes(tab.value) ? tab.value : props.platforms[0] ?? ''))
const text = computed(() => (shown.value ? textFor(shown.value, props.body, props.variants) : props.body))
function countOf(p: string) {
  const len = postLength(p, textFor(p, props.body, props.variants))
  return { len, max: platformRule(p).max, over: len > platformRule(p).max }
}
</script>

<template>
  <div class="vtabs" role="tablist" :aria-label="t('approvals.variants')">
    <button v-for="p in props.platforms" :key="p" type="button" role="tab" class="vtab" :aria-selected="shown === p" @click="tab = p">
      <PlatformMark :platform="p" :size="18" />
      <span class="vname">{{ platformRule(p).label }}</span>
      <span class="mono count" :class="{ over: countOf(p).over }">{{ countOf(p).len }}/{{ countOf(p).max }}</span>
    </button>
  </div>
  <p v-if="!props.variants?.[shown]?.trim()" class="hint note">{{ t('approvals.variantGeneral') }}</p>
  <div class="text" role="tabpanel">{{ text }}</div>
</template>

<style scoped>
.vtabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  scrollbar-width: none;
}

.vtab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 13.5px;
  white-space: nowrap;
  cursor: pointer;
}

.vtab[aria-selected='true'] {
  color: var(--text);
  border-bottom-color: var(--agent);
  font-weight: 500;
}

.count {
  font-size: 11.5px;
  color: var(--dim);
  font-weight: 400;
}

.count.over {
  color: var(--down);
}

.note {
  overflow-wrap: anywhere;
  margin: 0;
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
}

.text {
  padding: 20px;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.65;
  max-width: 72ch;
  overflow-wrap: anywhere;
}

@media (max-width: 600px) {
  .text {
    padding: 16px;
  }
}
</style>
