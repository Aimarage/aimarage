<script setup lang="ts">
import type { TalkKind } from '~~/shared/utils/talk'
import { UPLOAD_ACCEPT } from '~~/shared/utils/upload'

interface TalkData {
  task: { id: string, code: string, title: string }
  lines: { id: string, who: 'agent' | 'user', kind: TalkKind | 'version', text: string, at: string }[]
  draft: { id: string, version: number, status: string } | null
  writing: boolean
  busy: boolean
  canTalk: boolean
}

const props = defineProps<{ taskId: string }>()
const { t } = useI18n()
const { boot, canEdit, refresh: refreshBoot } = useBoot()
const { base } = useScope()
const panel = useChatPanel()
const toast = useToast()

const data = ref<TalkData | null>(null)
const text = ref('')
const sending = ref(false)
const pending = ref<string | null>(null)
const local = ref<string[]>([])
const failed = ref('')
const writing = ref(false)
const scroller = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
let fromVersion = 0
let until = 0
let timer: ReturnType<typeof setTimeout> | undefined
let alive = true

async function load() {
  clearTimeout(timer)
  try {
    const res = await $fetch<TalkData>(`/api/tasks/${props.taskId}/talk`)
    const grew = res.lines.length !== data.value?.lines.length
    if (res.writing && !writing.value) startWriting(res.draft?.version ?? 0)
    data.value = res
    if (writing.value && (res.draft?.version ?? 0) > fromVersion) {
      stopWriting()
      panel.latest.value = { taskId: props.taskId, id: res.draft!.id, version: res.draft!.version }
      void refreshBoot()
    }
    else if (writing.value && !res.writing && Date.now() > until - 230_000) {
      stopWriting()
      failed.value = t('talk.writeFailed')
    }
    if (grew) scrollDown()
  }
  catch {}
  if (!alive) return
  if (writing.value) {
    if (Date.now() > until) {
      stopWriting()
      failed.value = t('approvals.answerSlow')
    }
    else timer = setTimeout(load, 3000)
  }
  else if (data.value?.busy || queued.value.length) timer = setTimeout(load, 2000)
}

function startWriting(version: number) {
  fromVersion = version
  until = Date.now() + 240_000
  writing.value = true
  panel.writing.value = props.taskId
}

function stopWriting() {
  writing.value = false
  if (panel.writing.value === props.taskId) panel.writing.value = null
}

function scrollDown() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}

onMounted(load)
onBeforeUnmount(() => {
  alive = false
  clearTimeout(timer)
  stopWriting()
})

const staged = ref<File[]>([])
const toFundus = ref(false)
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const stagedMedia = computed(() => staged.value.some(f => /^(image|video)\//.test(f.type)))

function stage(list: FileList | null | undefined) {
  if (!canEdit.value) return
  staged.value = [...staged.value, ...Array.from(list ?? [])].slice(0, 10)
  if (fileInput.value) fileInput.value.value = ''
}
function onDrop(e: DragEvent) {
  dragging.value = false
  stage(e.dataTransfer?.files)
}

async function uploadStaged(): Promise<boolean> {
  const fd = new FormData()
  for (const f of staged.value) fd.append('file', f, f.name)
  if (toFundus.value) fd.append('fundus', '1')
  try {
    await $fetch(`/api/tasks/${props.taskId}/upload`, { method: 'POST', body: fd })
    staged.value = []
    toFundus.value = false
    await load()
    return true
  }
  catch (err) {
    toast.error(err)
    return false
  }
}

async function send(msg?: string) {
  if (!msg && staged.value.length && !sending.value) {
    sending.value = true
    const ok = await uploadStaged()
    sending.value = false
    if (!ok) return
  }
  const body = (msg ?? text.value).trim()
  if (!body || !data.value?.canTalk) return
  if (sending.value || writing.value || data.value.busy || queued.value.length) return enqueue(body, msg)
  sending.value = true
  failed.value = ''
  pending.value = body
  if (!msg) text.value = ''
  autosize()
  scrollDown()
  try {
    const res = await $fetch<{ revising: boolean, dropped?: boolean, moved?: string }>(`/api/tasks/${props.taskId}/talk`, { method: 'POST', body: { text: body }, timeout: 150_000 })
    pending.value = null
    if (res.revising) startWriting(data.value?.draft?.version ?? 0)
    if (res.dropped || res.moved) void refreshBoot()
    await load()
  }
  catch (err) {
    pending.value = null
    if (!msg) text.value = body
    const e = err as { statusMessage?: string, data?: { statusMessage?: string }, name?: string }
    failed.value = e.name === 'FetchError' && !e.data ? t('talk.timeout') : e.data?.statusMessage ?? e.statusMessage ?? t('talk.timeout')
  }
  finally {
    sending.value = false
    scrollDown()
  }
}

async function enqueue(body: string, msg?: string) {
  if (!msg) text.value = ''
  autosize()
  local.value.push(body)
  scrollDown()
  try {
    await $fetch(`/api/tasks/${props.taskId}/talk`, { method: 'POST', body: { text: body }, timeout: 150_000 })
  }
  catch (err) {
    if (!msg && !text.value) text.value = body
    const e = err as { statusMessage?: string, data?: { statusMessage?: string } }
    failed.value = e.data?.statusMessage ?? e.statusMessage ?? t('talk.timeout')
  }
  finally {
    local.value.splice(local.value.indexOf(body), 1)
    await load()
  }
}

async function unqueue(id: string) {
  try {
    await $fetch(`/api/tasks/${props.taskId}/talk`, { method: 'DELETE', query: { note: id } })
  }
  catch (err) {
    toast.error(err)
  }
  await load()
}

async function remember(id: string) {
  try {
    await $fetch(`/api/tasks/${props.taskId}/remember`, { method: 'POST', body: { noteId: id } })
    toast.push(t('talk.remembered'))
    await load()
  }
  catch (err) {
    toast.error(err)
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

const parts = (s: string) => s.split(/;\s+/).map(x => x.trim()).filter(Boolean)
const shown = computed(() => (data.value?.lines ?? []).filter(l => l.kind !== 'queued'))
const queued = computed(() => (data.value?.lines ?? []).filter(l => l.kind === 'queued'))
const hasUser = computed(() => !!data.value?.lines.some(l => l.who === 'user'))
const suggestions = computed(() => (data.value?.canTalk && data.value.draft && !hasUser.value ? [t('talk.sugg.shorter'), t('talk.sugg.explain')] : []))
const offText = computed(() => {
  if (!data.value || data.value.canTalk) return ''
  return boot.value?.agent.ready ? t('talk.closed') : t(boot.value?.features.hosted ? 'chat.notReadyHosted' : 'chat.notReady')
})
</script>

<template>
  <div class="chat talk" :class="{ dragging }" @dragover.prevent="dragging = canEdit" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <div ref="scroller" class="log" aria-live="polite">
      <div v-if="data && !data.lines.length" class="msg agent">
        <span class="who" aria-hidden="true" />
        <p class="txt">{{ data.draft ? t('talk.empty') : t('talk.emptyNoDraft') }}</p>
      </div>
      <template v-for="l in shown" :key="l.id">
        <div v-if="l.kind === 'version'" class="ver">
          <NuxtLink :to="`${base}/freigaben/${l.id.slice(2)}`">{{ t('talk.version', { v: l.text }) }}</NuxtLink>
        </div>
        <div v-else-if="l.who === 'user'" class="msg user"><div class="bubble">{{ l.text }}</div></div>
        <div v-else-if="l.kind === 'fact' || l.kind === 'saved'" class="fact" :class="{ saved: l.kind === 'saved' }">
          <span class="fl">{{ l.kind === 'saved' ? t('talk.saved') : t('talk.suggestFact') }}</span>
          <span class="ft">{{ l.text }}</span>
          <button v-if="l.kind === 'fact' && canEdit" type="button" class="btn small" @click="remember(l.id)">{{ t('talk.remember') }}</button>
        </div>
        <div v-else class="msg agent">
          <span class="who" aria-hidden="true" />
          <div class="body">
            <template v-if="l.kind === 'question'">
              <p class="txt lbl">{{ t('talk.question') }}</p>
              <ul class="qs"><li v-for="(q, i) in parts(l.text)" :key="i">{{ q }}</li></ul>
            </template>
            <p v-else class="txt">{{ l.text }}</p>
          </div>
        </div>
      </template>
      <div v-if="pending" class="msg user"><div class="bubble">{{ pending }}</div></div>
      <div v-if="sending || writing || data?.busy" class="msg agent busy">
        <span class="who pulse" aria-hidden="true" />
        <p class="thinking">{{ writing ? t('approvals.writing') : t('talk.typing') }}</p>
      </div>
      <div v-for="l in queued" :key="l.id" class="msg user queued">
        <div class="bubble">{{ l.text }}</div>
        <span class="qmeta">{{ t('chat.queued') }}<template v-if="canEdit"> · <button type="button" class="qx" @click="unqueue(l.id)">{{ t('chat.unqueue') }}</button></template></span>
      </div>
      <div v-for="(b, i) in local" :key="`l${i}`" class="msg user queued">
        <div class="bubble">{{ b }}</div>
        <span class="qmeta">{{ t('chat.queued') }}</span>
      </div>
      <p v-if="failed" class="err" role="alert">{{ failed }}</p>
    </div>
    <div v-if="suggestions.length" class="sugg">
      <button v-for="s in suggestions" :key="s" type="button" class="chip" :disabled="!canEdit || sending" @click="send(s)">{{ s }}</button>
    </div>
    <p v-if="offText" class="off">{{ offText }}</p>
    <div v-if="staged.length" class="staged">
      <span v-for="(f, i) in staged" :key="i" class="sf"><Icon :name="/^(image|video)\//.test(f.type) ? 'image' : 'doc'" :size="12" /><span class="ellipsis">{{ f.name }}</span><button type="button" class="sx" :aria-label="t('common.delete')" @click="staged.splice(i, 1)"><Icon name="x" :size="10" /></button></span>
      <label v-if="stagedMedia" class="sfund"><input v-model="toFundus" type="checkbox"> {{ t('upload.alsoFundus') }}</label>
    </div>
    <form class="composer" @submit.prevent="send()">
      <label class="clip" :class="{ off: !canEdit }" :title="t('upload.attach')"><Icon name="clip" /><span class="sr-only">{{ t('upload.attach') }}</span><input ref="fileInput" type="file" multiple hidden :disabled="!canEdit" :accept="UPLOAD_ACCEPT" @change="stage(($event.target as HTMLInputElement).files)"></label>
      <textarea ref="input" v-model="text" class="ta" rows="1" :placeholder="t('talk.placeholder')" :aria-label="t('talk.placeholder')" :disabled="!canEdit || !data?.canTalk" maxlength="4000" @keydown="onKey" @input="autosize" />
      <button type="submit" class="btn primary send" :disabled="(!text.trim() || !data?.canTalk) && (!staged.length || sending)" :aria-label="t('chat.send')"><Icon name="send" /></button>
    </form>
  </div>
</template>

<style scoped>
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
}

.msg.user {
  justify-content: flex-end;
  align-self: flex-end;
  max-width: 88%;
}

.bubble {
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
  gap: 6px;
}

.txt {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.lbl {
  color: var(--muted);
  font-size: 13px;
}

.qs {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
  font-size: 14px;
  line-height: 1.5;
}

.ver {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--meta);
  font-size: 11.5px;
  color: var(--dim);
}

.ver::before,
.ver::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--line);
}

.ver a {
  color: var(--muted);
}

.fact {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-left: 20px;
  padding: 10px 12px;
  border: 1px dashed var(--line2);
  border-radius: 4px;
  font-size: 13px;
}

.fact.saved {
  border-style: solid;
  border-color: var(--line);
  color: var(--muted);
}

.fl {
  color: var(--dim);
  font-size: 12px;
}

.ft {
  flex: 1 1 100%;
  overflow-wrap: anywhere;
}

.fact .btn {
  margin-left: auto;
}

.thinking {
  margin: 4px 0 0;
  color: var(--dim);
  font-size: 13px;
}

.err {
  margin: 0 0 0 20px;
  color: var(--down);
  font-size: 13px;
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

.sfund {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--muted);
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
