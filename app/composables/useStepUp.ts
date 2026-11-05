let resolver: ((ok: boolean) => void) | null = null

export class StepUpCancelled extends Error {
  override name = 'AbortError'
}

export function useStepUp() {
  const open = useState<boolean>('step-up-open', () => false)

  function ask(): Promise<boolean> {
    resolver?.(false)
    open.value = true
    return new Promise<boolean>((resolve) => {
      resolver = resolve
    })
  }

  function done(ok: boolean) {
    open.value = false
    const r = resolver
    resolver = null
    r?.(ok)
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    }
    catch (err) {
      if (!isStepUpError(err)) throw err
      if (!(await ask())) throw new StepUpCancelled('cancelled')
      return fn()
    }
  }

  return { open, ask, done, run }
}

export function usePasskeyOffer() {
  return useState<boolean>('passkey-offer', () => false)
}

export function usePasskeyOfferSeen() {
  return useState<boolean>('passkey-offer-seen', () => false)
}
