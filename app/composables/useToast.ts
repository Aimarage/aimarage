export interface Toast {
  id: number
  text: string
  kind: 'ok' | 'error'
}

export function useToast() {
  const toasts = useState<Toast[]>('toasts', () => [])
  function push(text: string, kind: Toast['kind'] = 'ok') {
    const id = Date.now() + Math.random()
    toasts.value = [...toasts.value, { id, text, kind }]
    setTimeout(() => (toasts.value = toasts.value.filter(t => t.id !== id)), 3500)
  }
  function error(err: unknown) {
    if (limitKindOf(err)) return
    const e = err as { data?: { statusMessage?: string, message?: string }, statusMessage?: string, message?: string }
    push(e?.data?.statusMessage ?? e?.statusMessage ?? e?.data?.message ?? e?.message ?? 'Fehler', 'error')
  }
  return { toasts, push, error }
}
