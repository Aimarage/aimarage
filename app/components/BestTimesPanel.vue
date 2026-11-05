<script setup lang="ts">
import { platformRule } from '~~/shared/utils/social'
import { reachRank } from '~~/shared/utils/platform-reach'

interface PlatformTimes { platform: string, posts: number, source: 'data' | 'default', days: number[], time: string }

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()

const { data } = await useFetch<{ platforms: PlatformTimes[], min: number }>(() => `/api/projects/${props.projectId}/best-times`, { key: `best-times:${props.projectId}` })
const list = computed(() => [...data.value?.platforms ?? []].sort((a, b) => b.posts - a.posts || reachRank(a.platform) - reachRank(b.platform)))
</script>

<template>
  <section v-if="data?.platforms.length" class="panel">
    <div class="panel-head"><h2>{{ t('bestTimes.title') }}</h2></div>
    <ul class="rows">
      <li v-for="p in list" :key="p.platform" class="line">
        <span class="name">{{ platformRule(p.platform).label }}</span>
        <span class="grow">{{ p.days.map(d => t(`days.short.${d}`)).join(', ') }} · <span class="mono">{{ p.time }}</span></span>
        <span class="dim small">{{ p.source === 'data' ? t('bestTimes.fromData', { n: p.posts }) : t('bestTimes.default', { n: p.posts, min: data.min }) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  font-size: 13.5px;
}

.name {
  flex: 0 0 110px;
  font-weight: 500;
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
}

.small {
  font-size: 12px;
}

@media (max-width: 600px) {
  .line {
    flex-wrap: wrap;
    gap: 2px 10px;
  }

  .small {
    flex: 1 1 100%;
  }
}
</style>
