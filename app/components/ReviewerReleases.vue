<script setup lang="ts">
export interface ReviewerRelease { draftId: string, projectId: string | null, title: string, platform: string | null, releaseAt: string | null }

const props = defineProps<{ items: ReviewerRelease[] }>()
const emit = defineEmits<{ stopped: [] }>()
const { t } = useI18n()
const { dateTime } = useFormat()
const { canEdit, projectById } = useBoot()
const toast = useToast()
const busy = ref<string | null>(null)

const link = (r: ReviewerRelease) => `/p/${projectById(r.projectId)?.slug ?? 'alle'}/freigaben/${r.draftId}`

async function stop(r: ReviewerRelease) {
  busy.value = r.draftId
  try {
    await $fetch(`/api/drafts/${r.draftId}/stop`, { method: 'POST' })
    toast.push(t('approvals.stopped'))
    emit('stopped')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <section v-if="props.items.length" aria-labelledby="h-reviewer" class="panel">
    <div class="panel-head"><h2 id="h-reviewer">{{ t('dash.reviewerTitle') }}</h2></div>
    <ul class="rr">
      <li v-for="r in props.items" :key="r.draftId">
        <PlatformMark v-if="r.platform" :platform="r.platform" />
        <NuxtLink :to="link(r)" class="rr-title">{{ r.title }}</NuxtLink>
        <span v-if="r.releaseAt" class="rr-at mono">{{ dateTime(r.releaseAt) }}</span>
        <button v-if="canEdit" type="button" class="btn small" :disabled="busy === r.draftId" @click="stop(r)">{{ t('approvals.stop') }}</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.rr {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.rr li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.rr-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.rr-at {
  font-size: 12px;
  color: var(--dim);
}
</style>
