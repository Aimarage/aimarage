<script setup lang="ts">
import { fold, helpBlocks, helpPath, helpSectionUrl, type HelpLang } from '~~/shared/utils/help'

interface HelpItem { id: string, title: string, path: string | null, keywords: string[], excerpt: string, body: string }
interface HelpData { lang: HelpLang, appUrl: string, intro: string, sections: HelpItem[] }

definePageMeta({ layout: false, public: true })
const { t, locale, setLocale } = useI18n()
const route = useRoute()
const { boot } = useBoot()
const { slug } = useScope()

const lang = computed<HelpLang>(() => {
  if (route.query.lang === 'en' || route.query.lang === 'de') return route.query.lang
  return boot.value && locale.value === 'en' ? 'en' : 'de'
})
if (!boot.value && locale.value !== lang.value) await setLocale(lang.value)
watch(lang, (l) => {
  if (!boot.value && locale.value !== l) setLocale(l)
})

const { data } = await useFetch<HelpData>('/api/help', { query: { lang }, key: computed(() => `help:${lang.value}`) })
const id = computed(() => String(route.params.id ?? ''))
const section = computed(() => (id.value ? data.value?.sections.find(s => s.id === id.value) ?? null : null))
if (id.value && data.value && !section.value) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })

const langQuery = computed(() => (lang.value === 'en' ? { lang: 'en' } : {}))
const linkTo = (sid: string) => ({ path: `/hilfe/${sid}`, query: langQuery.value })
const projectSlug = computed(() => (boot.value ? slug.value : 'alle'))
const blocks = computed(() => (section.value ? helpBlocks(boot.value ? helpPath(section.value.body, slug.value)! : section.value.body) : []))
const openPath = computed(() => helpPath(section.value?.path ?? null, projectSlug.value))
const mdHref = computed(() => `/hilfe${section.value ? `/${section.value.id}` : ''}.md${lang.value === 'en' ? '?lang=en' : ''}`)

const q = ref('')
const list = computed(() => {
  const words = fold(q.value).split(' ').filter(Boolean)
  const all = data.value?.sections ?? []
  if (!words.length) return all
  return all.filter((s) => {
    const hay = ` ${fold(s.title)} ${s.keywords.join(' ')} `
    return words.every(w => hay.includes(w))
  })
})

useHead(() => {
  const base = data.value?.appUrl ?? ''
  const sid = section.value?.id ?? null
  const title = section.value ? `${section.value.title} - ${t('help.title')}` : t('help.title')
  return {
    title,
    htmlAttrs: { lang: lang.value },
    meta: [
      { name: 'description', content: section.value?.excerpt || t('help.description') },
      { name: 'robots', content: 'index, follow' },
      { property: 'og:title', content: title },
    ],
    link: [
      { rel: 'canonical', href: helpSectionUrl(base, sid, lang.value) },
      { rel: 'alternate', hreflang: 'de', href: helpSectionUrl(base, sid, 'de') },
      { rel: 'alternate', hreflang: 'en', href: helpSectionUrl(base, sid, 'en') },
      { rel: 'alternate', hreflang: 'x-default', href: helpSectionUrl(base, sid, 'de') },
      { rel: 'alternate', type: 'text/markdown', href: `${base}${mdHref.value}` },
    ],
  }
})
</script>

<template>
  <NuxtLayout :name="boot ? 'default' : 'help'">
    <article v-if="data && section" class="page help">
      <div class="page-head">
        <div>
          <p class="crumbs"><NuxtLink :to="{ path: '/hilfe', query: langQuery }">{{ t('help.title') }}</NuxtLink></p>
          <h1>{{ section.title }}</h1>
        </div>
        <div v-if="openPath" class="actions">
          <NuxtLink :to="openPath" class="btn">{{ t('help.open') }}</NuxtLink>
        </div>
      </div>
      <div class="text">
        <template v-for="(b, i) in blocks" :key="i">
          <h2 v-if="b.t === 'h'" :id="b.id">{{ b.v }}</h2>
          <pre v-else-if="b.t === 'code'" class="code"><code>{{ b.v }}</code></pre>
          <ol v-else-if="b.t === 'ol'" :start="b.start !== 1 ? b.start : undefined">
            <li v-for="(item, j) in b.items" :key="j"><HelpInline :parts="item" /></li>
          </ol>
          <ul v-else-if="b.t === 'ul'">
            <li v-for="(item, j) in b.items" :key="j"><HelpInline :parts="item" /></li>
          </ul>
          <p v-else><HelpInline :parts="b.parts" /></p>
        </template>
      </div>
      <p class="foot"><NuxtLink :to="{ path: '/hilfe', query: langQuery }">{{ t('help.all') }}</NuxtLink><a :href="mdHref" class="dim">{{ t('help.asText') }}</a></p>
    </article>

    <div v-else-if="data" class="page help">
      <div class="page-head">
        <h1>{{ t('help.title') }}</h1>
      </div>
      <label class="search">
        <span class="sr-only">{{ t('help.search') }}</span>
        <Icon name="search" />
        <input v-model="q" type="search" class="input" :placeholder="t('help.search')">
      </label>
      <ul v-if="list.length" class="rows panel">
        <li v-for="s in list" :id="s.id" :key="s.id" class="topic">
          <NuxtLink :to="linkTo(s.id)" class="title">{{ s.title }}</NuxtLink>
          <p class="dim">{{ s.excerpt }}</p>
        </li>
      </ul>
      <p v-else class="empty">{{ t('help.empty') }}</p>
    </div>
  </NuxtLayout>
</template>

<style scoped>
/* Hilfe */
.help {
  max-width: 760px;
}

.search {
  position: relative;
  display: block;
}

.search :deep(svg) {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--dim);
}

.search .input {
  width: 100%;
  padding-left: 36px;
}

.topic {
  padding: 14px 16px;
}

.topic:target {
  box-shadow: inset 2px 0 0 var(--agent);
}

.topic .title {
  color: var(--text);
  font-weight: 500;
  text-decoration: none;
}

.topic .title:hover {
  color: var(--agent);
}

.topic p {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

/* Text */
.text {
  font-size: 15px;
  line-height: 1.65;
}

.text p,
.text ul,
.text ol {
  margin: 0 0 14px;
}

.text ul,
.text ol {
  padding-left: 22px;
}

.text li {
  margin-bottom: 6px;
}

.text h2 {
  margin: 28px 0 10px;
  font-size: 17px;
  font-weight: 600;
}

.text :deep(code) {
  font-family: var(--mono);
  font-size: 13px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--panel2);
  overflow-wrap: anywhere;
}

.code {
  margin: 0 0 14px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  overflow-x: auto;
}

.text .code code {
  padding: 0;
  background: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.foot {
  display: flex;
  gap: 16px;
  margin: 0;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  font-size: 13px;
}
</style>
