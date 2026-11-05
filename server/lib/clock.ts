import { timeIn, todayIn } from '../../shared/utils/dates'
import { config } from './config'

export function now(): Date {
  const fixed = config.fixedNow
  if (!fixed) return new Date()
  const d = new Date(fixed)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

export function today(timezone: string): string {
  return todayIn(timezone, now())
}

export function nowTime(timezone: string): string {
  return timeIn(timezone, now())
}
