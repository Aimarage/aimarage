<script setup lang="ts">
interface FirstStepsData {
  steps: { project: boolean, strategy: boolean, account: boolean, mainSwitch: boolean, passkey: boolean }
  hidden: boolean
}

const { t } = useI18n()
const { base } = useScope()
const { isAdmin } = useBoot()
const { data, refresh } = await useFetch<FirstStepsData>('/api/me/first-steps', { key: 'first-steps' })

const items = computed(() => {
  const s = data.value?.steps
  if (!s) return []
  return [
    { key: 'project', done: s.project, to: '/projekte/neu', admin: true },
    { key: 'strategy', done: s.strategy, to: `${base.value}/strategie`, admin: false },
    { key: 'account', done: s.account, to: `${base.value}/konten`, admin: false },
    { key: 'mainSwitch', done: s.mainSwitch, to: '/einstellungen/veroeffentlichen', admin: false },
    { key: 'passkey', done: s.passkey, to: '/einstellungen/sicherheit', admin: false },
  ].filter(i => !i.admin || isAdmin.value)
})
const show = computed(() => !!data.value && !data.value.hidden && items.value.some(i => !i.done))

async function hide() {
  await $fetch('/api/me', { method: 'PATCH', body: { prefs: { firstStepsHidden: true } } }).catch(() => {})
  await refresh()
}
</script>

<template>
  <section v-if="show" class="panel steps" aria-labelledby="h-steps">
    <div class="panel-head">
      <h2 id="h-steps">{{ t('firstSteps.title') }}</h2>
      <button type="button" class="btn ghost small" @click="hide">{{ t('firstSteps.hide') }}</button>
    </div>
    <ol class="list">
      <li v-for="i in items" :key="i.key" :class="{ done: i.done }">
        <span class="mark" aria-hidden="true">{{ i.done ? '✓' : '' }}</span>
        <div>
          <NuxtLink :to="i.to">{{ t(`firstSteps.${i.key}`) }}</NuxtLink>
          <p class="hint">{{ t(`firstSteps.${i.key}Hint`) }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.steps .panel-head .btn {
  margin-left: auto;
}

.list {
  list-style: none;
  margin: 0;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.list li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.list p {
  margin: 2px 0 0;
}

.mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border: 1px solid var(--line2);
  border-radius: 50%;
  font-size: 12px;
  color: var(--up);
}

.done a {
  color: var(--muted);
  text-decoration: line-through;
}
</style>
