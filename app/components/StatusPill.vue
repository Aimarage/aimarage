<script setup lang="ts">
const props = defineProps<{ status: string }>()
const { t } = useI18n()
</script>

<template>
  <span class="pill" :class="`s-${props.status}`">{{ t(`status.${props.status}`) }}</span>
</template>
