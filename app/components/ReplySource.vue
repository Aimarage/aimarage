<script setup lang="ts">
import type { ReplySource } from '~~/shared/utils/reply-source'
import { safeHttpUrl } from '~~/shared/utils/url'

const props = withDefaults(defineProps<{ source: ReplySource, next?: boolean, via?: string | null, posted?: string | null }>(), { next: true, via: null, posted: null })
const { t } = useI18n()
const { dateTime, dm, isoDay } = useFormat()
const s = computed(() => props.source)
const who = computed(() => (s.value.relation === 'mail' ? s.value.author ?? '' : s.value.author ? `@${s.value.author}` : ''))
const parent = computed(() => (s.value.parent?.text ? s.value.parent : null))
const head = computed(() => {
  const r = s.value.relation
  const p = parent.value
  if (r === 'mail') return t('source.mail', { who: who.value })
  if (r === 'thread') return s.value.sub ? t('source.threadIn', { sub: s.value.sub }) : t('source.thread')
  if (r === 'link') return t('source.link')
  if (r === 'conversation') return t('source.convo', { who: who.value })
  if (p?.ours || (r === 'reply' && !p)) return p?.at ? t('source.repliedOursOn', { who: who.value, day: dm(isoDay(p.at)) }) : t('source.repliedOurs', { who: who.value })
  if (p) return p.author ? t('source.repliedTo', { who: who.value, to: `@${p.author}` }) : t('source.repliedOther', { who: who.value })
  if (r === 'reaction') return t('source.reacted', { who: who.value })
  if (r === 'mention') return t('source.mentioned', { who: who.value })
  return s.value.sub ? t('source.wroteIn', { who: who.value, sub: s.value.sub }) : t('source.wrote', { who: who.value })
})
const url = computed(() => safeHttpUrl(s.value.url))
const postedUrl = computed(() => safeHttpUrl(props.posted))
const meta = computed(() => [s.value.at ? dateTime(s.value.at) : '', s.value.age ? t('approvals.threadAge', { age: s.value.age }) : ''].filter(Boolean).join(' - '))
</script>

<template>
  <div class="src">
    <p class="head">{{ head }}</p>
    <blockquote v-if="parent" class="quote parent">
      <ClampText :text="parent.text" :lines="2" />
    </blockquote>
    <p v-if="s.title" class="title">{{ s.relation === 'mail' ? t('source.subject', { subject: s.title }) : s.title }}</p>
    <blockquote v-if="s.text" class="quote">
      <ClampText :text="s.text" :lines="s.relation === 'mail' ? 14 : 40" />
    </blockquote>
    <p v-if="meta || url || postedUrl" class="meta">
      <span v-if="meta">{{ meta }}</span>
      <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer" :title="url">{{ t('source.open') }}</a>
      <span v-if="via && url && !postedUrl">{{ t('source.via', { handle: via }) }}</span>
      <a v-if="postedUrl" :href="postedUrl" target="_blank" rel="noopener noreferrer" :title="postedUrl">{{ t('source.posted') }}</a>
    </p>
    <p v-if="next" class="next">{{ postedUrl ? t('source.nextDone') : t('source.next') }}</p>
  </div>
</template>

<style scoped>
.src {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 20px 20px 0;
  max-width: 72ch;
}

.src p {
  margin: 0;
}

.head,
.next {
  font-weight: 600;
  font-size: 14px;
}

.next {
  margin-top: 8px;
}

.title {
  font-size: 14px;
}

.quote {
  margin: 0;
  position: relative;
  padding: 2px 0 2px 28px;
  font-style: italic;
  color: var(--body);
  white-space: pre-wrap;
  font-size: 14.5px;
  line-height: 1.6;
}

.quote::before {
  content: '\201D';
  position: absolute;
  left: 2px;
  top: 0;
  font-size: 26px;
  line-height: 1;
  font-style: normal;
  font-weight: 700;
  color: var(--dim);
}

.parent {
  color: var(--muted);
  font-size: 13.5px;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12.5px;
  color: var(--dim);
}
</style>
