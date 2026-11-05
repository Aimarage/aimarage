<script setup lang="ts">
import { CONVO_PLATFORMS, type ConvoPlatform } from '~~/shared/utils/listening'
import { platformRule } from '~~/shared/utils/social'
import { byReach } from '~~/shared/utils/platform-reach'

export interface ListeningVoice {
  platform: ConvoPlatform
  handle: string
  name: string | null
  followers: number | null
  pinned: boolean
  blocked: boolean
  source: string
}

export interface ListeningInfo {
  mode: 'off' | 'suggest' | 'auto'
  pausedUntil: string | null
  auto: boolean
  convo: Record<ConvoPlatform, boolean>
  voices: ListeningVoice[]
  voicesAt: string | null
}

const props = defineProps<{ projectId: string, listening: ListeningInfo, admin: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const toast = useToast()
const busy = ref(false)

const MODES = ['off', 'suggest', 'auto'] as const
const paused = computed(() => (props.listening.pausedUntil && Date.parse(props.listening.pausedUntil) > Date.now() ? new Date(props.listening.pausedUntil).toLocaleDateString(locale.value) : null))
const voices = computed(() => [...props.listening.voices].sort((a, b) => Number(a.blocked) - Number(b.blocked) || Number(b.pinned) - Number(a.pinned) || (b.followers ?? 0) - (a.followers ?? 0)))
const PLATS = byReach(CONVO_PLATFORMS, p => p)
const addPlatform = ref<ConvoPlatform>('bluesky')
const addHandle = ref('')
const label = (p: string) => platformRule(p).label
const fmt = (n: number) => new Intl.NumberFormat(locale.value, { notation: 'compact' }).format(n)

async function save(mode: string) {
  await put(`/api/projects/${props.projectId}`, { listening: mode }, 'PATCH')
}

async function put(url: string, body: Record<string, unknown>, method: 'PUT' | 'PATCH' = 'PUT') {
  busy.value = true
  try {
    await $fetch(url, { method, body })
    toast.push(t('settings.saved'))
    emit('changed')
    return true
  }
  catch (err) {
    toast.error(err)
    return false
  }
  finally {
    busy.value = false
  }
}

function toggle(p: ConvoPlatform, on: boolean) {
  return put(`/api/projects/${props.projectId}/listening`, { convo: { [p]: on } })
}

function voice(v: Pick<ListeningVoice, 'platform' | 'handle'>, action: string) {
  return put(`/api/projects/${props.projectId}/listening`, { voice: { platform: v.platform, handle: v.handle, action } })
}

async function add() {
  if (!addHandle.value.trim()) return
  if (await voice({ platform: addPlatform.value, handle: addHandle.value }, 'add')) addHandle.value = ''
}
</script>

<template>
  <section class="panel lpanel">
    <div class="lrow">
      <span class="lname">{{ t('listening.title') }}</span>
      <select class="select" :value="props.listening.mode" :disabled="busy || !props.admin" @change="save(($event.target as HTMLSelectElement).value)">
        <option v-for="m in MODES" :key="m" :value="m" :disabled="m === 'auto' && !props.listening.auto">{{ t(`listening.mode.${m}`) }}</option>
      </select>
    </div>
    <p class="help">{{ t('listening.help') }}<template v-if="!props.listening.auto"> {{ t('listening.autoSoon') }}</template></p>
    <p v-if="paused && props.listening.mode !== 'off'" class="help warn">
      {{ t('listening.paused', { date: paused }) }}
      <button v-if="props.admin" type="button" class="btn small" :disabled="busy" @click="save(props.listening.mode)">{{ t('listening.resume') }}</button>
    </p>

    <template v-if="props.listening.mode !== 'off'">
      <div class="lrow convo">
        <span class="lname">{{ t('listening.convo.title') }}</span>
      </div>
      <p class="help">{{ t('listening.convo.help') }}</p>
      <div class="plats">
        <label v-for="p in PLATS" :key="p" class="plat">
          <input type="checkbox" :checked="props.listening.convo[p]" :disabled="busy || !props.admin" @change="toggle(p, ($event.target as HTMLInputElement).checked)">
          <PlatformMark :platform="p" :size="18" />
          <span>{{ label(p) }}</span>
        </label>
      </div>
      <p class="help">{{ t('listening.convo.self') }}</p>

      <details class="voices">
        <summary>{{ t('listening.convo.voices', { n: voices.filter(v => !v.blocked).length }) }}</summary>
        <p v-if="!voices.length" class="help">{{ t('listening.convo.noVoices') }}</p>
        <ul v-else class="vlist">
          <li v-for="v in voices" :key="`${v.platform}:${v.handle}`" class="vrow" :class="{ off: v.blocked }">
            <PlatformMark :platform="v.platform" :size="18" />
            <span class="vname ellipsis">@{{ v.handle }}<span v-if="v.name" class="dim"> {{ v.name }}</span></span>
            <span v-if="v.followers" class="mono dim small">{{ fmt(v.followers) }}</span>
            <template v-if="props.admin">
              <button v-if="!v.blocked" type="button" class="btn ghost small" :disabled="busy" :aria-pressed="v.pinned" @click="voice(v, v.pinned ? 'unpin' : 'pin')">{{ v.pinned ? t('listening.convo.unpin') : t('listening.convo.pin') }}</button>
              <button type="button" class="btn ghost small" :disabled="busy" @click="voice(v, v.blocked ? 'unblock' : 'block')">{{ v.blocked ? t('listening.convo.unblock') : t('listening.convo.block') }}</button>
            </template>
          </li>
        </ul>
        <form v-if="props.admin" class="vadd" @submit.prevent="add">
          <select v-model="addPlatform" class="select" :disabled="busy">
            <option v-for="p in PLATS" :key="p" :value="p">{{ label(p) }}</option>
          </select>
          <input v-model="addHandle" class="input" :placeholder="t('listening.convo.handle')" maxlength="200">
          <button type="submit" class="btn small" :disabled="busy || !addHandle.trim()">{{ t('listening.convo.add') }}</button>
        </form>
      </details>
    </template>
  </section>
</template>

<style scoped>
.lpanel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
}

.lrow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.lrow.convo {
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.lname {
  flex: 1 1 auto;
  font-weight: 500;
  font-size: 13.5px;
}

.lrow .select {
  width: auto;
  min-width: 200px;
}

.help {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
}

.warn {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--down);
}

.plats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}

.plat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  font-size: 13.5px;
  cursor: pointer;
}

.voices summary {
  font-size: 13px;
  cursor: pointer;
  min-height: 32px;
  display: flex;
  align-items: center;
}

.vlist {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.vrow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  font-size: 13px;
  border-top: 1px solid var(--line);
}

.vrow.off .vname {
  text-decoration: line-through;
  color: var(--dim);
}

.vname {
  flex: 1 1 auto;
  min-width: 0;
}

.vadd {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.vadd .select {
  width: auto;
}

.vadd .input {
  flex: 1 1 180px;
  width: auto;
}
</style>
