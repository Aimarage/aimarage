<script setup lang="ts">
const { t } = useI18n()
const { base } = useScope()
const route = useRoute()
const id = computed(() => String(route.params.id))
useHead({ title: t('strategy.proposal') })
</script>

<template>
  <div class="page narrow">
    <div>
      <p class="crumbs"><NuxtLink :to="`${base}/freigaben`">{{ t('approvals.title') }}</NuxtLink> / {{ t('strategy.proposal') }}</p>
      <div class="page-head"><h1>{{ t('strategy.proposal') }}</h1></div>
      <p class="hint">{{ t('strategy.proposalHint') }}</p>
    </div>
    <StrategyCard :id="id" :embedded="true" />
    <p class="hint"><NuxtLink :to="`${base}/agent`">{{ t('strategy.discuss') }}</NuxtLink></p>
  </div>
</template>

<style scoped>
.narrow {
  max-width: 820px;
  gap: 20px;
}

.hint {
  margin: 8px 0 0;
}
</style>
