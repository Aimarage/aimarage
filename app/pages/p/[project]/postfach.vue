<script setup lang="ts">
import { MAIL_CATEGORIES, noteText, type MailCat } from '~~/shared/utils/inbox'

interface InboxItem {
  id: string
  project: string | null
  from: string | null
  fromName: string | null
  subject: string | null
  category: MailCat | null
  by: string | null
  note: string | null
  at: string
  taskId: string | null
  done: 'offen' | 'beantwortet' | 'erledigt' | null
}

const { t, locale } = useI18n()
const { project, base, query } = useScope()
const { dateTime } = useFormat()
const toast = useToast()
useHead({ title: t('inbox.title') })

const { data, refresh } = await useFetch<{ mailboxes: number, items: InboxItem[] }>('/api/inbox', { query, key: computed(() => `inbox-list:${query.value.project ?? 'alle'}`) })

const busy = ref<string | null>(null)
async function setCategory(m: InboxItem, category: MailCat) {
  if (category === m.category) return
  busy.value = m.id
  try {
    const r = await $fetch<{ taskId: string | null, dropped: boolean }>(`/api/inbox/${m.id}`, { method: 'PATCH', body: { category } })
    toast.push(r.taskId ? t('inbox.taskCreated') : r.dropped ? t('inbox.taskDropped') : t('inbox.saved'))
    await refresh()
  }
  catch (err) {
    toast.error(err)
    await refresh()
  }
  finally {
    busy.value = null
  }
}
async function setDone(m: InboxItem, done: boolean) {
  busy.value = m.id
  try {
    const r = await $fetch<{ dropped: boolean }>(`/api/inbox/${m.id}`, { method: 'PATCH', body: { done } })
    toast.push(!done ? t('inbox.reopened') : r.dropped ? t('inbox.doneDropped') : t('inbox.doneSaved'))
    await refresh()
  }
  catch (err) {
    toast.error(err)
    await refresh()
  }
  finally {
    busy.value = null
  }
}
const note = (m: InboxItem) => noteText(m.note, locale.value === 'en' ? 'en' : 'de')
</script>

<template>
  <div v-if="data" class="page">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('inbox.title') }}</h1>
      </div>
    </div>
    <p class="dim small">{{ t('inbox.help') }}</p>

    <p v-if="!data.mailboxes" class="empty">{{ t('inbox.noMailbox') }}</p>
    <p v-else-if="!data.items.length" class="empty">{{ t('inbox.empty') }}</p>
    <ul v-else class="rows panel">
      <li v-for="m in data.items" :key="m.id" class="mrow" :class="{ handled: m.category === 'antwort' && m.done !== 'offen' }">
        <span class="meta">
          <span class="mono dim at">{{ dateTime(m.at) }}</span>
          <span class="who ellipsis" :title="m.from ?? ''">{{ m.fromName || m.from }}<span v-if="!project && m.project" class="dim"> · {{ m.project }}</span></span>
        </span>
        <span class="subj ellipsis" :title="m.subject ?? ''">
          <NuxtLink v-if="m.taskId" :to="`${base}/aufgaben/${m.taskId}`">{{ m.subject || t('inbox.noSubject') }}</NuxtLink>
          <template v-else>{{ m.subject || t('inbox.noSubject') }}</template>
          <span v-if="m.category === 'wichtig' && note(m)" class="dim"> - {{ note(m) }}</span>
        </span>
        <span class="act">
          <button v-if="m.category === 'antwort' && m.done === 'offen'" type="button" class="btn small" :disabled="busy === m.id" :title="t('inbox.doneHint')" @click="setDone(m, true)">{{ t('inbox.done') }}</button>
          <button v-else-if="m.category === 'antwort' && m.done === 'erledigt'" type="button" class="btn ghost small state" :disabled="busy === m.id" :title="t('inbox.reopen')" @click="setDone(m, false)">{{ t('inbox.state.erledigt') }}</button>
          <span v-else-if="m.category === 'antwort' && m.done === 'beantwortet'" class="dim small state">{{ t('inbox.state.beantwortet') }}</span>
        </span>
        <select class="input cat" :class="m.category ?? ''" :value="m.category ?? ''" :disabled="busy === m.id" :aria-label="t('inbox.category')" @change="setCategory(m, ($event.target as HTMLSelectElement).value as MailCat)">
          <option v-if="!m.category" value="" disabled>{{ t('inbox.cat.none') }}</option>
          <option v-for="c in MAIL_CATEGORIES" :key="c" :value="c">{{ t(`inbox.cat.${c}`) }}</option>
        </select>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.mrow {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 48px;
  padding: 6px 16px;
  font-size: 14px;
}

.meta {
  display: flex;
  flex: 0 1 344px;
  gap: 14px;
  min-width: 0;
}

.at {
  flex: none;
  width: 130px;
  font-size: 12px;
  line-height: 20px;
}

.who {
  min-width: 0;
}

.subj {
  flex: 1 1 auto;
  min-width: 0;
}

.act {
  display: flex;
  flex: none;
  justify-content: flex-end;
  width: 96px;
}

.cat {
  flex: none;
  width: 170px;
  font-size: 13px;
}

.cat.antwort,
.cat.wichtig {
  font-weight: 600;
}

.handled .cat.antwort {
  font-weight: 400;
}

.handled .subj {
  color: var(--muted);
}

.small {
  font-size: 13px;
}

/* Handy */
@media (max-width: 600px) {
  .mrow {
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 10px 16px;
  }

  .meta,
  .subj {
    flex-basis: 100%;
  }

  .subj {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .act {
    order: 2;
    width: auto;
  }

  .act:empty {
    display: none;
  }

  .act .btn {
    min-height: 36px;
    padding: 0 16px;
  }

  .cat {
    flex: 1 1 auto;
    width: auto;
    max-width: 220px;
    min-height: 36px;
  }
}
</style>
