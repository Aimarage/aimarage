<script setup lang="ts">
import type { TodoView } from '~/composables/useTodo'

defineProps<{ view: TodoView, warn?: boolean, link?: string | null }>()
const { t } = useI18n()
</script>

<template>
  <section class="panel todo" :class="{ quiet: view.todo.main === 'none', warn }" :aria-label="t('todo.title')">
    <p class="todo-label">{{ t('todo.title') }}</p>
    <p class="todo-line">{{ view.line }}<template v-if="link"> <a :href="link" target="_blank" rel="noopener noreferrer" class="todo-link">{{ t('todo.done.view') }}</a></template></p>
    <p v-if="view.sub" class="todo-sub">{{ view.sub }}</p>
    <p v-if="view.flair" class="todo-flair">{{ view.flair }}</p>
    <slot />
  </section>
</template>

<style scoped>
.todo {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 20px;
  border-left: 3px solid var(--agent);
}

.todo.quiet {
  border-left-color: var(--line2);
}

.todo.warn {
  border-left-color: var(--warn);
}

.todo-label {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dim);
}

.todo-line {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.todo-link {
  font-weight: 500;
  white-space: nowrap;
}

.todo-sub {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.todo-flair {
  align-self: flex-start;
  margin: 2px 0 0;
  padding: 4px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--warn) 14%, var(--panel));
  font-size: 13.5px;
  font-weight: 600;
}

.todo :deep(.actionbar) {
  margin-top: 6px;
}

@media (max-width: 600px) {
  .todo {
    padding: 14px 16px;
  }
}
</style>
