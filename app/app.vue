<script setup lang="ts">
import { THEME_BOOT_SCRIPT, type BrandTheme } from '~~/shared/utils/brand-theme'

const { locale } = useI18n()
const { boot } = useBoot()

const brandStyle = computed(() => {
  const b = (boot.value?.extensions as { brand?: (BrandTheme & { inApp: boolean }) | null } | undefined)?.brand
  return b?.inApp ? brandThemeStyle(b) : ''
})

useHead(() => ({
  htmlAttrs: { lang: locale.value, ...(brandStyle.value ? { style: brandStyle.value } : {}) },
  titleTemplate: (t?: string) => (t ? `${t} - Aimarage` : 'Aimarage'),
}))

useHead({ script: [{ key: 'theme-boot', innerHTML: THEME_BOOT_SCRIPT, tagPosition: 'head' }] })
onMounted(() => useTheme().init())
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
