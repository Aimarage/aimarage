<script setup lang="ts">
import type { SlotName } from '~/utils/extensions'

const props = defineProps<{ name: SlotName }>()
const entries = computed(() => slotEntries(props.name))
</script>

<template>
  <component :is="e.component" v-for="e in entries" :key="e.id" />
</template>
