<script setup lang="ts">
import type { TaskItem } from '~~/server/services/views'
import type { AccessProblem } from '~~/shared/utils/access'

const props = withDefaults(defineProps<{ items: TaskItem[], today: string, base: string, access?: AccessProblem[] }>(), { access: () => [] })
const emit = defineEmits<{ done: [string, HTMLInputElement] }>()
const { t } = useI18n()
const { projectColor } = useColors()
const { dayShort, minutes } = useFormat()
const { canEdit } = useBoot()

function meta(it: TaskItem) {
  if (it.overdue) return { text: it.dueDate! < props.today ? dayShort(it.dueDate!) : it.dueTime ?? '', cls: 'late', title: t('state.overdue') }
  if (it.agentBusy) return { text: t('dash.running'), cls: '', title: '' }
  if (it.owner === 'agent') return { text: it.dueTime ?? '', cls: '', title: '' }
  const m = it.humanMin ?? it.estimateMin
  return { text: m ? minutes(m) : it.dueTime ?? '', cls: '', title: '' }
}

const mine = computed(() => props.items.filter(it => !it.forClaude))
const claude = computed(() => props.items.filter(it => it.forClaude))
</script>

<template>
  <section aria-labelledby="h-today" class="panel">
    <div class="panel-head"><h2 id="h-today">{{ t('dash.today') }}</h2><span class="count">{{ mine.length + props.access.length }}</span></div>
    <ul v-if="props.access.length" class="rows">
      <li v-for="a in props.access" :key="a.key" class="tl acc">
        <NuxtLink :to="a.path" class="row-link" :title="a.message">
          <span class="row-title">{{ t('dash.accessTitle', { what: a.what, project: a.projectName ? ` (${a.projectName})` : '' }) }}<small class="acc-msg">{{ a.message }}</small></span>
          <span class="row-meta m late">{{ minutes(a.min) }}</span>
          <span class="dim chev"><Icon name="chevron-right" /></span>
        </NuxtLink>
      </li>
    </ul>
    <ul v-if="mine.length" class="rows">
      <li v-for="it in mine" :key="it.id" class="tl">
        <input type="checkbox" :aria-label="t('dash.markDone', { title: it.title })" :disabled="!canEdit" class="chk" @change="emit('done', it.id, $event.target as HTMLInputElement)">
        <NuxtLink :to="`${props.base}/aufgaben/${it.id}`" class="row-link">
          <span class="sq" :style="{ background: projectColor(it.projectId) }" />
          <span class="row-title">{{ it.title }}</span>
          <TaskMark :state="it.state" :next="it.next" :user-id="it.assigneeUserId" :overdue="it.overdue" />
          <span class="row-meta m" :class="meta(it).cls" :title="meta(it).title">{{ meta(it).text }}</span>
          <span class="dim chev"><Icon name="chevron-right" /></span>
        </NuxtLink>
      </li>
    </ul>
    <p v-else-if="!props.access.length" class="empty">{{ t('dash.todayEmpty') }}</p>
    <template v-if="claude.length">
      <div class="panel-head sub"><h3>{{ t('dash.forClaude') }}</h3><span class="count">{{ claude.length }}</span></div>
      <p class="claude-hint">{{ t('dash.forClaudeHint') }}</p>
      <ul class="rows">
        <li v-for="it in claude" :key="it.id" class="tl">
          <NuxtLink :to="`${props.base}/aufgaben/${it.id}`" class="row-link">
            <span class="sq" :style="{ background: projectColor(it.projectId) }" />
            <span class="row-title">{{ it.title }}</span>
            <span class="dim chev"><Icon name="chevron-right" /></span>
          </NuxtLink>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.tl {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 16px;
}

.chk {
  width: 18px;
  height: 18px;
  margin: 0 6px 0 0;
  accent-color: var(--up);
  flex: none;
}

.row-link {
  padding-left: 0;
}

.m {
  min-width: 48px;
  text-align: right;
}

.m.late {
  color: var(--down);
}

.chev {
  display: inline-flex;
}

.sub {
  border-top: 1px solid var(--line);
}

.sub h3 {
  margin: 0;
  font-size: 13px;
  font-weight: var(--head-weight);
}

.acc .row-title {
  display: flex;
  flex-direction: column;
  color: var(--down);
}

.acc-msg {
  color: var(--dim);
  font-size: 12.5px;
}

.claude-hint {
  margin: 0;
  padding: 0 16px 6px;
  color: var(--dim);
  font-size: 12.5px;
}
</style>
