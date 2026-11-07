<script setup lang="ts">
const { t } = useI18n()
const { project } = useScope()
const { boot } = useBoot()
const route = useRoute()
const panel = useChatPanel()
const { onTask, open, task, mode, taskMode, narrowOpen } = panel
const live = ref(false)
const col = ref<HTMLElement | null>(null)
const gap = ref(0)
function measure() {
  gap.value = Math.max(0, Math.round(col.value?.parentElement?.getBoundingClientRect().top ?? 0))
}
const tk = computed(() => (live.value ? task.value : null))
const hidden = computed(() => route.path.includes('/agent') || route.path.startsWith('/projekte/neu') || !boot.value)

watch(() => task.value?.taskId, () => (narrowOpen.value = false))
watch(narrowOpen, (o) => {
  if (o) nextTick(() => col.value?.scrollIntoView({ block: 'start' }))
})
watch(() => route.path, () => {
  if (!onTask.value) narrowOpen.value = false
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && narrowOpen.value) narrowOpen.value = false
}
onMounted(() => {
  live.value = true
  measure()
  window.addEventListener('keydown', onKey)
  window.addEventListener('scroll', measure, { passive: true })
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', measure)
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <template v-if="!hidden">
    <button type="button" class="fab" :class="{ 'is-open': open, 'n-open': narrowOpen, 'has-task': onTask }" :aria-label="t('chat.open')" @click="panel.show()">
      <Icon name="chat" :size="20" /><span class="hide-m">{{ t('chat.ask') }}</span>
    </button>
    <aside ref="col" class="chatcol" :style="{ '--gap': `${gap}px` }" :class="{ 'is-open': open, 'n-open': narrowOpen }" :aria-label="t('chat.title')">
      <ChatTabs v-if="onTask" class="n-only tabs" />
      <div class="dh" :class="{ 'w-only': onTask }">
        <span class="dot" />
        <b>{{ t('chat.title') }}</b>
        <span v-if="taskMode" class="ctx ellipsis" :title="tk ? `${tk.code} ${tk.title}` : ''"><template v-if="tk"><span class="mono">{{ tk.code }}</span> {{ tk.title }}</template></span>
        <span v-else class="ctx dim ellipsis">{{ project?.name ?? t('nav.allProjects') }}</span>
        <button v-if="tk" type="button" class="switch" @click="mode = taskMode ? 'project' : 'task'">{{ taskMode ? t('chat.toProject') : t('chat.toTask', { code: tk.code }) }}</button>
        <button type="button" class="icon-btn close" :aria-label="t('chat.collapse')" :title="t('chat.collapse')" @click="panel.hide()"><Icon :name="narrowOpen && !onTask ? 'x' : 'chevron-right'" /></button>
      </div>
      <button v-if="tk" type="button" class="switch n-only n-switch" @click="mode = taskMode ? 'project' : 'task'">{{ taskMode ? t('chat.toProject') : t('chat.toTask', { code: tk.code }) }}</button>
      <template v-if="taskMode">
        <TaskTalk v-if="tk" :key="tk.taskId" :task-id="tk.taskId" />
      </template>
      <ChatView v-else :project="project?.slug ?? null" compact />
    </aside>
  </template>
</template>

<style scoped>
.fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 0 18px 0 16px;
  border: 0;
  border-radius: 24px;
  background: var(--btn);
  color: var(--on-btn);
  font-size: 14px;
  font-weight: 500;
  box-shadow: var(--shadow);
  cursor: pointer;
}

.fab:hover {
  filter: brightness(1.08);
}

.chatcol {
  display: none;
  flex-direction: column;
  min-width: 0;
  background: var(--panel);
}

.dh {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 56px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--line);
  font-size: 14px;
}

.ctx {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--muted);
}

.ctx .mono {
  color: var(--text);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 4px var(--primary-soft);
  flex: none;
}

.switch {
  flex: none;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}

.switch:hover {
  color: var(--text);
  border-color: var(--line2);
}

.close {
  margin-left: auto;
  flex: none;
}

.chatcol :deep(.chat) {
  flex: 1 1 auto;
  min-height: 0;
}

.n-only {
  display: none;
}

.tabs {
  margin: 12px 16px 0;
}

/* Breite Fenster */
@media (min-width: 1180px) {
  .chatcol.is-open {
    display: flex;
    flex: 0 0 400px;
    width: 400px;
    position: sticky;
    top: 0;
    height: calc(100vh - var(--gap, 0px));
    height: calc(100dvh - var(--gap, 0px));
    align-self: flex-start;
    border-left: 1px solid var(--line);
  }

  .fab.is-open {
    display: none;
  }
}

/* Schmale Fenster */
@media (max-width: 1179px) {
  .chatcol.n-open {
    display: flex;
    flex: 1 1 100%;
    height: 100dvh;
    min-height: 420px;
    padding: 0 0 8px;
  }

  .chatcol .w-only {
    display: none;
  }

  .n-only {
    display: flex;
  }

  .n-switch {
    align-self: flex-start;
    align-items: center;
    margin: 10px 16px 0;
  }

  .fab.n-open,
  .fab.has-task {
    display: none;
  }
}

/* Handy */
@media (max-width: 600px) {
  .fab {
    right: 16px;
    bottom: 16px;
    width: 52px;
    height: 52px;
    padding: 0;
    justify-content: center;
  }
}
</style>
