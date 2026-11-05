export default defineNuxtRouteMiddleware((to) => {
  if (to.path.startsWith('/k/') || to.meta.public) return
  const { boot } = useBoot()
  if (to.path === '/login') {
    if (boot.value) return navigateTo('/')
    return
  }
  if (!boot.value) return navigateTo({ path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} })
})
