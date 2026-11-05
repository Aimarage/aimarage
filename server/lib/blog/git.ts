import { createHash } from 'node:crypto'
import type { ProjectBlogGit } from '../../db/schema'
import { articleSlug } from '../../../shared/utils/article'
import { call, json } from './http'
import { BlogApiError, statusText, type ArticleImage, type ArticleInput, type BlogAdapter, type BlogTarget, type CallResult, type FetchLike } from './types'

export const GITHUB_API = 'https://api.github.com'
export const GITLAB_BASE = 'https://gitlab.com'
export const GIT_FILE_DEFAULT = '{slug}.md'
const GH_ERRORS = { 401: 'Token abgelehnt oder abgelaufen', 403: 'Token darf nicht ins Repo schreiben (Contents: Read and write)', 404: 'Repo, Branch oder Datei nicht gefunden (Token-Zugriff aufs Repo prüfen)', 409: 'Konflikt im Repo, Datei wurde gleichzeitig geändert', 422: 'Repo hat die Änderung abgelehnt' }
const GL_ERRORS = { 401: 'Token abgelehnt oder abgelaufen', 403: 'Token darf nicht ins Repo schreiben (Bereich api, Rolle Developer)', 404: 'Projekt, Branch oder Datei nicht gefunden (Token-Zugriff prüfen)', 400: 'Repo hat die Änderung abgelehnt' }
const SEGMENT = /^[\w-][\w.-]*$/
const PLACEHOLDER = /\{(slug|date|lang)\}/g

function segmentsOk(path: string): boolean {
  return path.split('/').every(s => SEGMENT.test(s) && !s.includes('..'))
}

export function gitDir(raw: string | null | undefined, label = 'Ordner'): string {
  const d = (raw ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.?\/+|\/+$/g, '')
  if (!d) throw new BlogApiError(`${label} fehlt`)
  if (d.length > 200 || !segmentsOk(d)) throw new BlogApiError(`${label} ungültig: nur Buchstaben, Ziffern, - _ . und /, kein .. und kein Punkt am Anfang`)
  return d
}

export function gitFilePattern(raw: string | null | undefined): string {
  const f = (raw ?? '').trim().replace(/^\/+/, '') || GIT_FILE_DEFAULT
  if (f.length > 120 || !f.includes('{slug}') || !/\.(md|mdx|markdown)$/i.test(f)) throw new BlogApiError('Dateiname muss {slug} enthalten und auf .md, .mdx oder .markdown enden')
  if (/\{(?!slug\}|date\}|lang\})/.test(f) || !segmentsOk(f.replace(PLACEHOLDER, 'x'))) throw new BlogApiError('Dateiname ungültig: erlaubt sind {slug}, {date}, {lang}, Buchstaben, Ziffern, - _ . und /')
  if (f.split('/').slice(0, -1).some(s => s.includes('{date}'))) throw new BlogApiError('{date} nur im Dateinamen, nicht im Unterordner')
  return f
}

export function gitPublicUrl(raw: string | null | undefined): string {
  const u = (raw ?? '').trim()
  if (!u.includes('{slug}')) throw new BlogApiError('Öffentliche Adresse muss {slug} enthalten')
  if (/\{(?!slug\}|date\}|lang\})/.test(u)) throw new BlogApiError('Öffentliche Adresse: erlaubt sind {slug}, {date} und {lang}')
  let p: URL
  try {
    p = new URL(u.replace(PLACEHOLDER, 'x'))
  }
  catch {
    throw new BlogApiError('Öffentliche Adresse ungültig')
  }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') throw new BlogApiError('Öffentliche Adresse: nur http(s)')
  if (u.length > 500) throw new BlogApiError('Öffentliche Adresse zu lang')
  return u
}

export type GitInput = { [K in keyof ProjectBlogGit]?: ProjectBlogGit[K] | null }

export function normalizeGit(input: GitInput | null | undefined): ProjectBlogGit {
  if (!input) throw new BlogApiError('Repo fehlt')
  const provider = input.provider === 'gitlab' ? 'gitlab' : 'github'
  const repo = (input.repo ?? '').trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
  if (provider === 'github' ? !/^[\w.-]+\/[\w.-]+$/.test(repo) : !/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) throw new BlogApiError(provider === 'github' ? 'Repo als owner/name angeben' : 'Projekt als gruppe/name angeben')
  if (repo.split('/').some(s => s === '.' || s === '..')) throw new BlogApiError('Repo ungültig')
  const branch = (input.branch ?? '').trim() || 'main'
  if (branch.length > 200 || !/^[\w.-]+(\/[\w.-]+)*$/.test(branch) || branch.includes('..') || branch.endsWith('.lock')) throw new BlogApiError('Branch ungültig')
  let base: string | null = null
  if (provider === 'gitlab') {
    const raw = input.base?.trim() || GITLAB_BASE
    let u: URL
    try {
      u = new URL(raw)
    }
    catch {
      throw new BlogApiError('GitLab-Adresse ungültig')
    }
    if (u.protocol !== 'https:') throw new BlogApiError('GitLab-Adresse: nur https')
    base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  }
  const imageDir = input.imageDir?.trim() ? gitDir(input.imageDir, 'Bilder-Ordner') : null
  return { provider, base, repo, branch, dir: gitDir(input.dir), file: gitFilePattern(input.file), publicUrl: gitPublicUrl(input.publicUrl), imageDir }
}

export function gitRepoUrl(g: Pick<ProjectBlogGit, 'provider' | 'base' | 'repo'>): string {
  return g.provider === 'gitlab' ? `${g.base || GITLAB_BASE}/${g.repo}` : `https://github.com/${g.repo}`
}

function cfg(t: BlogTarget): ProjectBlogGit {
  if (!t.git) throw new BlogApiError('Repo fehlt')
  return t.git
}

function safeSlug(slug: string): string {
  const s = articleSlug(slug)
  if (!s) throw new BlogApiError('Adresse (Slug) leer')
  return s
}

function safeLang(lang: string): string {
  if (!/^[a-z]{2}$/.test(lang)) throw new BlogApiError(`Sprache ungültig: ${lang}`)
  return lang
}

function fill(pattern: string, v: { slug: string, lang: string, date: string }): string {
  return pattern.replace(/\{slug\}/g, v.slug).replace(/\{lang\}/g, v.lang).replace(/\{date\}/g, v.date)
}

export function gitFilePath(g: Pick<ProjectBlogGit, 'dir' | 'file'>, v: { slug: string, lang: string, date: string, mainLang?: string | null }): string {
  const dir = gitDir(g.dir)
  const pattern = gitFilePattern(g.file)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw new BlogApiError('Datum ungültig')
  let name = fill(pattern, { slug: safeSlug(v.slug), lang: safeLang(v.lang), date: v.date })
  if (!pattern.includes('{lang}') && v.mainLang && v.lang !== v.mainLang) name = name.replace(/(\.[a-z]+)$/i, `.${v.lang}$1`)
  const path = `${dir}/${name}`
  if (!segmentsOk(path) || !path.startsWith(`${dir}/`)) throw new BlogApiError('Dateipfad ungültig')
  return path
}

export function gitArticleUrl(g: Pick<ProjectBlogGit, 'publicUrl'>, v: { slug: string, lang: string, date: string }): string {
  return fill(g.publicUrl, { slug: encodeURIComponent(safeSlug(v.slug)), lang: safeLang(v.lang), date: v.date })
}

export function yamlString(s: string): string {
  return JSON.stringify(s).replace(/[\u007F-\u009F\u2028\u2029\uFEFF]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export interface FrontmatterInput {
  title: string
  description: string
  date: string
  updated: string
  slug: string
  lang: string
  key?: string | null
  tags?: string[] | null
  image?: string | null
  canonical: string
  draft?: boolean
  aiGenerated?: boolean
}

export function gitMarkdown(f: FrontmatterInput, body: string): string {
  const lines = [
    '---',
    `title: ${yamlString(f.title)}`,
    `description: ${yamlString(f.description)}`,
    `date: ${f.date}`,
    `updated: ${f.updated}`,
    `slug: ${yamlString(safeSlug(f.slug))}`,
    `lang: ${safeLang(f.lang)}`,
    ...(f.key ? [`translationKey: ${yamlString(f.key)}`] : []),
    ...(f.tags?.length ? [`tags: [${f.tags.map(yamlString).join(', ')}]`] : []),
    ...(f.image ? [`image: ${yamlString(f.image)}`] : []),
    `canonical: ${yamlString(f.canonical)}`,
    ...(f.draft ? ['draft: true'] : []),
    `ai_generated: ${f.aiGenerated ? 'true' : 'false'}`,
    '---',
    '',
    '',
  ]
  return `${lines.join('\n')}${body.replace(/\r\n/g, '\n').trim()}\n`
}

export function frontmatterDate(md: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1]
  return fm ? /^date:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(fm)?.[1] ?? null : null
}

export function imagePublicPath(imageDir: string, file: string): string {
  return `/${imageDir.replace(/^(public|static)(\/|$)/, '')}/${file}`.replace(/\/{2,}/g, '/')
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }

export function imageFileName(img: ArticleImage): string {
  const ext = EXT[img.mime]
  if (!ext) throw new BlogApiError('Bildformat wird nicht übernommen, nur JPEG, PNG, WebP, GIF oder AVIF')
  const stem = articleSlug(img.name.replace(/\.[a-z0-9]+$/i, ''), 40) || 'bild'
  return `${stem}-${createHash('sha256').update(img.data).digest('hex').slice(0, 10)}.${ext}`
}

interface ExistingFile { content: Buffer, version: string }

interface Repo {
  list: (dir: string) => Promise<string[]>
  get: (path: string) => Promise<ExistingFile | null>
  put: (path: string, content: Buffer, message: string, existing: ExistingFile | null) => Promise<void>
}

function detail(r: CallResult): string {
  const m = r.body?.message ?? r.body?.error
  return typeof m === 'string' && m ? `: ${m.slice(0, 200)}` : ''
}

function encPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function github(g: ProjectBlogGit, token: string, fetchImpl: FetchLike): Repo & { check: () => Promise<void> } {
  const base = `${GITHUB_API}/repos/${encPath(g.repo)}`
  const h = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const ref = `ref=${encodeURIComponent(g.branch)}`
  const fail = (r: CallResult) => new BlogApiError(`${statusText(r.status, GH_ERRORS)}${r.status === 409 || r.status === 422 ? detail(r) : ''}`)
  return {
    async check() {
      const repo = await call(base, { method: 'GET', headers: h }, token, fetchImpl)
      if (repo.status !== 200) throw new BlogApiError(statusText(repo.status, { ...GH_ERRORS, 404: 'Repo nicht gefunden oder Token hat keinen Zugriff darauf' }))
      const br = await call(`${base}/branches/${encodeURIComponent(g.branch)}`, { method: 'GET', headers: h }, token, fetchImpl)
      if (br.status === 404) throw new BlogApiError(`Branch ${g.branch} nicht gefunden (404)`)
      if (br.status !== 200) throw fail(br)
      const probe = json({ content: '', encoding: 'utf-8' })
      const blob = await call(`${base}/git/blobs`, { method: 'POST', headers: { ...h, ...probe.headers }, body: probe.body }, token, fetchImpl)
      if (blob.status !== 201) throw new BlogApiError(statusText(blob.status, { ...GH_ERRORS, 404: 'Token darf nicht ins Repo schreiben (Contents: Read and write)' }))
    },
    async list(dir) {
      const r = await call(`${base}/contents/${encPath(dir)}?${ref}`, { method: 'GET', headers: h }, token, fetchImpl)
      if (r.status === 404) return []
      if (r.status !== 200) throw fail(r)
      return Array.isArray(r.body) ? (r.body as { name?: unknown, type?: unknown }[]).filter(e => e.type === 'file' && typeof e.name === 'string').map(e => String(e.name)) : []
    },
    async get(path) {
      const r = await call(`${base}/contents/${encPath(path)}?${ref}`, { method: 'GET', headers: h }, token, fetchImpl)
      if (r.status === 404) return null
      if (r.status !== 200) throw fail(r)
      if (typeof r.body?.sha !== 'string') throw new BlogApiError(`${path} ist keine Datei`)
      return { content: Buffer.from(typeof r.body.content === 'string' ? r.body.content : '', 'base64'), version: r.body.sha }
    },
    async put(path, content, message, existing) {
      const j = json({ message, content: content.toString('base64'), branch: g.branch, ...(existing ? { sha: existing.version } : {}) })
      const r = await call(`${base}/contents/${encPath(path)}`, { method: 'PUT', headers: { ...h, ...j.headers }, body: j.body }, token, fetchImpl)
      if (r.status !== 200 && r.status !== 201) throw fail(r)
    },
  }
}

function gitlab(g: ProjectBlogGit, token: string, fetchImpl: FetchLike): Repo & { check: () => Promise<void> } {
  const base = `${g.base || GITLAB_BASE}/api/v4/projects/${encodeURIComponent(g.repo)}`
  const h = { 'PRIVATE-TOKEN': token }
  const ref = `ref=${encodeURIComponent(g.branch)}`
  const file = (path: string) => `${base}/repository/files/${encodeURIComponent(path)}`
  const fail = (r: CallResult) => new BlogApiError(`${statusText(r.status, GL_ERRORS)}${r.status === 400 || r.status === 409 ? detail(r) : ''}`)
  return {
    async check() {
      const p = await call(base, { method: 'GET', headers: h }, token, fetchImpl)
      if (p.status !== 200) throw new BlogApiError(statusText(p.status, { ...GL_ERRORS, 404: 'Projekt nicht gefunden oder Token hat keinen Zugriff darauf' }))
      const self = await call(`${g.base || GITLAB_BASE}/api/v4/personal_access_tokens/self`, { method: 'GET', headers: h }, token, fetchImpl)
      const scopes = self.status === 200 && Array.isArray(self.body?.scopes) ? (self.body!.scopes as unknown[]).map(String) : null
      if (scopes && !scopes.includes('api')) throw new BlogApiError('Token braucht den Bereich api (write_repository gilt nur für git push, nicht für die Schnittstelle)')
      const br = await call(`${base}/repository/branches/${encodeURIComponent(g.branch)}`, { method: 'GET', headers: h }, token, fetchImpl)
      if (br.status === 404) throw new BlogApiError(`Branch ${g.branch} nicht gefunden (404)`)
      if (br.status !== 200) throw fail(br)
      if (br.body?.can_push === false) throw new BlogApiError(`Token darf nicht auf ${g.branch} schreiben (Rolle Developer, bei geschütztem Branch Maintainer)`)
    },
    async list(dir) {
      const names: string[] = []
      for (let page = 1; page <= 20; page++) {
        const r = await call(`${base}/repository/tree?path=${encodeURIComponent(dir)}&${ref}&per_page=100&page=${page}`, { method: 'GET', headers: h }, token, fetchImpl)
        if (r.status === 404) return names
        if (r.status !== 200) throw fail(r)
        const rows = Array.isArray(r.body) ? r.body as { name?: unknown, type?: unknown }[] : []
        names.push(...rows.filter(e => e.type === 'blob' && typeof e.name === 'string').map(e => String(e.name)))
        if (rows.length < 100) break
      }
      return names
    },
    async get(path) {
      const r = await call(`${file(path)}?${ref}`, { method: 'GET', headers: h }, token, fetchImpl)
      if (r.status === 404) return null
      if (r.status !== 200) throw fail(r)
      return { content: Buffer.from(typeof r.body?.content === 'string' ? r.body.content : '', 'base64'), version: typeof r.body?.last_commit_id === 'string' ? r.body.last_commit_id : '' }
    },
    async put(path, content, message, existing) {
      const j = json({ branch: g.branch, encoding: 'base64', content: content.toString('base64'), commit_message: message, ...(existing?.version ? { last_commit_id: existing.version } : {}) })
      const r = await call(file(path), { method: existing ? 'PUT' : 'POST', headers: { ...h, ...j.headers }, body: j.body }, token, fetchImpl)
      if (r.status !== 200 && r.status !== 201) throw fail(r)
    },
  }
}

export function gitRepo(t: BlogTarget, token: string, fetchImpl: FetchLike) {
  const g = cfg(t)
  return g.provider === 'gitlab' ? gitlab(g, token, fetchImpl) : github(g, token, fetchImpl)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function findDated(repo: Repo, path: string, date: string): Promise<string | null> {
  const i = path.lastIndexOf('/')
  const dir = path.slice(0, i)
  const name = path.slice(i + 1)
  if (!name.includes(date)) return null
  const re = new RegExp(`^${name.split(date).map(escapeRe).join('\\d{4}-\\d{2}-\\d{2}')}$`)
  const hit = (await repo.list(dir)).filter(n => re.test(n)).sort()[0]
  return hit ? `${dir}/${hit}` : null
}

function commitTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim()
  return `Aimarage: Artikel ${t.length > 72 ? `${t.slice(0, 71)}…` : t}`
}

export async function gitPublish(t: BlogTarget, token: string, a: ArticleInput, fetchImpl: FetchLike): Promise<{ url: string, path: string, changed: boolean }> {
  const g = cfg(t)
  const repo = gitRepo(t, token, fetchImpl)
  const startDate = a.date ?? a.updated
  let path = gitFilePath(g, { slug: a.slug, lang: a.lang, date: startDate, mainLang: a.mainLang })
  if (g.file.includes('{date}')) path = await findDated(repo, path, startDate) ?? path
  const existing = await repo.get(path)
  const date = (existing && frontmatterDate(existing.content.toString('utf8'))) || startDate
  const url = gitArticleUrl(g, { slug: a.slug, lang: a.lang, date })
  const md = gitMarkdown({ title: a.title, description: a.description, date, updated: a.updated, slug: a.slug, lang: a.lang, key: a.key, image: a.imageUrl, canonical: url, draft: t.status === 'draft', aiGenerated: a.aiGenerated }, a.body)
  const content = Buffer.from(md, 'utf8')
  if (existing?.content.equals(content)) return { url, path, changed: false }
  await repo.put(path, content, commitTitle(a.title), existing)
  return { url, path, changed: true }
}

export const gitBlog: BlogAdapter = {
  type: 'git',
  multiLang: true,
  async check(t, token, fetchImpl) {
    await gitRepo(t, token, fetchImpl).check()
  },
  async publish(t, token, a, fetchImpl) {
    const { url } = await gitPublish(t, token, a, fetchImpl)
    return { url }
  },
  async uploadImage(t, token, img, fetchImpl) {
    const g = cfg(t)
    if (!g.imageDir) throw new BlogApiError('Kein Bilder-Ordner eingetragen')
    const dir = gitDir(g.imageDir, 'Bilder-Ordner')
    const name = imageFileName(img)
    const path = `${dir}/${name}`
    if (!segmentsOk(path)) throw new BlogApiError('Bildpfad ungültig')
    const repo = gitRepo(t, token, fetchImpl)
    if (!await repo.get(path)) await repo.put(path, Buffer.from(img.data), `Aimarage: Bild ${name}`, null)
    return imagePublicPath(dir, name)
  },
}
