<script setup lang="ts">
import type { MessageCard } from '~~/server/db/schema'
import { UPLOAD_ACCEPT } from '~~/shared/utils/upload'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool: string | null
  error: boolean
  cards: MessageCard[]
  at: string
  queued?: boolean
}

interface ChatData {
  conversation: { id: string, kind: string, title: string | null, projectId: string | null, projectSlug: string | null, setupState: string | null }
  busy: boolean
  ready: boolean
  progress: { steps: { key: string, state: string, note?: string | null }[], done: boolean } | null
  messages: ChatMessage[]
}

const props = withDefaults(defineProps<{ project?: string | null, onboarding?: boolean, compact?: boolean }>(), { project: null, onboarding: false, compact: false })
const emit = defineEmits<{ project: [string] }>()
const { t, locale } = useI18n()
const { boot, canEdit, refresh: refreshBoot, projectById } = useBoot()
const toast = useToast()
const route = useRoute()

const query = computed(() => (props.onboarding ? { onboarding: '1' } : props.project ? { project: props.project } : {}))
const convId = ref<string | null>(null)
const data = ref<ChatData | null>(null)
const text = ref('')
const sending = ref(false)
const scroller = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let alive = true

async function load() {
  try {
    const res = await $fetch<ChatData>('/api/chat', { query: convId.value ? { ...query.value, id: convId.value } : query.value })
    const grew = (res.messages.length !== data.value?.messages.length) || res.busy !== data.value?.busy
    const hadProject = data.value?.conversation.projectSlug
    data.value = res
    convId.value = res.conversation.id
    if (res.conversation.projectSlug && res.conversation.projectSlug !== hadProject) {
      await refreshBoot()
      emit('project', res.conversation.projectSlug)
    }
    if (grew) scrollDown()
  }
  catch (err) {
    toast.error(err)
  }
  schedule()
}

function schedule() {
  clearTimeout(timer)
  if (!alive) return
  if (data.value?.busy) timer = setTimeout(load, 1200)
}

function scrollDown() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}

watch(query, () => {
  convId.value = null
  data.value = null
  listOpen.value = false
  void load()
})

// Spracheingabe (vor allem am Handy): Aufnahme an den Server (Mistral Voxtral, EU), sonst Spracherkennung des Browsers
const showMic = ref(false)
const mic = ref<'idle' | 'rec' | 'busy'>('idle')
let sttAvailable: boolean | null = null
let recorder: MediaRecorder | null = null
let recog: { stop: () => void } | null = null
let micTimer: ReturnType<typeof setTimeout> | undefined
let browserHint = false
onMounted(() => {
  showMic.value = !props.onboarding && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700)
})
function addText(s: string) {
  const v = s.trim()
  if (!v) return
  text.value = text.value.trim() ? `${text.value.trimEnd()} ${v}` : v
  autosize()
}
async function toggleMic() {
  if (mic.value === 'rec') {
    clearTimeout(micTimer)
    recorder?.stop()
    recog?.stop()
    return
  }
  if (mic.value === 'busy') return
  if (sttAvailable === null) sttAvailable = await $fetch<{ available: boolean }>('/api/chat/transcribe').then(r => r.available).catch(() => false)
  if (sttAvailable && typeof MediaRecorder !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') return record()
  const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRec, webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition
  if (!SR) return toast.push(t('chat.micNone'))
  if (!browserHint) {
    browserHint = true
    toast.push(t('chat.micBrowser'))
  }
  const r = new SR()
  r.lang = locale.value === 'en' ? 'en-US' : 'de-AT'
  r.interimResults = false
  r.continuous = true
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i]!.isFinal) addText(e.results[i]![0]!.transcript)
  }
  r.onerror = (e) => {
    if (e.error === 'not-allowed') toast.push(t('chat.micDenied'))
  }
  r.onend = () => {
    mic.value = 'idle'
    recog = null
  }
  recog = r
  mic.value = 'rec'
  r.start()
}
interface SpeechRec {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: (e: { resultIndex: number, results: ArrayLike<{ isFinal: boolean } & ArrayLike<{ transcript: string }>> }) => void
  onerror: (e: { error: string }) => void
  onend: () => void
  start: () => void
  stop: () => void
}
async function record() {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  }
  catch {
    return toast.push(t('chat.micDenied'))
  }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(x => MediaRecorder.isTypeSupported?.(x)) ?? ''
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = e => e.data.size && chunks.push(e.data)
  rec.onstop = async () => {
    stream.getTracks().forEach(tr => tr.stop())
    recorder = null
    const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' })
    if (!blob.size) return void (mic.value = 'idle')
    mic.value = 'busy'
    const fd = new FormData()
    fd.append('audio', blob, /mp4/.test(blob.type) ? 'audio.m4a' : /ogg/.test(blob.type) ? 'audio.ogg' : 'audio.webm')
    fd.append('lang', locale.value === 'en' ? 'en' : 'de')
    try {
      addText((await $fetch<{ text: string }>('/api/chat/transcribe', { method: 'POST', body: fd })).text)
      nextTick(() => input.value?.focus())
    }
    catch (err) {
      toast.error(err)
    }
    finally {
      mic.value = 'idle'
    }
  }
  recorder = rec
  rec.start()
  mic.value = 'rec'
  micTimer = setTimeout(() => recorder?.stop(), 120_000)
}
onBeforeUnmount(() => {
  clearTimeout(micTimer)
  recorder?.stop()
  recog?.stop()
})

interface ChatEntry { id: string, title: string | null, at: string, empty: boolean }
const { dateTime } = useFormat()
const listOpen = ref(false)
const chats = ref<ChatEntry[]>([])
const scopeQuery = computed(() => (props.project ? { project: props.project } : {}))
async function loadChats() {
  try {
    chats.value = (await $fetch<{ chats: ChatEntry[] }>('/api/chat/list', { query: scopeQuery.value })).chats
  }
  catch (err) {
    toast.error(err)
  }
}
async function toggleList() {
  listOpen.value = !listOpen.value
  if (listOpen.value) await loadChats()
}
async function openChat(id: string) {
  listOpen.value = false
  if (id === convId.value) return
  clearTimeout(timer)
  convId.value = id
  data.value = null
  staged.value = []
  await load()
  scrollDown()
}
async function newChat() {
  try {
    const r = await $fetch<{ id: string }>('/api/chat/new', { method: 'POST', body: scopeQuery.value })
    text.value = ''
    await openChat(r.id)
    nextTick(() => input.value?.focus())
  }
  catch (err) {
    toast.error(err)
  }
}
async function removeChat(c: ChatEntry) {
  if (!confirm(t('chat.deleteConfirm', { title: c.title || t('chat.newChat') }))) return
  try {
    await $fetch(`/api/chat/${c.id}`, { method: 'DELETE' })
    chats.value = chats.value.filter(x => x.id !== c.id)
    if (c.id === convId.value) {
      convId.value = null
      data.value = null
      listOpen.value = false
      await load()
    }
  }
  catch (err) {
    toast.error(err)
  }
}
onMounted(load)
onBeforeUnmount(() => {
  alive = false
  clearTimeout(timer)
})

const staged = ref<File[]>([])
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const canUpload = computed(() => canEdit.value && !!data.value?.conversation.projectId && !props.onboarding)

function stage(list: FileList | null | undefined) {
  if (!canUpload.value) return
  staged.value = [...staged.value, ...Array.from(list ?? [])].slice(0, 10)
  if (fileInput.value) fileInput.value.value = ''
}
function onDrop(e: DragEvent) {
  dragging.value = false
  stage(e.dataTransfer?.files)
}

async function sendFiles() {
  if (!data.value || sending.value) return
  const body = text.value.trim()
  const fd = new FormData()
  fd.append('conversationId', data.value.conversation.id)
  fd.append('text', body)
  fd.append('page', route.fullPath)
  for (const f of staged.value) fd.append('file', f, f.name)
  sending.value = true
  try {
    const res = await $fetch<{ queued?: boolean }>('/api/chat/upload', { method: 'POST', body: fd })
    if (res.queued) toast.push(t('chat.queuedHint'))
    staged.value = []
    text.value = ''
    autosize()
    data.value.busy = true
    scrollDown()
    timer = setTimeout(load, 800)
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    sending.value = false
  }
}

async function send(msg?: string) {
  if (!msg && staged.value.length) return sendFiles()
  const body = (msg ?? text.value).trim()
  if (!body || !data.value || sending.value) return
  sending.value = true
  try {
    const res = await $fetch<{ id: string, queued: boolean }>('/api/chat', { method: 'POST', body: { conversationId: data.value.conversation.id, text: body, page: route.fullPath } })
    text.value = ''
    autosize()
    data.value.busy = true
    data.value.messages.push({ id: res.queued ? res.id : `local-${Date.now()}`, role: 'user', content: body, tool: null, error: false, cards: [], at: new Date().toISOString(), queued: res.queued })
    scrollDown()
    clearTimeout(timer)
    timer = setTimeout(load, 800)
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    sending.value = false
  }
}

async function unqueue(m: ChatMessage) {
  try {
    await $fetch(`/api/chat/queued/${m.id}`, { method: 'DELETE' })
    if (data.value) data.value.messages = data.value.messages.filter(x => x.id !== m.id)
  }
  catch (err) {
    toast.error(err)
    void load()
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

function autosize() {
  nextTick(() => {
    const el = input.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  })
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function follow(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest?.('a.in')
  const href = a?.getAttribute('href')
  if (!href || e.metaKey || e.ctrlKey || e.shiftKey) return
  e.preventDefault()
  navigateTo(href.replace(/&amp;/g, '&'))
}

function render(s: string) {
  const lines = esc(s).split('\n')
  const out: string[] = []
  let list = false
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/(^|[\s(])(\/(?:p\/[a-z0-9-]+|einstellungen|projekte|abo|team|tarif)(?:[/?][\w\-/?=&;]*)?)(?=[\s.,:;!)]|$)/g, '$1<a class="in" href="$2">$2</a>')
    const m = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
    if (m) {
      if (!list) out.push('<ul>')
      list = true
      out.push(`<li>${m[1]}</li>`)
      continue
    }
    if (list) out.push('</ul>')
    list = false
    out.push(line.trim() ? `<p>${line}</p>` : '')
  }
  if (list) out.push('</ul>')
  return out.join('')
}

const visible = computed(() => (data.value?.messages ?? []).filter(m => !m.queued && (m.role !== 'assistant' || m.content || m.cards.length)))
const waiting = computed(() => (data.value?.messages ?? []).filter(m => m.queued))
const suggestions = computed(() => {
  if (props.onboarding || !data.value || data.value.messages.some(m => m.role === 'user')) return []
  return props.project ? [t('chat.sugg.status'), t('chat.sugg.week'), t('chat.sugg.social')] : [t('chat.sugg.allStatus'), t('chat.sugg.allWeek')]
})
const projectSlug = (id: unknown) => projectById(String(id ?? ''))?.slug ?? null
</script>

<template>
  <div class="chat" :class="{ compact: props.compact, dragging }" @dragover.prevent="dragging = canUpload" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <div v-if="!props.onboarding" class="bar">
      <button type="button" class="icon-btn" :class="{ on: listOpen }" :aria-expanded="listOpen" :aria-label="t('chat.chats')" :title="t('chat.chats')" @click="toggleList"><Icon name="menu" /></button>
      <span class="ctitle ellipsis">{{ data?.conversation.title || t('chat.newChat') }}</span>
      <button type="button" class="icon-btn" :aria-label="t('chat.newChat')" :title="t('chat.newChat')" :disabled="!canEdit" @click="newChat"><Icon name="plus" /></button>
    </div>
    <div v-if="listOpen" class="chats">
      <p v-if="!chats.length" class="dim small pad">{{ t('chat.noChats') }}</p>
      <div v-for="c in chats" :key="c.id" class="crow" :class="{ cur: c.id === convId }">
        <button type="button" class="copen" @click="openChat(c.id)">
          <span class="ellipsis">{{ c.title || t('chat.newChat') }}</span>
          <span class="mono dim cdate">{{ dateTime(c.at) }}</span>
        </button>
        <button type="button" class="icon-btn cdel" :aria-label="t('common.delete')" :title="t('common.delete')" @click="removeChat(c)"><Icon name="x" :size="12" /></button>
      </div>
    </div>
    <div v-show="!listOpen" ref="scroller" class="log" aria-live="polite">
      <template v-for="m in visible" :key="m.id">
        <div v-if="m.role === 'user'" class="msg user"><div class="bubble">{{ m.content }}</div></div>
        <div v-else-if="m.role === 'tool'" class="step" :class="{ err: m.error }">
          <Icon :name="m.error ? 'x' : 'check'" :size="12" />
          <span>{{ m.tool ? t(`chat.tools.${m.tool}`) : t('chat.tools.other') }}</span>
        </div>
        <div v-else class="msg agent">
          <span class="who" aria-hidden="true" />
          <div class="body">
            <div v-if="m.content" class="txt" @click="follow" v-html="render(m.content)" />
            <div v-for="(c, i) in m.cards" :key="i" class="card">
              <StrategyCard v-if="c.type === 'strategy' && c.id" :id="c.id" :editable="data?.conversation.kind === 'onboarding'" @decided="() => load()" />
              <ChatGoals v-else-if="c.type === 'goals' && c.data?.projectId" :project-id="String(c.data.projectId)" />
              <NuxtLink v-else-if="(c.type === 'task' || c.type === 'draft') && c.id" :to="`/p/${projectSlug(c.data?.projectId) ?? 'alle'}/aufgaben/${c.id}`" class="mini">
                <Icon :name="c.type === 'draft' ? 'post' : 'tasks'" />
                <span class="ellipsis">{{ c.data?.title }}</span>
                <span class="mono dim">{{ c.data?.date ? String(c.data.date).slice(8, 10) + '.' + String(c.data.date).slice(5, 7) + '.' : '' }} {{ c.data?.time ?? '' }}</span>
                <Icon name="chevron-right" />
              </NuxtLink>
              <NuxtLink v-else-if="c.type === 'approvals' && c.data?.count" :to="`/p/${projectSlug(c.data?.projectId) ?? 'alle'}/freigaben`" class="mini">
                <Icon name="post" />
                <span class="ellipsis">{{ t('chat.approvalsWaiting', { n: c.data.count }, Number(c.data.count)) }}</span>
                <Icon name="chevron-right" />
              </NuxtLink>
              <NuxtLink v-else-if="c.type === 'project' && c.data?.slug" :to="`/p/${c.data.slug}`" class="mini">
                <Icon name="dashboard" />
                <span class="ellipsis">{{ c.data.created ? t('chat.projectReady', { name: c.data.name, n: c.data.created }) : t('chat.projectCreated', { name: c.data.name }) }}</span>
                <Icon name="chevron-right" />
              </NuxtLink>
            </div>
          </div>
        </div>
      </template>
      <div v-if="data?.busy" class="msg agent busy">
        <span class="who pulse" aria-hidden="true" />
        <div class="body">
          <p class="thinking">{{ t('chat.thinking') }}</p>
          <ul v-if="data.progress" class="prog">
            <li v-for="s in data.progress.steps" :key="s.key" :class="`ps-${s.state}`">
              <span class="pi"><Icon v-if="s.state === 'ok'" name="check" :size="12" /><Icon v-else-if="s.state === 'error'" name="x" :size="12" /></span>
              <span>{{ t(`onboarding.steps.${s.key}`) }}</span>
              <span v-if="s.note" class="dim">{{ s.note }}</span>
            </li>
          </ul>
        </div>
      </div>
      <div v-for="m in waiting" :key="m.id" class="msg user queued">
        <div class="bubble">{{ m.content }}</div>
        <span class="qmeta">{{ t('chat.queued') }} · <button type="button" class="qx" @click="unqueue(m)">{{ t('chat.unqueue') }}</button></span>
      </div>
    </div>
    <div v-if="suggestions.length" class="sugg">
      <button v-for="s in suggestions" :key="s" type="button" class="chip" :disabled="!canEdit" @click="send(s)">{{ s }}</button>
    </div>
    <p v-if="data && !data.ready" class="off"><template v-if="boot?.features.hosted">{{ t('chat.notReadyHosted') }}</template><template v-else>{{ t('chat.notReady') }} <NuxtLink to="/einstellungen/ki">{{ t('chat.setupAccess') }}</NuxtLink></template><template v-if="props.onboarding"> · <NuxtLink to="/projekte/neu?form=1">{{ t('onboarding.useForm') }}</NuxtLink></template></p>
    <div v-if="staged.length" class="staged">
      <span v-for="(f, i) in staged" :key="i" class="sf"><Icon :name="/^(image|video)\//.test(f.type) ? 'image' : 'doc'" :size="12" /><span class="ellipsis">{{ f.name }}</span><button type="button" class="sx" :aria-label="t('common.delete')" @click="staged.splice(i, 1)"><Icon name="x" :size="10" /></button></span>
      <span class="small dim">{{ t('upload.projectHint') }}</span>
    </div>
    <form class="composer" @submit.prevent="send()">
      <label v-if="!props.onboarding" class="clip" :class="{ off: !canUpload }" :title="canUpload ? t('upload.attach') : t('upload.needProject')"><Icon name="clip" /><span class="sr-only">{{ t('upload.attach') }}</span><input ref="fileInput" type="file" multiple hidden :disabled="!canUpload" :accept="UPLOAD_ACCEPT" @change="stage(($event.target as HTMLInputElement).files)"></label>
      <textarea ref="input" v-model="text" class="ta" rows="1" :placeholder="props.onboarding ? t('chat.placeholderNew') : t('chat.placeholder')" :aria-label="t('chat.placeholder')" :disabled="!canEdit || !data" maxlength="8000" @keydown="onKey" @input="autosize" />
      <button v-if="showMic" type="button" class="mic" :class="mic" :disabled="!canEdit || !data || mic === 'busy'" :aria-label="mic === 'rec' ? t('chat.micStop') : mic === 'busy' ? t('chat.micBusy') : t('chat.mic')" :title="mic === 'rec' ? t('chat.micStop') : mic === 'busy' ? t('chat.micBusy') : t('chat.mic')" @click="toggleMic"><Icon :name="mic === 'rec' ? 'stop' : 'mic'" /></button>
      <button type="submit" class="btn primary send" :disabled="(!text.trim() && !staged.length) || sending" :aria-label="t('chat.send')"><Icon name="send" /></button>
    </form>
    <p class="ainote small dim">{{ t('chat.aiNote') }}</p>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 2px 6px;
  border-bottom: 1px solid var(--line);
}

.bar .icon-btn.on {
  background: var(--panel2);
  color: var(--text);
}

.ctitle {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-size: 13px;
}

.chats {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.pad {
  padding: 10px;
}

.crow {
  display: flex;
  align-items: center;
  border-radius: 4px;
}

.crow:hover,
.crow.cur {
  background: var(--panel2);
}

.copen {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.cdate {
  font-size: 11.5px;
}

.cdel {
  flex: none;
  opacity: .6;
}

.chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--panel);
}

.log {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overscroll-behavior: contain;
}

.msg {
  display: flex;
  gap: 12px;
  max-width: 760px;
}

.msg.user {
  justify-content: flex-end;
  align-self: flex-end;
}

.bubble {
  max-width: 560px;
  padding: 9px 13px;
  border-radius: 12px 12px 3px 12px;
  background: var(--primary-soft);
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
}

.msg.queued {
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.msg.queued .bubble {
  background: transparent;
  border: 1px dashed var(--line2);
  color: var(--muted);
}

.qmeta {
  font-size: 11.5px;
  color: var(--dim);
}

.qx {
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.qx:hover {
  color: var(--text);
}

.who {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 8px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 4px var(--primary-soft);
}

.pulse {
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.txt {
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.txt :deep(p) {
  margin: 0 0 6px;
}

.txt :deep(p:last-child) {
  margin-bottom: 0;
}

.txt :deep(ul) {
  margin: 4px 0 6px;
  padding-left: 18px;
}

.txt :deep(a) {
  color: var(--primary);
}

.step {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 20px;
  font-family: var(--meta);
  font-size: 11.5px;
  color: var(--dim);
}

.step svg {
  color: var(--up);
}

.step.err svg {
  color: var(--down);
}

.thinking {
  margin: 4px 0 0;
  color: var(--dim);
  font-size: 13px;
}

.prog {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
}

.prog li {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}

.prog .ps-wait {
  color: var(--dim);
}

.pi {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--line2);
  flex: none;
}

.ps-ok .pi {
  border-color: var(--up);
  color: var(--up);
}

.ps-run .pi {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.ps-error .pi {
  border-color: var(--down);
  color: var(--down);
}

.mini {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 13.5px;
}

.mini:hover {
  background: var(--panel2);
  color: var(--text);
}

.mini .ellipsis {
  flex: 1 1 auto;
}

.sugg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 20px 8px;
}

.chip {
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
}

.chip:hover {
  color: var(--text);
  border-color: var(--primary);
}

.off {
  margin: 0;
  padding: 8px 20px;
  color: var(--muted);
  font-size: 13px;
  border-top: 1px solid var(--line);
}

.chat.dragging {
  box-shadow: inset 0 0 0 2px var(--primary);
}

.staged {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 8px 16px 0;
  border-top: 1px solid var(--line);
}

.sf {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--line2);
  border-radius: 14px;
  font-size: 12.5px;
}

.sx {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.small {
  font-size: 12px;
}

.clip {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 40px;
  color: var(--muted);
  cursor: pointer;
}

.clip:hover {
  color: var(--text);
}

.clip.off {
  opacity: 0.5;
  cursor: default;
}

.mic {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 20px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.mic.rec {
  background: var(--danger, #c0392b);
  color: #fff;
}

.mic.busy {
  opacity: .5;
}

.ainote {
  margin: 0;
  padding: 0 20px 8px;
  text-align: center;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 12px 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}

.ta {
  flex: 1 1 auto;
  min-height: 40px;
  max-height: 160px;
  padding: 9px 12px;
  border-radius: 4px;
  border: 1px solid var(--line2);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.45;
  resize: none;
}

.send {
  width: 40px;
  min-height: 40px;
  padding: 0;
}

/* Handy */
@media (max-width: 600px) {
  .log {
    padding: 16px 14px 8px;
  }

  .sugg {
    padding: 0 14px 8px;
  }

  .ta {
    font-size: 16px;
  }
}
</style>
