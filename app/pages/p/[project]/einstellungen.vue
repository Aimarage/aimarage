<script setup lang="ts">
import { PROJECT_COLORS } from '~~/shared/utils/domain'
import type { FeedInfo } from '~/components/ProjectFeeds.vue'

interface Project { id: string, slug: string, name: string, code: string, color: string, icon: string, url: string | null, description: string | null, tonality: string | null, archived: boolean, autonomy: Record<string, string>, rules: string | null, facts: { known: string[], avoid: string[] }, blog: string | null, pacing: number | null, draftAhead: number, stats: Stats | null, blogApi: BlogApi | null, outlets: { social: boolean, mail: boolean, blog: boolean }, trust: string[], feeds: FeedInfo[], geoQuestions: number, client: { okApproves: boolean, links: number } }
interface BlogGit { provider: 'github' | 'gitlab', base: string | null, repo: string, branch: string, dir: string, file: string, publicUrl: string, imageDir: string | null }
interface BlogApi { type: 'aimarage' | 'wordpress' | 'webflow' | 'git', url: string, user: string | null, status: 'publish' | 'draft', category: number | null, collectionId: string | null, fields: { title: string, slug: string, body: string, description?: string | null } | null, git: BlogGit | null, hasToken: boolean, hint: string, checkedAt: string | null, error: string | null, lastPublish: string | null }
interface Stats { mode: 'api' | 'counter', site: string | null, url: string, campaignPrefix: string | null, hasToken: boolean, hint: string, setAt: string | null, checkedAt: string | null, error: string | null, lastSync: string | null }

const KINDS = ['social', 'content', 'mail', 'verzeichnis', 'community'] as const
const CHOOSE: readonly string[] = ['social', 'content']
const { t, tm, rt } = useI18n()
const { dateTime } = useFormat()
const { boot, isAdmin, refresh: refreshBoot } = useBoot()
const { project, base } = useScope()
const toast = useToast()
useHead({ title: computed(() => project.value ? `${t('projectSettings.title')} - ${project.value.name}` : t('settings.projects')) })

const { data, refresh } = await useFetch<{ projects: Project[] }>('/api/settings', { key: 'settings' })
const current = computed(() => (project.value ? data.value?.projects.find(p => p.id === project.value!.id) ?? null : null))

type Section = 'basics' | 'about' | 'rules' | 'facts' | 'approval' | 'publish' | 'feeds' | 'geo' | 'stats' | 'client'
const sections: Section[] = ['basics', 'about', 'rules', 'facts', 'approval', 'publish', 'feeds', 'geo', 'stats', 'client']
const open = ref<Section | null>(null)

const form = ref({ name: '', code: '', color: 'blue', url: '', blog: '', description: '', tonality: '', rules: '', known: '', avoid: '', pacing: 0, draftAhead: 7, autonomy: {} as Record<string, string>, statsMode: 'api' as 'api' | 'counter', statsUrl: '', statsToken: '', statsPrefix: '', statsCopy: '', apiType: 'aimarage', apiUrl: '', apiToken: '', apiUser: '', apiStatus: 'publish', apiCategory: '', apiCollection: '', apiTitle: 'name', apiSlug: 'slug', apiBody: 'post-body', apiDesc: '', gitProvider: 'github', gitBase: '', gitRepo: '', gitBranch: 'main', gitDir: '', gitFile: '{slug}.md', gitPublicUrl: '', gitImageDir: '' })
interface Checked { ok: boolean, rows: number, days: number, error: string | null }
const checked = ref<Checked | null>(null)
const apiChecked = ref<{ ok: boolean, error: string | null } | null>(null)
const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)
function reset() {
  const p = current.value
  if (!p) return
  form.value = { name: p.name, code: p.code, color: p.color, url: p.url ?? '', blog: p.blog ?? '', description: p.description ?? '', tonality: p.tonality ?? '', rules: p.rules ?? '', known: p.facts.known.join('\n'), avoid: p.facts.avoid.join('\n'), pacing: p.pacing ?? 0, draftAhead: p.draftAhead ?? 7, autonomy: Object.fromEntries(CHOOSE.map(k => [k, p.autonomy?.[k] && p.autonomy[k] !== 'approve' ? 'auto_report' : 'approve'])), statsMode: p.stats?.mode ?? 'api', statsUrl: p.stats?.url ?? '', statsToken: '', statsPrefix: p.stats?.campaignPrefix ?? '', statsCopy: '', apiType: p.blogApi?.type ?? 'aimarage', apiUrl: p.blogApi?.url ?? '', apiToken: '', apiUser: p.blogApi?.user ?? '', apiStatus: p.blogApi?.status ?? 'publish', apiCategory: p.blogApi?.category ? String(p.blogApi.category) : '', apiCollection: p.blogApi?.collectionId ?? '', apiTitle: p.blogApi?.fields?.title ?? 'name', apiSlug: p.blogApi?.fields?.slug ?? 'slug', apiBody: p.blogApi?.fields?.body ?? 'post-body', apiDesc: p.blogApi?.fields?.description ?? '', ...gitForm(p.blogApi?.git ?? null) }
}
function gitForm(g: BlogGit | null) {
  return { gitProvider: g?.provider ?? 'github', gitBase: g?.provider === 'gitlab' && g.base !== GITLAB ? g.base ?? '' : '', gitRepo: g?.repo ?? '', gitBranch: g?.branch ?? 'main', gitDir: g?.dir ?? '', gitFile: g?.file ?? '{slug}.md', gitPublicUrl: g?.publicUrl ?? '', gitImageDir: g?.imageDir ?? '' }
}
watch(current, reset, { immediate: true })
watch(() => current.value?.id, () => { checked.value = null; apiChecked.value = null })
function toggle(s: Section) {
  reset()
  checked.value = null
  apiChecked.value = null
  open.value = open.value === s ? null : s
}

const autoCount = computed(() => CHOOSE.filter(k => current.value?.autonomy?.[k] && current.value.autonomy[k] !== 'approve').length)
const hasOutlet = (k: string) => !!current.value && (k === 'content' ? current.value.outlets.blog : k === 'mail' ? current.value.outlets.mail : current.value.outlets.social)
function trust(kind: string, accept: boolean) {
  return apiCall(async () => {
    await $fetch(`/api/projects/${current.value!.id}/trust`, { method: 'POST', body: { kind, accept } })
    if (accept) toast.push(t('settings.saved'))
    await Promise.all([refresh(), refreshBoot()])
    reset()
  })
}
function summary(s: Section) {
  const p = current.value!
  if (s === 'basics') return [p.code, p.url?.replace(/^https?:\/\//, ''), t(`project.colors.${p.color}`)].filter(Boolean).join(' · ')
  if (s === 'about') return p.description || p.tonality || t('projectSettings.empty')
  if (s === 'rules') return p.rules ? t('projectSettings.lines', { n: lines(p.rules).length }) : t('projectSettings.empty')
  if (s === 'facts') return t('projectSettings.factsSum', { known: p.facts.known.length, avoid: p.facts.avoid.length })
  if (s === 'publish') {
    const b = p.blogApi
    if (!b) return t('projectSettings.publish.off')
    const host = b.git ? b.git.repo : b.url.replace(/^https?:\/\//, '').split('/')[0]
    if (!b.hasToken) return `${host} · ${t('projectSettings.stats.noToken')}`
    if (b.error) return `${host} · ${b.error}`
    return `${host} · ${b.lastPublish ? t('projectSettings.publish.last', { at: dateTime(b.lastPublish) }) : t('projectSettings.publish.ready')}`
  }
  if (s === 'feeds') {
    const bad = p.feeds.find(f => f.error)
    if (!p.feeds.length) return t('feeds.none')
    const last = p.feeds.map(f => f.syncedAt).filter((x): x is string => !!x).sort().at(-1)
    return [t('feeds.count', p.feeds.length), bad ? bad.error : last ? t('feeds.synced', { at: dateTime(last) }) : t('feeds.waiting')].join(' · ')
  }
  if (s === 'geo') return p.geoQuestions ? t('geo.count', p.geoQuestions) : t('geo.auto')
  if (s === 'client') return [t('client.admin.count', p.client.links), p.client.okApproves ? t('client.admin.okOn') : ''].filter(Boolean).join(' · ')
  if (s === 'stats') {
    const st = p.stats
    if (!st) return t('projectSettings.stats.off')
    if (st.mode === 'counter') return `${t('projectSettings.stats.counterShort')} · ${st.lastSync ? t('projectSettings.stats.lastHit', { at: dateTime(st.lastSync) }) : t('projectSettings.stats.noHit')}`
    const host = st.url.replace(/^https?:\/\//, '').split('/')[0]
    if (!st.hasToken) return `${host} · ${t('projectSettings.stats.noToken')}`
    if (st.error) return `${host} · ${st.error}`
    return `${host} · ${st.lastSync ? t('projectSettings.stats.synced', { at: dateTime(st.lastSync) }) : t('projectSettings.stats.waiting')}`
  }
  return [autoCount.value ? t('projectSettings.autoSum', { n: autoCount.value }) : t('projectSettings.allApprove'), t('projectSettings.draftAheadSum', p.draftAhead ?? 7, { named: { n: p.draftAhead ?? 7 } }), p.pacing ? t('projectSettings.pacingSum', { n: p.pacing }) : ''].filter(Boolean).join(' · ')
}

function summaryOk(s: Section) {
  const p = current.value!
  if (s === 'publish') return !!p.blogApi?.hasToken && !p.blogApi.error
  if (s === 'stats') return p.stats?.mode === 'counter' ? !!p.stats.lastSync : !!p.stats?.hasToken && !p.stats.error
  if (s === 'feeds') return p.feeds.length > 0 && !p.feeds.some(f => f.error)
  return false
}

const busy = ref(false)
async function patch(body: Record<string, unknown>) {
  busy.value = true
  try {
    await $fetch(`/api/projects/${current.value!.id}`, { method: 'PATCH', body })
    toast.push(t('settings.saved'))
    open.value = null
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
const statsUrlChanged = computed(() => !!current.value?.stats && form.value.statsUrl.trim() !== current.value.stats.url)
const statsDonors = computed(() => (data.value?.projects ?? []).filter(x => x.id !== current.value?.id && x.stats?.hasToken && x.stats.url === form.value.statsUrl.trim()))
const appOrigin = useRequestURL().origin
const isCounter = computed(() => form.value.statsMode === 'counter' && current.value?.stats?.mode === 'counter' && !!current.value.stats.site)
const snippet = computed(() => current.value?.stats?.site ? `<script defer src="${appOrigin}/z.js" data-site="${current.value.stats.site}"></` + `script>` : '')
async function copySnippet() {
  await navigator.clipboard.writeText(snippet.value).catch(() => {})
  toast.push(t('projectSettings.stats.copied'))
}
async function saveStats() {
  const f = form.value
  busy.value = true
  try {
    if (f.statsMode === 'counter') {
      await $fetch(`/api/projects/${current.value!.id}/stats`, { method: 'PUT', body: { mode: 'counter' } })
      toast.push(t('settings.saved'))
      await refresh()
      return
    }
    await $fetch(`/api/projects/${current.value!.id}/stats`, { method: 'PUT', body: { url: f.statsUrl.trim(), campaignPrefix: f.statsPrefix.trim() || null, ...(f.statsToken.trim() ? { token: f.statsToken.trim() } : f.statsCopy ? { copyFrom: f.statsCopy } : {}) } })
    toast.push(t('settings.saved'))
    f.statsToken = ''
    f.statsCopy = ''
    open.value = null
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
async function checkStats() {
  busy.value = true
  checked.value = null
  try {
    const r = await $fetch<Checked>(`/api/projects/${current.value!.id}/stats-check`, { method: 'POST' })
    await refresh()
    checked.value = r
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
async function removeStats() {
  if (!confirm(t('projectSettings.stats.removeConfirm'))) return
  busy.value = true
  try {
    await $fetch(`/api/projects/${current.value!.id}/stats`, { method: 'DELETE' })
    open.value = null
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const GITLAB = 'https://gitlab.com'
const gitChanged = (b: BlogApi, f: typeof form.value) => f.gitProvider !== b.git?.provider || f.gitRepo.trim().replace(/^\/+|\/+$/g, '') !== b.git.repo || (f.gitProvider === 'gitlab' && (f.gitBase.trim().replace(/\/+$/, '') || GITLAB) !== (b.git.base || GITLAB))
const apiUrlChanged = computed(() => { const b = current.value?.blogApi, f = form.value; return !!b && (f.apiType === 'git' ? f.apiType !== b.type || gitChanged(b, f) : f.apiUrl.trim() !== b.url || f.apiType !== b.type || (f.apiType === 'wordpress' && f.apiUser.trim() !== (b.user ?? '')) || (f.apiType === 'webflow' && f.apiCollection.trim() !== (b.collectionId ?? ''))) })
const BLOG_TYPES = ['aimarage', 'wordpress', 'webflow', 'git'] as const
const gitFormat = computed(() => t('projectSettings.publish.gitFormat'))
async function copyGitFormat() {
  await navigator.clipboard.writeText(`${t('projectSettings.publish.gitPrompt', { dir: form.value.gitDir.trim() || 'src/content/blog' })}\n\n${gitFormat.value}`).catch(() => {})
  toast.push(t('projectSettings.publish.gitCopied'))
}
async function apiCall(fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
function saveApi() {
  const f = form.value
  return apiCall(async () => {
    const git = f.apiType === 'git' ? { provider: f.gitProvider, base: f.gitProvider === 'gitlab' ? f.gitBase.trim() || null : null, repo: f.gitRepo.trim(), branch: f.gitBranch.trim() || 'main', dir: f.gitDir.trim(), file: f.gitFile.trim() || '{slug}.md', publicUrl: f.gitPublicUrl.trim(), imageDir: f.gitImageDir.trim() || null } : null
    await $fetch(`/api/projects/${current.value!.id}/blog-api`, { method: 'PUT', body: { type: f.apiType, ...(git ? { git } : { url: f.apiUrl.trim() }), user: f.apiUser.trim() || null, status: f.apiStatus, category: Number(f.apiCategory) || null, collectionId: f.apiCollection.trim() || null, fields: f.apiType === 'webflow' ? { title: f.apiTitle, slug: f.apiSlug, body: f.apiBody, description: f.apiDesc || null } : null, ...(f.apiToken.trim() ? { token: f.apiToken.trim() } : {}) } })
    toast.push(t('settings.saved'))
    f.apiToken = ''
    open.value = null
    await refresh()
  })
}
function checkApi() {
  apiChecked.value = null
  return apiCall(async () => {
    const r = await $fetch<{ ok: boolean, error: string | null }>(`/api/projects/${current.value!.id}/blog-api-check`, { method: 'POST' })
    await refresh()
    apiChecked.value = r
  })
}
function removeApi() {
  if (!confirm(t('projectSettings.publish.removeConfirm'))) return
  return apiCall(async () => {
    await $fetch(`/api/projects/${current.value!.id}/blog-api`, { method: 'DELETE' })
    open.value = null
    await refresh()
  })
}

function save(s: Section) {
  const f = form.value
  if (s === 'stats') return saveStats()
  if (s === 'publish') return saveApi()
  if (s === 'basics') return patch({ name: f.name, code: f.code, color: f.color, url: f.url || null, blog: f.blog.trim() || null })
  if (s === 'about') return patch({ description: f.description || null, tonality: f.tonality || null })
  if (s === 'rules') return patch({ rules: f.rules.trim() || null })
  if (s === 'facts') return patch({ facts: { known: lines(f.known), avoid: lines(f.avoid) } })
  return patch({ autonomy: f.autonomy, pacing: f.pacing || null, draftAhead: Math.min(21, Math.max(1, Math.round(f.draftAhead || 7))) })
}
function archive() {
  const p = current.value!
  if (!p.archived && !confirm(t('projectSettings.archiveConfirm', { name: p.name }))) return
  return patch({ archived: !p.archived })
}
const delOpen = ref(false)
const delName = ref('')
async function removeProject() {
  busy.value = true
  try {
    await $fetch<unknown>(`/api/projects/${current.value!.id}/delete` as string, { method: 'POST', body: { name: delName.value } })
    toast.push(t('projectSettings.deleted'))
    delOpen.value = false
    await refreshBoot()
    await navigateTo('/')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="data" class="page">
    <template v-if="current">
      <div class="page-head">
        <h1>{{ t('projectSettings.title') }}</h1>
      </div>
      <p v-if="current.archived" class="hint note">{{ t('projectSettings.isArchived') }}</p>

      <section class="panel">
        <ul class="rows">
          <li v-for="s in sections" :key="s">
            <button type="button" class="row-link srow" :aria-expanded="open === s" @click="toggle(s)">
              <span class="slabel">{{ t(`projectSettings.sections.${s}`) }}</span>
              <span class="ssum ellipsis" :class="summaryOk(s) ? 'good' : 'dim'">{{ summary(s) }}</span>
              <Icon :name="open === s ? 'chevron-down' : 'chevron-right'" class="dim" />
            </button>
            <div v-if="open === s && s === 'feeds'" class="sedit">
              <ProjectFeeds :project-id="current.id" :admin="isAdmin" @changed="refresh" />
            </div>
            <div v-else-if="open === s && s === 'geo'" class="sedit">
              <ProjectGeo :project-id="current.id" :admin="isAdmin" @changed="refresh" />
            </div>
            <div v-else-if="open === s && s === 'client'" class="sedit">
              <ProjectClient :project-id="current.id" :admin="isAdmin" :owner="boot?.role === 'owner'" @changed="refresh" />
            </div>
            <form v-else-if="open === s" class="sedit" @submit.prevent="save(s)">
              <fieldset class="plain" :disabled="!isAdmin">
                <div v-if="s === 'basics'" class="form-grid">
                  <label class="field"><span>{{ t('project.name') }}</span><input v-model="form.name" class="input" required maxlength="60"></label>
                  <label class="field"><span>{{ t('project.code') }}</span><input v-model="form.code" class="input mono" required minlength="2" maxlength="5" pattern="[A-Za-z0-9]+"></label>
                  <label class="field"><span>{{ t('project.url') }}</span><input v-model="form.url" class="input" type="url"></label>
                  <label class="field"><span>{{ t('project.color') }}</span><select v-model="form.color" class="select"><option v-for="c in PROJECT_COLORS" :key="c" :value="c">{{ t(`project.colors.${c}`) }}</option></select></label>
                  <label class="field wide"><span>{{ t('project.blog') }}</span><input v-model="form.blog" class="input" type="url" maxlength="300" placeholder="https://"></label>
                  <p class="hint wide">{{ t('project.blogHint') }}</p>
                </div>
                <div v-else-if="s === 'about'" class="form-grid">
                  <label class="field wide"><span>{{ t('project.description') }}</span><textarea v-model="form.description" class="textarea" rows="3" /></label>
                  <label class="field wide"><span>{{ t('settings.tonality') }}</span><textarea v-model="form.tonality" class="textarea" rows="3" /></label>
                </div>
                <div v-else-if="s === 'rules'" class="form-grid">
                  <label class="field wide"><span>{{ t('project.rules') }}</span><textarea v-model="form.rules" class="textarea" rows="8" :placeholder="t('project.rulesHint')" /></label>
                </div>
                <div v-else-if="s === 'facts'" class="form-grid">
                  <label class="field wide"><span>{{ t('project.factsKnown') }}</span><textarea v-model="form.known" class="textarea" rows="4" :placeholder="t('project.factsKnownHint')" /></label>
                  <label class="field wide"><span>{{ t('project.factsAvoid') }}</span><textarea v-model="form.avoid" class="textarea" rows="3" :placeholder="t('project.factsAvoidHint')" /></label>
                </div>
                <div v-else-if="s === 'publish'" class="form-grid">
                  <p class="hint wide">{{ t('projectSettings.publish.help') }}</p>
                  <label class="field wide"><span>{{ t('projectSettings.publish.type') }}</span><select v-model="form.apiType" class="select"><option v-for="ty in BLOG_TYPES" :key="ty" :value="ty">{{ t(`projectSettings.publish.types.${ty}`) }}</option></select></label>
                  <ol class="guide wide"><li v-for="(step, i) in tm(`projectSettings.publish.guide.${form.apiType}`)" :key="i">{{ rt(step) }}</li></ol>
                  <template v-if="form.apiType === 'git'">
                    <label class="field"><span>{{ t('projectSettings.publish.gitProvider') }}</span><select v-model="form.gitProvider" class="select"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label>
                    <label v-if="form.gitProvider === 'gitlab'" class="field"><span>{{ t('projectSettings.publish.gitBase') }}</span><input v-model="form.gitBase" class="input mono" type="url" maxlength="200" placeholder="https://gitlab.com"></label>
                    <label class="field"><span>{{ t('projectSettings.publish.gitRepo') }}</span><input v-model="form.gitRepo" class="input mono" required maxlength="200" :placeholder="form.gitProvider === 'gitlab' ? 'gruppe/website' : 'owner/website'" autocomplete="off"></label>
                    <label class="field"><span>{{ t('projectSettings.publish.gitBranch') }}</span><input v-model="form.gitBranch" class="input mono" maxlength="200" placeholder="main"></label>
                    <label class="field"><span>{{ t('projectSettings.publish.gitDir') }}</span><input v-model="form.gitDir" class="input mono" required maxlength="200" placeholder="src/content/blog"></label>
                    <label class="field"><span>{{ t('projectSettings.publish.gitFile') }}</span><input v-model="form.gitFile" class="input mono" maxlength="120" placeholder="{slug}.md"></label>
                    <label class="field wide"><span>{{ t('projectSettings.publish.gitPublicUrl') }}</span><input v-model="form.gitPublicUrl" class="input mono" required maxlength="500" placeholder="https://example.com/{lang}/blog/{slug}"></label>
                    <label class="field wide"><span>{{ t('projectSettings.publish.gitImageDir') }}</span><input v-model="form.gitImageDir" class="input mono" maxlength="200" placeholder="public/images/blog"></label>
                  </template>
                  <label v-else class="field wide"><span>{{ t(`projectSettings.publish.url_${form.apiType}`) }}</span><input v-model="form.apiUrl" class="input mono" type="url" required maxlength="500" :placeholder="form.apiType === 'aimarage' ? 'https://example.com/blog/api' : form.apiType === 'wordpress' ? 'https://example.com' : 'https://example.com/blog'"></label>
                  <label v-if="form.apiType === 'wordpress'" class="field"><span>{{ t('projectSettings.publish.user') }}</span><input v-model="form.apiUser" class="input" required maxlength="120" autocomplete="off"></label>
                  <label v-if="form.apiType === 'webflow'" class="field"><span>{{ t('projectSettings.publish.collection') }}</span><input v-model="form.apiCollection" class="input mono" required maxlength="60"></label>
                  <label class="field" :class="{ wide: form.apiType === 'aimarage' }">
                    <span>{{ t(`projectSettings.publish.token_${form.apiType}`) }}</span>
                    <input v-model="form.apiToken" class="input mono" type="password" autocomplete="off" maxlength="500" :required="!current.blogApi?.hasToken || apiUrlChanged" :placeholder="current.blogApi?.hasToken && !apiUrlChanged ? t('projectSettings.stats.tokenKeep', { hint: current.blogApi.hint }) : ''">
                  </label>
                  <template v-if="form.apiType !== 'aimarage'">
                    <label class="field"><span>{{ t('projectSettings.publish.status') }}</span><select v-model="form.apiStatus" class="select"><option value="publish">{{ t('projectSettings.publish.statusPublish') }}</option><option value="draft">{{ t('projectSettings.publish.statusDraft') }}</option></select></label>
                    <label v-if="form.apiType === 'wordpress'" class="field"><span>{{ t('projectSettings.publish.category') }}</span><input v-model="form.apiCategory" class="input" inputmode="numeric" pattern="[0-9]*" maxlength="10"></label>
                    <template v-if="form.apiType === 'webflow'">
                      <label class="field"><span>{{ t('projectSettings.publish.fieldTitle') }}</span><input v-model="form.apiTitle" class="input mono" maxlength="80"></label>
                      <label class="field"><span>{{ t('projectSettings.publish.fieldSlug') }}</span><input v-model="form.apiSlug" class="input mono" maxlength="80"></label>
                      <label class="field"><span>{{ t('projectSettings.publish.fieldBody') }}</span><input v-model="form.apiBody" class="input mono" maxlength="80"></label>
                      <label class="field"><span>{{ t('projectSettings.publish.fieldDesc') }}</span><input v-model="form.apiDesc" class="input mono" maxlength="80"></label>
                    </template>
                    <p class="hint wide">{{ t(form.apiType === 'git' ? 'projectSettings.publish.gitLangs' : 'projectSettings.publish.oneLang') }}</p>
                  </template>
                  <template v-if="form.apiType === 'git'">
                    <p class="hint wide">{{ t('projectSettings.publish.gitSite') }} {{ t('projectSettings.publish.gitPrompt', { dir: form.gitDir.trim() || 'src/content/blog' }) }}</p>
                    <details class="wide fm">
                      <summary>{{ t('projectSettings.publish.gitFormatTitle') }}</summary>
                      <pre class="mono">{{ gitFormat }}</pre>
                      <button type="button" class="btn small" @click="copyGitFormat">{{ t('projectSettings.publish.gitCopy') }}</button>
                    </details>
                  </template>
                  <p v-if="!current.blog" class="hint wide warn">{{ t('projectSettings.publish.noBlog') }}</p>
                  <p v-if="apiUrlChanged && current.blogApi?.hasToken" class="hint wide warn">{{ t('projectSettings.stats.urlChanged') }}</p>
                  <p v-if="apiChecked" class="wide check" :class="apiChecked.ok ? 'ok' : 'bad'">{{ apiChecked.ok ? t('projectSettings.publish.checkOk') : apiChecked.error }}</p>
                </div>
                <div v-else-if="s === 'stats'" class="form-grid">
                  <label class="field wide"><span>{{ t('projectSettings.stats.mode') }}</span><select v-model="form.statsMode" class="select"><option value="api">{{ t('projectSettings.stats.modeApi') }}</option><option value="counter">{{ t('projectSettings.stats.modeCounter') }}</option></select></label>
                  <template v-if="form.statsMode === 'counter'">
                    <p class="hint wide">{{ t('projectSettings.stats.counterHelp') }}</p>
                    <p v-if="!current.url" class="hint wide warn">{{ t('projectSettings.stats.counterNoUrl') }}</p>
                    <template v-if="isCounter">
                      <div class="wide snip">
                        <pre class="mono">{{ snippet }}</pre>
                        <button type="button" class="btn small" @click="copySnippet">{{ t('projectSettings.stats.copy') }}</button>
                      </div>
                      <p class="hint wide">{{ t('projectSettings.stats.counterClaude') }}</p>
                      <p class="wide check" :class="current.stats?.lastSync ? 'ok' : ''">{{ current.stats?.lastSync ? t('projectSettings.stats.lastHit', { at: dateTime(current.stats.lastSync) }) : t('projectSettings.stats.noHit') }}</p>
                    </template>
                    <p v-else class="hint wide">{{ t('projectSettings.stats.counterSave') }}</p>
                  </template>
                  <template v-else>
                    <p class="hint wide">{{ t('projectSettings.stats.help') }}</p>
                    <label class="field wide"><span>{{ t('projectSettings.stats.url') }}</span><input v-model="form.statsUrl" class="input mono" type="url" required maxlength="500" placeholder="https://example.com/api/v1/admin/utm"></label>
                    <label v-if="statsDonors.length" class="field wide">
                      <span>{{ t('projectSettings.stats.copyFrom') }}</span>
                      <select v-model="form.statsCopy" class="input">
                        <option value="">{{ t('projectSettings.stats.copyNone') }}</option>
                        <option v-for="d in statsDonors" :key="d.id" :value="d.id">{{ d.name }}</option>
                      </select>
                    </label>
                    <label v-if="!form.statsCopy" class="field wide">
                      <span>{{ t('projectSettings.stats.token') }}</span>
                      <input v-model="form.statsToken" class="input mono" type="password" autocomplete="off" maxlength="500" :required="!current.stats?.hasToken || statsUrlChanged" :placeholder="current.stats?.hasToken && !statsUrlChanged ? t('projectSettings.stats.tokenKeep', { hint: current.stats.hint }) : ''">
                    </label>
                    <label class="field wide">
                      <span>{{ t('projectSettings.stats.prefix') }}</span>
                      <input v-model="form.statsPrefix" class="input mono" maxlength="64" :placeholder="`${current.code.toLowerCase()}-`">
                      <small class="hint">{{ t('projectSettings.stats.prefixHint', { code: current.code.toLowerCase() }) }}</small>
                    </label>
                    <p v-if="statsUrlChanged && current.stats?.hasToken" class="hint wide warn">{{ t('projectSettings.stats.urlChanged') }}</p>
                    <p v-if="checked" class="wide check" :class="checked.ok ? 'ok' : 'bad'">{{ checked.ok ? t('projectSettings.stats.checkOk', { n: checked.rows, days: checked.days }) : checked.error }}</p>
                  </template>
                </div>
                <div v-else class="auto">
                  <p class="hint">{{ t('autonomy.hint') }}</p>
                  <div v-for="k in KINDS" :key="k" class="akind">
                    <div class="arow">
                      <span class="ellipsis">{{ t(`autonomy.kinds.${k}`) }}</span>
                      <select v-if="CHOOSE.includes(k)" v-model="form.autonomy[k]" class="select" :aria-label="t(`autonomy.kinds.${k}`)">
                        <option value="approve">{{ t('autonomy.levels.approve') }}</option>
                        <option value="auto_report">{{ t('autonomy.levels.auto_report') }}</option>
                      </select>
                      <span v-else class="dim fixed">{{ t(`autonomy.fixedFor.${k}`) }}</span>
                    </div>
                    <p v-if="CHOOSE.includes(k) && form.autonomy[k] !== 'approve' && !hasOutlet(k)" class="hint warn">{{ t(`autonomy.need.${k}`) }}</p>
                    <p v-else-if="current.trust.includes(k) && form.autonomy[k] === 'approve'" class="hint suggest">
                      {{ t('autonomy.suggest', { n: 5 }) }}
                      <button type="button" class="btn small" :disabled="busy" @click="trust(k, true)">{{ t('autonomy.yes') }}</button>
                      <button type="button" class="btn small ghost" :disabled="busy" @click="trust(k, false)">{{ t('autonomy.no') }}</button>
                    </p>
                  </div>
                  <label class="field pacing"><span>{{ t('project.pacing') }}</span><input v-model.number="form.pacing" class="input" type="number" min="0" max="20"></label>
                  <label class="field pacing"><span>{{ t('project.draftAhead') }}</span><input v-model.number="form.draftAhead" class="input" type="number" min="1" max="21"><small class="hint">{{ t('project.draftAheadHint') }}</small></label>
                </div>
              </fieldset>
              <div v-if="isAdmin" class="form-actions">
                <button type="submit" class="btn primary" :disabled="busy">{{ t('settings.save') }}</button>
                <button type="button" class="btn ghost" @click="open = null">{{ t('common.cancel') }}</button>
                <template v-if="s === 'publish' && current.blogApi">
                  <button v-if="current.blogApi.hasToken && !apiUrlChanged" type="button" class="btn" :disabled="busy" @click="checkApi">{{ t('projectSettings.stats.check') }}</button>
                  <button type="button" class="btn danger" :disabled="busy" @click="removeApi">{{ t('projectSettings.stats.remove') }}</button>
                </template>
                <template v-if="s === 'stats' && current.stats">
                  <button v-if="form.statsMode === 'api' && current.stats.mode === 'api' && current.stats.hasToken && !statsUrlChanged" type="button" class="btn" :disabled="busy" @click="checkStats">{{ t('projectSettings.stats.check') }}</button>
                  <button type="button" class="btn danger" :disabled="busy" @click="removeStats">{{ t('projectSettings.stats.remove') }}</button>
                </template>
              </div>
            </form>
          </li>
          <li>
            <NuxtLink :to="`${base}/konten`" class="row-link srow">
              <span class="slabel">{{ t('projectSettings.sections.accounts') }}</span>
              <span class="ssum dim ellipsis">{{ t('projectSettings.accountsSum') }}</span>
              <Icon name="chevron-right" class="dim" />
            </NuxtLink>
          </li>
        </ul>
      </section>

      <div v-if="isAdmin" class="foot">
        <button type="button" class="btn small" :disabled="busy" @click="archive">{{ current.archived ? t('settings.unarchive') : t('projectSettings.archive') }}</button>
        <button type="button" class="btn small danger" :disabled="busy" @click="delName = ''; delOpen = true">{{ t('projectSettings.delete') }}</button>
      </div>
      <AppDialog v-if="delOpen" :open="delOpen" :title="t('projectSettings.deleteTitle', { name: current.name })" @close="delOpen = false">
        <form class="confirm" @submit.prevent="removeProject">
          <p class="warnc">{{ t('projectSettings.deleteWarn') }}</p>
          <label class="field"><span>{{ t('projectSettings.deleteLabel', { name: current.name }) }}</span><input v-model="delName" class="input" autocomplete="off" required></label>
          <div class="form-actions">
            <button type="submit" class="btn danger" :disabled="busy || delName.trim() !== current.name.trim()">{{ t('projectSettings.deleteConfirm') }}</button>
            <button type="button" class="btn" @click="delOpen = false">{{ t('common.cancel') }}</button>
          </div>
        </form>
      </AppDialog>
    </template>

    <template v-else>
      <div class="page-head">
        <h1>{{ t('settings.projects') }}</h1>
        <NuxtLink v-if="isAdmin" to="/projekte/neu" class="btn small add"><Icon name="plus" />{{ t('project.new') }}</NuxtLink>
      </div>
      <section class="panel">
        <ul class="rows">
          <li v-for="p in data.projects" :key="p.id">
            <NuxtLink :to="`/p/${p.slug}/einstellungen`" class="row-link">
              <ProjectMark :color="p.color" :icon="p.icon" :size="28" />
              <span class="row-title">{{ p.name }} <span class="mono dim small">{{ p.code }}</span><span v-if="p.archived" class="dim small"> ({{ t('settings.archived') }})</span></span>
              <span class="dim small hide-m ellipsis url">{{ p.url?.replace(/^https?:\/\//, '') }}</span>
              <Icon name="chevron-right" class="dim" />
            </NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.note {
  margin: -16px 0 0;
}

.srow {
  width: 100%;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.slabel {
  flex: 0 0 190px;
  font-size: 14px;
  font-weight: 500;
}

.ssum {
  flex: 1 1 auto;
  font-size: 13px;
}

.ssum.good {
  color: var(--up);
}

.sedit {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  background: var(--panel2);
  border-top: 1px solid var(--line);
}

.plain {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

.foot {
  display: flex;
  gap: 8px;
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 440px;
}

.warnc {
  margin: 0;
  color: var(--down);
}

.add {
  margin-left: auto;
}

.url {
  max-width: 260px;
}

.small {
  font-size: 12px;
}

.auto {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.auto .hint {
  margin: 0 0 4px;
}

.akind .hint {
  margin: 4px 0 0;
  font-size: 12.5px;
}

.suggest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.arow {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13.5px;
}

.arow > span {
  flex: 1 1 auto;
}

.arow .select {
  flex: 0 1 330px;
  width: auto;
}

.fixed {
  flex: 0 1 330px !important;
  padding-left: 12px;
  font-size: 12.5px;
}

.form-grid .hint,
.check {
  margin: 0;
}

.check {
  font-size: 13px;
}

.check.ok {
  color: var(--up);
}

.check.bad,
.warn {
  color: var(--down);
}

.guide {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: var(--dim);
}

.guide li + li {
  margin-top: 2px;
}

.fm summary {
  cursor: pointer;
  font-size: 13px;
}

.fm pre {
  margin: 8px 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre;
  background: var(--bg2);
  border-radius: 4px;
}

.snip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.snip pre {
  margin: 0;
  width: 100%;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg2);
  border-radius: 4px;
}

.pacing {
  margin-top: 10px;
  max-width: 360px;
}

@media (max-width: 600px) {
  .srow {
    flex-wrap: wrap;
    gap: 2px 10px;
    padding-top: 10px;
    padding-bottom: 10px;
  }

  .slabel {
    flex: 1 1 auto;
  }

  .srow > svg {
    order: 2;
  }

  .ssum {
    order: 3;
    flex: 1 1 100%;
  }

  .arow {
    flex-wrap: wrap;
    gap: 4px;
  }

  .arow .select {
    flex: 1 1 100%;
  }
}
</style>
