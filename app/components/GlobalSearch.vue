<script setup lang="ts">
import type { SearchHit, SearchResult } from '~~/shared/utils/global-search'

const { t } = useI18n()
const route = useRoute()
const q = ref('')
const res = ref<SearchResult | null>(null)
const active = ref(-1)
const open = ref(false)
const expanded = ref(false)
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const isMac = ref(true)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

const groups = computed(() => {
  const r = res.value
  if (!r) return []
  return [
    { key: 'tasks', label: t('globalSearch.tasks'), items: r.tasks },
    { key: 'drafts', label: t('globalSearch.drafts'), items: r.drafts },
    { key: 'projects', label: t('globalSearch.projects'), items: r.projects },
  ].filter(g => g.items.length)
})
const flat = computed(() => groups.value.flatMap(g => g.items))
const indexOf = (hit: SearchHit) => flat.value.indexOf(hit)
const showList = computed(() => open.value && q.value.trim().length >= 2 && !!res.value)

async function load(text: string): Promise<SearchResult | null> {
  const n = ++seq
  try {
    const r = await $fetch<SearchResult>('/api/search', { query: { q: text } })
    if (n !== seq) return null
    res.value = r
    active.value = -1
    return r
  }
  catch {
    return null
  }
}

watch(q, (v) => {
  clearTimeout(timer)
  open.value = true
  if (v.trim().length < 2) {
    seq++
    res.value = null
    return
  }
  timer = setTimeout(() => load(v.trim()), 180)
})

function close() {
  open.value = false
  expanded.value = false
  active.value = -1
}

async function go(hit: SearchHit) {
  q.value = ''
  res.value = null
  close()
  input.value?.blur()
  await navigateTo(hit.to)
}

async function enter() {
  const text = q.value.trim()
  if (text.length < 2) return
  if (active.value >= 0 && flat.value[active.value]) return go(flat.value[active.value]!)
  clearTimeout(timer)
  const r = await load(text) ?? res.value
  const hit = r?.exact ?? (r && [...r.tasks, ...r.drafts, ...r.projects].length === 1 ? [...r.tasks, ...r.drafts, ...r.projects][0] : null)
  if (hit) go(hit)
}

function move(step: number) {
  if (!flat.value.length) return
  open.value = true
  active.value = (active.value + step + flat.value.length) % flat.value.length
}

function onEsc() {
  if (showList.value) open.value = false
  else {
    q.value = ''
    close()
    input.value?.blur()
  }
}

async function focus() {
  expanded.value = true
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    focus()
    return
  }
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
  const el = e.target as HTMLElement | null
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
  e.preventDefault()
  focus()
}

function onDoc(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) close()
}

onMounted(() => {
  isMac.value = /Mac|iPhone|iPad/.test(navigator.platform)
  window.addEventListener('keydown', onKey)
  document.addEventListener('mousedown', onDoc)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('mousedown', onDoc)
})
watch(() => route.fullPath, close)
</script>

<template>
  <div ref="root" class="gs" :class="{ expanded }">
    <button type="button" class="icon-btn gs-open" :aria-label="t('globalSearch.open')" @click="focus">
      <Icon name="search" />
    </button>
    <div class="gs-box">
      <Icon name="search" class="gs-icon" />
      <input
        ref="input"
        v-model="q"
        type="search"
        class="gs-input"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('globalSearch.placeholder')"
        :aria-label="t('globalSearch.label')"
        aria-controls="gs-list"
        :aria-expanded="showList"
        :aria-activedescendant="active >= 0 ? `gs-${active}` : undefined"
        @focus="open = true"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="enter"
        @keydown.esc.prevent="onEsc"
      >
      <kbd v-if="!q" class="gs-kbd">{{ isMac ? '⌘K' : 'Ctrl K' }}</kbd>
      <div v-if="showList" id="gs-list" class="gs-list" role="listbox">
        <p v-if="!flat.length" class="gs-empty">{{ t('globalSearch.none') }}</p>
        <div v-for="g in groups" :key="g.key" role="group" :aria-label="g.label">
          <div class="gs-group">{{ g.label }}</div>
          <NuxtLink
            v-for="hit in g.items"
            :id="`gs-${indexOf(hit)}`"
            :key="hit.id"
            :to="hit.to"
            class="gs-item"
            :class="{ on: indexOf(hit) === active }"
            role="option"
            :aria-selected="indexOf(hit) === active"
            @mouseenter="active = indexOf(hit)"
            @click.prevent="go(hit)"
          >
            <span class="ellipsis">{{ hit.label }}</span>
            <span v-if="hit.code" class="gs-code">{{ hit.code }}</span>
          </NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Suchfeld */
.gs {
  position: relative;
  min-width: 0;
}

.gs-open {
  display: none;
}

.gs-box {
  position: relative;
  width: 260px;
  max-width: 100%;
}

.gs-icon {
  position: absolute;
  left: 2px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--dim);
  pointer-events: none;
}

.gs-input {
  width: 100%;
  height: 36px;
  padding: 0 52px 0 28px;
  border: 0;
  border-bottom: 2px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--text);
  font-size: 15px;
  -webkit-appearance: none;
  appearance: none;
}

.gs-input::placeholder {
  color: var(--dim);
}

.gs-input::-webkit-search-cancel-button {
  display: none;
}

.gs-input:focus {
  outline: none;
  border-color: var(--text);
}

.gs-kbd {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 3px;
  font-family: var(--meta);
  font-size: 12px;
  color: var(--dim);
  pointer-events: none;
}

/* Treffer */
.gs-list {
  position: absolute;
  z-index: 60;
  top: 42px;
  right: 0;
  width: 420px;
  max-width: calc(100vw - 32px);
  max-height: 70vh;
  overflow-y: auto;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--line2);
  border-radius: 4px;
  box-shadow: var(--shadow);
}

.gs-group {
  padding: 8px 10px 4px;
  font-size: 13px;
  font-style: italic;
  color: var(--dim);
}

.gs-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: 4px;
  color: var(--text);
  font-size: 15px;
  text-decoration: none;
}

.gs-item > .ellipsis {
  flex: 1 1 auto;
  min-width: 0;
}

.gs-item.on {
  background: var(--panel2);
  color: var(--text);
}

.gs-code {
  flex: none;
  font-family: var(--meta);
  font-size: 12.5px;
  color: var(--dim);
}

.gs-empty {
  margin: 0;
  padding: 10px;
  font-size: 13px;
  color: var(--dim);
}

/* Handy */
@media (max-width: 600px) {
  .gs-open {
    display: inline-grid;
  }

  .gs-box {
    display: none;
  }

  .gs.expanded {
    position: static;
  }

  .gs.expanded .gs-open {
    display: none;
  }

  .gs.expanded .gs-box {
    display: block;
    position: absolute;
    z-index: 60;
    left: 16px;
    right: 16px;
    top: 16px;
    width: auto;
  }

  .gs.expanded .gs-icon {
    left: 12px;
    z-index: 1;
  }

  .gs.expanded .gs-input {
    height: 44px;
    padding: 0 12px 0 32px;
    background: var(--panel);
    border: 2px solid var(--text);
    border-radius: 4px;
  }

  .gs-kbd {
    display: none;
  }

  .gs-list {
    top: 50px;
    left: 0;
    width: auto;
  }
}
</style>
