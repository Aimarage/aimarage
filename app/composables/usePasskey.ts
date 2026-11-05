import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser'

type AuthOptions = Parameters<typeof startAuthentication>[0]['optionsJSON']
type RegOptions = Parameters<typeof startRegistration>[0]['optionsJSON']

export function usePasskey() {
  const stepUp = useStepUp()

  async function signIn(autofill = false): Promise<void> {
    const { challengeId, options } = await $fetch<{ challengeId: string, options: AuthOptions }>('/api/auth/passkey/login/options', { method: 'POST' })
    const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill })
    await $fetch('/api/auth/passkey/login/verify', { method: 'POST', body: { challengeId, response } })
  }

  async function register(name: string): Promise<void> {
    const { challengeId, options } = await stepUp.run(() => $fetch<{ challengeId: string, options: RegOptions }>('/api/auth/passkey/register/options', { method: 'POST' }))
    const response = await startRegistration({ optionsJSON: options })
    await $fetch('/api/auth/passkey/register/verify', { method: 'POST', body: { challengeId, response, name } })
  }

  async function confirm(): Promise<void> {
    const { challengeId, options } = await $fetch<{ challengeId: string, options: AuthOptions }>('/api/auth/step-up', { method: 'POST', body: { method: 'passkey-options' } })
    const response = await startAuthentication({ optionsJSON: options })
    await $fetch('/api/auth/step-up', { method: 'POST', body: { method: 'passkey', challengeId, response } })
  }

  return { signIn, register, confirm, supported: browserSupportsWebAuthn, autofillSupported: browserSupportsWebAuthnAutofill, cancel: () => WebAuthnAbortService.cancelCeremony() }
}

export function deviceName(locale = 'de'): string {
  const ua = import.meta.client ? navigator.userAgent : ''
  if (!ua) return 'Passkey'
  const de = locale === 'de'
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : de ? 'Gerät' : 'Device'
  const browser = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  return de ? `${browser} auf ${os}` : `${browser} on ${os}`
}

export function isPasskeyCancel(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'NotAllowedError' || name === 'AbortError'
}
