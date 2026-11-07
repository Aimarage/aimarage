<script setup lang="ts">
const { t } = useI18n()
const route = useRoute()
const lang = computed(() => (route.query.lang === 'en' ? 'en' : 'de'))
</script>

<template>
  <div class="shell">
    <header class="top">
      <NuxtLink :to="{ path: '/hilfe', query: lang === 'en' ? { lang: 'en' } : {} }" class="brand">
        <AppLogo />
        Aimarage
      </NuxtLink>
      <nav class="right" :aria-label="t('help.lang')">
        <NuxtLink :to="{ path: route.path, query: {} }" :aria-current="lang === 'de' ? 'true' : undefined" class="lang" hreflang="de">DE</NuxtLink>
        <NuxtLink :to="{ path: route.path, query: { lang: 'en' } }" :aria-current="lang === 'en' ? 'true' : undefined" class="lang" hreflang="en">EN</NuxtLink>
        <NuxtLink to="/login" class="btn">{{ t('help.login') }}</NuxtLink>
      </nav>
    </header>
    <main class="main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  background: var(--main);
  color: var(--text);
}

.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 32px;
  border-bottom: 1px solid var(--line);
  background: var(--chrome);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 15px;
  color: var(--text);
  text-decoration: none;
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

.lang {
  font-family: var(--meta);
  font-size: 12.5px;
  color: var(--dim);
  text-decoration: none;
}

.lang[aria-current] {
  color: var(--text);
}

.main {
  padding: 44px 32px 72px;
}

@media (max-width: 600px) {
  .top {
    padding: 10px 16px;
  }

  .main {
    padding: 28px 16px 56px;
  }
}
</style>
