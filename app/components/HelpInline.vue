<script setup lang="ts">
import type { HelpInline } from '~~/shared/utils/help'

defineProps<{ parts: HelpInline[] }>()
</script>

<template>
  <template v-for="(p, i) in parts" :key="i">
    <code v-if="p.t === 'code'">{{ p.v }}</code>
    <a v-else-if="p.t === 'link'" :href="p.href" rel="noopener">{{ p.v }}</a>
    <template v-else>{{ p.v }}</template>
  </template>
</template>
