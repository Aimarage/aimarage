<script setup lang="ts">
import { ALL_SLUG } from '~~/shared/utils/domain'

const { boot, isAdmin } = useBoot()
const { project } = useScope()
const { t } = useI18n()
const route = useRoute()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

function sectionPath(slug: string) {
  return projectSectionPath(route.path, slug)
}

function onDoc(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}
watch(open, (o) => {
  if (o) {
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
  }
  else {
    document.removeEventListener('mousedown', onDoc)
    document.removeEventListener('keydown', onKey)
  }
})
watch(() => route.fullPath, () => (open.value = false))
</script>

<template>
  <div ref="root" class="switch">
    <button type="button" class="switch-btn" aria-haspopup="true" :aria-expanded="open" :aria-label="t('nav.switchProject', { name: project?.name ?? t('nav.allProjects') })" @click="open = !open">
      <ProjectMark :color="project?.color" :icon="project?.icon" />
      <span class="what"><small>{{ t('nav.project') }}</small><span class="ellipsis name">{{ project?.name ?? t('nav.allProjects') }}</span></span>
      <Icon name="chevron-down" :size="18" class="chev" />
    </button>
    <div v-if="open" class="menu" role="menu">
      <NuxtLink :to="sectionPath(ALL_SLUG)" class="menu-item" role="menuitemradio" :aria-checked="!project">
        <ProjectMark :size="28" />
        <span class="grow ellipsis">{{ t('nav.allProjects') }}</span>
        <Icon v-if="!project" name="check" />
      </NuxtLink>
      <div class="sep" />
      <NuxtLink v-for="p in boot?.projects ?? []" :key="p.id" :to="sectionPath(p.slug)" class="menu-item" role="menuitemradio" :aria-checked="p.id === project?.id">
        <ProjectMark :color="p.color" :icon="p.icon" :size="28" />
        <span class="grow ellipsis">{{ p.name }}</span>
        <Icon v-if="p.id === project?.id" name="check" />
      </NuxtLink>
      <template v-if="isAdmin">
        <div class="sep" />
        <NuxtLink to="/projekte/neu" class="menu-item" role="menuitem"><span class="plus"><Icon name="plus" /></span>{{ t('nav.newProject') }}</NuxtLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
.switch {
  position: relative;
}

.switch-btn {
  width: 100%;
  min-height: 64px;
  padding: 10px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-radius: 0;
  border: 0;
  border-top: 1px solid var(--side-line);
  border-bottom: 1px solid var(--side-line);
  background: transparent;
  color: #ffffff;
  text-align: left;
  cursor: pointer;
}

.what {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.what small {
  font-size: 13px;
  font-style: italic;
  color: var(--side-dim);
}

.name {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.chev {
  color: var(--side-dim);
}

.switch-btn:hover .chev {
  color: #ffffff;
}

.menu {
  position: absolute;
  z-index: 40;
  top: 66px;
  left: 0;
  right: 0;
  min-width: 220px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--line2);
  border-radius: 4px;
  box-shadow: var(--shadow);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 8px;
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 15px;
}

.menu-item:hover {
  background: var(--panel2);
}

.grow {
  flex: 1 1 auto;
}

.plus {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  border: 1px dashed var(--line2);
  color: var(--muted);
}

.sep {
  height: 1px;
  margin: 4px 0;
  background: var(--line);
}
</style>
