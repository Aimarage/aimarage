<script setup lang="ts">
import type { TaskWhere } from '~~/shared/utils/where'

const props = defineProps<{ where: TaskWhere, project: { id: string, name: string, url: string | null } | null, onEdit?: () => void }>()
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()
const { isAdmin, canEdit } = useBoot()
const toast = useToast()

const label = computed(() => (props.where.newPost ? t('where.newPost') : t(`where.kind.${props.where.kind}`)))
const site = computed(() => props.project?.url?.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') ?? props.project?.name ?? '')
const missing = computed(() => t(`where.missing.${props.where.kind}`, { project: props.project?.name ?? '' }))
const example = computed(() => (props.project?.url ? `${props.project.url.replace(/\/$/, '')}/ratgeber` : 'https://'))
const canSet = computed(() => (props.where.kind === 'blog' ? isAdmin.value && !!props.project : canEdit.value && !!props.onEdit))

const open = ref(false)
const blog = ref('')
const busy = ref(false)
function set() {
  if (props.where.kind !== 'blog') return props.onEdit?.()
  open.value = !open.value
}
async function save() {
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.project!.id}`, { method: 'PATCH', body: { blog: blog.value.trim() } })
    toast.push(t('where.saved'))
    open.value = false
    emit('saved')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="wt">
    <p class="line">
      <PlatformMark :platform="props.where.mark ?? 'external'" :size="22" :missing="props.where.missing" />
      <b>{{ label }}</b>
      <span v-if="props.where.place" class="ellipsis">{{ props.where.newPost ? '' : '- ' }}<a v-if="props.where.url" :href="props.where.url" target="_blank" rel="noopener noreferrer">{{ props.where.place }}</a><template v-else>{{ props.where.place }}</template></span>
      <span v-else-if="props.where.missing" class="none">- {{ t('where.none') }}</span>
      <span class="dim">· {{ t(`where.by.${props.where.by}`) }}</span>
    </p>
    <p v-if="props.where.setup === 'reddit'" class="miss">{{ t('where.setupReddit') }} <NuxtLink v-if="isAdmin" to="/einstellungen/apps?app=brave">{{ t('where.setupLink') }}</NuxtLink></p>
    <template v-if="props.where.missing">
      <p class="miss">{{ missing }}</p>
      <p v-if="props.where.kind === 'blog'" class="sug dim">{{ t('where.suggest', { site }) }}</p>
      <div v-if="canSet && !open">
        <button type="button" class="btn small" @click="set"><Icon name="target" />{{ t('where.set') }}</button>
      </div>
      <form v-if="open" class="set" @submit.prevent="save">
        <label class="field"><span>{{ t('where.blogLabel') }}</span><input v-model="blog" class="input" type="url" required maxlength="300" :placeholder="example"></label>
        <div class="form-actions">
          <button type="submit" class="btn primary small" :disabled="busy">{{ t('common.save') }}</button>
          <button type="button" class="btn ghost small" @click="open = false">{{ t('common.cancel') }}</button>
        </div>
      </form>
    </template>
  </div>
</template>

<style scoped>
.wt {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin: 0;
  font-size: 14px;
  min-width: 0;
}

.line .ellipsis {
  min-width: 0;
  max-width: 100%;
}

.none,
.miss {
  color: var(--warn);
}

.miss {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.sug {
  margin: 0;
  font-size: 13px;
}

.set {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}

.set .field {
  flex: 1 1 240px;
  margin: 0;
}

.set .form-actions {
  margin: 0;
}
</style>
