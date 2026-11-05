<script setup lang="ts">
export interface GoalItem {
  id: string
  projectId: string | null
  label: string
  metricKey: string | null
  mode: 'sum' | 'last' | 'month'
  targetValue: number | null
  startDate: string | null
  deadline: string | null
  active: boolean
  note: string | null
  progress: { current: number, target: number, pct: number, expectedPct: number | null, state: 'done' | 'on_track' | 'behind' | 'open' }
}

const props = withDefaults(defineProps<{ goals: GoalItem[], showProject?: boolean, editable?: boolean, to?: string | null, compact?: boolean }>(), { showProject: false, editable: false, to: null, compact: false })
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const { projectColor } = useColors()
const { num, dm } = useFormat()
const { canEdit, boot, projectById } = useBoot()
const toast = useToast()

const open = ref<string | null>(null)
const form = ref({ value: '', day: '', label: '', target: '', deadline: '', mode: 'sum' as GoalItem['mode'] })
const busy = ref(false)

function toggle(g: GoalItem) {
  if (!props.editable) return
  if (open.value === g.id) {
    open.value = null
    return
  }
  form.value = { value: '', day: boot.value?.today ?? '', label: g.label, target: g.targetValue === null ? '' : String(g.targetValue), deadline: g.deadline ?? '', mode: g.mode }
  open.value = g.id
}

async function saveValue(g: GoalItem) {
  if (form.value.value === '') return
  busy.value = true
  try {
    await $fetch(`/api/goals/${g.id}/value`, { method: 'POST', body: { value: Number(form.value.value.replace(',', '.')), day: form.value.day || undefined } })
    form.value.value = ''
    toast.push(t('goals.saved'))
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

async function saveGoal(g: GoalItem, active?: boolean) {
  busy.value = true
  try {
    const f = form.value
    await $fetch(`/api/goals/${g.id}`, { method: 'PATCH', body: active === undefined ? { label: f.label, targetValue: f.target === '' ? null : Number(f.target.replace(',', '.')), deadline: f.deadline || null, mode: f.mode } : { active } })
    toast.push(t('goals.saved'))
    open.value = null
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const NuxtLink = resolveComponent('NuxtLink')
</script>

<template>
  <ul class="rows goals" :class="{ compact: props.compact }">
    <li v-for="g in props.goals" :key="g.id" :class="{ off: !g.active }">
      <component :is="props.editable ? 'button' : props.to ? NuxtLink : 'div'" :to="!props.editable && props.to ? props.to : undefined" :type="props.editable ? 'button' : undefined" class="gl" :class="{ click: props.editable || props.to }" :aria-expanded="props.editable ? open === g.id : undefined" @click="toggle(g)">
        <span v-if="props.showProject" class="sq" :style="{ background: projectColor(g.projectId) }" />
        <span class="lbl ellipsis"><template v-if="props.showProject && projectById(g.projectId)">{{ projectById(g.projectId)!.name }}: </template>{{ g.label }}</span>
        <span class="bar" :class="`st-${g.progress.state}`" role="progressbar" :aria-valuenow="g.progress.pct" aria-valuemin="0" aria-valuemax="100" :aria-label="g.label">
          <span class="fill" :style="{ width: `${g.progress.pct}%` }" />
          <span v-if="g.progress.expectedPct !== null && g.progress.expectedPct >= 3 && g.progress.state !== 'done'" class="exp" :style="{ left: `${g.progress.expectedPct}%` }" :title="t('goals.expected', { pct: g.progress.expectedPct })" />
        </span>
        <span class="val mono"><b>{{ num(g.progress.current) }}</b>/{{ g.targetValue === null ? '?' : num(g.targetValue) }}</span>
        <span v-if="!props.compact" class="dl mono hide-m">{{ g.deadline ? dm(g.deadline) : '' }}</span>
      </component>
      <div v-if="props.editable && open === g.id" class="edit">
        <form v-if="canEdit && g.metricKey" class="line" @submit.prevent="saveValue(g)">
          <label class="field"><span>{{ g.mode === 'last' ? t('goals.valueLast') : t('goals.valueSum') }}</span><input v-model="form.value" class="input mono" inputmode="decimal" required></label>
          <label class="field"><span>{{ t('goals.day') }}</span><input v-model="form.day" class="input" type="date"></label>
          <button type="submit" class="btn" :disabled="busy">{{ t('goals.record') }}</button>
        </form>
        <p class="hint">{{ t(`goals.modeHint.${g.mode}`) }}<template v-if="g.note"> - {{ g.note }}</template></p>
        <form v-if="canEdit" class="line" @submit.prevent="saveGoal(g)">
          <label class="field grow"><span>{{ t('goals.label') }}</span><input v-model="form.label" class="input" required maxlength="120"></label>
          <label class="field"><span>{{ t('goals.target') }}</span><input v-model="form.target" class="input mono" inputmode="decimal"></label>
          <label class="field"><span>{{ t('goals.deadline') }}</span><input v-model="form.deadline" class="input" type="date"></label>
          <label class="field"><span>{{ t('goals.mode') }}</span><select v-model="form.mode" class="select"><option value="sum">{{ t('goals.modes.sum') }}</option><option value="last">{{ t('goals.modes.last') }}</option><option value="month">{{ t('goals.modes.month') }}</option></select></label>
          <div class="acts">
            <button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button>
            <button type="button" class="btn ghost" :disabled="busy" @click="saveGoal(g, !g.active)">{{ g.active ? t('goals.archive') : t('goals.restore') }}</button>
          </div>
        </form>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.gl {
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
  text-decoration: none;
  font-size: 13.5px;
}

.gl.click {
  cursor: pointer;
}

.gl.click:hover {
  background: var(--panel2);
  color: var(--text);
}

.off .gl {
  opacity: 0.55;
}

.lbl {
  flex: 1 1 auto;
}

.bar {
  position: relative;
  flex: 0 0 120px;
  height: 6px;
  border-radius: 3px;
  background: var(--bg2);
  box-shadow: inset 0 0 0 1px var(--line);
}

.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: var(--agent);
}

.st-behind .fill {
  background: var(--warn);
}

.st-done .fill {
  background: var(--up);
}

.exp {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 12px;
  margin-left: -1px;
  background: var(--dim);
  border-radius: 1px;
}

.val {
  flex: none;
  min-width: 64px;
  text-align: right;
  font-size: 12px;
  color: var(--dim);
}

.val b {
  color: var(--text);
  font-weight: 500;
}

.dl {
  flex: none;
  min-width: 46px;
  text-align: right;
  font-size: 11.5px;
  color: var(--dim);
}

.edit {
  padding: 4px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--panel2);
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}

.line .field {
  flex: 0 1 150px;
}

.line .grow {
  flex: 1 1 220px;
}

.acts {
  display: flex;
  gap: 8px;
}

.hint {
  margin: 0;
}

.compact .bar {
  flex-basis: 64px;
}

.compact .gl {
  gap: 10px;
}

/* Handy */
@media (max-width: 600px) {
  .gl {
    gap: 10px;
  }

  .bar {
    flex-basis: 56px;
  }

  .line .field {
    flex: 1 1 130px;
  }
}
</style>
