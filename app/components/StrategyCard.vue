<script setup lang="ts">
import type { StrategyChange, StrategyChannel } from '~~/server/db/schema'

export interface StrategyDetail {
  strategy: { id: string, version: number, status: 'vorschlag' | 'aktiv' | 'abgeloest' | 'verworfen', kind: string, summary: string | null, channels: StrategyChannel[], changes: StrategyChange[], byAgent: boolean, createdAt: string }
  current: StrategyChannel[] | null
  project: { id: string, slug: string, name: string, setupState: string, analysis: Record<string, unknown> | null }
  goals: { id: string, label: string, targetValue: number | null, deadline: string | null }[]
}

const props = withDefaults(defineProps<{ id: string, embedded?: boolean, editable?: boolean }>(), { embedded: true, editable: false })
const emit = defineEmits<{ decided: [{ action: 'approve' | 'reject', created: number, slug: string }] }>()
const { t } = useI18n()
const { canEdit, refresh: refreshBoot } = useBoot()
const toast = useToast()

const { data, refresh } = useFetch<StrategyDetail>(() => `/api/strategies/${props.id}`, { key: computed(() => `strategy:${props.id}`) })
const busy = ref(false)
const done = ref<{ action: 'approve' | 'reject', created: number, slug: string } | null>(null)
const edited = ref<StrategyChannel[] | null>(null)
const channels = computed<StrategyChannel[]>({
  get: () => edited.value ?? data.value?.strategy.channels ?? [],
  set: v => { edited.value = v },
})
watch(data, () => { edited.value = null })
const isInitial = computed(() => data.value?.strategy.kind === 'initial' || !data.value?.strategy.changes.length)
const dirty = computed(() => JSON.stringify(channels.value) !== JSON.stringify(data.value?.strategy.channels ?? []))

async function save() {
  await $fetch(`/api/strategies/${props.id}`, { method: 'PATCH', body: { channels: channels.value } })
}

async function act(action: 'approve' | 'reject') {
  busy.value = true
  try {
    if (action === 'approve' && dirty.value) await save()
    const r = await $fetch<{ created: number, slug: string }>(`/api/strategies/${props.id}/action`, { method: 'POST', body: { action } })
    done.value = { action, created: r.created, slug: r.slug }
    toast.push(action === 'approve' ? t('strategy.approved', { n: r.created }) : t('strategy.rejected'))
    await Promise.all([refresh(), refreshBoot()])
    emit('decided', done.value)
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const changeIcon = (c: StrategyChange['change']) => (c === 'more' ? 'up' : c === 'less' ? 'down' : c === 'pause' ? 'pause' : c === 'new' || c === 'resume' ? 'plus' : 'x')
</script>

<template>
  <div v-if="data" class="sc" :class="{ embedded: props.embedded }">
    <div class="sc-head">
      <span class="dot" />
      <b>{{ data.strategy.status === 'vorschlag' ? t('strategy.proposalFor', { name: data.project.name }) : t('strategy.strategyFor', { name: data.project.name }) }}</b>
      <span class="pill" :class="data.strategy.status === 'aktiv' ? 's-erledigt' : data.strategy.status === 'vorschlag' ? 's-entwurf_fertig' : 's-verworfen'">{{ t(`strategy.status.${data.strategy.status}`) }}</span>
    </div>
    <p v-if="data.strategy.summary" class="sum">{{ data.strategy.summary }}</p>
    <ul v-if="!isInitial" class="rows changes">
      <li v-for="c in data.strategy.changes" :key="c.channelKey + c.change" class="ch">
        <span class="ic" :class="c.change"><Icon :name="changeIcon(c.change)" :size="14" /></span>
        <span class="ellipsis nm"><b>{{ c.name }}</b> {{ t(`strategy.change.${c.change}`) }}</span>
        <span class="dim why ellipsis">{{ c.reason }}</span>
      </li>
    </ul>
    <StrategyRows v-else v-model:channels="channels" :goals="data.goals" :mode="props.editable && canEdit && data.strategy.status === 'vorschlag' ? 'edit' : 'view'" compact />
    <div v-if="done" class="done">
      <template v-if="done.action === 'approve'">{{ t('strategy.approved', { n: done.created }) }} <NuxtLink :to="`/p/${done.slug}/kalender`">{{ t('strategy.toCalendar') }}</NuxtLink></template>
      <template v-else>{{ t('strategy.rejected') }}</template>
    </div>
    <div v-else-if="canEdit && data.strategy.status === 'vorschlag'" class="acts">
      <button type="button" class="btn primary" :disabled="busy" @click="act('approve')"><Icon name="check" />{{ isInitial ? t('strategy.approvePlan') : t('strategy.accept') }}</button>
      <button v-if="props.editable && dirty" type="button" class="btn" :disabled="busy" @click="save().then(() => refresh())">{{ t('settings.save') }}</button>
      <button type="button" class="btn ghost danger" :disabled="busy" @click="act('reject')">{{ t('strategy.reject') }}</button>
    </div>
  </div>
</template>

<style scoped>
.sc {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sc.embedded {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  padding: 12px 0 14px;
}

.sc-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 0 16px;
  font-size: 13.5px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 4px var(--primary-soft);
}

.sum {
  margin: 0;
  padding: 0 16px;
  color: var(--muted);
  font-size: 13.5px;
}

.rows {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.ch {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 16px;
  font-size: 13.5px;
}

.ic {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: var(--panel2);
  color: var(--muted);
  flex: none;
}

.ic.more,
.ic.new,
.ic.resume {
  color: var(--up);
}

.ic.less,
.ic.pause,
.ic.remove {
  color: var(--warn);
}

.nm {
  flex: 0 1 auto;
}

.why {
  flex: 1 1 0;
  font-size: 12.5px;
}

.acts,
.done {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
}

.done {
  color: var(--up);
  font-size: 13.5px;
}

/* Handy */
@media (max-width: 600px) {
  .ch {
    flex-wrap: wrap;
    padding-top: 8px;
    padding-bottom: 8px;
  }

  .why {
    flex-basis: 100%;
    padding-left: 32px;
    white-space: normal;
  }
}
</style>
