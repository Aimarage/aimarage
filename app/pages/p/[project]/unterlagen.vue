<script setup lang="ts">
const { t } = useI18n()
const { project } = useScope()
const route = useRoute()
const router = useRouter()
useHead({ title: t('docs.page') })

const tab = computed<'docs' | 'fundus'>(() => (route.query.tab === 'fundus' ? 'fundus' : 'docs'))
function setTab(v: 'docs' | 'fundus') {
  void router.replace({ query: { ...route.query, tab: v === 'docs' ? undefined : v } })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>{{ t('docs.page') }}</h1>
      <div v-if="project" class="seg actions" role="group" :aria-label="t('docs.page')">
        <button type="button" :aria-pressed="tab === 'docs'" @click="setTab('docs')">{{ t('docs.title') }}</button>
        <button type="button" :aria-pressed="tab === 'fundus'" @click="setTab('fundus')">{{ t('fundus.title') }}</button>
      </div>
    </div>
    <p v-if="!project" class="hint">{{ t('docs.pickProject') }}</p>
    <template v-else>
      <p class="hint intro">{{ tab === 'docs' ? t('docs.intro') : t('fundus.introPage') }}</p>
      <template v-if="tab === 'docs'">
        <ProjectDocuments :project-id="project.id" />
        <ProjectSitePages :project-id="project.id" />
      </template>
      <ProjectFundus v-else :project-id="project.id" />
    </template>
  </div>
</template>

<style scoped>
.intro {
  margin: -8px 0 0;
}
</style>
