export function errorText(err: unknown, fallback = 'Fehler'): string {
  const e = err as { data?: { statusMessage?: string, message?: string }, statusMessage?: string }
  return e?.data?.statusMessage ?? e?.statusMessage ?? e?.data?.message ?? fallback
}

export function errorStatus(err: unknown): number | undefined {
  return (err as { statusCode?: number, status?: number })?.statusCode ?? (err as { status?: number })?.status
}

export function isStepUpError(err: unknown): boolean {
  const e = err as { statusCode?: number, data?: { data?: { stepUp?: boolean } } }
  return e?.statusCode === 403 && e?.data?.data?.stepUp === true
}
