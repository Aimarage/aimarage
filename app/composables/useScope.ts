import { ALL_SLUG } from '~~/shared/utils/domain'

export function useScope() {
  const route = useRoute()
  const { projectBySlug } = useBoot()
  const slug = computed(() => String(route.params.project ?? useCookie('ma_project').value ?? ALL_SLUG))
  const project = computed(() => projectBySlug(slug.value))
  const isAll = computed(() => !project.value)
  const base = computed(() => `/p/${project.value?.slug ?? ALL_SLUG}`)
  const query = computed(() => (project.value ? { project: project.value.slug } : {}))
  return { slug, project, isAll, base, query }
}
