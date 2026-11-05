import { config } from '~~/server/lib/config'

// Welche Anmeldungen die App anbieten soll.
export default defineEventHandler(() => ({ password: config.authPassword, code: true }))
