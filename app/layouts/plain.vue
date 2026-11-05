<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <div class="shell">
    <header class="top">
      <NuxtLink to="/" class="back"><Icon name="chevron-left" :size="14" />{{ t('settings.backHome') }}</NuxtLink>
      <div class="right">
        <AccountMenu />
      </div>
    </header>
    <main class="main">
      <slot />
    </main>
    <ToastHost />
    <ClientOnly>
      <StepUpDialog />
    </ClientOnly>
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

.back {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 13.5px;
  text-decoration: none;
}

.back:hover {
  color: var(--text);
}

.right {
  margin-left: auto;
}

.main {
  padding: 24px 32px;
  max-width: 1400px;
  margin: 0 auto;
}

@media (max-width: 720px) {
  .top {
    padding: 10px 16px;
  }

  .main {
    padding: 16px;
  }
}
</style>
