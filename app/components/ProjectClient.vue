<script setup lang="ts">
interface ClientLink { id: string, label: string, hint: string, canReport: boolean, createdAt: string, expiresAt: string | null, expired: boolean, lastUsedAt: string | null }
interface Feedback { id: string, taskId: string, draftId: string, code: string, title: string, client: string | null, verdict: 'ok' | 'change', comment: string | null, approved: boolean, createdAt: string }

const props = defineProps<{ projectId: string, admin: boolean, owner: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const { dateTime, dm, isoDay } = useFormat()
const { base } = useScope()
const toast = useToast()

const { data, refresh } = await useFetch<{ links: ClientLink[], feedback: Feedback[], okApproves: boolean }>(() => `/api/projects/${props.projectId}/client-links`, { key: `client-links-${props.projectId}`, immediate: props.admin })
const form = ref({ label: '', days: 0, canReport: false, sendTo: '' })
const fresh = ref<string | null>(null)
const busy = ref(false)

async function run(fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
    await refresh()
    emit('changed')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
function create() {
  return run(async () => {
    const sendTo = form.value.sendTo.trim() || null
    const r = await $fetch<{ url: string, mailed?: boolean }>(`/api/projects/${props.projectId}/client-links`, { method: 'POST', body: { label: form.value.label.trim() || null, days: form.value.days || null, canReport: form.value.canReport, sendTo } })
    fresh.value = r.url
    if (sendTo) toast.push(r.mailed ? t('client.admin.mailed', { to: sendTo }) : t('client.admin.mailFailed'), r.mailed ? 'ok' : 'error')
    form.value = { label: '', days: 0, canReport: false, sendTo: '' }
  })
}
async function copy() {
  if (!fresh.value) return
  try {
    await navigator.clipboard.writeText(fresh.value)
    toast.push(t('client.admin.copied'))
  }
  catch (err) {
    toast.error(err)
  }
}
function revoke(l: ClientLink) {
  if (!confirm(t('client.admin.revokeConfirm', { label: l.label }))) return
  return run(async () => {
    await $fetch(`/api/projects/${props.projectId}/client-links`, { method: 'DELETE', query: { id: l.id } })
  })
}
function setOk(v: boolean) {
  return run(async () => {
    await $fetch(`/api/projects/${props.projectId}/client-settings`, { method: 'PUT', body: { okApproves: v } })
  })
}
const day = (iso: string) => dm(isoDay(iso))
</script>

<template>
  <div class="client">
    <p class="hint">{{ t('client.admin.help') }}</p>
    <template v-if="admin && data">
      <ul v-if="data.links.length" class="list">
        <li v-for="l in data.links" :key="l.id" class="line">
          <span class="ellipsis grow">{{ l.label }} <span class="mono dim">...{{ l.hint }}</span></span>
          <span v-if="l.canReport" class="dim hide-m">{{ t('client.admin.report') }}</span>
          <span v-if="l.expired" class="bad">{{ t('client.admin.expired') }}</span>
          <span v-else-if="l.expiresAt" class="dim">{{ t('client.admin.until', { date: day(l.expiresAt) }) }}</span>
          <span class="dim hide-m">{{ l.lastUsedAt ? t('client.admin.used', { at: dateTime(l.lastUsedAt) }) : t('client.admin.unused') }}</span>
          <button type="button" class="btn small" :disabled="busy" @click="revoke(l)">{{ t('client.admin.revoke') }}</button>
        </li>
      </ul>
      <p v-else class="hint dim">{{ t('client.admin.none') }}</p>
      <div v-if="fresh" class="fresh">
        <p class="hint">{{ t('client.admin.newLink') }}</p>
        <div class="row">
          <input class="input mono" :value="fresh" readonly :aria-label="t('client.admin.newLink')" @focus="($event.target as HTMLInputElement).select()">
          <button type="button" class="btn" @click="copy"><Icon name="copy" />{{ t('client.admin.copy') }}</button>
        </div>
      </div>
      <form class="add" @submit.prevent="create">
        <label class="field"><span>{{ t('client.admin.label') }}</span><input v-model="form.label" class="input" maxlength="60" :placeholder="t('client.admin.labelPlaceholder')"></label>
        <label class="field"><span>{{ t('client.admin.days') }}</span>
          <select v-model.number="form.days" class="select">
            <option :value="0">{{ t('client.admin.forever') }}</option>
            <option v-for="n in [7, 30, 90, 365]" :key="n" :value="n">{{ t('client.admin.daysN', { n }) }}</option>
          </select>
        </label>
        <label class="field"><span>{{ t('client.admin.sendTo') }}</span><input v-model="form.sendTo" class="input" type="email" maxlength="254" :placeholder="t('client.admin.sendToPlaceholder')"></label>
        <label class="check"><input v-model="form.canReport" type="checkbox"> {{ t('client.admin.canReport') }}</label>
        <button type="submit" class="btn" :disabled="busy">{{ t('client.admin.create') }}</button>
      </form>
      <label class="check ok-switch">
        <input type="checkbox" :checked="data.okApproves" :disabled="busy || !owner" @change="setOk(($event.target as HTMLInputElement).checked)">
        <span>{{ t('client.admin.okApproves') }}</span>
      </label>
      <p class="hint dim">{{ t('client.admin.okApprovesHint') }}</p>

      <p class="sub">{{ t('client.admin.feedback') }}</p>
      <ul v-if="data.feedback.length" class="list">
        <li v-for="f in data.feedback" :key="f.id" class="line fb">
          <span class="pill" :class="f.verdict === 'ok' ? 's-erledigt' : 's-wartet'">{{ t(`client.admin.verdict.${f.verdict}`) }}</span>
          <span class="grow fb-text">
            <NuxtLink :to="`${base}/aufgaben/${f.taskId}`" class="mono small">{{ f.code }}</NuxtLink> {{ f.title }}
            <span v-if="f.comment" class="dim"> - {{ f.comment }}</span>
          </span>
          <span v-if="f.approved" class="dim hide-m">{{ t('client.admin.approved') }}</span>
          <span class="dim small nowrap">{{ dateTime(f.createdAt) }}</span>
        </li>
      </ul>
      <p v-else class="hint dim">{{ t('client.admin.noFeedback') }}</p>
    </template>
  </div>
</template>

<style scoped>
.client {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hint,
.sub {
  margin: 0;
  font-size: 13px;
}

.sub {
  margin-top: 8px;
  font-weight: 600;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.line {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  font-size: 13px;
}

.line + .line {
  border-top: 1px solid var(--line);
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
}

.fb {
  align-items: flex-start;
  padding: 6px 0;
}

.fb-text {
  overflow-wrap: anywhere;
}

.nowrap {
  white-space: nowrap;
}

.bad {
  color: var(--down);
}

.fresh .row,
.add {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}

.fresh .input {
  flex: 1 1 260px;
  min-width: 0;
}

.add .field {
  flex: 1 1 160px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  font-size: 13px;
}

.ok-switch {
  font-weight: 500;
}
</style>
