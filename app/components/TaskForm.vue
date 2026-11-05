<script setup lang="ts">
import { CATEGORIES, DRAFT_KINDS, PRIOS } from '~~/shared/utils/domain'
import type { TaskFormValue } from '~/composables/useTaskForm'


const props = defineProps<{ modelValue: TaskFormValue, busy?: boolean, submitLabel: string }>()
const emit = defineEmits<{ 'update:modelValue': [TaskFormValue], 'submit': [], 'cancel': [] }>()
const { t } = useI18n()
const { boot } = useBoot()
const v = computed({ get: () => props.modelValue, set: x => emit('update:modelValue', x) })
</script>

<template>
  <form class="tf" @submit.prevent="emit('submit')">
    <div class="form-grid">
      <label class="field wide"><span>{{ t('task.titleField') }}</span><input v-model="v.title" class="input" required maxlength="200" :placeholder="t('tasks.new')"></label>
      <label class="field"><span>{{ t('task.project') }}</span>
        <select v-model="v.project" class="select">
          <option :value="null">{{ t('task.allProjects') }}</option>
          <option v-for="p in boot?.projects ?? []" :key="p.id" :value="p.slug">{{ p.name }}</option>
        </select>
      </label>
      <label class="field"><span>{{ t('task.category') }}</span>
        <select v-model="v.category" class="select"><option v-for="c in CATEGORIES" :key="c" :value="c">{{ t(`cat.${c}`) }}</option></select>
      </label>
      <label class="field"><span>{{ t('task.due') }}</span><input v-model="v.dueDate" class="input" type="date"></label>
      <label class="field"><span>{{ t('task.time') }}</span><input v-model="v.dueTime" class="input" type="time" step="900" :disabled="!v.dueDate"></label>
      <label class="field"><span>{{ t('task.duration') }}</span><input v-model.number="v.durationMin" class="input" type="number" min="5" step="5"></label>
      <label class="field"><span>{{ t('task.estimate') }}</span><input v-model.number="v.estimateMin" class="input" type="number" min="0" step="5"></label>
      <label class="field"><span>{{ t('task.assignee') }}</span>
        <select v-model="v.assigneeUserId" class="select">
          <option :value="null">{{ t('task.nobody') }}</option>
          <option v-for="m in boot?.members ?? []" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
      </label>
      <label class="field"><span>{{ t('task.prio') }}</span>
        <select v-model="v.prio" class="select"><option v-for="p in PRIOS" :key="p" :value="p">{{ p }}</option></select>
      </label>
      <label class="field"><span>{{ t('task.agentStep') }}</span><input v-model="v.agentStep" class="input" maxlength="300"></label>
      <label class="field"><span>{{ t('task.humanStep') }}</span><input v-model="v.humanStep" class="input" maxlength="300"></label>
      <label class="field"><span>{{ t('task.draftKind') }}</span>
        <select v-model="v.draftKind" class="select">
          <option :value="null">{{ t('common.none') }}</option>
          <option v-for="k in DRAFT_KINDS" :key="k" :value="k">{{ t(`kind.${k}`) }}</option>
        </select>
      </label>
      <label class="field"><span>{{ t('task.channel') }}</span><input v-model="v.channel" class="input" maxlength="200" placeholder="reddit:r/mcp, mail, blog"></label>
      <label class="field"><span>{{ t('task.targetUrl') }}</span><input v-model="v.targetUrl" class="input" type="url" placeholder="https://"></label>
      <label class="field"><span>{{ t('task.metric') }}</span><input v-model="v.metric" class="input" maxlength="300"></label>
      <label class="field"><span>{{ t('task.followUp') }}</span><input v-model="v.followUpOn" class="input" type="date"></label>
      <label class="field wide"><span>{{ t('task.description') }}</span><textarea v-model="v.description" class="textarea" rows="4" /></label>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn primary" :disabled="props.busy">{{ props.submitLabel }}</button>
      <button type="button" class="btn ghost" @click="emit('cancel')">{{ t('task.cancel') }}</button>
    </div>
  </form>
</template>

<style scoped>
.tf {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
</style>
