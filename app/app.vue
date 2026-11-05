<script setup lang="ts">
const { locale } = useI18n()

useHead(() => ({
  htmlAttrs: { lang: locale.value },
  titleTemplate: (t?: string) => (t ? `${t} - Aimarage` : 'Aimarage'),
}))
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
