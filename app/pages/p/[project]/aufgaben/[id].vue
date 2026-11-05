<script setup lang="ts">
import { draftChecks, isTalkNote } from '~~/shared/utils/talk'
import { mailExcerpt, parseMailDesc, splitOrder, statusItems } from '~~/shared/utils/digest'
import { openStaleHint, STALE_KEEP } from '~~/shared/utils/stale'
import { safeHttpUrl } from '~~/shared/utils/url'
import { OPEN_STATUSES, STATUS_FLOW, type DraftKind, type TaskStatus } from '~~/shared/utils/domain'
import { markOf } from '~~/shared/utils/drafting'
import { PLATFORM_RULES, platformRule } from '~~/shared/utils/social'
import { postTarget, type TaskWhere } from '~~/shared/utils/where'
import type { TodoServerFacts } from '~~/server/lib/todo'
import { linkLabel, type TaskLink } from '~~/shared/utils/links'
import { postErrorText } from '~~/shared/utils/post-errors'
import { openFirst, type CheckItem } from '~~/shared/utils/task-check'
import type { TaskService } from '~~/shared/utils/service'
import { sourceRest, type ReplySource } from '~~/shared/utils/reply-source'

interface Detail {
  task: {
    id: string, code: string, title: string, description: string | null, projectId: string | null, category: string, channel: string | null, language: string | null
    dueDate: string | null, dueTime: string | null, durationMin: number, estimateMin: number | null, prio: 'P1' | 'P2' | 'P3', status: TaskStatus, agentStep: string | null, humanStep: string | null
    assigneeUserId: string | null, draftKind: DraftKind | null, targetUrl: string | null, service: TaskService | null, metric: string | null, followUpOn: string | null, milestone: boolean, postedUrl: string | null, owner: 'agent' | 'human' | 'none', doneAt: string | null
    checkKind: 'seo' | 'seo-drop' | 'directory' | 'post' | null
    forClaude: boolean
  }
  project: { id: string, slug: string, name: string, color: string, url: string | null } | null
  utmUrl: string | null
  where: TaskWhere
  todo: TodoServerFacts
  drafts: { id: string, version: number, kind: DraftKind, subject: string | null, recipient: string | null, body: string, variants: Record<string, string> | null, status: string, byAgent: boolean, createdAt: string }[]
  notes: { id: string, text: string, byAgent: boolean, userId: string | null, createdAt: string }[]
  history: { id: string, action: string, actor: string, userId: string | null, detail: Record<string, unknown>, createdAt: string }[]
  results: { id: string, metric: string, value: number, note: string | null, measuredOn: string }[]
  dependsOn: { id: string, code: string, title: string, status: string } | null
  dependents: { id: string, code: string, title: string, status: string }[]
  recurrence: { id: string, rule: string, text: string, active: boolean, untilDate: string | null } | null
  agentBusy: boolean
  outlet: {
    possible: boolean, platform: string | null, accounts: { platform: string, name: string }[], live: boolean, at: string | null
    post: { status: string, scheduledAt: string, updatedAt: string, platforms: string[], error: string | null } | null
  }
  runs: { id: string, job: string, status: string, startedAt: string, summary: string | null }[]
  links: TaskLink[]
  mail: { from: string, fromName: string | null, date: string | null } | null
  source: ReplySource | null
}

const { t, te, locale } = useI18n()
const { boot, canEdit, memberById, refresh: refreshBoot } = useBoot()
const { base } = useScope()
const { dayDm, dm, dateTime, time, isoDay, num } = useFormat()
const { categoryColor } = useColors()
const toast = useToast()
const route = useRoute()
const id = computed(() => String(route.params.id))

const { data, refresh, error } = await useFetch<Detail>(() => `/api/tasks/${id.value}`, { key: computed(() => `task:${id.value}`) })
if (error.value) throw createError({ statusCode: 404, statusMessage: t('tasks.empty') })
useHead({ title: computed(() => data.value?.task.title ?? '') })

const task = computed(() => data.value!.task)
const panel = useChatPanel()
let chatToken = 0
watch(() => data.value?.task, (tk) => {
  if (tk) chatToken = panel.setTask({ taskId: tk.id, code: tk.code, title: tk.title })
}, { immediate: true })
onBeforeUnmount(() => panel.clearTask(chatToken))
watch(panel.latest, (v) => {
  if (v?.taskId === task.value.id) void refresh()
})
const notes = computed(() => data.value!.notes.filter(n => !isTalkNote(n)))
const openDraft = computed(() => data.value?.drafts.find(d => d.status === 'offen') ?? null)
const lastDraft = computed(() => data.value?.drafts[0] ?? null)
const curDraft = computed(() => data.value?.drafts.find(d => d.status === 'offen' || d.status === 'freigegeben') ?? null)
const oldDrafts = computed(() => data.value?.drafts.filter(d => d.id !== curDraft.value?.id) ?? [])
const oldOpen = ref(false)
const curFassungen = computed(() => {
  const d = curDraft.value
  if (!d || d.kind === 'mail') return []
  const own = Object.keys(d.variants ?? {}).filter(k => PLATFORM_RULES[k] && d.variants?.[k]?.trim())
  return [...new Set([...(outlet.value.possible ? outlet.value.accounts.map(a => a.platform) : []), ...own])]
})
const noDraftWhy = computed(() => data.value?.notes.filter(n => n.byAgent).at(-1)?.text ?? null)
async function copyDraft() {
  const d = curDraft.value
  if (!d) return
  try {
    await navigator.clipboard.writeText(d.subject && d.kind !== 'post' ? `${d.subject}\n\n${d.body}` : d.body)
    toast.push(t('approvals.copied'))
  }
  catch {
    toast.push(t('common.error'), 'error')
  }
}
const links = computed(() => (data.value?.links ?? []).map(l => ({ ...l, href: safeHttpUrl(l.url) })).filter((l): l is TaskLink & { href: string } => !!l.href))

const outlet = computed(() => data.value!.outlet)
const post = computed(() => outlet.value.post)
const mark = computed(() => markOf(task.value) ?? outlet.value.platform)
const where = computed(() => data.value!.where)
const ownWhere = computed(() => where.value.kind !== 'social' && where.value.kind !== 'mail' && where.value.kind !== 'none')
const approved = computed(() => data.value?.drafts.find(d => d.status === 'freigegeben') ?? null)
const taskOpen = computed(() => OPEN_STATUSES.includes(task.value.status))
const site = computed(() => (ownWhere.value && taskOpen.value ? safeHttpUrl(task.value.targetUrl) : null))
function openSite() {
  const u = site.value ?? target.value
  if (u) window.open(u, '_blank', 'noopener,noreferrer')
}
const postPending = computed(() => post.value?.status === 'laeuft' || (post.value?.status === 'geplant' && new Date(post.value.scheduledAt).getTime() < Date.now() + 60_000))
const canPost = computed(() => canEdit.value && task.value.status === 'freigegeben' && outlet.value.possible && outlet.value.accounts.length > 0 && !!approved.value)
const platformName = computed(() => (outlet.value.accounts.length ? outlet.value.accounts.map(a => platformRule(a.platform).label).join(', ') : mark.value ? platformRule(mark.value).label : ''))

const postLead = usePostLead()
const lead = computed(() => (outlet.value.possible || post.value ? postLead({ status: task.value.status, platform: platformName.value, hasAccount: outlet.value.accounts.length > 0, live: outlet.value.live, at: outlet.value.at, post: post.value }) : null))

type Act = 'review' | 'post' | 'planned' | 'agentDraft' | 'writeDraft' | 'viewDraft' | 'openSite' | 'copyOpen' | 'copy' | 'reopen' | 'status' | 'done' | 'forceDone' | 'edit'
const acts = computed<Act[]>(() => {
  const x = task.value
  const future = !!outlet.value.at && new Date(outlet.value.at).getTime() > Date.now() && post.value?.status !== 'geplant'
  const agent: Act[] = boot.value?.agent.ready && x.agentStep ? ['agentDraft'] : []
  let list: Act[]
  if (openDraft.value) list = ['review', 'done', 'edit']
  else if (canPost.value) list = ['post', 'done', ...(future ? ['planned' as Act] : []), 'viewDraft', ...agent, 'writeDraft', 'edit']
  else if (x.status === 'geplant' || x.status === 'freigegeben') list = [...agent, 'writeDraft', 'done', ...(approved.value ? ['viewDraft' as Act] : []), 'edit']
  else if (finished.value) list = ['edit', 'reopen']
  else list = ['done', 'edit']
  if (site.value && !openDraft.value) {
    const main: Act = approved.value && !canPost.value ? 'copyOpen' : 'openSite'
    if (main === 'copyOpen' || !x.agentStep) list.unshift(main)
    else list.splice(1, 0, main)
  }
  if (checkable.value) list.push('forceDone')
  return list.filter(a => (a !== 'done' && a !== 'forceDone') || quick.value.includes('erledigt'))
})
const finished = computed(() => ['erledigt', 'ausgewertet'].includes(task.value.status))
const target = computed(() => postTarget([task.value.targetUrl, where.value.url], where.value))
const infoOpen = computed(() => !!openDraft.value && draftChecks(data.value!.notes, openDraft.value.createdAt).some(c => c.kind === 'info'))
const todoFor = useTodo()
const todo = computed(() => {
  const x = task.value
  const f = data.value!.todo
  const future = !!outlet.value.at && new Date(outlet.value.at).getTime() > Date.now()
  return todoFor({
    status: x.status,
    category: x.category,
    draftKind: curDraft.value?.kind ?? x.draftKind,
    forClaude: x.forClaude,
    owner: x.owner,
    agentBusy: data.value!.agentBusy,
    draft: openDraft.value ? 'open' : approved.value ? 'approved' : null,
    info: infoOpen.value,
    out: f.out,
    route: f.route,
    scheduledAt: post.value?.status === 'geplant' ? post.value.scheduledAt : future ? outlet.value.at : null,
    running: post.value?.status === 'laeuft',
    platform: platformName.value || null,
    place: where.value.kind === 'blog' ? where.value.place : x.service?.name ?? where.value.place,
    placeKind: where.value.kind,
    missing: where.value.missing,
    url: site.value ?? target.value,
    flair: f.flair,
    flairRequired: f.flairRequired,
    waitDay: f.waitDay,
    to: data.value!.drafts[0]?.recipient ?? null,
    host: where.value.place,
    checkable: checkable.value,
    humanStep: x.humanStep,
    estimateMin: x.estimateMin,
    doneAt: x.doneAt,
    posted: !!x.postedUrl || links.value.length > 0,
    sent: x.draftKind === 'mail' && !!x.doneAt,
    sweep: f.sweep,
  })
})
const doneLink = computed(() => (todo.value.todo.key.startsWith('done.') ? safeHttpUrl(task.value.postedUrl) ?? links.value[0]?.href ?? null : null))
const primary = computed<Act | null>(() => {
  const m = todo.value.todo.main
  if (m === 'none') return null
  if (openDraft.value) return 'review'
  if ((m === 'copyOpen' || m === 'copy') && approved.value) return site.value || target.value ? 'copyOpen' : 'copy'
  if (m === 'open' && (site.value || target.value)) return 'openSite'
  if (m === 'check' || m === 'done' || m === 'open') return acts.value.includes('done') ? 'done' : null
  if (m === 'edit') return 'edit'
  return null
})
const visible = computed(() => (primary.value ? [primary.value] : []))
const more = computed(() => [...acts.value.filter(a => a !== primary.value && a !== 'reopen'), ...(!finished.value && moreStatus.value.length ? ['status' as Act] : []), ...(acts.value.includes('reopen') ? ['reopen' as Act] : [])])
const moreStatus = computed(() => STATUS_FLOW[task.value.status].filter(s => s !== 'erledigt'))
const ACT_ICON: Record<Act, string> = { review: 'approvals', post: 'send', planned: 'calendar', agentDraft: 'agent', writeDraft: 'edit', viewDraft: 'doc', openSite: 'external', copyOpen: 'external', copy: 'copy', reopen: 'history', status: 'list', done: 'check', forceDone: 'check', edit: 'edit' }
function actLabel(a: Act): string {
  if (a === 'review') return todo.value.todo.main === 'answer' ? t('todo.btn.answer') : t('todo.btn.review')
  if (a === 'copy') return t('todo.btn.copy')
  if (a === 'reopen') return t('todo.reopen')
  if (a === 'status') return t('todo.statusChange')
  if (a === 'post') return outlet.value.live ? t('outlet.postNow') : t('outlet.testNow')
  if (a === 'planned') return `${t('outlet.postPlanned')} (${dm(isoDay(outlet.value.at!))} ${time(outlet.value.at!)})`
  if (a === 'agentDraft') return data.value!.agentBusy ? t('task.agentWorking') : t('task.agentDraft')
  if (a === 'writeDraft') return t('task.writeDraft')
  if (a === 'viewDraft') return t('outlet.viewDraft')
  if (a === 'openSite') return t('approvals.openSite')
  if (a === 'copyOpen') return t('approvals.copyOpen')
  if (a === 'done') return checkable.value ? (checking.value ? t('task.checking') : t('task.check')) : t('task.markDone')
  if (a === 'forceDone') return t('task.forceDone')
  return t('task.edit')
}
function run(a: Act) {
  menuOpen.value = false
  if (a === 'review') return navigateTo(`${base.value}/freigaben/${openDraft.value!.id}`)
  if (a === 'viewDraft') return navigateTo(`${base.value}/freigaben/${approved.value!.id}`)
  if (a === 'post') return publish('now')
  if (a === 'openSite') return openSite()
  if (a === 'copyOpen') return copyDraft().then(openSite)
  if (a === 'copy') return copyDraft()
  if (a === 'reopen') return reopen()
  if (a === 'status') return openStatus()
  if (a === 'planned') return publish('planned')
  if (a === 'agentDraft') return agentDraft()
  if (a === 'writeDraft') return startDraft()
  if (a === 'done') return checkable.value ? runCheck() : setStatus('erledigt')
  if (a === 'forceDone') return setStatus('erledigt')
  startEdit()
}

const busy = ref(false)
async function publish(when: 'now' | 'planned') {
  busy.value = true
  try {
    const res = await $fetch<{ at: string, live: boolean }>(`/api/drafts/${approved.value!.id}/publish`, { method: 'POST', body: { when } })
    toast.push(when === 'planned' ? t('publish.scheduled', { at: dateTime(res.at) }) : res.live ? t('publish.sending') : t('outlet.dryDone'))
    await Promise.all([refresh(), refreshBoot()])
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const menuOpen = ref(false)
const menuRoot = ref<HTMLElement | null>(null)
function onDoc(e: MouseEvent) {
  if (menuRoot.value && !menuRoot.value.contains(e.target as Node)) menuOpen.value = false
}
watch(menuOpen, o => (o ? document.addEventListener('mousedown', onDoc) : document.removeEventListener('mousedown', onDoc)))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc))

let poll: ReturnType<typeof setInterval> | undefined
watch(() => !!data.value?.agentBusy || postPending.value, (busy) => {
  if (import.meta.server) return
  clearInterval(poll)
  if (busy) poll = setInterval(() => refresh(), 3000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(poll))

async function setStatus(status: TaskStatus) {
  menuOpen.value = false
  busy.value = true
  try {
    await $fetch(`/api/tasks/${task.value.id}`, { method: 'PATCH', body: { status } })
    await Promise.all([refresh(), refreshBoot()])
    toast.push(t('history.status', { status: t(`status.${status}`) }))
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}

const quick = computed(() => STATUS_FLOW[task.value.status])

const statusOpen = ref(false)
const statusPick = ref<TaskStatus | ''>('')
function openStatus() {
  statusPick.value = ''
  statusOpen.value = true
}
const statusWarn = computed(() => (statusPick.value === 'verworfen' && (task.value.postedUrl || links.value.length) ? t('todo.dropPosted') : ''))
async function saveStatus() {
  if (!statusPick.value) return
  statusOpen.value = false
  await setStatus(statusPick.value)
}
async function reopen() {
  const at = task.value.doneAt ? dateTime(task.value.doneAt) : ''
  const posted = !!task.value.postedUrl || links.value.length > 0
  if (!confirm(posted && at ? t('todo.reopenPosted', { at }) : t('todo.reopenAsk'))) return
  await setStatus(approved.value ? 'freigegeben' : 'wartet')
}

const checkable = computed(() => !!task.value.checkKind)
const checking = ref(false)
const checkLink = ref('')
const checkResult = ref<{ ok: boolean, closed: boolean, items: CheckItem[], needLink?: boolean } | null>(null)
const checkItems = computed(() => openFirst(checkResult.value?.items ?? []))
async function runCheck() {
  menuOpen.value = false
  checking.value = true
  busy.value = true
  try {
    const res = await $fetch<{ ok: boolean, closed: boolean, items: CheckItem[], needLink?: boolean }>(`/api/tasks/${task.value.id}/check`, { method: 'POST', body: { link: checkLink.value.trim() || null } })
    checkResult.value = res
    if (res.closed) {
      checkLink.value = ''
      toast.push(t('task.checkOk'))
      await Promise.all([refresh(), refreshBoot()])
    }
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    checking.value = false
    busy.value = false
  }
}
watch(id, () => {
  checkResult.value = null
  checkLink.value = ''
})

async function agentDraft() {
  try {
    await $fetch(`/api/tasks/${task.value.id}/agent-draft`, { method: 'POST' })
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

const editOpen = ref(false)
const editBusy = ref(false)
const form = ref(emptyTaskForm(null, null, ''))
function startEdit() {
  const x = task.value
  form.value = { project: data.value!.project?.slug ?? null, title: x.title, description: x.description ?? '', category: x.category as never, channel: x.channel ?? '', dueDate: x.dueDate ?? '', dueTime: x.dueTime ?? '', durationMin: x.durationMin, estimateMin: x.estimateMin, prio: x.prio, agentStep: x.agentStep ?? '', humanStep: x.humanStep ?? '', assigneeUserId: x.assigneeUserId, draftKind: x.draftKind, targetUrl: x.targetUrl ?? '', metric: x.metric ?? '', followUpOn: x.followUpOn ?? '' }
  editOpen.value = true
}
async function saveEdit() {
  editBusy.value = true
  try {
    const before = data.value?.project?.slug ?? null
    await $fetch(`/api/tasks/${task.value.id}`, { method: 'PATCH', body: formToBody(form.value) })
    editOpen.value = false
    toast.push(t('tasks.saved'))
    const routeSlug = String(route.params.project)
    if (form.value.project !== before && routeSlug !== 'alle') await navigateTo(`/p/${form.value.project ?? 'alle'}/aufgaben/${task.value.id}`)
    else await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    editBusy.value = false
  }
}

const draftOpen = ref(false)
const draftForm = ref({ kind: 'text' as DraftKind, subject: '', recipient: '', targetUrl: '', body: '' })
function startDraft() {
  const d = lastDraft.value
  draftForm.value = { kind: d?.kind ?? task.value.draftKind ?? 'text', subject: d?.subject ?? '', recipient: '', targetUrl: task.value.targetUrl ?? '', body: d?.body ?? '' }
  draftOpen.value = true
}
async function saveDraft() {
  try {
    const f = draftForm.value
    const res = await $fetch<{ id: string }>(`/api/tasks/${task.value.id}/drafts`, { method: 'POST', body: { kind: f.kind, subject: f.subject || null, recipient: f.recipient || null, targetUrl: f.targetUrl || null, body: f.body } })
    draftOpen.value = false
    await refreshBoot()
    await navigateTo(`${base.value}/freigaben/${res.id}`)
  }
  catch (err) {
    toast.error(err)
  }
}

const source = computed(() => (data.value?.source && data.value.source.relation !== 'mail' ? data.value.source : null))
const srcInDraft = computed(() => !!source.value && !!curDraft.value)
const descSplit = computed(() => splitOrder(sourceRest(task.value.description, source.value)))
const mailDesc = computed(() => parseMailDesc(descSplit.value.text))
const descStatus = computed(() => (mailDesc.value ? null : statusItems(descSplit.value.text)))
const descText = computed(() => (mailDesc.value ? '' : descStatus.value ? descStatus.value.rest : descSplit.value.text))
const mailOpen = ref(false)
const mailLine = computed(() => {
  const m = data.value?.mail
  const md = mailDesc.value
  if (!m && !md) return null
  const who = m?.fromName || md?.who || m?.from || ''
  const subject = md?.subject ?? ''
  if (!subject) return m?.date ? t('task.mailFrom', { who, at: dateTime(m.date) }) : t('task.mailFromNoDate', { who })
  return m?.date ? t('task.mailHead', { who, at: dateTime(m.date), subject }) : t('task.mailHeadNoDate', { who, subject })
})
const mailShort = computed(() => (mailDesc.value ? mailExcerpt(mailDesc.value.body) : ''))
async function copyOrder() {
  try {
    await navigator.clipboard.writeText(descSplit.value.order ?? '')
    toast.push(t('task.orderCopied'))
  }
  catch {
    toast.push(t('common.error'), 'error')
  }
}
const checkFull = ref(false)
const checkLine = computed(() => {
  const d = openDraft.value
  if (!d) return null
  const c = draftChecks(data.value!.notes, d.createdAt)
  return c.find(x => x.kind === 'check') ?? c[0] ?? null
})
function noteStatus(text: string) {
  return statusItems(text)
}
const descAny = computed(() => !!(descText.value || descStatus.value || descSplit.value.order || mailLine.value || (source.value && !srcInDraft.value)))
const showDrafts = computed(() => data.value!.drafts.length > 0 || data.value!.agentBusy)

const note = ref('')
const noteOpen = ref(false)
const noteBox = ref<HTMLTextAreaElement | null>(null)
async function openNote() {
  noteOpen.value = true
  await nextTick()
  noteBox.value?.focus()
}
async function addNote() {
  if (!note.value.trim()) return
  try {
    await $fetch(`/api/tasks/${task.value.id}/notes`, { method: 'POST', body: { text: note.value } })
    note.value = ''
    noteOpen.value = false
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

const staleHint = computed(() => (task.value.status === 'geplant' || task.value.status === 'entwurf_fertig' ? openStaleHint(data.value!.notes) : null))
async function keepTask() {
  try {
    await $fetch(`/api/tasks/${task.value.id}/notes`, { method: 'POST', body: { text: `${STALE_KEEP} ${t('task.stale.keepNote')}` } })
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

const endAsk = ref(false)
const ending = ref(false)
async function endSeries() {
  if (!data.value?.recurrence || ending.value) return
  ending.value = true
  try {
    const r = await $fetch<{ discarded: string[] }>(`/api/recurrences/${data.value.recurrence.id}`, { method: 'PATCH', body: { active: false } })
    endAsk.value = false
    toast.push(t('task.seriesEnded', r.discarded.length, { named: { count: r.discarded.length } }))
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    ending.value = false
  }
}

const result = ref({ metric: '', value: '' as string | number })
async function addResult() {
  if (!result.value.metric || result.value.value === '') return
  try {
    await $fetch(`/api/tasks/${task.value.id}/results`, { method: 'POST', body: { metric: result.value.metric, value: Number(result.value.value) } })
    result.value = { metric: '', value: '' }
    await refresh()
  }
  catch (err) {
    toast.error(err)
  }
}

function historyText(h: Detail['history'][number]) {
  if (h.action.startsWith('status:')) return t('history.status', { status: t(`status.${h.action.slice(7)}`) })
  if (h.action === 'moved') {
    const ch = h.detail.changes as Record<string, { to: string | null }> | undefined
    const d = ch?.dueDate?.to ?? task.value.dueDate
    return `${t('history.moved')}${d ? ` -> ${dayDm(d)}` : ''}${ch?.dueTime?.to ? ` ${ch.dueTime.to}` : ''}`
  }
  return te(`history.${h.action}`) ? t(`history.${h.action}`) : h.action
}
const POSTED = ['social_posted', 'social_posted_report', 'blog_published', 'blog_published_report', 'mail_sent', 'mail_sent_report', 'mail_resent']
function histLink(h: Detail['history'][number]): { href: string, external: boolean } | null {
  if (!POSTED.includes(h.action) && !(h.action === 'status:erledigt' && (task.value.postedUrl || links.value.length))) return null
  const urls = Array.isArray(h.detail.urls) ? (h.detail.urls as unknown[]).map(u => safeHttpUrl(typeof u === 'string' ? u : null)).filter((u): u is string => !!u) : []
  const href = urls[0] ?? safeHttpUrl(task.value.postedUrl) ?? links.value[0]?.href ?? null
  if (href) return { href, external: true }
  return approved.value ? { href: `${base.value}/freigaben/${approved.value.id}`, external: false } : null
}
const who = (actor: string, userId: string | null) => (actor === 'agent' ? t('task.agentBy') : actor === 'mcp' ? t('task.mcpBy') : actor === 'system' ? t('task.systemBy') : memberById(userId)?.name ?? '')
</script>

<template>
  <div v-if="data" class="page">
    <div>
      <p class="crumbs"><NuxtLink :to="`${base}/aufgaben`">{{ t('task.back') }}</NuxtLink> / {{ task.code }}</p>
      <div class="page-head">
        <h1>{{ task.title }}</h1>
      </div>
      <div class="sub">
        <StatusPill :status="task.status" />
        <span class="tag"><span class="sq" :style="{ background: data.project ? `var(--c-${data.project.color})` : 'var(--t-all)' }" />{{ data.project?.name ?? t('task.allProjects') }}</span>
        <span class="tag"><span class="sq" :style="{ background: categoryColor(task.category as never) }" />{{ t(`cat.${task.category}`) }}</span>
        <span v-if="task.dueDate" class="tag mono">{{ dayDm(task.dueDate) }}<template v-if="task.dueTime"> {{ task.dueTime }}</template></span>
        <span class="tag"><OwnerBadge :owner="task.owner" :user-id="task.assigneeUserId" />{{ task.owner === 'agent' ? t('cal.owner.agent') : memberById(task.assigneeUserId)?.name ?? t('task.nobody') }}</span>
      </div>
    </div>

    <TodoBox :view="todo" :link="doneLink" :warn="!!lead?.warn || where.missing">
      <div v-if="canEdit && (visible.length || more.length)" class="actionbar">
        <button v-for="a in visible" :key="a" type="button" class="btn primary" :disabled="busy || (a === 'agentDraft' && data.agentBusy) || (!!todo.todo.waitDay && (a === 'copyOpen' || a === 'copy'))" @click="run(a)"><Icon :name="ACT_ICON[a]" />{{ actLabel(a) }}</button>
        <div v-if="more.length" ref="menuRoot" class="more">
          <button type="button" class="btn ghost" aria-haspopup="true" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">{{ t('approvals.more') }}<Icon name="chevron-down" :size="12" /></button>
          <div v-if="menuOpen" class="menu" role="menu">
            <button v-for="a in more" :key="a" type="button" class="item" role="menuitem" :disabled="busy || (a === 'agentDraft' && data.agentBusy)" @click="run(a)"><Icon :name="ACT_ICON[a]" />{{ actLabel(a) }}</button>
          </div>
        </div>
      </div>
      <p v-if="lead?.warn" class="warn-text">{{ lead.text }} <NuxtLink v-if="lead.switch" to="/einstellungen/veroeffentlichen">{{ t('outlet.switchLink') }}</NuxtLink></p>
      <WhereTarget v-if="ownWhere && where.missing" :where="where" :project="data.project" :on-edit="startEdit" @saved="refresh()" />
      <ServiceInfo v-if="ownWhere && where.kind !== 'blog' && taskOpen && task.service" :service="task.service" />
      <div v-if="checkResult && checkItems.length" class="check" role="status">
        <p class="check-head">{{ checkResult.ok ? t('task.checkOk') : t('task.checkOpen') }}</p>
        <StatusList :items="checkItems" />
        <form v-if="!checkResult.ok && checkResult.needLink && canEdit" class="check-link" @submit.prevent="runCheck">
          <label class="sr-only" for="check-link">{{ t('task.checkLink') }}</label>
          <input id="check-link" v-model="checkLink" type="url" inputmode="url" :placeholder="t('task.checkLinkHint')">
          <button type="submit" class="btn" :disabled="busy">{{ checking ? t('task.checking') : t('task.check') }}</button>
        </form>
      </div>
    </TodoBox>

    <section v-if="staleHint && canEdit" class="panel stale">
      <p><strong>{{ t('task.stale.title') }}</strong> {{ staleHint }}</p>
      <div class="actionbar">
        <button type="button" class="btn primary" @click="setStatus('verworfen')">{{ t('task.stale.drop') }}</button>
        <button type="button" class="btn ghost" @click="keepTask">{{ t('task.stale.keep') }}</button>
      </div>
    </section>

    <section v-if="descAny" class="panel desc">
      <h2 class="sr-only">{{ t('task.description') }}</h2>
      <ReplySource v-if="source && !srcInDraft" class="desc-src" :source="source" :next="false" :posted="task.postedUrl" />
      <p v-if="mailLine" class="mail-meta" :title="data.mail?.from ?? mailDesc?.from">{{ mailLine }}</p>
      <template v-if="mailDesc">
        <ClampText v-if="mailOpen" class="desc-text" :text="mailDesc.body" :lines="9999" />
        <p v-else-if="mailShort" class="desc-text mail-short">{{ mailShort }}</p>
        <button type="button" class="link-btn" :aria-expanded="mailOpen" @click="mailOpen = !mailOpen">{{ mailOpen ? t('task.mailShort') : t('task.mailFull') }}</button>
      </template>
      <ClampText v-else-if="descText" class="desc-text" :text="descText" />
      <StatusList v-if="descStatus" :items="descStatus.items" class="desc-status" />
      <details v-if="descSplit.order" class="order">
        <summary>
          <span class="order-name"><Icon name="doc" :size="14" />{{ t('task.order') }}</span>
          <button type="button" class="btn ghost small" @click.prevent="copyOrder"><Icon name="copy" :size="14" />{{ t('task.orderCopy') }}</button>
        </summary>
        <pre class="order-text">{{ descSplit.order }}</pre>
      </details>
    </section>

    <div class="cols">
      <div class="main-col">
        <section v-if="showDrafts" class="panel">
          <div class="panel-head"><h2>{{ t('task.drafts') }}</h2><span class="count">{{ data.drafts.length }}</span></div>
          <template v-if="curDraft">
            <div class="draft-bar">
              <span class="pill" :class="`s-${curDraft.status === 'offen' ? 'entwurf_fertig' : 'erledigt'}`">{{ t(`approvals.status.${curDraft.status}`) }}</span>
              <span class="row-meta">{{ t('task.versions', { v: curDraft.version }) }} - {{ t(`kind.${curDraft.kind}`) }}</span>
              <span class="draft-acts">
                <NuxtLink v-if="curDraft.status === 'offen'" :to="`${base}/freigaben/${curDraft.id}`" class="btn ghost small">{{ t('task.openInApprovals') }}</NuxtLink>
                <button type="button" class="btn ghost small" @click="copyDraft"><Icon name="copy" :size="14" />{{ t('task.copy') }}</button>
              </span>
            </div>
            <p v-if="checkLine && curDraft.status === 'offen'" class="check-line" :class="{ full: checkFull }" :title="checkLine.text" @click="checkFull = !checkFull"><b>{{ checkLine.kind === 'info' ? t('approvals.infoNeeded') : t('task.pleaseCheck') }}</b> {{ checkLine.text }}</p>
            <p v-if="curDraft.subject" class="draft-subj">{{ curDraft.subject }}</p>
            <ReplySource v-if="srcInDraft && source" :source="source" :next="!where.newPost" :posted="task.postedUrl" />
            <DraftFassungen v-if="curFassungen.length" :platforms="curFassungen" :body="curDraft.body" :variants="curDraft.variants ?? {}" />
            <div v-else class="draft-text">{{ curDraft.body }}</div>
          </template>
          <p v-else-if="data.drafts.length" class="draft-none">{{ data.agentBusy ? t('task.agentWorking') : noDraftWhy ? t('task.noValidWhy', { why: noDraftWhy }) : t('task.noValid') }}</p>
          <p v-else class="empty">{{ data.agentBusy ? t('task.agentWorking') : t('task.noDrafts') }}</p>
          <template v-if="oldDrafts.length">
            <button type="button" class="old-toggle" :aria-expanded="oldOpen" @click="oldOpen = !oldOpen">
              <Icon :name="oldOpen ? 'chevron-down' : 'chevron-right'" :size="14" />{{ t('task.olderVersions', { n: oldDrafts.length }) }}
            </button>
            <ul v-if="oldOpen" class="rows old-list">
              <li v-for="d in oldDrafts" :key="d.id">
                <NuxtLink :to="`${base}/freigaben/${d.id}`" class="row-link">
                  <Icon :name="d.kind === 'mail' ? 'mail' : d.kind === 'post' ? 'post' : 'doc'" />
                  <span class="row-title">{{ t('task.versions', { v: d.version }) }} - {{ t(`kind.${d.kind}`) }}</span>
                  <span class="row-meta">{{ d.byAgent ? t('approvals.byAgent') : t('approvals.byUser') }}</span>
                  <span class="pill" :class="`s-${d.status === 'offen' ? 'entwurf_fertig' : d.status === 'freigegeben' ? 'erledigt' : 'verworfen'}`">{{ t(`approvals.status.${d.status}`) }}</span>
                </NuxtLink>
              </li>
            </ul>
          </template>
        </section>

        <button v-if="canEdit && !notes.length && !noteOpen" type="button" class="add-note" @click="openNote"><Icon name="plus" :size="14" />{{ t('task.addNote') }}</button>
        <details v-else-if="notes.length || noteOpen" class="panel notes" :open="noteOpen || undefined">
          <summary class="notes-sum"><Icon name="chevron-right" :size="14" class="chev" />{{ t('task.notes') }}<span v-if="notes.length" class="count">{{ notes.length }}</span></summary>
          <ul v-if="notes.length" class="rows">
            <li v-for="n in notes" :key="n.id" class="note">
              <span class="note-meta mono dim">{{ dateTime(n.createdAt) }} - {{ n.byAgent ? t('task.agentBy') : memberById(n.userId)?.name }}</span>
              <template v-if="noteStatus(n.text)">
                <ClampText v-if="noteStatus(n.text)!.rest" class="note-text" :text="noteStatus(n.text)!.rest" :lines="2" />
                <StatusList :items="noteStatus(n.text)!.items" class="note-status" />
              </template>
              <ClampText v-else class="note-text" :text="postErrorText(n.text, locale === 'en' ? 'en' : 'de')" :lines="2" />
            </li>
          </ul>
          <form v-if="canEdit" class="note-form" :class="{ first: !notes.length }" @submit.prevent="addNote">
            <textarea ref="noteBox" v-model="note" class="textarea" rows="2" :placeholder="t('task.notePlaceholder')" :aria-label="t('task.addNote')" />
            <div class="note-acts">
              <button type="submit" class="btn" :disabled="!note.trim()">{{ t('task.addNote') }}</button>
              <button v-if="!notes.length" type="button" class="btn ghost" @click="noteOpen = false; note = ''">{{ t('task.cancel') }}</button>
            </div>
          </form>
        </details>

        <section v-if="data.history.length" class="panel">
          <div class="panel-head"><h2>{{ t('task.history') }}</h2></div>
          <ol class="rows">
            <li v-for="h in data.history" :key="h.id" class="hist">
              <time class="mono dim">{{ dateTime(h.createdAt) }}</time>
              <span class="ellipsis">{{ historyText(h) }}</span>
              <template v-if="histLink(h)">
                <a v-if="histLink(h)!.external" :href="histLink(h)!.href" target="_blank" rel="noopener noreferrer" class="hist-link">{{ t('todo.done.view') }}</a>
                <NuxtLink v-else :to="histLink(h)!.href" class="hist-link">{{ t('todo.done.view') }}</NuxtLink>
              </template>
              <span class="dim who">{{ who(h.actor, h.userId) }}</span>
            </li>
          </ol>
        </section>
      </div>

      <div class="side-col">
        <section class="panel">
          <div class="panel-head"><h2>{{ t('task.details') }}</h2><span class="mono dim">{{ task.code }}</span></div>
          <div v-if="(ownWhere && !where.missing) || (!ownWhere && mark)" class="dest">
            <WhereTarget v-if="ownWhere" :where="where" :project="data.project" :on-edit="startEdit" @saved="refresh()" />
            <PostTarget v-else-if="mark" :platform="mark" :accounts="outlet.accounts" :possible="outlet.possible" />
          </div>
          <dl class="dl">
            <template v-if="task.agentStep"><dt>{{ t('task.agentStep') }}</dt><dd class="pre">{{ task.agentStep }}</dd></template>
            <template v-if="task.humanStep"><dt>{{ t('task.humanStep') }}</dt><dd class="pre">{{ task.humanStep }}</dd></template>
            <template v-if="task.dueDate"><dt>{{ t('task.due') }}</dt><dd>{{ dayDm(task.dueDate) }}<template v-if="task.dueTime">, {{ task.dueTime }} ({{ task.durationMin }} Min)</template></dd></template>
            <template v-if="task.estimateMin"><dt>{{ t('task.estimate') }}</dt><dd>{{ task.estimateMin }}</dd></template>
            <dt>{{ t('task.prio') }}</dt><dd>{{ task.prio }}</dd>
            <template v-if="task.channel"><dt>{{ t('task.channel') }}</dt><dd>{{ task.channel }}</dd></template>
            <template v-if="task.draftKind"><dt>{{ t('task.draftKind') }}</dt><dd>{{ t(`kind.${task.draftKind}`) }}</dd></template>
            <template v-if="task.metric"><dt>{{ t('task.metric') }}</dt><dd>{{ task.metric }}</dd></template>
            <template v-if="data.utmUrl"><dt>{{ t('task.utm') }}</dt><dd class="url"><a :href="data.utmUrl" target="_blank" rel="noopener noreferrer">{{ data.utmUrl }}</a></dd></template>
            <template v-if="links.length"><dt>{{ links.length > 1 ? t('task.postedUrls') : t('task.postedUrl') }}</dt><dd><span v-for="l in links" :key="l.url" class="plink"><span class="plink-name">{{ linkLabel(l.platform, l.url) }}</span><a class="url-a" :href="l.href" target="_blank" rel="noopener noreferrer">{{ l.url }}</a></span></dd></template>
            <template v-if="task.followUpOn"><dt>{{ t('task.followUp') }}</dt><dd>{{ dayDm(task.followUpOn) }}</dd></template>
            <template v-if="data.recurrence">
              <dt>{{ t('task.recurrence') }}</dt>
              <dd>
                {{ data.recurrence.text }}
                <span v-if="!data.recurrence.active" class="dim"> - {{ t('task.seriesOver') }}</span>
                <template v-else-if="canEdit">
                  <span v-if="endAsk" class="series-ask">{{ t('task.seriesEndAsk') }} <button type="button" class="series-link danger" :disabled="ending" @click="endSeries">{{ t('task.seriesEndYes') }}</button> <button type="button" class="series-link" @click="endAsk = false">{{ t('task.cancel') }}</button></span>
                  <button v-else type="button" class="series-link" @click="endAsk = true">{{ t('task.seriesEnd') }}</button>
                </template>
              </dd>
            </template>
            <template v-if="data.dependsOn"><dt>{{ t('task.dependsOn') }}</dt><dd><NuxtLink :to="`${base}/aufgaben/${data.dependsOn.id}`">{{ data.dependsOn.title }}</NuxtLink> ({{ t(`status.${data.dependsOn.status}`) }})</dd></template>
            <template v-if="data.dependents.length"><dt>{{ t('task.dependents') }}</dt><dd><NuxtLink v-for="d in data.dependents" :key="d.id" :to="`${base}/aufgaben/${d.id}`" class="dep">{{ d.title }}</NuxtLink></dd></template>
          </dl>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>{{ t('task.results') }}</h2></div>
          <ul v-if="data.results.length" class="rows">
            <li v-for="r in data.results" :key="r.id" class="res"><span class="ellipsis">{{ r.metric }}</span><b class="mono">{{ num(r.value) }}</b><span class="mono dim">{{ dayDm(r.measuredOn) }}</span></li>
          </ul>
          <p v-else class="empty">{{ t('task.noResults') }}</p>
          <form v-if="canEdit" class="res-form" @submit.prevent="addResult">
            <input v-model="result.metric" class="input" :placeholder="task.metric ?? t('task.resultMetric')" :aria-label="t('task.resultMetric')" list="metric-list">
            <datalist id="metric-list"><option value="Klicks" /><option value="Anmeldungen" /><option value="Antwort" /><option value="Eintrag live" /><option value="Upvotes" /><option value="Backlink" /></datalist>
            <input v-model="result.value" class="input num" type="number" step="any" :placeholder="t('task.resultValue')" :aria-label="t('task.resultValue')">
            <button type="submit" class="btn">{{ t('task.addResult') }}</button>
          </form>
        </section>
      </div>
    </div>

    <AppDialog :open="editOpen" :title="t('task.edit')" @close="editOpen = false">
      <TaskForm v-if="editOpen" v-model="form" :busy="editBusy" :submit-label="t('task.save')" @submit="saveEdit" @cancel="editOpen = false" />
    </AppDialog>

    <AppDialog :open="statusOpen" :title="t('todo.statusChange')" @close="statusOpen = false">
      <form class="draft-form" @submit.prevent="saveStatus">
        <label class="field"><span>{{ t('todo.statusNew') }}</span>
          <select v-model="statusPick" class="select" required>
            <option value="" disabled>{{ t('todo.statusPick') }}</option>
            <option v-for="st in moreStatus" :key="st" :value="st">{{ t(`status.${st}`) }}</option>
          </select>
        </label>
        <p v-if="statusWarn" class="warn-text">{{ statusWarn }}</p>
        <div class="form-actions">
          <button type="submit" class="btn primary" :disabled="!statusPick || busy">{{ t('todo.statusSave') }}</button>
          <button type="button" class="btn ghost" @click="statusOpen = false">{{ t('task.cancel') }}</button>
        </div>
      </form>
    </AppDialog>

    <AppDialog :open="draftOpen" :title="t('task.writeDraft')" @close="draftOpen = false">
      <form class="draft-form" @submit.prevent="saveDraft">
        <div class="form-grid">
          <label class="field"><span>{{ t('task.draftKind') }}</span>
            <select v-model="draftForm.kind" class="select"><option v-for="k in (['post', 'mail', 'article', 'text'] as const)" :key="k" :value="k">{{ t(`kind.${k}`) }}</option></select>
          </label>
          <label v-if="draftForm.kind === 'mail'" class="field"><span>{{ t('approvals.to') }}</span><input v-model="draftForm.recipient" class="input" type="email"></label>
          <label v-else class="field"><span>{{ t('approvals.postAtUrl') }}</span><input v-model="draftForm.targetUrl" class="input" type="url" placeholder="https://"></label>
          <label v-if="draftForm.kind === 'mail' || draftForm.kind === 'article'" class="field wide"><span>{{ t('approvals.subject') }}</span><input v-model="draftForm.subject" class="input"></label>
          <label class="field wide"><span>{{ t('kind.text') }}</span><textarea v-model="draftForm.body" class="textarea" rows="12" required /></label>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn primary" :disabled="!draftForm.body.trim()">{{ t('task.save') }}</button>
          <button type="button" class="btn ghost" @click="draftOpen = false">{{ t('task.cancel') }}</button>
        </div>
      </form>
    </AppDialog>
  </div>
</template>

<style scoped>
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

.dest {
  padding: 12px 16px 0;
}

.warn-text {
  margin: 0;
  font-size: 13.5px;
  color: var(--warn);
}

.stale {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 20px;
  border-left: 3px solid var(--warn);
}

.stale p {
  margin: 0;
}

.actionbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.more {
  position: relative;
}

.check {
  display: grid;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.check-head {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.check-link {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.check-link input {
  flex: 1 1 240px;
  min-width: 0;
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
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
}

.item:hover {
  background: var(--panel2);
}

.sep {
  margin: 6px 4px;
  border: 0;
  border-top: 1px solid var(--line);
}

.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-start;
}

.main-col {
  flex: 999 1 480px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.side-col {
  flex: 1 1 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.draft-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
}

.draft-acts {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.draft-subj {
  margin: 0;
  padding: 16px 20px 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.draft-text {
  padding: 16px 20px 20px;
  white-space: pre-wrap;
  font-size: 14.5px;
  line-height: 1.65;
  max-width: 72ch;
  overflow-wrap: anywhere;
}

.draft-none {
  margin: 0;
  padding: 20px 16px;
  color: var(--muted);
  font-size: 13.5px;
  overflow-wrap: anywhere;
}

.old-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 0 16px;
  border: 0;
  border-top: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.old-toggle:hover {
  color: var(--text);
  background: var(--panel2);
}

.series-link {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  text-decoration: underline;
  cursor: pointer;
}

.series-link:hover {
  color: var(--text);
}

.series-link.danger {
  color: var(--down);
}

.series-ask {
  display: block;
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--muted);
}

.desc {
  padding: 16px 20px;
}

.desc-src {
  padding: 0 0 8px;
}

.desc-text {
  margin: 0;
  max-width: 72ch;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.mail-meta {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--muted);
}

.mail-short {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  white-space: normal;
}

.link-btn {
  margin-top: 4px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.link-btn:hover {
  color: var(--text);
}

.desc-status {
  margin-top: 10px;
}

.order {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel2);
}

.order summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  min-height: 44px;
  padding: 4px 8px 4px 12px;
  font-size: 13.5px;
  cursor: pointer;
  list-style: none;
}

.order summary::-webkit-details-marker {
  display: none;
}

.order-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}

.order-text {
  margin: 0;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--line);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
}

.check-line {
  cursor: pointer;
  margin: 0;
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--warn) 8%, var(--panel));
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

.note-text {
  margin-top: 4px;
}

.note-status {
  margin-top: 6px;
}

.add-note {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13.5px;
  cursor: pointer;
}

.add-note:hover {
  color: var(--text);
}

.note-form.first {
  border-top: 0;
}

.note-acts {
  display: flex;
  gap: 8px;
}

.old-list {
  border-top: 1px solid var(--line);
}

.note {
  padding: 10px 16px;
}

.note-meta {
  font-size: 11.5px;
}

.note-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--line);
}

.note-form .textarea {
  min-height: 64px;
}

.hist {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 0 16px;
  font-size: 13px;
}

.hist time {
  flex: none;
  font-size: 11.5px;
}

.hist .ellipsis {
  flex: 1 1 auto;
}

.hist-link {
  flex: none;
  font-size: 12.5px;
}

.who {
  flex: none;
  font-size: 12px;
}

.dl {
  margin: 0;
  padding: 12px 16px 16px;
  display: grid;
  grid-template-columns: minmax(0, 130px) minmax(0, 1fr);
  gap: 8px 12px;
  font-size: 13px;
}

.dl dt {
  color: var(--dim);
}

.dl dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.pre {
  white-space: pre-wrap;
}

.url a {
  font-family: var(--mono);
  font-size: 11.5px;
}

.plink {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}

.plink + .plink {
  margin-top: 4px;
}

.plink-name {
  flex: 0 0 auto;
}

.url-a {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 11.5px;
}

.dep {
  display: block;
}

.res {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 0 16px;
  font-size: 13px;
}

.res .ellipsis {
  flex: 1 1 auto;
}

.res-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--line);
}

.res-form .input {
  flex: 2 1 140px;
  width: auto;
}

.res-form .num {
  flex: 1 1 80px;
}

.draft-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Handy */
@media (max-width: 600px) {
  .dl {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }

  .dl dd {
    margin-bottom: 8px;
  }

  .hist .who {
    display: none;
  }

  .draft-subj {
    padding: 14px 16px 0;
  }

  .draft-text {
    padding: 14px 16px 16px;
  }

  .desc {
    padding: 14px 16px;
  }

  .check-line {
    padding: 10px 16px;
  }
}
</style>
