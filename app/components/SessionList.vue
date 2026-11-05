<script setup lang="ts">
interface Session { id: string, method: string, userAgent: string, createdAt: string, lastSeenAt: string, current: boolean, client?: string, deviceName?: string }

const { t } = useI18n()
const { dateTime } = useFormat()
const { boot } = useBoot()
const toast = useToast()
const { data, refresh } = await useFetch<{ sessions: Session[] }>('/api/me/sessions', { key: 'my-sessions' })
const others = computed(() => (data.value?.sessions ?? []).filter(s => !s.current).length)
const all = ref(false)

interface Row { key: string, label: string, method: string, last: string, current: boolean, ids: string[] }
const rows = computed<Row[]>(() => {
  const list = data.value?.sessions ?? []
  const out: Row[] = []
  const byKey = new Map<string, Row>()
  for (const s of list) {
    const label = s.client === 'app' ? t('security.appDevice', { name: s.deviceName || 'iPhone' }) : device(s.userAgent)
    if (s.current) {
      out.unshift({ key: s.id, label, method: s.method, last: s.lastSeenAt, current: true, ids: [s.id] })
      continue
    }
    const key = `${label}|${s.method}`
    const row = byKey.get(key)
    if (row) {
      row.ids.push(s.id)
      if (s.lastSeenAt > row.last) row.last = s.lastSeenAt
      continue
    }
    const r = { key, label, method: s.method, last: s.lastSeenAt, current: false, ids: [s.id] }
    byKey.set(key, r)
    out.push(r)
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current) || b.last.localeCompare(a.last))
})
const shown = computed(() => (all.value ? rows.value : rows.value.slice(0, 3)))

function device(ua: string): string {
  if (!ua) return t('security.unknownDevice')
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  const browser = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : ''
  return [browser, os].filter(Boolean).join(' - ') || ua.slice(0, 40)
}

async function end(r: Row) {
  try {
    await Promise.all(r.ids.map(id => $fetch(`/api/me/sessions/${id}`, { method: 'DELETE' })))
    if (r.current) {
      boot.value = null
      await navigateTo('/login')
      return
    }
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

async function endOthers() {
  try {
    await $fetch('/api/me/sessions/others', { method: 'DELETE' })
    toast.push(t('security.othersEnded'))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}
</script>

<template>
  <div class="block">
    <h3>{{ t('security.sessions') }}</h3>
    <ul class="rows">
      <li v-for="r in shown" :key="r.key" class="line">
        <span class="grow">
          <span class="ellipsis">{{ r.label }}<b v-if="r.current" class="cur"> {{ t('security.thisDevice') }}</b></span>
          <span class="dim small"><template v-if="r.ids.length > 1">{{ t('security.grouped', { n: r.ids.length, method: t(`security.method.${r.method}`) }) }}</template><template v-else>{{ t(`security.method.${r.method}`) }}</template> - {{ t('security.lastSeen', { at: dateTime(r.last) }) }}</span>
        </span>
        <button type="button" class="btn small ghost" @click="end(r)">{{ r.ids.length > 1 ? t('security.signOutAll') : t('security.signOut') }}</button>
      </li>
    </ul>
    <button v-if="rows.length > 3" type="button" class="btn small ghost more" @click="all = !all">{{ all ? t('security.showLess') : t('security.showAll', { n: rows.length - 3 }) }}</button>
    <div v-if="others" class="form-actions">
      <button type="button" class="btn" @click="endOthers">{{ t('security.signOutOthers') }}</button>
    </div>
  </div>
</template>

<style scoped>
.block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.block h3 {
  font-size: 14px;
  font-weight: 600;
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.cur {
  font-weight: 500;
  color: var(--agent);
}

.small {
  font-size: 12px;
}

.more {
  align-self: flex-start;
}
</style>
