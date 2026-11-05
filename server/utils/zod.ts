import { z } from 'zod'
import { isHttpUrl } from '../../shared/utils/url'

export { z }

export function httpUrl(max: number) {
  return z.string().max(max).refine(isHttpUrl, { message: 'Nur http(s)-Links' })
}
