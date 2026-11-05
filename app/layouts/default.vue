<script setup lang="ts">
const { boot, refresh } = useBoot()
const { project, base } = useScope()
const { t } = useI18n()
const route = useRoute()
const chat = useChatPanel()
const settingsNav = useSettingsNav()

watch(() => route.path, () => { refresh() })

const approvals = computed(() => {
  const a = boot.value?.approvals ?? {}
  if (project.value) return a[project.value.id] ?? 0
  return Object.values(a).reduce((s, n) => s + n, 0)
})

const overdue = computed(() => {
  const o = boot.value?.overdue ?? {}
  if (project.value) return o[project.value.id] ?? 0
  return Object.values(o).reduce((s, n) => s + n, 0)
})

const nav = computed(() => [
  { to: base.value, icon: 'dashboard', label: t('nav.dashboard'), exact: true },
  { to: `${base.value}/agent`, icon: 'chat', label: t('nav.agentChat') },
  { to: `${base.value}/freigaben`, icon: 'approvals', label: t('nav.approvals'), count: approvals.value },
  { to: `${base.value}/kalender`, icon: 'calendar', label: t('nav.calendar') },
  { to: `${base.value}/aufgaben`, icon: 'tasks', label: t('nav.tasks'), count: overdue.value, late: true },
  { to: `${base.value}/strategie`, icon: 'target', label: t('nav.strategy') },
  { to: `${base.value}/unterlagen`, icon: 'doc', label: t('nav.files') },
  { to: `${base.value}/berichte`, icon: 'reports', label: t('nav.reports') },
  { to: `${base.value}/verlauf`, icon: 'history', label: t('nav.history') },
  { to: `${base.value}/konten`, icon: 'link', label: t('nav.accounts') },
])

const brand = computed(() => {
  const b = (boot.value?.extensions as { brand?: { name: string, logoUrl: string | null, inApp: boolean } | null } | undefined)?.brand
  return b?.inApp && b.logoUrl ? b : null
})

function active(item: { to: string, exact?: boolean }) {
  return item.exact ? route.path === item.to : route.path.startsWith(item.to)
}

const navEl = ref<HTMLElement | null>(null)
function showActive() {
  nextTick(() => {
    const nav = navEl.value
    const a = nav?.querySelector<HTMLElement>('.nav-item.active')
    if (!nav || !a || nav.scrollWidth <= nav.clientWidth) return
    nav.scrollLeft = a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2
  })
}
async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  boot.value = null
  await navigateTo('/login')
}

onMounted(showActive)
watch(() => route.path, showActive)
</script>

<template>
  <div class="shell">
    <header class="top pad">
      <MobileMenu />
      <NuxtLink v-if="brand" :to="base" class="brand">
        <img :src="brand.logoUrl!" :alt="brand.name" class="brand-logo">
      </NuxtLink>
      <NuxtLink v-else :to="base" class="brand">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect x="1" y="1" width="20" height="20" rx="5" fill="none" stroke="var(--line2)" /><path d="M5 15 L9 9 L12.5 12.5 L17 6" fill="none" stroke="var(--agent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /><circle cx="17" cy="6" r="1.8" fill="var(--agent)" /></svg>
        Aimarage
      </NuxtLink>
      <AgentLine class="agentline" />
      <div class="right">
        <GlobalSearch />
        <AccountMenu />
      </div>
    </header>
    <div class="body" :class="{ 'chat-n': chat.narrowOpen.value }">
      <aside v-if="settingsNav.inSettings.value" class="side">
        <NuxtLink :to="settingsNav.back.value.to" class="back"><Icon name="chevron-left" :size="14" /><span class="ellipsis">{{ settingsNav.back.value.label }}</span></NuxtLink>
        <nav ref="navEl" class="nav" :aria-label="t('settings.title')">
          <template v-for="g in settingsNav.groups.value" :key="g.id">
            <h2 class="group">{{ g.label }}</h2>
            <NuxtLink v-for="item in g.items" :key="item.id" :to="item.to" class="nav-item" :class="{ active: settingsNav.active.value?.id === item.id }" :aria-current="settingsNav.active.value?.id === item.id ? 'page' : undefined">
              <Icon :name="item.icon" />{{ item.label }}
            </NuxtLink>
          </template>
          <button type="button" class="nav-item logout" @click="logout"><Icon name="logout" />{{ t('account.logout') }}</button>
        </nav>
        <div class="legal"><ExtSlot name="legal-links" /></div>
      </aside>
      <aside v-else class="side">
        <ProjectSwitcher class="switcher" />
        <nav ref="navEl" class="nav" :aria-label="t('nav.main')">
          <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" class="nav-item" :class="{ active: active(item) }" :aria-current="active(item) ? 'page' : undefined">
            <Icon :name="item.icon" />{{ item.label }}<span v-if="item.count" class="badge" :class="{ late: item.late }" :title="item.late ? t('dash.overdueLine', item.count) : undefined">{{ item.count }}</span>
          </NuxtLink>
          <NuxtLink :to="`${base}/einstellungen`" class="nav-item settings" :class="{ active: route.path.startsWith(`${base}/einstellungen`) }" :aria-current="route.path.startsWith(`${base}/einstellungen`) ? 'page' : undefined">
            <Icon name="settings" />{{ t('nav.settings') }}
          </NuxtLink>
          <NuxtLink to="/hilfe" class="nav-item help" :class="{ active: route.path.startsWith('/hilfe') }" :aria-current="route.path.startsWith('/hilfe') ? 'page' : undefined">
            <Icon name="help" />{{ t('nav.help') }}
          </NuxtLink>
        </nav>
        <div class="legal"><ExtSlot name="legal-links" /></div>
      </aside>
      <main class="main pad">
        <ExtSlot name="banner" />
        <ChatTabs v-if="chat.onTask.value" class="tabs-n" />
        <slot />
      </main>
      <ChatDock />
    </div>
    <ToastHost />
    <ClientOnly>
      <PasskeyOffer />
      <StepUpDialog />
      <LimitDialog />
    </ClientOnly>
  </div>
</template>

<style scoped>
/* Kopfzeile */
.shell {
  min-height: 100vh;
  background: var(--main);
  color: var(--text);
}

.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 24px;
  padding: 12px 32px;
  border-bottom: 1px solid var(--line);
  background: var(--chrome);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-size: 15px;
  color: var(--text);
  text-decoration: none;
}

.brand-logo {
  display: block;
  max-height: 28px;
  max-width: 180px;
  object-fit: contain;
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

/* Seitenleiste */
.body {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
}

.side {
  flex: 0 0 240px;
  max-width: 240px;
  min-width: 0;
  padding: 20px 12px;
  border-right: 1px solid var(--line);
  align-self: stretch;
  background: var(--side);
}

.switcher {
  margin-bottom: 20px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 4px;
  color: var(--muted);
  font-size: 13.5px;
  text-decoration: none;
  white-space: nowrap;
}

.nav-item:hover {
  color: var(--text);
}

.nav-item.active {
  background: var(--panel2);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--agent);
}

.nav-item .badge {
  margin-left: auto;
}

.nav-item .badge.late {
  background: var(--down);
  color: var(--panel);
}

.nav-item.settings {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  border-radius: 0 0 4px 4px;
}

.back {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 12px;
  margin-bottom: 12px;
  color: var(--muted);
  font-size: 13px;
  text-decoration: none;
}

.back:hover {
  color: var(--text);
}

.group {
  margin: 14px 12px 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.group:first-child {
  margin-top: 0;
}

.nav-item.logout {
  margin-top: 12px;
  border: 0;
  border-top: 1px solid var(--line);
  border-radius: 0 0 4px 4px;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
}

.legal {
  margin-top: 16px;
  padding: 0 12px;
}

.main {
  flex: 999 1 560px;
  min-width: 0;
  padding: 44px 48px 72px;
}

/* Chat */
.tabs-n {
  display: none;
}

@media (min-width: 901px) {
  .body {
    flex-wrap: nowrap;
  }
}

@media (max-width: 1179px) {
  .tabs-n {
    display: flex;
    margin: -20px 0 20px;
  }

  .body.chat-n .main {
    display: none;
  }
}

/* Handy */
@media (max-width: 900px) {
  .side {
    flex: 1 1 100%;
    max-width: none;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    padding: 8px 16px;
  }

  .switcher {
    display: none;
  }

  .back {
    margin-bottom: 4px;
    padding: 0;
  }

  .group,
  .nav-item.logout,
  .legal {
    display: none;
  }

  .nav {
    position: relative;
    flex-direction: row;
    gap: 4px;
    margin: 0 -16px;
    padding: 0 16px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .nav::-webkit-scrollbar {
    display: none;
  }

  .nav-item {
    flex: none;
    width: auto;
    min-height: 36px;
    padding: 0 10px;
    gap: 8px;
  }

  .nav-item.settings {
    margin-top: 0;
    border-top: 0;
    border-radius: 4px;
  }

  .nav-item .badge {
    margin-left: 4px;
  }
}

@media (max-width: 600px) {
  .pad {
    padding-left: 16px;
    padding-right: 16px;
  }

  .main {
    padding-top: 28px;
  }

  .agentline {
    order: 3;
    flex: 1 1 100%;
  }
}
</style>
