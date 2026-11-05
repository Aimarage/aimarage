export function useLimit() {
  const kind = useState<string | null>('limit-kind', () => null)

  function show(k: string) {
    kind.value = k || 'other'
  }

  function close() {
    kind.value = null
  }

  return { kind, show, close }
}

export function limitKindOf(err: unknown): string | null {
  const e = err as { statusCode?: number, status?: number, data?: { data?: { code?: string, kind?: string } } }
  const status = e?.statusCode ?? e?.status
  return status === 402 && e?.data?.data?.code === 'limit' ? e.data.data.kind ?? 'other' : null
}
