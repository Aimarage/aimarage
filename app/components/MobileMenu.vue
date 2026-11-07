<script setup lang="ts">
import { ALL_SLUG } from '~~/shared/utils/domain'

const { boot, isAdmin } = useBoot()
const { project } = useScope()
const { t } = useI18n()
const route = useRoute()
const settingsNav = useSettingsNav()
const open = ref(false)
const btn = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)

function close(back = true) {
  if (!open.value) return
  open.value = false
  if (back) nextTick(() => btn.value?.focus())
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key !== 'Tab' || !panel.value) return
  const f = [...panel.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
  if (!f.length) return
  const first = f[0]!
  const last = f[f.length - 1]!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  }
  else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(open, (o) => {
  document.documentElement.classList.toggle('menu-open', o)
  if (o) {
    document.addEventListener('keydown', onKey)
    nextTick(() => panel.value?.querySelector<HTMLElement>('.mm-close')?.focus())
  }
  else {
    document.removeEventListener('keydown', onKey)
  }
})
watch(() => route.fullPath, () => close(false))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  document.documentElement.classList.remove('menu-open')
})

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  boot.value = null
  await navigateTo('/login')
}
</script>

<template>
  <button ref="btn" type="button" class="icon-btn mm-btn" :aria-label="t('nav.openMenu')" aria-haspopup="dialog" :aria-expanded="open" aria-controls="mobile-menu" @click="open = true">
    <Icon name="menu" :size="20" />
  </button>
  <Teleport to="body">
    <div v-if="open" class="mm-back" @click="close()" />
    <div v-if="open" id="mobile-menu" ref="panel" class="mm" role="dialog" aria-modal="true" :aria-label="t('nav.main')">
      <div class="mm-head">
        <b class="mm-brand"><AppLogo />Aimarage</b>
        <button type="button" class="icon-btn mm-close" :aria-label="t('nav.closeMenu')" @click="close()"><Icon name="x" :size="18" /></button>
      </div>
      <nav v-if="settingsNav.inSettings.value" class="mm-sec" :aria-label="t('settings.title')">
        <NuxtLink :to="settingsNav.back.value.to" class="mm-item"><Icon name="chevron-left" /><span class="grow ellipsis">{{ settingsNav.back.value.label }}</span></NuxtLink>
        <template v-for="g in settingsNav.groups.value" :key="g.id">
          <h2 class="mm-group">{{ g.label }}</h2>
          <NuxtLink v-for="item in g.items" :key="item.id" :to="item.to" class="mm-item" :aria-current="settingsNav.active.value?.id === item.id ? 'page' : undefined">
            <Icon :name="item.icon" /><span class="grow ellipsis">{{ item.label }}</span>
            <Icon v-if="settingsNav.active.value?.id === item.id" name="check" />
          </NuxtLink>
        </template>
      </nav>
      <nav v-else class="mm-sec" :aria-label="t('nav.projects')">
        <h2>{{ t('nav.projects') }}</h2>
        <NuxtLink :to="projectSectionPath(route.path, ALL_SLUG)" class="mm-item" :aria-current="!project ? 'page' : undefined">
          <ProjectMark :size="28" />
          <span class="grow ellipsis">{{ t('nav.allProjects') }}</span>
          <Icon v-if="!project" name="check" />
        </NuxtLink>
        <NuxtLink v-for="p in boot?.projects ?? []" :key="p.id" :to="projectSectionPath(route.path, p.slug)" class="mm-item" :aria-current="p.id === project?.id ? 'page' : undefined">
          <ProjectMark :color="p.color" :icon="p.icon" :size="28" />
          <span class="grow ellipsis">{{ p.name }}</span>
          <Icon v-if="p.id === project?.id" name="check" />
        </NuxtLink>
        <NuxtLink v-if="isAdmin" to="/projekte/neu" class="mm-item"><span class="plus"><Icon name="plus" /></span>{{ t('nav.newProject') }}</NuxtLink>
      </nav>
      <nav class="mm-sec mm-acc" :aria-label="t('nav.account')">
        <h2>{{ t('nav.account') }}</h2>
        <NuxtLink v-if="!settingsNav.inSettings.value" to="/einstellungen" class="item"><Icon name="settings" />{{ t('account.settings') }}</NuxtLink>
        <ExtSlot name="account-menu" />
        <NuxtLink to="/hilfe" class="item"><Icon name="help" />{{ t('nav.help') }}</NuxtLink>
        <button type="button" class="item" @click="logout"><Icon name="logout" />{{ t('account.logout') }}</button>
      </nav>
      <div class="mm-legal"><ExtSlot name="legal-links" /></div>
    </div>
  </Teleport>
</template>

<style scoped>
.mm-legal {
  padding: 4px 8px 0;
}

.mm-btn {
  display: none;
  margin-left: -8px;
  width: 44px;
  height: 44px;
}

@media (max-width: 900px) {
  .mm-btn {
    display: inline-grid;
  }
}

.mm-back {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: var(--overlay);
}

.mm {
  position: fixed;
  z-index: 91;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(320px, 86vw);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 12px calc(16px + env(safe-area-inset-bottom));
  background: var(--panel);
  border-right: 1px solid var(--line);
  box-shadow: var(--shadow);
}

.mm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 0 4px 0 8px;
  font-size: 18px;
  letter-spacing: -0.02em;
}

.mm-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mm-close {
  width: 44px;
  height: 44px;
}

.mm-sec {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
}

.mm-sec h2 {
  margin: 0 8px 6px;
  font-size: 13px;
  font-weight: var(--head-weight);
  font-style: italic;
  color: var(--muted);
}

.mm-sec .mm-group {
  margin: 10px 8px 4px;
}

.mm-item {
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

.mm-item:hover,
.mm-acc :deep(.item:hover) {
  background: var(--panel2);
}

.mm-item[aria-current='page'] {
  background: var(--marker);
  color: var(--on-marker);
  font-weight: 600;
}

.mm-acc :deep(.item) {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  text-decoration: none;
  font-size: 15px;
  text-align: left;
  cursor: pointer;
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
</style>
