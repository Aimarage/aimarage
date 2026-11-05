import { eq } from 'drizzle-orm'
import { hashPassword, hasStepUp, verifyPassword } from '~~/server/lib/auth'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'
import { updateSettings } from '~~/server/lib/connections'
import { today } from '~~/server/lib/clock'
import { planByBudget } from '~~/server/lib/time-budget'
import { BUDGET_CHOICES } from '~~/shared/utils/time-budget'

const body = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  locale: z.enum(['de', 'en']).optional(),
  prefs: z.object({
    calView: z.enum(['day', 'week', 'month']).optional(),
    tasksView: z.enum(['list', 'board']).optional(),
    lastProject: z.string().max(60).optional(),
    firstStepsHidden: z.boolean().optional(),
    morningMailOff: z.boolean().optional(),
  }).optional(),
  minutesPerDay: z.number().int().refine(n => (BUDGET_CHOICES as readonly number[]).includes(n)).optional(),
  currentPassword: z.string().max(500).optional(),
  newPassword: z.string().min(8).max(500).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const db = await getDb()
  const set: Partial<typeof schema.users.$inferInsert> = {}
  if (input.name) set.name = input.name
  if (input.locale) set.locale = input.locale
  if (input.prefs) set.prefs = { ...s.user.prefs, ...input.prefs }
  if (input.newPassword) {
    if (!config.authPassword) throw createError({ statusCode: 404, statusMessage: 'Passwort-Anmeldung ist ausgeschaltet' })
    if (s.user.passwordHash) {
      if (!(await verifyPassword(input.currentPassword ?? '', s.user.passwordHash))) throw createError({ statusCode: 400, statusMessage: 'Aktuelles Passwort stimmt nicht' })
    }
    else if (!hasStepUp(s)) {
      throw createError({ statusCode: 403, statusMessage: 'Bitte zuerst bestätigen', data: { stepUp: true } })
    }
    set.passwordHash = await hashPassword(input.newPassword)
  }
  if (input.minutesPerDay) {
    const userId = s.user.id
    const settings = await updateSettings(db, s.workspace.id, st => ({ ...st, timeBudget: { ...st.timeBudget, [userId]: input.minutesPerDay! } }))
    await planByBudget(db, { ...s.workspace, settings }, today(s.workspace.timezone))
  }
  if (Object.keys(set).length) await db.update(schema.users).set(set).where(eq(schema.users.id, s.user.id))
  return { ok: true }
})
