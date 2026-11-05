<script setup lang="ts">
import { noteText, type InboxLine } from '~~/shared/utils/inbox'

const { t, locale } = useI18n()
const { query, base } = useScope()
const { data } = await useFetch<{ lines: InboxLine[] }>('/api/inbox/summary', { query, key: computed(() => `inbox:${query.value.project ?? 'alle'}`) })

const lines = computed(() => data.value?.lines ?? [])

function parts(l: InboxLine): string {
  const c = l.counts
  const ads = c.newsletter + c.spam
  return [
    c.antwort ? t('inbox.sum.antwort', c.antwort, { named: { n: c.antwort } }) : '',
    c.wichtig ? t('inbox.sum.wichtig', { n: c.wichtig }) : '',
    c.info ? t('inbox.sum.info', c.info, { named: { n: c.info } }) : '',
    ads ? t('inbox.sum.ads', { n: ads }) : '',
  ].filter(Boolean).join(', ')
}

const note = (n: string | null, subject: string | null) => noteText(n, locale.value === 'en' ? 'en' : 'de') ?? subject ?? ''
const link = (l: InboxLine) => (query.value.project ? `${base.value}/postfach` : `/p/${l.slug}/postfach`)
</script>

<template>
  <div v-if="lines.length" class="inbox">
    <template v-for="l in lines" :key="l.projectId">
      <p><NuxtLink :to="link(l)">{{ t('inbox.line', { name: l.name, n: l.counts.total }) }}</NuxtLink> - {{ parts(l) }}</p>
      <p v-for="i in l.important.slice(0, 3)" :key="i.id" class="imp">{{ t('inbox.important') }}: {{ i.from }}<template v-if="note(i.note, i.subject)"> - {{ note(i.note, i.subject) }}</template></p>
    </template>
  </div>
</template>

<style scoped>
.inbox {
  margin: 6px 0 0;
  max-width: 64ch;
  color: var(--muted);
  font-size: 15px;
  line-height: 1.5;
}

.inbox p {
  margin: 0;
}

.inbox a {
  color: var(--text);
}

.imp {
  color: var(--text);
}
</style>
