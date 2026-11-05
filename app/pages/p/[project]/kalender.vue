<script setup lang="ts">
const { t } = useI18n()
const { boot, canEdit } = useBoot()
const { project, isAll, base } = useScope()
const { dayDm } = useFormat()
const toast = useToast()
useHead({ title: t('nav.calendar') })

const cal = useCalendar()

async function move(id: string, date: string, time: string | null) {
  const it = cal.data.value?.items.find(i => i.id === id)
  if (!it) return
  const before = { dueDate: it.dueDate, dueTime: it.dueTime }
  it.dueDate = date
  it.dueTime = time
  try {
    await $fetch(`/api/tasks/${id}`, { method: 'PATCH', body: { dueDate: date, dueTime: time } })
    toast.push(t('cal.moved', { date: `${dayDm(date)}${time ? ` ${time}` : ''}` }))
    await cal.refresh()
  }
  catch (err) {
    Object.assign(it, before)
    toast.error(err)
  }
}
</script>

<template>
  <div class="page wide">
    <div class="page-head">
      <div>
        <p class="crumbs">{{ project?.name ?? t('nav.allProjects') }}</p>
        <h1>{{ t('nav.calendar') }}</h1>
      </div>
      <div class="actions"><TaskCreateButton /></div>
    </div>
    <AiReviewerAsk v-if="boot?.projects.length" />
    <CalendarBoard
      :items="cal.data.value?.items ?? []"
      :view="cal.view.value"
      :anchor="cal.anchor.value"
      :today="boot!.today"
      :color-by="isAll ? 'project' : 'category'"
      :base="base"
      :hour-height="44"
      :start-hour="7"
      :end-hour="20"
      :draggable="canEdit"
      @update:view="cal.setView"
      @update:anchor="(a: string) => (cal.anchor.value = a)"
      @move="move"
    />
    <p v-if="canEdit" class="hint hide-m">{{ t('cal.dragHint') }}</p>
  </div>
</template>

<style scoped>
.wide {
  max-width: 1320px;
  gap: 20px;
}
</style>
