<script setup lang="ts">
import type { StrategyChannel } from '~~/server/db/schema'
import { channelReach } from '~~/shared/utils/platform-reach'

export interface ChannelStat {
  planned: number
  done: number
  skipped: number
  rejected: number
  results: number
}

export interface ChannelDetail {
  next: { id: string, code: string, title: string, date: string | null, time: string | null, status: string, place: string | null }[]
  autonomy: string
  fixed: boolean
  outlet: string | null
}

const props = withDefaults(defineProps<{
  channels: StrategyChannel[]
  goals?: { id: string, label: string }[]
  stats?: Record<string, ChannelStat>
  details?: Record<string, ChannelDetail>
  base?: string
  mode?: 'view' | 'edit' | 'live'
  compact?: boolean
}>(), { goals: () => [], stats: () => ({}), details: () => ({}), base: '', mode: 'view', compact: false })
const emit = defineEmits<{ 'update:channels': [StrategyChannel[]], 'change': [{ key: string, weight?: number, active?: boolean }] }>()
const { t } = useI18n()
const open = ref<string | null>(null)

const goalLabel = (id: string) => props.goals.find(g => g.id === id)?.label ?? ''
const { dayDm } = useFormat()
function howText(c: StrategyChannel) {
  const d = props.details[c.key]
  if (d?.outlet && d.autonomy !== 'approve') return t('strategy.howAuto', { outlet: d.outlet })
  return t(`strategy.how.${c.category}`)
}

function setWeight(c: StrategyChannel, w: number) {
  if (props.mode === 'live') return emit('change', { key: c.key, weight: w })
  emit('update:channels', props.channels.map(x => (x.key === c.key ? { ...x, weight: w } : x)))
}
function setActive(c: StrategyChannel, active: boolean) {
  if (props.mode === 'live') return emit('change', { key: c.key, active })
  emit('update:channels', props.channels.map(x => (x.key === c.key ? { ...x, active } : x)))
}
function remove(c: StrategyChannel) {
  emit('update:channels', props.channels.filter(x => x.key !== c.key))
}
function toggleGoal(c: StrategyChannel, id: string) {
  const ids = c.goalIds.includes(id) ? c.goalIds.filter(g => g !== id) : [...c.goalIds, id]
  emit('update:channels', props.channels.map(x => (x.key === c.key ? { ...x, goalIds: ids } : x)))
}
function statLine(key: string) {
  const s = props.stats[key]
  if (!s || !s.planned) return ''
  return t('strategy.statLine', { done: s.done, planned: s.planned, results: s.results })
}
</script>

<template>
  <ul class="rows strat">
    <li v-for="c in props.channels" :key="c.key" :class="{ off: !c.active }">
      <button type="button" class="sr" :aria-expanded="open === c.key" @click="open = open === c.key ? null : c.key">
        <span class="sq" :style="{ background: `var(${CATEGORY_COLOR_VAR[c.category as keyof typeof CATEGORY_COLOR_VAR] ?? '--t-all'})` }" />
        <span class="nm ellipsis">{{ c.name }}</span>
        <span v-if="!props.compact && statLine(c.key)" class="st mono hide-m">{{ statLine(c.key) }}</span>
        <span v-if="channelReach(c)" class="reach">{{ t(`strategy.reach.${channelReach(c)}`) }}</span>
        <span v-if="!c.active" class="pill">{{ t('strategy.paused') }}</span>
        <span v-else class="dots" :title="t(`strategy.weights.${c.weight}`)" :aria-label="t(`strategy.weights.${c.weight}`)">
          <span v-for="i in 6" :key="i" class="d" :class="{ on: i <= c.weight }" />
        </span>
        <span class="dim chev"><Icon :name="open === c.key ? 'chevron-down' : 'chevron-right'" /></span>
      </button>
      <div v-if="open === c.key" class="more">
        <p class="why">{{ c.why || t('strategy.noWhy') }}</p>
        <div v-if="c.places?.length" class="places">
          <span v-for="pl in c.places" :key="pl" class="place">{{ pl }}</span>
        </div>
        <dl class="kv">
          <template v-if="c.topics?.length"><dt>{{ t('strategy.topics') }}</dt><dd><span v-for="(tp, i) in c.topics" :key="i" class="line">{{ tp }}</span></dd></template>
          <dt>{{ t('strategy.frequency') }}</dt><dd>{{ t(`cat.${c.category}`) }} - {{ t(`strategy.weights.${c.weight}`) }}</dd>
          <template v-if="c.goalIds.length && props.goals.length"><dt>{{ t('strategy.forGoals') }}</dt><dd>{{ c.goalIds.map(goalLabel).filter(Boolean).join(', ') }}</dd></template>
          <dt>{{ t('strategy.howTitle') }}</dt><dd>{{ howText(c) }}</dd>
          <template v-if="props.details[c.key]"><dt>{{ t('autonomy.title') }}</dt><dd>{{ props.details[c.key]!.fixed ? t('autonomy.fixed') : t(`autonomy.levels.${props.details[c.key]!.autonomy}`) }}</dd></template>
          <template v-if="props.mode !== 'edit'"><dt>{{ t('strategy.effect') }}</dt><dd>{{ statLine(c.key) || t('strategy.noEffectYet') }}</dd></template>
          <template v-if="props.details[c.key]?.next.length">
            <dt>{{ t('strategy.nextTasks') }}</dt>
            <dd class="next">
              <NuxtLink v-for="n in props.details[c.key]!.next" :key="n.id" :to="`${props.base}/aufgaben/${n.id}`" class="nx">
                <span class="mono dim">{{ n.date ? dayDm(n.date) : '' }}</span>
                <span class="ellipsis">{{ n.title }}</span>
              </NuxtLink>
            </dd>
          </template>
        </dl>
        <template v-if="props.mode !== 'view'">
          <div class="seg" role="group" :aria-label="t('strategy.frequency')">
            <button v-for="w in 6" :key="w" type="button" :aria-pressed="c.weight === w" @click="setWeight(c, w)">{{ t(`strategy.weightsShort.${w}`) }}</button>
          </div>
          <div v-if="props.mode === 'edit' && props.goals.length" class="goalpick">
            <span class="dim">{{ t('strategy.forGoals') }}:</span>
            <button v-for="g in props.goals" :key="g.id" type="button" class="chip" :aria-pressed="c.goalIds.includes(g.id)" @click="toggleGoal(c, g.id)">{{ g.label }}</button>
          </div>
          <div class="acts">
            <button type="button" class="btn small" @click="setActive(c, !c.active)"><Icon :name="c.active ? 'pause' : 'play'" :size="12" />{{ c.active ? t('strategy.pause') : t('strategy.resume') }}</button>
            <button v-if="props.mode === 'edit'" type="button" class="btn small ghost danger" @click="remove(c)"><Icon name="x" :size="12" />{{ t('strategy.remove') }}</button>
          </div>
        </template>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.sr {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 0 16px;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 13.5px;
  cursor: pointer;
}

.sr:hover {
  background: var(--panel2);
}

.off .nm {
  color: var(--dim);
  text-decoration: line-through;
}

.nm {
  flex: 1 1 auto;
}

.st {
  flex: none;
  font-size: 11.5px;
  color: var(--dim);
}

.dots {
  display: inline-flex;
  gap: 3px;
  flex: none;
}

.d {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line2);
}

.d.on {
  background: var(--primary);
}

.chev {
  display: inline-flex;
}

.more {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 16px 14px 36px;
}

.why {
  margin: 0;
  color: var(--muted);
}

.reach {
  flex-shrink: 0;
  color: var(--dim);
  font-size: 12px;
  white-space: nowrap;
}

.meta {
  margin: 0;
  font-size: 12.5px;
}

.seg {
  align-self: flex-start;
  flex-wrap: wrap;
}

.goalpick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.chip {
  height: 26px;
  padding: 0 10px;
  border-radius: 3px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.chip[aria-pressed='true'] {
  border-color: var(--marker);
  color: var(--on-marker);
  background: var(--marker);
  font-weight: 700;
}

.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.places {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.place {
  padding: 2px 9px;
  border-radius: 11px;
  background: var(--panel2);
  border: 1px solid var(--line);
  font-size: 12px;
}

.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 12.5px;
}

.kv dt {
  color: var(--dim);
}

.kv dd {
  margin: 0;
  min-width: 0;
}

.line {
  display: block;
}

.next {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nx {
  display: flex;
  gap: 8px;
  min-width: 0;
  color: var(--text);
  text-decoration: none;
}

.nx:hover {
  color: var(--primary);
}

.nx .mono {
  flex: none;
  min-width: 42px;
}

/* Handy */
@media (max-width: 600px) {
  .more {
    padding-left: 16px;
  }

  .kv {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .kv dd {
    margin-bottom: 6px;
  }
}
</style>
