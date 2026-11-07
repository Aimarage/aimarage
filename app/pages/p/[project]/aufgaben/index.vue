<script setup lang="ts">
import { CATEGORIES, type TaskStatus } from '~~/shared/utils/domain'
import type { TaskItem } from '~~/server/services/views'

const { t } = useI18n()
const { boot, canEdit } = useBoot()
const { project, isAll, base, query } = useScope()
const { dayDm, dayLong, dm } = useFormat()
const { projectColor, categoryColor } = useColors()
const toast = useToast()
const route = useRoute()
const router = useRouter()
useHead({ title: t('nav.tasks') })

type Scope = 'open' | 'today' | 'week' | 'overdue' | 'backlog' | 'done' | 'all'
const scopes: Scope[] = ['open', 'today', 'week', 'overdue', 'backlog', 'done', 'all']
const scope = ref<Scope>((scopes as string[]).includes(String(route.query.scope)) ? route.query.scope as Scope : 'open')
const category = ref(String(route.query.category ?? ''))
const assignee = ref(String(route.query.assignee ?? ''))
const q = ref(String(route.query.q ?? ''))
const view = ref<'list' | 'board'>(boot.value?.user.prefs.tasksView ?? 'list')

watch([scope, category, assignee, q], () => router.replace({ query: { ...(scope.value !== 'open' ? { scope: scope.value } : {}), ...(category.value ? { category: category.value } : {}), ...(assignee.value ? { assignee: assignee.value } : {}), ...(q.value ? { q: q.value } : {}) } }))

const effectiveScope = computed(() => (view.value === 'board' && scope.value === 'open' ? 'all' : scope.value))
const { data, refresh } = await useFetch<{ today: string, items: TaskItem[] }>('/api/tasks', {
  query: computed(() => ({ ...query.value, scope: effectiveScope.value, category: category.value || undefined, assignee: assignee.value || undefined, q: q.value || undefined })),
  key: computed(() => `tasks:${query.value.project ?? 'alle'}:${effectiveScope.value}:${category.value}:${assignee.value}:${q.value}`),
  default: () => ({ today: '', items: [] }),
})

async function setView(v: 'list' | 'board') {
  view.value = v
  await $fetch('/api/me', { method: 'PATCH', body: { prefs: { tasksView: v } } }).catch(() => {})
  if (boot.value) boot.value.user.prefs = { ...boot.value.user.prefs, tasksView: v }
}

const color = (it: TaskItem) => (isAll.value ? projectColor(it.projectId) : categoryColor(it.category))
const columns: TaskStatus[] = ['geplant', 'entwurf_fertig', 'freigegeben', 'wartet', 'erledigt']
const boardItems = computed(() => {
  const m = new Map<TaskStatus, TaskItem[]>(columns.map(c => [c, []]))
  for (const it of data.value.items) {
    const key = it.status === 'ausgewertet' ? 'erledigt' : it.status
    m.get(key)?.push(it)
  }
  return m
})

const dragging = ref<string | null>(null)
const over = ref<TaskStatus | null>(null)
async function dropTo(status: TaskStatus) {
  const id = dragging.value
  dragging.value = null
  over.value = null
  const it = data.value.items.find(i => i.id === id)
  if (!it || it.status === status) return
  try {
    await $fetch(`/api/tasks/${it.id}`, { method: 'PATCH', body: { status } })
    toast.push(t('tasks.statusChanged', { status: t(`status.${status}`) }))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

function due(it: TaskItem) {
  if (!it.dueDate) return t('tasks.noDate')
  return `${dayDm(it.dueDate)}${it.dueTime ? ` ${it.dueTime}` : ''}`
}
const groups = computed(() => {
  const out: { key: string, label: string, today: boolean, late?: boolean, items: TaskItem[] }[] = []
  const overdue = scope.value === 'overdue' ? [] : data.value.items.filter(i => i.overdue)
  if (overdue.length) out.push({ key: 'overdue', label: t('state.overdue'), today: false, late: true, items: overdue })
  for (const it of data.value.items) {
    if (overdue.includes(it)) continue
    const key = it.dueDate ?? 'none'
    let g = out[out.length - 1]
    if (!g || g.key !== key) {
      g = { key, label: it.dueDate ? `${it.dueDate === data.value.today ? `${t('cal.today')}, ` : ''}${dayLong(it.dueDate)} ${dm(it.dueDate)}` : t('tasks.noDate'), today: it.dueDate === data.value.today, items: [] }
      out.push(g)
    }
    g.items.push(it)
  }
  return out
})
</script>

<template>
  <div class="page wide">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('tasks.title') }}</h1>
      </div>
      <div class="actions">
        <div class="seg" role="group" :aria-label="t('cal.view')">
          <button type="button" :aria-pressed="view === 'list'" @click="setView('list')"><Icon name="list" :size="14" />&nbsp;{{ t('tasks.list') }}</button>
          <button type="button" :aria-pressed="view === 'board'" @click="setView('board')"><Icon name="board" :size="14" />&nbsp;{{ t('tasks.board') }}</button>
        </div>
        <ReleasePlanButton v-if="!isAll" @created="refresh()" />
        <TaskCreateButton />
      </div>
    </div>

    <div class="filters">
      <div class="scopes" role="tablist">
        <button v-for="s in scopes" :key="s" type="button" role="tab" class="scope" :aria-selected="scope === s" @click="scope = s">{{ t(`tasks.scope.${s}`) }}</button>
      </div>
      <div class="selects">
        <select v-model="category" class="select" :aria-label="t('tasks.filterCategory')">
          <option value="">{{ t('tasks.anyCategory') }}</option>
          <option v-for="c in CATEGORIES" :key="c" :value="c">{{ t(`cat.${c}`) }}</option>
        </select>
        <select v-model="assignee" class="select" :aria-label="t('tasks.filterAssignee')">
          <option value="">{{ t('tasks.filterAssignee') }}: {{ t('tasks.anyone') }}</option>
          <option value="agent">{{ t('tasks.agent') }}</option>
          <option value="me">{{ t('tasks.me') }}</option>
          <option v-for="m in (boot?.members ?? []).filter(m => m.id !== boot?.user.id)" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
        <label class="search"><Icon name="search" /><input v-model.lazy="q" class="input" type="search" :placeholder="t('tasks.search')" :aria-label="t('tasks.search')"></label>
      </div>
    </div>

    <section v-if="view === 'list'" class="panel">
      <div class="panel-head"><h2>{{ t(`tasks.scope.${scope}`) }}</h2><span class="count">{{ t('tasks.count', data.items.length) }}</span><StateLegend class="legend hide-m" /></div>
      <template v-if="data.items.length">
        <div v-for="g in groups" :key="g.key" class="grp">
          <div class="grp-head" :class="{ today: g.today, late: g.late }">{{ g.label }}<span v-if="g.late" class="late-n mono">{{ g.items.length }}</span></div>
          <ul class="rows">
            <li v-for="it in g.items" :key="it.id">
              <NuxtLink :to="`${base}/aufgaben/${it.id}`" class="row-link">
                <span class="sq" :style="{ background: color(it) }" />
                <span class="code mono hide-m">{{ it.code }}</span>
                <PlatformMark v-if="it.platform" :platform="it.platform" :size="16" :missing="it.noTarget" />
                <span v-else class="pm-gap" />
                <span class="row-title" :class="{ done: it.state === 'done' }">{{ it.title }}</span>
                <span class="row-meta due" :class="{ late: it.overdue }">{{ g.late && it.dueDate !== data.today ? dayDm(it.dueDate!) : it.dueTime ?? '' }}</span>
                <TaskMark :state="it.state" :next="it.next" :user-id="it.assigneeUserId" :overdue="it.overdue" />
                <StatusPill :status="it.status" class="hide-m st" />
                <span class="dim chev"><Icon name="chevron-right" /></span>
              </NuxtLink>
            </li>
          </ul>
        </div>
      </template>
      <p v-else class="empty">{{ t('tasks.empty') }}</p>
    </section>

    <div v-else class="board">
      <section v-for="c in columns" :key="c" class="col panel" :class="{ over: over === c }" @dragover.prevent="canEdit && (over = c)" @dragleave="over = null" @drop.prevent="dropTo(c)">
        <div class="col-head"><StatusPill :status="c" /><span class="count">{{ boardItems.get(c)!.length }}</span></div>
        <div class="cards">
          <NuxtLink v-for="it in boardItems.get(c)" :key="it.id" :to="`${base}/aufgaben/${it.id}`" class="card" :draggable="canEdit" @dragstart="dragging = it.id" @dragend="dragging = null">
            <span class="card-top"><span class="sq" :style="{ background: color(it) }" /><span class="mono dim small" :class="{ late: it.overdue }">{{ due(it) }}</span><PlatformMark v-if="it.platform" :platform="it.platform" :size="16" :missing="it.noTarget" /><TaskMark :state="it.state" :next="it.next" :user-id="it.assigneeUserId" :overdue="it.overdue" /></span>
            <span class="card-title">{{ it.title }}</span>
          </NuxtLink>
          <p v-if="!boardItems.get(c)!.length" class="hint drop">{{ t('tasks.dropHere') }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wide {
  max-width: 1320px;
  gap: 20px;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.scopes {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  max-width: 100%;
}

.scope {
  min-height: 36px;
  padding: 0 14px;
  border-radius: 3px;
  border: 0;
  background: transparent;
  color: var(--body);
  font-size: 15px;
  cursor: pointer;
  white-space: nowrap;
}

.scope[aria-selected='true'] {
  background: var(--marker);
  color: var(--on-marker);
  font-weight: 700;
}

.selects {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}

.selects .select {
  width: auto;
  min-width: 140px;
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 10px;
  border: 1px solid var(--line2);
  border-radius: 4px;
  background: var(--panel);
  color: var(--dim);
}

.search .input {
  border: 0;
  min-width: 140px;
  padding-left: 0;
}

.code {
  flex: none;
  width: 104px;
  font-size: 12px;
  color: var(--dim);
}

.done {
  color: var(--dim);
}

.grp-head {
  padding: 8px 16px;
  background: var(--panel2);
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
}

.grp:first-child .grp-head {
  border-top: 0;
}

.grp-head.today {
  color: var(--primary);
}

.grp-head.late {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--down);
  background: color-mix(in srgb, var(--down) 7%, var(--panel2));
}

.late-n {
  font-weight: 400;
}

.legend {
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);
}

.card-top .late {
  color: var(--down);
}

.due {
  min-width: 72px;
  text-align: right;
}

.due.late {
  color: var(--down);
}

.st {
  min-width: 108px;
  justify-content: center;
}

.chev {
  display: inline-flex;
}

/* Board */
.board {
  display: grid;
  grid-template-columns: repeat(5, minmax(200px, 1fr));
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
}

.col {
  display: flex;
  flex-direction: column;
  min-height: 200px;
  background: color-mix(in srgb, var(--panel) 55%, var(--bg));
}

.col.over {
  outline: 2px dashed var(--primary);
  outline-offset: -2px;
}

.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  cursor: grab;
}

.card:hover {
  border-color: var(--line2);
  color: var(--text);
}

.pm-gap {
  flex: none;
  width: 16px;
}

.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-top .small {
  flex: 1 1 auto;
  font-size: 11.5px;
}

.card-title {
  font-size: 13.5px;
  line-height: 1.35;
}

.drop {
  text-align: center;
  padding: 16px 0;
}

/* Handy */
@media (max-width: 600px) {
  .selects {
    margin-left: 0;
    width: 100%;
  }

  .selects .select,
  .search {
    flex: 1 1 140px;
  }

  .due {
    min-width: 0;
  }

  .board {
    grid-template-columns: repeat(5, minmax(240px, 82vw));
    scroll-snap-type: x mandatory;
  }

  .col {
    scroll-snap-align: start;
  }
}
</style>
