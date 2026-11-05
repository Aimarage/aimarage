<script setup lang="ts">
const { t } = useI18n()
const route = useRoute()
const { narrowOpen } = useChatPanel()
const mainLabel = computed(() => (route.path.includes('/freigaben/') ? t('chat.tabDraft') : t('chat.tabTask')))
</script>

<template>
  <div class="ctabs" role="tablist">
    <button type="button" role="tab" class="ctab" :aria-selected="!narrowOpen" @click="narrowOpen = false">{{ mainLabel }}</button>
    <button type="button" role="tab" class="ctab" :aria-selected="narrowOpen" @click="narrowOpen = true"><span class="dot" />{{ t('chat.title') }}</button>
  </div>
</template>

<style scoped>
.ctabs {
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel2);
}

.ctab {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  cursor: pointer;
}

.ctab[aria-selected='true'] {
  background: var(--panel);
  color: var(--text);
  font-weight: 500;
  box-shadow: 0 0 0 1px var(--line);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--agent);
}
</style>
