<script setup lang="ts">
import { safeHttpUrl } from '~~/shared/utils/url'
import { isLangKey } from '~~/shared/utils/article'
import { platformRule, postLength } from '~~/shared/utils/social'
import { platformOf } from '~~/shared/utils/drafting'
import { draftChecks, isTalkNote } from '~~/shared/utils/talk'
import { isRedditNote, parseRedditNote } from '~~/shared/utils/reddit'
import { postTarget, hostPath, postLink as linkInPost } from '~~/shared/utils/where'
import { siteHosts } from '~~/shared/utils/utm'
import { statusItems } from '~~/shared/utils/digest'
import type { MediaItem, SocialInfo } from '~/components/SocialPublish.vue'
import type { TaskService } from '~~/shared/utils/service'
import type { ReplySource } from '~~/shared/utils/reply-source'
import type { TodoServerFacts } from '~~/server/lib/todo'

interface DraftDetail {
  draft: { id: string, taskId: string, version: number, kind: 'post' | 'mail' | 'article' | 'text', subject: string | null, body: string, platforms: string[], variants: Record<string, string>, recipient: string | null, targetUrl: string | null, status: 'offen' | 'freigegeben' | 'verworfen' | 'ersetzt', byAgent: boolean, aiGenerated?: boolean, createdByUserId: string | null, approvedByUserId: string | null, approvedAt: string | null, approvedVia?: string | null, releaseAt?: string | null, createdAt: string }
  task: { id: string, code: string, title: string, status: string, category: string, channel: string | null, dueDate: string | null, dueTime: string | null, projectId: string | null, humanStep: string | null, targetUrl: string | null, service: TaskService | null, postedUrl: string | null, doneAt: string | null, forClaude?: boolean, estimateMin?: number | null }
  project: { id: string, slug: string, name: string, color: string, url: string | null } | null
  utmUrl: string | null
  privacy?: string[]
  where: import('~~/shared/utils/where').TaskWhere
  todo: TodoServerFacts
  reply: { platform: 'bluesky' | 'mastodon', handle: string | null, connected: boolean } | null
  source: ReplySource | null
  subreddit: { sub: string, promo: 'yes' | 'no' | 'days' | 'unknown', days: number[], flair: string | null, flairRequired: boolean } | null
  versions: { id: string, version: number, status: string, byAgent: boolean, createdAt: string }[]
  notes: { id: string, text: string, byAgent: boolean, createdAt: string }[]
  social: SocialInfo
  media: MediaItem[]
  blog: { ready: boolean, live: boolean, host: string | null, at: string | null }
  mail: { ready: boolean, live: boolean, locked: boolean, from: string | null, sent: { to: string | null, at: string } | null, log: { id: string, status: string, to: string | null, at: string, error: string | null }[] }
}

const { t, locale } = useI18n()
const { boot, canEdit, isAdmin, memberById, refresh: refreshBoot } = useBoot()
const { base } = useScope()
const { dateTime, dayDm } = useFormat()
const toast = useToast()
const route = useRoute()
const id = computed(() => String(route.params.id))

const { data, refresh, error } = await useFetch<DraftDetail>(() => `/api/drafts/${id.value}`, { key: computed(() => `draft:${id.value}`) })
if (error.value) throw createError({ statusCode: 404, statusMessage: t('approvals.empty') })
useHead({ title: computed(() => data.value?.task.title ?? t('approvals.title')) })

const d = computed(() => data.value!.draft)
const newer = computed(() => {
  const vs = data.value?.versions ?? []
  const v = vs.find(x => x.status === 'offen') ?? vs[0]
  return v && v.version > (data.value?.draft.version ?? 0) ? v : null
})
const fromVersion = computed(() => (typeof route.query.von === 'string' ? route.query.von : null))
const earlier = computed(() => (data.value?.versions ?? []).filter(v => v.id !== data.value?.draft.id))
function openNewer(newerId: string, replace = false) {
  return navigateTo({ path: `${base.value}/freigaben/${newerId}`, query: { von: String(d.value.version) } }, { replace })
}
if (newer.value && route.query.alt !== '1' && (d.value.status === 'ersetzt' || d.value.status === 'verworfen')) await openNewer(newer.value.id, true)
const isMail = computed(() => d.value.kind === 'mail')
const dest = computed(() => data.value!.where)
const ownDest = computed(() => !isMail.value && dest.value.kind !== 'social' && dest.value.kind !== 'mail' && dest.value.kind !== 'none')
const hosts = computed(() => siteHosts([data.value?.project?.url, data.value?.utmUrl]))
const target = computed(() => (isMail.value ? null : postTarget([thread.value?.url, d.value.targetUrl, data.value?.task.targetUrl, dest.value.url], dest.value, { community: community.value, siteHosts: hosts.value })))
const postLink = computed(() => (isMail.value ? null : linkInPost([d.value.body, ...Object.values(d.value.variants ?? {})], hosts.value, safeHttpUrl(data.value?.utmUrl), community.value)))
const source = computed(() => data.value?.source ?? null)
const hdrTarget = computed(() => (source.value?.url && !dest.value.newPost ? null : target.value))
const subRules = computed(() => (isMail.value || thread.value ? null : data.value?.subreddit ?? null))
const subDays = computed(() => {
  const r = subRules.value
  if (!r) return null
  if (r.promo === 'no') return t('approvals.noPromo')
  if (r.promo !== 'days' || !r.days.length) return null
  const names = r.days.map(n => new Intl.DateTimeFormat(locale.value, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, n))))
  return t('approvals.onlyDays', { days: new Intl.ListFormat(locale.value, { type: 'disjunction' }).format(names) })
})
const isOpen = computed(() => d.value.status === 'offen' || d.value.status === 'freigegeben')
const checks = computed(() => draftChecks(data.value!.notes, d.value.createdAt))
const reddit = computed(() => {
  const since = new Date(d.value.createdAt).getTime() - 2000
  const n = data.value!.notes.find(n => n.byAgent && new Date(n.createdAt).getTime() >= since && isRedditNote(n.text))
  return n ? parseRedditNote(n.text) : null
})
const thread = computed(() => (reddit.value?.kind === 'thread' ? reddit.value : null))
const infoNeeded = computed(() => isOpen.value && checks.value.some(c => c.kind === 'info'))
const platform = computed(() => platformOf({ channel: data.value!.task.channel, targetUrl: d.value.targetUrl ?? data.value!.task.targetUrl, title: data.value!.task.title, category: data.value!.task.category }))
const mark = computed(() => (isMail.value ? 'mail' : platform.value ?? data.value!.social.chosen[0] ?? null))
const reply = computed(() => (!isMail.value && data.value!.reply?.connected ? data.value!.reply : null))
const replyTarget = computed(() => safeHttpUrl(data.value!.task.targetUrl ?? d.value.targetUrl))
const replyHandle = computed(() => reply.value?.handle ?? (reply.value ? platformRule(reply.value.platform).label : ''))
const markAccounts = computed(() => (reply.value ? [{ platform: reply.value.platform, name: replyHandle.value }] : data.value!.social.accounts.filter(a => data.value!.social.chosen.includes(a.platform))))
const platformName = computed(() => (platform.value === 'forum' ? t('approvals.forum') : platform.value ? platformRule(platform.value).label : null))
const community = computed(() => platform.value === 'reddit' || platform.value === 'forum' || data.value!.task.category === 'community')
const autoPost = computed(() => showSocial.value && socialPlatforms.value.length > 0)
const autoNames = computed(() => (data.value!.social.chosen.length ? data.value!.social.chosen : socialPlatforms.value).map(p => platformRule(p).label).join(', '))
const where = computed(() => (target.value ? hostPath(target.value) : dest.value.place ?? platformName.value ?? t('approvals.target')))
const service = computed(() => (isMail.value ? null : data.value!.task.service ?? null))
const openKey = computed(() => (!target.value ? 'approvals.steps.find' : service.value?.account === 'vorhanden' ? 'approvals.steps.openLogin' : 'approvals.steps.open'))
const serviceSteps = computed(() => service.value?.steps.slice(0, 3) ?? [])
const situation = computed<'info' | 'mail' | 'reply' | 'auto' | 'blog' | 'self'>(() => (infoNeeded.value && d.value.status === 'offen' && boot.value?.agent.ready ? 'info' : isMail.value ? 'mail' : reply.value ? 'reply' : data.value!.blog.ready ? 'blog' : autoPost.value ? 'auto' : 'self'))
const questions = computed(() => checks.value.filter(c => c.kind === 'info'))
const shownChecks = computed(() => (situation.value === 'info' ? checks.value.filter(c => c.kind !== 'info') : checks.value))
const checkFull = ref(false)
const checkLine = computed(() => (d.value.status === 'offen' ? shownChecks.value[0] ?? null : null))
const moreChecks = computed(() => (checkLine.value ? shownChecks.value.slice(1) : []))
const finished = computed(() => {
  const sent = data.value!.mail.sent
  if (isMail.value && sent) return t('mailbox.sentAt', { to: sent.to ?? d.value.recipient ?? '', at: dateTime(sent.at) })
  const at = data.value!.task.doneAt
  if (!at) return null
  if (reply.value) return t('approvals.repliedAt', { at: dateTime(at) })
  return isMail.value ? t('mailbox.markedSent', { at: dateTime(at) }) : t('mailbox.doneAt', { at: dateTime(at) })
})
const canResend = computed(() => canEdit.value && isMail.value && !!data.value!.mail.sent && data.value!.mail.ready && !mailOff.value)
const doneLabel = computed(() => (isMail.value ? t('approvals.sent') : t('approvals.posted')))

const postLead = usePostLead()
const postState = computed(() => (situation.value === 'auto' && d.value.status === 'freigegeben' ? postLead({ status: data.value!.task.status, platform: autoNames.value, hasAccount: true, live: data.value!.social.live, at: data.value!.social.planned, post: data.value!.social.posts[0] ?? null }) : null))

type Act = 'send' | 'mailto' | 'copyOpen' | 'copy' | 'approve' | 'done' | 'edit' | 'reject' | 'stop'
const pending = ref<Act | null>(null)
const result = ref<string | null>(null)
watch(id, () => (result.value = null))
const acts = computed<Act[]>(() => {
  const offen = d.value.status === 'offen'
  const copyMain: Act = target.value ? 'copyOpen' : 'copy'
  let list: Act[]
  if (situation.value === 'mail') list = data.value!.mail.ready ? ['send', 'edit', 'mailto', 'done', 'copy', 'reject'] : ['mailto', 'done', 'edit', 'copy', 'reject']
  else if (situation.value === 'reply') list = offen ? ['approve', 'edit', 'copy', 'reject'] : ['edit', 'copy', 'reject']
  else if (situation.value === 'auto' || situation.value === 'blog') list = offen ? ['approve', 'edit', 'copy', 'done', 'reject'] : ['edit', 'copy', 'done', 'reject']
  else list = [copyMain, 'done', 'edit', ...(copyMain === 'copyOpen' ? ['copy' as Act] : []), 'approve', 'reject']
  list = list.filter(a => a !== 'approve' || (offen && !infoNeeded.value))
  return stoppable.value ? ['stop', ...list] : list
})
const stoppable = computed(() => canEdit.value && d.value.status === 'freigegeben' && data.value!.task.status === 'freigegeben' && !data.value!.task.doneAt && data.value!.social.posts[0]?.status !== 'laeuft')
const byReviewer = computed(() => stoppable.value && d.value.approvedVia === 'reviewer')
const copied = ref(false)
watch(id, () => (copied.value = false))
const todoFor = useTodo()
const todo = computed(() => {
  const x = data.value!.task
  const f = data.value!.todo
  const p = data.value!.social.posts[0]
  const sent = data.value!.mail.sent
  const blogAt = data.value!.blog.at && new Date(data.value!.blog.at).getTime() > Date.now() ? data.value!.blog.at : null
  const out = situation.value === 'mail' ? (data.value!.mail.ready ? 'mail' : 'mailSelf') : situation.value === 'info' ? f.out : situation.value
  return todoFor({
    status: x.status,
    category: x.category,
    draftKind: d.value.kind,
    forClaude: x.forClaude,
    draft: d.value.status === 'offen' ? 'open' : d.value.status === 'freigegeben' ? 'approved' : 'gone',
    info: situation.value === 'info',
    out,
    route: f.route,
    scheduledAt: out === 'auto' ? (p?.status === 'geplant' ? p.scheduledAt : data.value!.social.planned) : out === 'blog' ? blogAt : null,
    running: p?.status === 'laeuft',
    platform: out === 'auto' ? autoNames.value : reply.value ? platformRule(reply.value.platform).label : platformName.value,
    place: service.value?.name ?? dest.value.place ?? (target.value ? hostPath(target.value) : null),
    placeKind: isMail.value ? 'mail' : dest.value.kind,
    missing: dest.value.missing,
    url: target.value,
    flair: thread.value ? null : subRules.value?.flair ?? f.flair,
    flairRequired: !thread.value && !!(subRules.value?.flairRequired ?? f.flairRequired),
    waitDay: thread.value ? null : f.waitDay,
    to: d.value.recipient,
    host: data.value!.blog.host,
    humanStep: x.humanStep,
    estimateMin: x.estimateMin ?? null,
    doneAt: sent?.at ?? x.doneAt,
    posted: !isMail.value && !!x.doneAt,
    sent: isMail.value && (!!sent || !!x.doneAt),
  })
})
const doneLink = computed(() => safeHttpUrl(data.value?.task.postedUrl))
const primary = computed<Act | null>(() => {
  const m = todo.value.todo.main
  if (stoppable.value && (route.query.stoppen === '1' || byReviewer.value)) return 'stop'
  if (m === 'approve') return acts.value.includes('approve') ? 'approve' : null
  if (m === 'send' || m === 'mailto') return acts.value.includes(m) ? m : null
  if (m === 'copyOpen' || m === 'copy') return copied.value && acts.value.includes('done') ? 'done' : acts.value.includes(m) ? m : acts.value.includes('copy') ? 'copy' : null
  return null
})
const quiet = computed(() => !primary.value)
const visible = computed(() => (primary.value ? [primary.value] : []))
const more = computed(() => acts.value.filter(a => a !== primary.value))
const ACT_ICON: Record<Act, string> = { send: 'send', mailto: 'mail', copyOpen: 'external', copy: 'copy', approve: 'check', done: 'check', edit: 'edit', reject: 'x', stop: 'x' }
function actLabel(a: Act): string {
  if (a === 'send') return t('mailbox.send')
  if (a === 'mailto') return t('approvals.openMail')
  if (a === 'copyOpen') return t('approvals.copyOpen')
  if (a === 'copy') return t('approvals.copy')
  if (a === 'approve') return situation.value === 'reply' ? t('approvals.approveReply') : t('approvals.approve')
  if (a === 'done') return doneLabel.value
  if (a === 'edit') return t('approvals.edit')
  if (a === 'stop') return t('approvals.stop')
  return t('approvals.reject')
}
function run(a: Act) {
  menuOpen.value = false
  if (a === 'send') return sendNow()
  if (a === 'copyOpen') return copy(true).then(() => (copied.value = true))
  if (a === 'copy') return copy(false).then(() => (copied.value = true))
  if (a === 'approve') return act('approve', 'approve')
  if (a === 'stop') return stopNow()
  if (a === 'done') mode.value = 'done'
  else if (a === 'edit') startEdit()
  else if (a === 'reject') mode.value = 'reject'
}

const panel = useChatPanel()
let chatToken = 0
watch(() => data.value?.task, (tk) => {
  if (tk) chatToken = panel.setTask({ taskId: tk.id, code: tk.code, title: tk.title })
}, { immediate: true })
onBeforeUnmount(() => panel.clearTask(chatToken))
const waiting = computed(() => panel.writing.value === d.value.taskId)
watch(panel.latest, async (v) => {
  if (!v || v.taskId !== d.value.taskId || v.id === d.value.id || v.version <= d.value.version) return
  await openNewer(v.id, true)
})
onMounted(() => {
  if (situation.value === 'info' && panel.wide()) panel.show()
})
function answer() {
  panel.mode.value = 'task'
  panel.show()
  nextTick(() => setTimeout(() => (document.querySelector('.chatcol textarea') as HTMLTextAreaElement | null)?.focus(), 50))
}
const otherNotes = computed(() => data.value!.notes.filter(n => !isTalkNote(n) && !isRedditNote(n.text) && n.id !== checkLine.value?.id && !moreChecks.value.some(c => c.id === n.id)).slice(0, 5))
const detailCount = computed(() => moreChecks.value.length + otherNotes.value.length)

const menuOpen = ref(false)
const menuRoot = ref<HTMLElement | null>(null)
function onDoc(e: MouseEvent) {
  if (menuRoot.value && !menuRoot.value.contains(e.target as Node)) menuOpen.value = false
}
watch(menuOpen, o => (o ? document.addEventListener('mousedown', onDoc) : document.removeEventListener('mousedown', onDoc)))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc))

const fullText = computed(() => (d.value.kind === 'article' && d.value.subject ? `${d.value.subject}\n\n${d.value.body}` : d.value.body))

const mailto = computed(() => {
  const q = [d.value.subject ? `subject=${encodeURIComponent(d.value.subject)}` : '', `body=${encodeURIComponent(d.value.body)}`].filter(Boolean).join('&')
  return `mailto:${(d.value.recipient ?? '').split(/[;,\s]+/).filter(Boolean).map(encodeURIComponent).join(',').replace(/%40/g, '@')}?${q}`
})

const postTitle = computed(() => (!isMail.value && d.value.kind === 'post' && d.value.subject?.trim()) || null)
async function copyTitle() {
  try {
    await navigator.clipboard.writeText(postTitle.value ?? '')
    toast.push(t('approvals.titleCopied'))
  }
  catch {
    toast.push(t('common.error'), 'error')
  }
}

async function copy(open: boolean) {
  try {
    await navigator.clipboard.writeText(fullText.value)
    toast.push(t('approvals.copied'))
  }
  catch {
    toast.push(t('common.error'), 'error')
  }
  if (open && target.value) window.open(target.value, '_blank', 'noopener,noreferrer')
}

const mode = ref<'view' | 'edit' | 'reject' | 'done'>('view')
const edit = ref({ subject: '', recipient: '', targetUrl: '', body: '', variants: {} as Record<string, string> })
const showSocial = computed(() => data.value!.social.possible && d.value.kind !== 'mail')
const videoTitle = computed(() => showSocial.value && d.value.kind !== 'article' && data.value!.social.accounts.some(a => a.platform === 'youtube'))
const socialPlatforms = computed(() => data.value!.social.accounts.filter(a => a.postable).map(a => a.platform))
const fassungen = computed(() => {
  if (!showSocial.value) return []
  const chosen = data.value!.social.chosen.filter(p => socialPlatforms.value.includes(p))
  return [...chosen, ...socialPlatforms.value.filter(p => !chosen.includes(p))]
})
const langs = computed(() => (d.value.kind === 'article' ? Object.keys(d.value.variants ?? {}).filter(k => isLangKey(k) && d.value.variants[k]?.trim()) : []))
const langTab = ref('')
const langText = computed(() => (langTab.value && langs.value.includes(langTab.value) ? d.value.variants[langTab.value]! : null))
function countOf(p: string, text: string) {
  const len = postLength(p, text)
  return { len, max: platformRule(p).max, over: len > platformRule(p).max }
}
const reason = ref('')
const dropTask = ref<boolean | null>(null)
const dropTaskOn = computed(() => dropTask.value ?? obsoleteReason(reason.value))
const postedUrl = ref('')
const busy = ref(false)

function startEdit() {
  edit.value = { subject: d.value.subject ?? '', recipient: d.value.recipient ?? '', targetUrl: d.value.targetUrl ?? '', body: d.value.body, variants: Object.fromEntries([...fassungen.value, ...langs.value].map(p => [p, d.value.variants?.[p] ?? ''])) }
  mode.value = 'edit'
}

async function saveEdit() {
  busy.value = true
  try {
    const res = await $fetch<{ id: string }>(`/api/drafts/${d.value.id}`, { method: 'PATCH', body: { subject: edit.value.subject || null, recipient: edit.value.recipient || null, targetUrl: edit.value.targetUrl || null, body: edit.value.body, ...(showSocial.value || langs.value.length ? { variants: edit.value.variants } : {}) } })
    mode.value = 'view'
    toast.push(t('tasks.saved'))
    await navigateTo(`${base.value}/freigaben/${res.id}`, { replace: true })
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const alts = computed(() => Object.entries(d.value.variants ?? {}).filter(([k, v]) => /^alt-\d$/.test(k) && v.trim()).map(([key, text]) => ({ key, text })))
async function pickAlt(key: string) {
  busy.value = true
  try {
    const res = await $fetch<{ id: string }>(`/api/drafts/${d.value.id}/pick`, { method: 'POST', body: { key } })
    toast.push(t('approvals.altPicked'))
    await navigateTo(`${base.value}/freigaben/${res.id}`, { replace: true })
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const mailOff = computed(() => isMail.value && data.value!.mail.ready && !data.value!.mail.live)
const sendBlocked = ref(false)
async function enableMail(andSend: boolean) {
  if (!andSend && !confirm(t('mailbox.liveConfirm'))) return
  if (andSend && !confirm(t('mailbox.enableSendConfirm', { to: d.value.recipient ?? '' }))) return
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { sendLive: true } })
    await refresh()
    sendBlocked.value = false
    toast.push(t('mailbox.enabled'))
  }
  catch (err) {
    toast.error(err)
    return
  }
  finally {
    busy.value = false
  }
  if (andSend) await sendNow(true)
}

async function sendNow(confirmed = false, resend = false) {
  if (mailOff.value) {
    sendBlocked.value = true
    return
  }
  const sent = data.value!.mail.sent
  if (resend && sent && !confirm(t('mailbox.resendConfirm', { at: dateTime(sent.at), to: sent.to ?? d.value.recipient ?? '' }))) return
  if (!resend && !confirmed && !confirm(t('mailbox.sendConfirm', { to: d.value.recipient ?? '' }))) return
  menuOpen.value = false
  busy.value = true
  pending.value = 'send'
  try {
    const res = await $fetch<{ status: string, to: string }>(`/api/drafts/${d.value.id}/send`, { method: 'POST', body: { resend }, timeout: 100_000 })
    const msg = res.status === 'gesendet' ? t('mailbox.sent', { to: res.to }) : t('mailbox.dry', { to: res.to })
    toast.push(msg, res.status === 'gesendet' ? 'ok' : 'error')
    await Promise.all([refresh(), refreshBoot()])
    result.value = msg
  }
  catch (err) {
    const e = err as { name?: string, data?: { data?: { code?: string } } }
    if (e?.data?.data?.code === 'already_sent') {
      toast.push(t('mailbox.alreadySent'), 'error')
      await refresh()
    }
    else if (e?.data?.data?.code === 'smtp_unreachable' || e?.name === 'TimeoutError' || /operation was aborted|timeout/i.test(String((err as Error)?.message ?? ''))) toast.push(t('mailbox.unreachable'), 'error')
    else toast.error(err)
  }
  finally {
    busy.value = false
    pending.value = null
  }
}

async function stopNow() {
  busy.value = true
  pending.value = 'stop'
  try {
    await $fetch(`/api/drafts/${d.value.id}/stop`, { method: 'POST' })
    toast.push(t('approvals.stopped'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
    pending.value = null
  }
}

async function act(action: 'approve' | 'reject' | 'posted', from: Act | null = null) {
  busy.value = true
  pending.value = from
  try {
    const res = await $fetch<{ scheduledAt?: string, publishAt?: string, warning?: string }>(`/api/drafts/${d.value.id}/action`, { method: 'POST', body: { action, reason: reason.value || null, postedUrl: postedUrl.value || null, ...(action === 'reject' ? { dropTask: dropTaskOn.value } : {}) } })
    if (res.warning) toast.push(res.warning, 'error')
    const msg = action === 'approve' ? (res.scheduledAt ? t('publish.scheduled', { at: dateTime(res.scheduledAt) }) : res.publishAt ? t('approvals.blogScheduled', { at: dateTime(res.publishAt) }) : reply.value ? t('approvals.replyQueued') : t('approvals.approved')) : action === 'reject' ? (dropTaskOn.value ? t('approvals.rejectedTask') : t('approvals.rejected')) : isMail.value ? t('approvals.doneMail') : t('approvals.done')
    toast.push(msg)
    mode.value = 'view'
    await Promise.all([refresh(), refreshBoot()])
    if (action !== 'approve') await navigateTo(`${base.value}/freigaben`)
    else result.value = res.warning ? `${msg} - ${res.warning}` : msg
  }
  catch (err) {
    const newerId = (err as { data?: { data?: { newerId?: string } } })?.data?.data?.newerId
    if (newerId) {
      toast.push(t('approvals.newerFound'), 'error')
      mode.value = 'view'
      await openNewer(newerId)
    }
    else toast.error(err)
  }
  finally {
    busy.value = false
    pending.value = null
  }
}
</script>

<template>
  <div v-if="data" class="page">
    <div>
      <p class="crumbs"><NuxtLink :to="`${base}/freigaben`">{{ t('approvals.title') }}</NuxtLink> / {{ data.task.code }}</p>
      <div class="page-head"><h1>{{ data.task.title }}</h1></div>
      <p v-if="fromVersion && !newer" class="newer-note" role="status">{{ t('approvals.newerOpened', { v: d.version }) }}</p>
      <div class="sub">
        <span v-if="infoNeeded" class="pill s-wartet">{{ t('approvals.infoBadge') }}</span>
        <span v-else-if="d.status !== 'offen'" class="pill" :class="`s-${d.status === 'freigegeben' ? 'erledigt' : 'verworfen'}`">{{ reply && d.status === 'freigegeben' && data.task.doneAt ? t('approvals.replied') : t(`approvals.status.${d.status}`) }}</span>
        <span class="tag"><span class="sq" :style="{ background: data.project ? `var(--c-${data.project.color})` : 'var(--t-all)' }" />{{ data.project?.name ?? t('task.allProjects') }}</span>
        <span class="tag"><Icon :name="isMail ? 'mail' : d.kind === 'post' ? 'post' : 'doc'" />{{ t(`kind.${d.kind}`) }} v{{ d.version }}</span>
        <span class="tag"><OwnerBadge v-if="d.byAgent" owner="agent" />{{ d.byAgent ? t('approvals.byAgent') : memberById(d.createdByUserId)?.name ?? t('approvals.byUser') }}, {{ dateTime(d.createdAt) }}</span>
        <span v-if="d.aiGenerated" class="tag" :title="t('approvals.aiDraftHint')">{{ t('approvals.aiDraft') }}</span>
        <span v-if="data.task.dueDate" class="tag mono">{{ dayDm(data.task.dueDate) }}<template v-if="data.task.dueTime"> {{ data.task.dueTime }}</template></span>
      </div>
    </div>

    <section v-if="newer" class="panel guide warn newer" role="status">
      <p class="lead">{{ t('approvals.newerExists', { v: newer.version }) }}</p>
      <div class="actionbar"><NuxtLink :to="`${base}/freigaben/${newer.id}`" class="btn primary">{{ t('approvals.openNewer') }}</NuxtLink></div>
    </section>

    <section v-if="isOpen && !newer && data.privacy?.length" class="panel guide warn privacy" role="alert">
      <p class="lead"><b>{{ t('approvals.privacyTitle') }}</b> {{ t('approvals.privacyHint') }}</p>
      <ul><li v-for="p in data.privacy" :key="p">{{ p }}</li></ul>
    </section>

    <TodoBox v-if="finished && !newer && isOpen" :view="todo" :link="doneLink">
      <div v-if="canResend" class="actionbar">
        <div ref="menuRoot" class="more">
          <button type="button" class="btn ghost" aria-haspopup="true" :aria-expanded="menuOpen" :disabled="busy" @click="menuOpen = !menuOpen"><span v-if="pending === 'send'" class="spin" />{{ t('approvals.more') }}<Icon name="chevron-down" :size="12" /></button>
          <div v-if="menuOpen" class="menu" role="menu">
            <button type="button" class="item" role="menuitem" :disabled="busy" @click="sendNow(false, true)"><Icon name="send" />{{ t('mailbox.resend') }}</button>
          </div>
        </div>
      </div>
    </TodoBox>
    <TodoBox v-else-if="!isOpen && !newer" :view="todo" />
    <TodoBox v-else-if="isOpen && !newer" :view="todo" :warn="situation === 'info' || !!postState?.warn || dest.missing || mailOff">
      <p v-if="waiting" class="wait" role="status"><span class="spin" />{{ t('approvals.writing') }}</p>
      <template v-else-if="situation === 'info'">
        <blockquote v-for="q in questions" :key="q.id" class="question"><ClampText :text="q.text" :lines="4" /></blockquote>
        <div v-if="canEdit" class="actionbar">
          <button type="button" class="btn primary" @click="answer"><Icon name="chat" />{{ t('approvals.answer') }}</button>
          <button type="button" class="btn ghost danger" @click="mode = 'reject'">{{ t('approvals.reject') }}</button>
        </div>
      </template>
      <template v-else>
        <p v-if="situation === 'reply' && d.status === 'offen'" class="why">
          <i18n-t keypath="approvals.lead.reply" tag="span" scope="global"><template #handle><b>{{ replyHandle }}</b></template><template #post><a v-if="replyTarget" :href="replyTarget" target="_blank" rel="noopener noreferrer">{{ hostPath(replyTarget) }}</a><b v-else>{{ platformName }}</b></template></i18n-t>
        </p>
        <p v-else-if="postState?.warn" class="why warn-text">{{ postState.text }} <NuxtLink v-if="postState.switch" to="/einstellungen/veroeffentlichen">{{ t('outlet.switchLink') }}</NuxtLink></p>
        <ServiceInfo v-if="service && situation === 'self'" :service="service" />
        <p v-if="reddit && reddit.kind !== 'thread'" class="why">
          {{ reddit.kind === 'access' ? t('approvals.redditAccess') : t('approvals.redditNone') }}
          <a :href="reddit.url" target="_blank" rel="noopener noreferrer">{{ t('approvals.redditSearch') }}</a><template v-if="reddit.kind === 'access' && isAdmin"> - <NuxtLink to="/einstellungen/apps?app=reddit">{{ t('approvals.redditSettings') }}</NuxtLink></template>
        </p>
        <ol v-if="situation === 'self' && !dest.missing && serviceSteps.length" class="steps">
          <li><i18n-t :keypath="openKey" tag="span" scope="global"><template #where><a v-if="target" :href="target" target="_blank" rel="noopener noreferrer">{{ where }}</a><b v-else>{{ where }}</b></template></i18n-t></li>
          <template v-if="serviceSteps.length">
            <li v-for="st in serviceSteps" :key="st">{{ st }}</li>
          </template>
          <template v-else>
            <li>{{ t('approvals.steps.copy') }}</li>
            <li>{{ community ? t('approvals.steps.post') : t('approvals.steps.publish') }}</li>
            <li>{{ t('approvals.steps.done', { label: doneLabel }) }}</li>
          </template>
        </ol>
        <div v-if="situation === 'self' && postTitle" class="ptitle">
          <span class="ptitle-label">{{ t('approvals.postTitle') }}</span>
          <b class="ptitle-text">{{ postTitle }}</b>
          <button type="button" class="btn ghost small" @click="copyTitle"><Icon name="copy" />{{ t('approvals.copyTitle') }}</button>
        </div>
      </template>
      <div v-if="mailOff && situation === 'mail' && !waiting" class="checks" role="status">
        <p><b>{{ sendBlocked ? t('mailbox.notSent') : t('mailbox.off') }}</b> <template v-if="data.mail.locked">{{ t('mailbox.offLocked') }}</template><template v-else-if="!isAdmin">{{ t('mailbox.offAdmin') }}</template></p>
        <div v-if="isAdmin && !data.mail.locked" class="actionbar">
          <button type="button" class="btn" :class="{ primary: sendBlocked }" :disabled="busy" @click="enableMail(sendBlocked)">{{ sendBlocked ? t('mailbox.enableAndSend') : t('mailbox.enable') }}</button>
        </div>
      </div>
      <p v-if="byReviewer && mode === 'view' && !waiting" class="check-line" role="status"><b>{{ t('approvals.viaReviewerHint') }}</b> {{ d.releaseAt ? t('approvals.reviewerGoesOut', { time: dateTime(d.releaseAt) }) : t('approvals.reviewerStopHint') }}</p>
      <p v-if="result && mode === 'view'" class="result" role="status"><Icon name="check" class="ok-icon" />{{ result }}</p>
      <p v-if="checkLine && !waiting" class="check-line" :class="{ full: checkFull }" role="status" :title="checkLine.text" @click="checkFull = !checkFull"><b>{{ checkLine.kind === 'info' ? t('approvals.infoNeeded') : t('task.pleaseCheck') }}</b> {{ checkLine.text }}</p>
      <div v-if="canEdit && mode === 'view' && situation !== 'info' && !waiting" class="actionbar" :class="{ quiet }">
        <template v-for="a in visible" :key="a">
          <a v-if="a === 'mailto'" :href="mailto" class="btn primary"><Icon :name="ACT_ICON[a]" />{{ actLabel(a) }}</a>
          <button v-else type="button" class="btn primary" :disabled="busy || (!!todo.todo.waitDay && (a === 'copyOpen' || a === 'copy' || a === 'done'))" @click="run(a)"><span v-if="pending === a" class="spin" /><Icon v-else :name="ACT_ICON[a]" />{{ actLabel(a) }}</button>
        </template>
        <div v-if="more.length" ref="menuRoot" class="more">
          <button type="button" class="btn ghost" aria-haspopup="true" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">{{ t('approvals.more') }}<Icon name="chevron-down" :size="12" /></button>
          <div v-if="menuOpen" class="menu" role="menu">
            <template v-for="a in more" :key="a">
              <a v-if="a === 'mailto'" :href="mailto" class="item" role="menuitem" @click="menuOpen = false"><Icon :name="ACT_ICON[a]" />{{ actLabel(a) }}</a>
              <button v-else type="button" class="item" :class="{ danger: a === 'reject' }" role="menuitem" :disabled="busy" @click="run(a)"><Icon :name="ACT_ICON[a]" />{{ actLabel(a) }}</button>
            </template>
          </div>
        </div>
      </div>
      <WhereTarget v-if="ownDest && dest.missing" :where="dest" :project="data.project" @saved="refresh()" />
      <div v-else-if="ownDest || mark" class="dest">
        <WhereTarget v-if="ownDest" :where="dest" :project="data.project" @saved="refresh()" />
        <PostTarget v-else-if="mark" :platform="mark" :accounts="markAccounts" :possible="data.social.possible" />
      </div>
    </TodoBox>

    <form v-if="mode === 'done'" class="panel inline-form" @submit.prevent="act('posted')">
      <label class="field"><span>{{ t('approvals.postedUrl') }}</span><input v-model="postedUrl" class="input" type="url" placeholder="https://"></label>
      <div class="form-actions"><button type="submit" class="btn ok" :disabled="busy"><span v-if="busy" class="spin" />{{ isMail ? t('approvals.sent') : t('approvals.posted') }}</button><button type="button" class="btn ghost" @click="mode = 'view'">{{ t('common.cancel') }}</button></div>
    </form>
    <form v-if="mode === 'reject'" class="panel inline-form" @submit.prevent="act('reject')">
      <label class="field"><span>{{ t('approvals.rejectReason') }}</span><textarea v-model="reason" class="textarea" rows="3" /></label>
      <label class="drop-task"><input type="checkbox" :checked="dropTaskOn" @change="dropTask = ($event.target as HTMLInputElement).checked"> {{ t('approvals.dropTask') }}</label>
      <div class="form-actions"><button type="submit" class="btn danger" :disabled="busy"><span v-if="busy" class="spin" />{{ t('approvals.reject') }}</button><button type="button" class="btn ghost" @click="mode = 'view'">{{ t('common.cancel') }}</button></div>
    </form>

    <section v-if="mode === 'edit'" class="panel">
      <form class="panel-body edit" @submit.prevent="saveEdit">
        <div class="form-grid">
          <label v-if="isMail" class="field"><span>{{ t('approvals.to') }}</span><input v-model="edit.recipient" class="input"></label>
          <label v-if="!isMail" class="field"><span>{{ t('approvals.postAtUrl') }}</span><input v-model="edit.targetUrl" class="input" type="url"></label>
          <label v-if="isMail || d.kind === 'article' || (d.kind === 'post' && community)" class="field wide"><span>{{ d.kind === 'post' ? t('approvals.postTitle') : t('approvals.subject') }}</span><input v-model="edit.subject" class="input"></label>
          <label v-else-if="videoTitle" class="field wide"><span>{{ t('approvals.videoTitle') }}</span><input v-model="edit.subject" class="input" maxlength="100" :placeholder="t('approvals.videoTitleHint')"></label>
          <label class="field wide"><span>{{ t('kind.text') }}</span><textarea v-model="edit.body" class="textarea" rows="16" required /></label>
          <template v-if="showSocial">
            <label v-for="p in fassungen" :key="p" class="field wide">
              <span class="vlabel"><PlatformMark :platform="p" :size="18" />{{ t('publish.variantFor', { p: platformRule(p).label }) }}<span class="mono count" :class="{ over: countOf(p, edit.variants[p] || edit.body).over }">{{ countOf(p, edit.variants[p] || edit.body).len }}/{{ platformRule(p).max }}</span></span>
              <textarea v-model="edit.variants[p]" class="textarea" rows="5" :placeholder="t('publish.variantEmpty')" />
            </label>
          </template>
          <label v-for="l in langs" :key="l" class="field wide"><span>{{ t('approvals.langVersion', { lang: l.toUpperCase() }) }}</span><textarea v-model="edit.variants[l]" class="textarea" rows="12" /></label>
        </div>
        <div class="form-actions"><button type="submit" class="btn primary" :disabled="busy">{{ t('approvals.saveVersion') }}</button><button type="button" class="btn ghost" @click="mode = 'view'">{{ t('common.cancel') }}</button></div>
      </form>
    </section>

    <section v-else class="panel doc">
      <dl v-if="isMail || d.subject || hdrTarget || postLink || subRules" class="hdr">
        <template v-if="isMail"><dt>{{ t('approvals.to') }}</dt><dd>{{ d.recipient || '-' }}</dd></template>
        <template v-if="d.subject"><dt>{{ videoTitle ? t('approvals.videoTitle') : postTitle ? t('approvals.postTitle') : t('approvals.subject') }}</dt><dd><b>{{ d.subject }}</b></dd></template>
        <template v-if="thread && !source && !dest.newPost"><dt>{{ t('approvals.thread') }}</dt><dd><a :href="thread.url" target="_blank" rel="noopener noreferrer">{{ thread.title }}</a><span v-if="thread.age" class="excerpt">{{ t('approvals.threadAge', { age: thread.age }) }}</span><span v-if="thread.excerpt" class="excerpt">{{ thread.excerpt }}</span></dd></template>
        <template v-else-if="hdrTarget"><dt>{{ t('approvals.postAt') }}</dt><dd><a :href="hdrTarget" target="_blank" rel="noopener noreferrer" :title="hdrTarget">{{ hostPath(hdrTarget) }}</a></dd></template>
        <template v-if="subRules?.flair || subRules?.flairRequired"><dt>{{ t('approvals.flair') }}</dt><dd><b v-if="subRules.flair">{{ subRules.flair }}</b><template v-else>{{ t('approvals.flairRequired') }}</template></dd></template>
        <template v-if="subDays"><dt>{{ t('approvals.postDay') }}</dt><dd>{{ subDays }}</dd></template>
        <template v-if="postLink"><dt>{{ t('approvals.postLink') }}</dt><dd><a :href="postLink.url" target="_blank" rel="noopener noreferrer" :title="postLink.url">{{ hostPath(postLink.url) }}</a><span v-if="!postLink.inText" class="excerpt">{{ t('approvals.postLinkMissing') }}</span></dd></template>
      </dl>
      <ReplySource v-if="source" :source="source" :next="!dest.newPost" :via="reply ? replyHandle : null" :posted="data.task.postedUrl" />
      <DraftFassungen v-if="fassungen.length" :platforms="fassungen" :body="d.body" :variants="d.variants ?? {}" />
      <template v-else-if="langs.length">
        <div class="vtabs" role="tablist" :aria-label="t('approvals.langs')">
          <button type="button" role="tab" class="vtab" :aria-selected="!langText" @click="langTab = ''"><span class="vname">{{ t('approvals.langMain') }}</span></button>
          <button v-for="l in langs" :key="l" type="button" role="tab" class="vtab" :aria-selected="langTab === l" @click="langTab = l"><span class="vname">{{ l.toUpperCase() }}</span></button>
        </div>
        <div class="text" role="tabpanel">{{ langText ?? d.body }}</div>
      </template>
      <div v-else class="text">{{ d.body }}</div>
      <p v-if="isMail && data.mail.log.length" class="hint note">{{ data.mail.log.map(m => `${t(`mailbox.status.${m.status}`)} ${m.to ?? ''} ${dateTime(m.at)}${m.error ? `: ${m.error}` : ''}`).join(' / ') }}</p>
      <p v-if="isMail" class="hint note">{{ data.mail.ready ? t('mailbox.note', { from: data.mail.from ?? '' }) : t('approvals.mailNote') }}</p>
    </section>

    <section v-if="alts.length && mode !== 'edit' && d.status === 'offen' && !newer" class="panel alts">
      <div class="panel-head"><h2>{{ t('approvals.alts') }}</h2></div>
      <ul class="alt-list">
        <li v-for="a in alts" :key="a.key" class="alt">
          <p class="alt-text">{{ a.text }}</p>
          <button v-if="canEdit" type="button" class="btn small" :disabled="busy" @click="pickAlt(a.key)"><Icon name="check" />{{ t('approvals.pickAlt') }}</button>
        </li>
      </ul>
    </section>

    <SocialPublish v-if="showSocial && mode !== 'edit'" :draft-id="d.id" :body="d.body" :variants="d.variants ?? {}" :social="data.social" :media="data.media" :editable="canEdit && isOpen && !newer && !finished" :project-id="data.task.projectId" @changed="refresh" />

    <div class="cols">
      <details v-if="detailCount" class="panel grow notes">
        <summary class="notes-sum"><Icon name="chevron-right" :size="14" class="chev" />{{ t('task.detailsN', { n: detailCount }) }}</summary>
        <ul class="rows">
          <li v-for="c in moreChecks" :key="c.id" class="note-row"><b>{{ c.kind === 'info' ? t('approvals.infoNeeded') : t('approvals.checkFound') }}</b> {{ c.text }}</li>
          <li v-for="n in otherNotes" :key="n.id" class="note-row">
            <span class="mono dim small">{{ dateTime(n.createdAt) }}{{ n.byAgent ? ` - ${t('task.agentBy')}` : '' }}</span>
            <template v-if="statusItems(n.text)">
              <ClampText v-if="statusItems(n.text)!.rest" class="note-text" :text="statusItems(n.text)!.rest" :lines="2" />
              <StatusList :items="statusItems(n.text)!.items" class="note-status" />
            </template>
            <ClampText v-else class="note-text" :text="n.text" :lines="2" />
          </li>
        </ul>
      </details>
      <section class="panel grow">
        <div class="panel-head"><h2>{{ t('task.drafts') }}</h2><NuxtLink :to="`${base}/aufgaben/${data.task.id}`" class="to-task">{{ t('approvals.task') }}</NuxtLink></div>
        <details v-if="earlier.length" class="earlier">
          <summary>{{ t('approvals.earlier', { n: earlier.length }) }}</summary>
          <ul class="rows">
            <li v-for="v in earlier" :key="v.id">
              <NuxtLink :to="{ path: `${base}/freigaben/${v.id}`, query: { alt: '1' } }" class="row-link">
                <span class="row-title">{{ t('task.versions', { v: v.version }) }}</span>
                <span class="row-meta when">{{ v.byAgent ? t('approvals.byAgent') : t('approvals.byUser') }} - {{ dateTime(v.createdAt) }}</span>
                <span class="row-meta">{{ t(`approvals.status.${v.status}`) }}</span>
              </NuxtLink>
            </li>
          </ul>
        </details>
      </section>
    </div>
  </div>
</template>

<style scoped>
.newer-note {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--muted);
}

.result {
  margin: 0;
  display: flex;
  align-items: center;
  font-size: 13.5px;
}

.earlier summary {
  padding: 10px 20px;
  cursor: pointer;
  font-size: 13.5px;
  color: var(--muted);
}

.btn .spin {
  width: 12px;
  height: 12px;
}
.wait {
  display: flex;
  align-items: center;
  gap: 10px;
}

.spin {
  width: 14px;
  height: 14px;
  border: 2px solid var(--line2);
  border-top-color: var(--agent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.checks {
  display: grid;
  gap: 4px;
  font-size: 13.5px;
}

.checks p {
  margin: 0;
}

.sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--muted);
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.guide {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-left: 3px solid var(--agent);
}

.guide.warn {
  border-left-color: var(--warn);
}

.privacy ul {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 13.5px;
}

.ok-icon {
  color: var(--up);
  margin-right: 6px;
  vertical-align: -2px;
}

.lead {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.question {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--line2);
  background: var(--panel2);
  border-radius: 0 6px 6px 0;
  font-size: 14px;
  white-space: pre-line;
}

.why {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.warn-text {
  color: var(--warn);
}

.dest {
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.steps {
  margin: 0;
  padding-left: 22px;
  display: grid;
  gap: 4px;
  font-size: 14px;
}

.steps a {
  overflow-wrap: anywhere;
}

.ptitle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel2);
  font-size: 14px;
}

.ptitle-label {
  color: var(--dim);
}

.ptitle-text {
  flex: 1 1 240px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.actionbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.more {
  position: relative;
}

.actionbar.quiet {
  justify-content: flex-end;
  margin-top: 0;
}

.actionbar.quiet .menu {
  left: auto;
  right: 0;
}

.menu {
  position: absolute;
  z-index: 50;
  left: 0;
  top: calc(100% + 6px);
  min-width: 220px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--line2);
  border-radius: 10px;
  box-shadow: var(--shadow);
}

.item {
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

.item:hover {
  background: var(--panel2);
}

.item.danger {
  color: var(--down);
}

.drop-task {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.inline-form {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: -16px;
}

.doc {
  overflow: hidden;
}

.hdr {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--panel2);
  font-size: 13.5px;
}

.hdr dt {
  color: var(--dim);
}

.hdr dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.excerpt {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 13px;
}

.text {
  padding: 20px;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.65;
  max-width: 72ch;
  overflow-wrap: anywhere;
}

.alt-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.alt {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
}

.alt-text {
  flex: 1 1 auto;
  margin: 0;
  white-space: pre-wrap;
  font-size: 14.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.note {
  overflow-wrap: anywhere;
  margin: 0;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
}

.edit {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-start;
}

.grow {
  flex: 1 1 320px;
}

.note-row {
  padding: 10px 16px;
  font-size: 13px;
}

.note-text,
.note-status {
  margin-top: 4px;
}

.check-line {
  cursor: pointer;
  margin: 0;
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.check-line.full {
  white-space: normal;
  overflow-wrap: anywhere;
}

.notes-sum {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}

.notes-sum::-webkit-details-marker {
  display: none;
}

.notes[open] .chev {
  transform: rotate(90deg);
}

.notes > .rows {
  border-top: 1px solid var(--line);
}

.small {
  font-size: 11.5px;
}

.to-task {
  margin-left: auto;
  font-size: 13px;
}

.cur {
  background: var(--agent-soft);
}

.vtabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  scrollbar-width: none;
}

.vtab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 13.5px;
  white-space: nowrap;
  cursor: pointer;
}

.vtab[aria-selected='true'] {
  color: var(--text);
  border-bottom-color: var(--agent);
  font-weight: 500;
}

.count {
  font-size: 11.5px;
  color: var(--dim);
  font-weight: 400;
}

.count.over {
  color: var(--down);
}

.vlabel {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.vlabel .count {
  margin-left: auto;
}

/* Handy */
@media (max-width: 600px) {
  .actionbar > .btn {
    flex: 1 1 auto;
  }

  .guide {
    padding: 14px 16px;
  }

  .menu {
    left: auto;
    right: 0;
  }

  .text {
    padding: 16px;
  }

  .when {
    display: none;
  }
}
</style>
