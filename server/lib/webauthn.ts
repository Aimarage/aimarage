import { and, eq, gt, lt } from 'drizzle-orm'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { AuthError } from './auth-codes'
import { now } from './clock'
import { config } from './config'
import type { DbOrTx } from './db'
import { schema } from './db'

const CHALLENGE_TTL_MS = 5 * 60_000

type ChallengeKind = 'register' | 'login' | 'step_up'
type Transport = AuthenticatorTransport

export const PASSKEY_SNOOZE_DAYS = 30

async function storeChallenge(db: DbOrTx, kind: ChallengeKind, challenge: string, userId: string | null): Promise<string> {
  const at = now()
  await db.delete(schema.webauthnChallenges).where(lt(schema.webauthnChallenges.expiresAt, at))
  const [row] = await db.insert(schema.webauthnChallenges).values({ kind, challenge, userId, expiresAt: new Date(at.getTime() + CHALLENGE_TTL_MS) }).returning({ id: schema.webauthnChallenges.id })
  return row!.id
}

async function takeChallenge(db: DbOrTx, id: string, kind: ChallengeKind, userId: string | null): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AuthError(400, 'Passkey-Anfrage abgelaufen, bitte erneut versuchen')
  const [row] = await db.delete(schema.webauthnChallenges)
    .where(and(eq(schema.webauthnChallenges.id, id), eq(schema.webauthnChallenges.kind, kind), gt(schema.webauthnChallenges.expiresAt, now())))
    .returning()
  if (!row || (userId && row.userId !== userId)) throw new AuthError(400, 'Passkey-Anfrage abgelaufen, bitte erneut versuchen')
  return row.challenge
}

export async function passkeyRegistrationOptions(db: DbOrTx, user: { id: string, email: string, name: string, webauthnUserId: string }) {
  const existing = await db.select({ id: schema.passkeys.credentialId, transports: schema.passkeys.transports }).from(schema.passkeys).where(eq(schema.passkeys.userId, user.id))
  const options = await generateRegistrationOptions({
    rpName: 'Aimarage',
    rpID: config.rpId,
    userName: user.email,
    userDisplayName: user.name,
    userID: Buffer.from(user.webauthnUserId, 'hex'),
    attestationType: 'none',
    excludeCredentials: existing.map(p => ({ id: p.id, transports: p.transports as Transport[] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  const challengeId = await storeChallenge(db, 'register', options.challenge, user.id)
  return { challengeId, options }
}

export async function verifyPasskeyRegistration(db: DbOrTx, userId: string, challengeId: string, response: RegistrationResponseJSON, name: string) {
  const expectedChallenge = await takeChallenge(db, challengeId, 'register', userId)
  let verification
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: config.appOrigin, expectedRPID: config.rpId, requireUserVerification: true })
  }
  catch (err) {
    console.error('[webauthn] Registrierung fehlgeschlagen:', err instanceof Error ? err.message : err)
    throw new AuthError(400, 'Passkey konnte nicht geprüft werden')
  }
  if (!verification.verified || !verification.registrationInfo) throw new AuthError(400, 'Passkey konnte nicht geprüft werden')
  const info = verification.registrationInfo
  const [row] = await db.insert(schema.passkeys).values({
    userId,
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter,
    transports: info.credential.transports ?? response.response?.transports ?? [],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    name: name.trim().slice(0, 60) || 'Passkey',
  }).onConflictDoNothing().returning()
  if (!row) throw new AuthError(409, 'Dieser Passkey ist schon eingetragen')
  return row
}

function withHybrid(t: Transport[]): Transport[] | undefined {
  if (!t.length) return undefined
  return t.includes('hybrid') ? t : [...t, 'hybrid']
}

export async function passkeyLoginOptions(db: DbOrTx, userId: string | null = null, kind: 'login' | 'step_up' = 'login') {
  const own = userId ? await db.select({ id: schema.passkeys.credentialId, transports: schema.passkeys.transports }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId)) : []
  if (userId && !own.length) throw new AuthError(400, 'Für dieses Konto ist kein Passkey eingerichtet')
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials: own.map(p => ({ id: p.id, transports: withHybrid(p.transports as Transport[]) })),
  })
  const challengeId = await storeChallenge(db, kind, options.challenge, userId)
  return { challengeId, options }
}

export async function verifyPasskeyLogin(db: DbOrTx, challengeId: string, response: AuthenticationResponseJSON, userId: string | null = null, kind: 'login' | 'step_up' = 'login') {
  const credentialId = String(response?.id ?? '')
  const [pk] = credentialId ? await db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, credentialId)).limit(1) : []
  if (userId && pk?.userId !== userId) {
    await takeChallenge(db, challengeId, kind, userId).catch(() => {})
    throw new AuthError(401, 'Dieser Passkey gehört zu einem anderen Konto')
  }
  const expectedChallenge = await takeChallenge(db, challengeId, kind, userId)
  if (!pk) throw new AuthError(400, 'Dieser Passkey ist hier nicht bekannt. Bitte mit Code anmelden und den Passkey neu anlegen.')
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      credential: { id: pk.credentialId, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports as Transport[] },
      requireUserVerification: true,
    })
  }
  catch (err) {
    console.error('[webauthn] Anmeldung fehlgeschlagen:', err instanceof Error ? err.message : err)
    throw new AuthError(400, 'Anmeldung mit Passkey fehlgeschlagen')
  }
  if (!verification.verified) throw new AuthError(400, 'Anmeldung mit Passkey fehlgeschlagen')
  await db.update(schema.passkeys).set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: now() }).where(eq(schema.passkeys.id, pk.id))
  if (kind === 'login') await db.update(schema.users).set({ lastLoginAt: now() }).where(eq(schema.users.id, pk.userId))
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, pk.userId))
  return user!
}

export async function listPasskeys(db: DbOrTx, userId: string) {
  return db.select({ id: schema.passkeys.id, name: schema.passkeys.name, deviceType: schema.passkeys.deviceType, backedUp: schema.passkeys.backedUp, createdAt: schema.passkeys.createdAt, lastUsedAt: schema.passkeys.lastUsedAt })
    .from(schema.passkeys).where(eq(schema.passkeys.userId, userId)).orderBy(schema.passkeys.createdAt)
}

export async function countPasskeys(db: DbOrTx, userId: string): Promise<number> {
  return (await db.select({ id: schema.passkeys.id }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId))).length
}

export function passkeySnoozed(prefs: { passkeySnoozedUntil?: string } | null | undefined, at = now()): boolean {
  const until = prefs?.passkeySnoozedUntil ? new Date(prefs.passkeySnoozedUntil).getTime() : 0
  return until > at.getTime()
}

export async function shouldOfferPasskey(db: DbOrTx, user: { id: string, prefs: { passkeySnoozedUntil?: string } }): Promise<boolean> {
  if (passkeySnoozed(user.prefs)) return false
  return (await countPasskeys(db, user.id)) === 0
}
