<script setup lang="ts">
import type { GoalItem } from './GoalList.vue'

const props = defineProps<{ projectId: string }>()
const { projectById } = useBoot()
const slug = computed(() => projectById(props.projectId)?.slug ?? null)
const { data } = useFetch<{ goals: GoalItem[] }>('/api/goals', { query: computed(() => ({ project: slug.value ?? undefined })), key: computed(() => `chatgoals:${props.projectId}`), immediate: !!slug.value, watch: [slug] })
</script>

<template>
  <div v-if="data?.goals.length" class="cg">
    <GoalList :goals="data.goals" :to="slug ? `/p/${slug}/strategie` : null" compact />
  </div>
</template>

<style scoped>
.cg {
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
}
</style>
