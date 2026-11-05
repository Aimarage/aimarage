import type { ProjectBlogApi } from '../../db/schema'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class BlogApiError extends Error {}

export class BlogLangError extends BlogApiError {
  constructor(public lang: string) {
    super(`Sprache ${lang.toUpperCase()} wird von der Website nicht angenommen (422)`)
  }
}

export class BlogRetryError extends BlogApiError {
  constructor(public seconds: number) {
    super(`Zu viele Anfragen (429), erneut in ${seconds} Sekunden`)
  }
}

export type BlogTarget = ProjectBlogApi

export interface ArticleImage {
  name: string
  mime: string
  data: Uint8Array
}

export interface ArticleInput {
  key: string
  lang: string
  slug: string
  title: string
  description: string
  body: string
  date?: string | null
  updated: string
  image?: ArticleImage | null
  imageUrl?: string | null
  aiGenerated?: boolean
  mainLang?: string | null
}

export interface BlogAdapter {
  type: NonNullable<ProjectBlogApi['type']>
  multiLang: boolean
  check: (target: BlogTarget, secret: string, fetchImpl: FetchLike) => Promise<void>
  publish: (target: BlogTarget, secret: string, article: ArticleInput, fetchImpl: FetchLike) => Promise<{ url: string }>
  uploadImage?: (target: BlogTarget, secret: string, image: ArticleImage, fetchImpl: FetchLike) => Promise<string>
  withdraw?: (target: BlogTarget, secret: string, postedUrl: string, fetchImpl: FetchLike) => Promise<{ deleted: boolean }>
}

export interface CallResult {
  status: number
  body: Record<string, unknown> | null
  retryAfter?: number | null
}

export function statusText(status: number, extra?: Partial<Record<number, string>>): string {
  if (extra?.[status]) return `${extra[status]} (${status})`
  if (status === 401 || status === 403) return `Zugang abgelehnt (${status}), bitte Zugangsdaten prüfen`
  if (status === 404) return 'Adresse nicht gefunden oder Schnittstelle abgeschaltet (404)'
  if (status === 429) return 'Zu viele Anfragen (429), später erneut'
  return `Seite antwortet mit Fehler ${status}`
}
