<script setup lang="ts">
interface Kpi {
  projectId: string
  key: string
  label: string
  value: number | null
  change: number | null
  series: (number | null)[]
}

const props = defineProps<{ kpis: Kpi[], day: string, all: boolean, to: string }>()
const { projectById } = useBoot()
const { dayDm, dayShort, num, pct } = useFormat()
const { t } = useI18n()

// Kacheln ohne eine einzige Zahl in den letzten 14 Tagen erst zeigen, wenn es Daten gibt.
const cards = computed(() => props.kpis.filter(k => k.series.some(v => v !== null)).map((k) => {
  const p = projectById(k.projectId)
  return { ...k, color: p ? `var(--c-${p.color})` : 'var(--primary)', title: props.all ? p?.name ?? k.label : k.label, sub: props.all ? (k.key === 'visitors' ? t('dash.visitorsYesterday') : `${k.label} ${t('dash.yesterday')}`) : t('dash.yesterday') }
}))
</script>

<template>
  <section v-if="cards.length" :aria-label="t('dash.kpis')" class="kpis" :class="{ four: cards.length > 3 }" :style="{ gridTemplateColumns: `repeat(${Math.max(cards.length, 1)}, minmax(0, 1fr))` }">
    <NuxtLink v-for="k in cards" :key="`${k.projectId}-${k.key}`" :to="props.to" class="kpi" :style="{ borderTopColor: k.color }">
      <div class="kpi-head">
        <span v-if="props.all" class="sq" :style="{ background: k.color }" />
        <strong class="ellipsis">{{ k.title }}</strong>
        <span class="date mono hide-m">{{ dayDm(props.day) }}</span>
      </div>
      <div class="kpimain">
        <div>
          <div class="num mono">{{ num(k.value) }}</div>
          <div class="sub hide-m">{{ k.value === null ? t('dash.noData') : k.sub }}</div>
        </div>
        <span v-if="k.change !== null" class="chg mono" :class="k.change >= 0 ? 'up' : 'down'" :title="t('dash.toDayBefore', { day: dayShort(props.day) })">{{ pct(k.change) }}</span>
        <Sparkline class="spark" :values="k.series" :color="k.color" />
      </div>
    </NuxtLink>
  </section>
</template>

<style scoped>
.kpis {
  display: grid;
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}

.kpi {
  background: var(--panel);
  padding: 22px 24px;
  min-width: 0;
  border-top: 2px solid var(--primary);
  color: var(--text);
  text-decoration: none;
}

.kpi:hover {
  background: color-mix(in srgb, var(--panel2) 60%, var(--panel));
  color: var(--text);
}

.kpi-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  font-size: 13px;
  color: var(--muted);
}

.kpi-head strong {
  color: var(--text);
  font-weight: 600;
}

.date {
  margin-left: auto;
  font-size: 11px;
  color: var(--dim);
}

.kpimain {
  display: flex;
  align-items: flex-end;
  gap: 14px;
}

.num {
  font-size: 44px;
  font-weight: var(--head-weight);
  line-height: 0.95;
  letter-spacing: var(--head-spacing);
}

.sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
  white-space: nowrap;
}

.chg {
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 4px 5px;
  border-radius: 3px;
}

.chg.up {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 12%, transparent);
}

.chg.down {
  color: var(--down);
  background: color-mix(in srgb, var(--down) 12%, transparent);
}

/* Handy */
@media (max-width: 900px) and (min-width: 601px) {
  .kpis {
    grid-template-columns: minmax(0, 1fr) !important;
  }
}

@media (max-width: 600px) {
  .kpis.four {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }

  .kpi {
    padding: 16px 14px;
  }

  .kpimain {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .num {
    font-size: 30px;
  }

  .spark {
    display: none;
  }
}
</style>
