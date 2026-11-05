export interface ChatTask {
  taskId: string
  code: string
  title: string
  token: number
}

export const CHAT_WIDE = '(min-width: 1180px)'

export function useChatPanel() {
  const route = useRoute()
  const onTask = computed(() => /\/(freigaben|aufgaben)\/[0-9a-f-]{36}/i.test(route.path))
  const opts = { default: () => null, maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' as const }
  const cookiePage = useCookie<'open' | 'closed' | null>('ma_chat', opts)
  const cookieTask = useCookie<'open' | 'closed' | null>('ma_chat_task', opts)
  const prefPage = useState<'open' | 'closed' | null>('chat-pref', () => cookiePage.value)
  const prefTask = useState<'open' | 'closed' | null>('chat-pref-task', () => cookieTask.value)
  const stored = computed({
    get: () => (onTask.value ? prefTask.value : prefPage.value),
    set: (v) => {
      if (onTask.value) prefTask.value = cookieTask.value = v
      else prefPage.value = cookiePage.value = v
    },
  })
  const task = useState<ChatTask | null>('chat-task', () => null)
  const mode = useState<'task' | 'project'>('chat-mode', () => 'task')
  const narrowOpen = useState<boolean>('chat-narrow', () => false)
  const latest = useState<{ taskId: string, id: string, version: number } | null>('chat-latest', () => null)
  const writing = useState<string | null>('chat-writing', () => null)

  const open = computed(() => (stored.value ? stored.value === 'open' : onTask.value))
  const taskMode = computed(() => onTask.value && mode.value === 'task')

  function wide() {
    return import.meta.client && window.matchMedia(CHAT_WIDE).matches
  }
  function show() {
    if (wide()) stored.value = 'open'
    else narrowOpen.value = true
  }
  function hide() {
    if (wide()) stored.value = 'closed'
    else narrowOpen.value = false
  }
  function setTask(t: Omit<ChatTask, 'token'>): number {
    const token = Date.now() + Math.random()
    if (task.value?.taskId !== t.taskId) mode.value = 'task'
    task.value = { ...t, token }
    return token
  }
  function clearTask(token: number) {
    if (task.value?.token === token) task.value = null
  }

  return { onTask, open, stored, task, mode, taskMode, narrowOpen, latest, writing, wide, show, hide, setTask, clearTask }
}
