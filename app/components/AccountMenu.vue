<script setup lang="ts">
const { boot } = useBoot()
const { t } = useI18n()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const route = useRoute()

function onDoc(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
watch(open, o => (o ? document.addEventListener('mousedown', onDoc) : document.removeEventListener('mousedown', onDoc)))
watch(() => route.fullPath, () => (open.value = false))

const toast = useToast()
const { refresh } = useBoot()
const otherWorkspaces = computed(() => (boot.value?.workspaces ?? []).filter(w => w.id !== boot.value?.workspace.id))
async function switchTo(id: string) {
  try {
    await $fetch('/api/auth/workspace', { method: 'POST', body: { workspaceId: id } })
    await refresh()
    await navigateTo('/')
  }
  catch (err) {
    toast.error(err)
  }
}

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  boot.value = null
  await navigateTo('/login')
}
</script>

<template>
  <div ref="root" class="acc">
    <button type="button" class="acc-btn" :aria-label="t('account.menu', { name: boot?.user.name })" aria-haspopup="true" :aria-expanded="open" @click="open = !open">
      <span class="avatar">{{ boot?.user.initials }}</span>
    </button>
    <div v-if="open" class="menu" role="menu">
      <div class="who">
        <b class="ellipsis">{{ boot?.user.name }}</b>
        <span class="ellipsis dim">{{ boot?.user.email }}</span>
        <span class="ellipsis dim">{{ boot?.workspace.name }}<template v-if="boot?.workspace.demo"> ({{ t('account.demo') }})</template></span>
      </div>
      <button v-for="w in otherWorkspaces" :key="w.id" type="button" class="item" role="menuitem" @click="switchTo(w.id)"><Icon name="grid" /><span class="ellipsis">{{ t('account.switchTo', { name: w.name }) }}</span></button>
      <NuxtLink to="/einstellungen" class="item" role="menuitem"><Icon name="settings" />{{ t('account.settings') }}</NuxtLink>
      <ExtSlot name="account-menu" />
      <button type="button" class="item" role="menuitem" @click="logout"><Icon name="logout" />{{ t('account.logout') }}</button>
    </div>
  </div>
</template>

<style scoped>
.acc {
  position: relative;
}

.acc-btn {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0;
}

.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel2);
  border: 1px solid var(--line2);
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.menu {
  position: absolute;
  z-index: 50;
  right: 0;
  top: 48px;
  width: 240px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--line2);
  border-radius: 10px;
  box-shadow: var(--shadow);
}

.who {
  display: flex;
  flex-direction: column;
  padding: 8px 10px 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
  font-size: 13px;
}

.item,
.menu :deep(.item) {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-decoration: none;
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
}

.item:hover,
.menu :deep(.item:hover) {
  background: var(--panel2);
}
</style>
