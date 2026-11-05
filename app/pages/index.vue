<script setup lang="ts">
import { ALL_SLUG } from '~~/shared/utils/domain'

const { boot, projectBySlug, isAdmin } = useBoot()
const last = useCookie('ma_project').value
const slug = last && (last === ALL_SLUG || projectBySlug(last)) ? last : ALL_SLUG
if (boot.value && !boot.value.projects.length && isAdmin.value) await navigateTo('/projekte/neu', { replace: true })
else if (boot.value) await navigateTo(`/p/${slug}`, { replace: true })
</script>

<template>
  <div />
</template>
