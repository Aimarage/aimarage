<script setup lang="ts">
const { t } = useI18n()
const { project, base } = useScope()
useHead({ title: t('chat.title') })
</script>

<template>
  <div class="page chatpage">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('chat.title') }}</h1>
      </div>
      <div class="actions"><NuxtLink :to="`${base}/agent/protokoll`" class="btn ghost small">{{ t('agent.protocol') }}<Icon name="chevron-right" :size="12" /></NuxtLink></div>
    </div>
    <section class="panel box">
      <ChatView :project="project?.slug ?? null" />
    </section>
  </div>
</template>

<style scoped>
.chatpage {
  gap: 20px;
  max-width: 880px;
}

.box {
  height: calc(100vh - 230px);
  min-height: 460px;
  overflow: hidden;
}

/* Handy */
@media (max-width: 900px) {
  .box {
    height: calc(100dvh - 250px);
    min-height: 420px;
  }
}
</style>
