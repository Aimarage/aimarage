import { CATEGORY_COLOR_VAR, type Category } from '~~/shared/utils/domain'

export function useColors() {
  const { projectById } = useBoot()
  const projectColor = (projectId: string | null | undefined) => {
    const p = projectById(projectId)
    return p ? `var(--c-${p.color})` : 'var(--t-all)'
  }
  const categoryColor = (c: Category) => `var(${CATEGORY_COLOR_VAR[c]})`
  return { projectColor, categoryColor }
}
