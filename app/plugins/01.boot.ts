export default defineNuxtPlugin(async (nuxtApp) => {
  const { boot, loaded, refresh } = useBoot()
  if (!loaded.value) await refresh()
  const locale = boot.value?.user.locale
  const i18n = nuxtApp.$i18n as { locale: { value: string }, setLocale: (l: string) => Promise<void> }
  if (locale && i18n.locale.value !== locale) await i18n.setLocale(locale)
})
