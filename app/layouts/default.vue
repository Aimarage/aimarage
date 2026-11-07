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
const brandName = computed(() => {
  const b = (boot.value?.extensions as { brand?: { name: string, inApp: boolean } | null } | undefined)?.brand
  return b?.inApp && b.name ? b.name : 'Aimarage'
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
    <aside class="side">
      <div class="side-in">
        <NuxtLink :to="base" class="brand side-brand">
          <img v-if="brand" :src="brand.logoUrl!" :alt="brand.name" class="brand-logo">
          <template v-else><AppLogo />{{ brandName }}</template>
        </NuxtLink>
        <template v-if="settingsNav.inSettings.value">
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
        </template>
        <template v-else>
          <ProjectSwitcher class="switcher" />
          <nav ref="navEl" class="nav" :aria-label="t('nav.main')">
            <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" class="nav-item" :class="{ active: active(item) }" :aria-current="active(item) ? 'page' : undefined">
              <Icon :name="item.icon" />{{ item.label }}<span v-if="item.count" class="count-n" :class="{ late: item.late }" :title="item.late ? t('dash.overdueLine', item.count) : undefined">{{ item.count }}</span>
            </NuxtLink>
            <NuxtLink :to="`${base}/einstellungen`" class="nav-item settings" :class="{ active: route.path.startsWith(`${base}/einstellungen`) }" :aria-current="route.path.startsWith(`${base}/einstellungen`) ? 'page' : undefined">
              <Icon name="settings" />{{ t('nav.settings') }}
            </NuxtLink>
            <NuxtLink to="/hilfe" class="nav-item help" :class="{ active: route.path.startsWith('/hilfe') }" :aria-current="route.path.startsWith('/hilfe') ? 'page' : undefined">
              <Icon name="help" />{{ t('nav.help') }}
            </NuxtLink>
          </nav>
        </template>
        <div class="legal"><ExtSlot name="legal-links" /></div>
      </div>
    </aside>
    <div class="body" :class="{ 'chat-n': chat.narrowOpen.value }">
      <div class="col">
        <header class="top pad">
          <MobileMenu />
          <NuxtLink :to="base" class="brand top-brand">
            <img v-if="brand" :src="brand.logoUrl!" :alt="brand.name" class="brand-logo">
            <template v-else><AppLogo />{{ brandName }}</template>
          </NuxtLink>
          <AgentLine class="agentline" />
          <div class="right">
            <GlobalSearch />
            <ThemeToggle class="theme" />
            <AccountMenu />
          </div>
        </header>
        <main class="main pad">
          <ExtSlot name="banner" />
          <ChatTabs v-if="chat.onTask.value" class="tabs-n" />
          <slot />
        </main>
      </div>
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
/* Rahmen */
.shell {
  display: flex;
  min-height: 100vh;
  background: var(--main);
  color: var(--text);
}

.body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
}

.col {
  flex: 999 1 560px;
  min-width: 0;
}

/* Kopfzeile */
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 24px;
  padding: 22px 48px 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-size: 19px;
  color: var(--text);
  text-decoration: none;
}

.top-brand {
  display: none;
}

.brand-logo {
  display: block;
  max-height: 30px;
  max-width: 180px;
  object-fit: contain;
}

.agentline {
  flex: 1 1 auto;
  min-width: 0;
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  min-width: 0;
}

@media (min-width: 601px) {
  .top {
    flex-wrap: nowrap;
  }
}

/* Seitenleiste */
.side {
  flex: 0 0 232px;
  width: 232px;
  min-width: 0;
  background: var(--side);
  color: var(--side-text);
}

.side-in {
  position: sticky;
  top: 0;
  height: 100vh;
  height: 100dvh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 22px 16px 18px;
  scrollbar-width: thin;
}

.side-brand {
  color: #ffffff;
  padding: 0 10px 20px;
}

.switcher {
  margin-bottom: 14px;
}

.nav {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 40px;
  padding: 0 10px;
  border-radius: 4px;
  color: var(--side-text);
  font-size: 15.5px;
  text-decoration: none;
  white-space: normal;
  line-height: 1.25;
}

.nav-item :deep(svg) {
  opacity: 0.7;
}

.nav-item:hover {
  color: var(--side-hover);
}

.nav-item.active {
  background: var(--marker);
  color: var(--on-marker);
  font-weight: 600;
}

.nav-item.active :deep(svg) {
  opacity: 1;
}

.count-n {
  margin-left: auto;
  font-size: 13px;
  font-weight: 700;
  color: var(--marker);
}

.nav-item.active .count-n {
  color: var(--on-marker);
}

.count-n.late {
  padding: 0 6px;
  border-radius: 3px;
  background: var(--done);
  color: #ffffff;
}

.nav-item.settings {
  margin-top: auto;
}

.back {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 10px;
  margin-bottom: 8px;
  color: var(--side-dim);
  font-size: 14px;
  text-decoration: none;
}

.back:hover {
  color: var(--side-hover);
}

.group {
  margin: 16px 10px 4px;
  font-size: 13px;
  font-weight: 400;
  font-style: italic;
  color: var(--side-dim);
}

.group:first-child {
  margin-top: 0;
}

.nav-item.logout {
  margin-top: auto;
  border: 0;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 15.5px;
}

.legal {
  margin-top: 14px;
  padding: 12px 10px 0;
  border-top: 1px solid var(--side-line);
  font-size: 12.5px;
}

.legal :deep(a) {
  color: var(--side-dim);
}

.legal :deep(a:hover) {
  color: var(--side-hover);
}

.main {
  min-width: 0;
  padding: 36px 48px 72px;
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
  .shell {
    flex-direction: column;
  }

  .body,
  .col {
    display: contents;
  }

  .top {
    order: 0;
    padding-top: 10px;
    padding-bottom: 10px;
    background: var(--side);
    color: #ffffff;
  }

  .top-brand {
    display: flex;
    color: #ffffff;
  }

  .top :deep(.mm-btn),
  .top :deep(.gs-open),
  .top .theme {
    background: transparent;
    border-color: var(--side-line);
    color: var(--side-text);
  }

  .top :deep(.acc-btn) {
    color: var(--side-text);
  }

  .agentline {
    color: var(--side-text);
  }

  .top :deep(.gs-input) {
    color: #ffffff;
    border-color: var(--side-line);
  }

  .agentline :deep(b) {
    color: #ffffff;
  }

  .agentline :deep(.dot:not(.off)) {
    background: #6cc4a1;
  }

  .side {
    order: 1;
    flex: none;
    width: auto;
    padding: 0 16px 10px;
  }

  .side-in {
    display: contents;
  }

  .side-brand,
  .switcher,
  .group,
  .nav-item.logout,
  .legal {
    display: none;
  }

  .back {
    margin-bottom: 4px;
    padding: 0;
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
    font-size: 15px;
    white-space: nowrap;
  }

  .nav-item.settings {
    margin-top: 0;
  }

  .count-n {
    margin-left: 4px;
  }

  .main {
    order: 2;
  }

  .body > :deep(.chatcol) {
    order: 3;
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
