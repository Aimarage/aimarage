<script setup lang="ts">
import type { TodoView } from '~/composables/useTodo'

const props = defineProps<{ view: TodoView, warn?: boolean, link?: string | null }>()
const { t } = useI18n()
const label = computed(() => (props.view.todo.key.startsWith('done.') ? t('todo.done.title') : t('todo.title')))
</script>

<template>
  <section class="panel todo" :class="{ quiet: view.todo.main === 'none', warn }" :aria-label="label">
    <p class="todo-label">{{ label }}</p>
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
  padding: 18px 24px;
  background: var(--marker-soft);
  box-shadow: none;
}

.todo.quiet {
  background: var(--panel);
  box-shadow: var(--sheet);
}

.todo.warn {
  background: color-mix(in srgb, var(--warn) 12%, var(--panel));
}

.todo-label {
  margin: 0;
  font-size: 14px;
  font-style: italic;
  color: var(--muted);
}

.todo-line {
  margin: 0;
  font-size: 19px;
  font-weight: var(--head-weight);
  letter-spacing: var(--head-spacing);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.todo-link {
  font-weight: 500;
  white-space: nowrap;
}

.todo-sub {
  margin: 0;
  font-size: 14.5px;
  color: var(--body);
}

.todo-flair {
  align-self: flex-start;
  margin: 2px 0 0;
  padding: 4px 10px;
  border-radius: 3px;
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
