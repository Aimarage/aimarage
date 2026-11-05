<script setup lang="ts">
export interface AutoStrategyNote { id: string, projectId: string | null, text: string, textEn: string, at: string }

const props = defineProps<{ items: AutoStrategyNote[] }>()
const emit = defineEmits<{ undone: [] }>()
const { t, locale } = useI18n()
const { canEdit } = useBoot()
const toast = useToast()
const busy = ref<string | null>(null)

async function undo(n: AutoStrategyNote) {
  busy.value = n.id
  try {
    await $fetch('/api/strategy/auto-undo', { method: 'POST', body: { id: n.id } })
    toast.push(t('dash.autoStrategyUndone'))
    emit('undone')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <section v-if="props.items.length" aria-labelledby="h-autostrat" class="panel">
    <div class="panel-head"><h2 id="h-autostrat">{{ t('dash.autoStrategyTitle') }}</h2></div>
    <ul class="as">
      <li v-for="n in props.items" :key="n.id">
        <span class="as-text">{{ locale === 'en' ? n.textEn : n.text }}</span>
        <button v-if="canEdit" type="button" class="btn small" :disabled="busy === n.id" @click="undo(n)">{{ t('dash.autoStrategyUndo') }}</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.as {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.as li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.as-text {
  flex: 1;
  min-width: 0;
  color: var(--text);
  font-size: 13px;
}
</style>
