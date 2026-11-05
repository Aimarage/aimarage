<script setup lang="ts">
const { t, te } = useI18n()
const limit = useLimit()
const social = computed(() => limit.kind.value === 'socialAccounts' || limit.kind.value === 'servicesEurMonth')
const text = computed(() => {
  const k = `limit.kinds.${limit.kind.value}`
  return te(k) ? t(k) : t('limit.kinds.other')
})
</script>

<template>
  <AppDialog v-if="limit.kind.value" :open="!!limit.kind.value" :title="t('limit.title')" @close="limit.close()">
    <div class="lim">
      <p>{{ text }}</p>
      <div class="lim-actions">
        <NuxtLink v-if="social" to="/abo#zusatzkonten" class="btn primary" @click="limit.close()">{{ t('limit.extraAccount') }}</NuxtLink>
        <NuxtLink to="/abo" class="btn" :class="{ primary: !social }" @click="limit.close()">{{ t('limit.plan') }}</NuxtLink>
        <button type="button" class="btn" @click="limit.close()">{{ t('common.close') }}</button>
      </div>
    </div>
  </AppDialog>
</template>

<style scoped>
.lim {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.lim p {
  margin: 0;
  color: var(--muted);
  line-height: 1.5;
}

.lim-actions {
  display: flex;
  gap: 8px;
}
</style>
