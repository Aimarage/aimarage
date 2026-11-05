import { ALL_SLUG } from '~~/shared/utils/domain'

export default defineNuxtRouteMiddleware((to) => {
  const slug = to.params.project
  if (!slug) return
  const last = useCookie('ma_project', { maxAge: 60 * 60 * 24 * 30, sameSite: 'lax', path: '/' })
  if (slug === ALL_SLUG) {
    last.value = ALL_SLUG
    return
  }
  const { boot, projectBySlug } = useBoot()
  if (boot.value && !projectBySlug(String(slug))) return abortNavigation(createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' }))
  last.value = String(slug)
})
