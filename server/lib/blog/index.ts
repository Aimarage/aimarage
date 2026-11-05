import { aimarageBlog } from './aimarage'
import { gitBlog } from './git'
import { BlogApiError, type ArticleInput, type BlogAdapter, type BlogTarget, type FetchLike } from './types'
import { webflowBlog } from './webflow'
import { wordpressBlog } from './wordpress'

export * from './types'

export const BLOG_TYPES = ['aimarage', 'wordpress', 'webflow', 'git'] as const

const adapters: Record<string, BlogAdapter> = { aimarage: aimarageBlog, wordpress: wordpressBlog, webflow: webflowBlog, git: gitBlog }

export function blogAdapter(target: Pick<BlogTarget, 'type'>): BlogAdapter {
  const a = adapters[target.type ?? 'aimarage']
  if (!a) throw new BlogApiError('Unbekannte Art des Veröffentlichens')
  return a
}

export function publishTo(target: BlogTarget, secret: string, article: ArticleInput, fetchImpl: FetchLike = fetch): Promise<{ url: string }> {
  return blogAdapter(target).publish(target, secret, article, fetchImpl)
}
