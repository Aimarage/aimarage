import { config } from '~~/server/lib/config'
import { systemMailConfig } from '~~/server/lib/system-mail'

export default defineEventHandler(() => ({ password: config.authPassword, hosted: config.hosted, mail: !!systemMailConfig.smtpUrl }))
