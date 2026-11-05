<script setup lang="ts">
import type { AccountsData } from '~/components/ProjectAccounts.vue'
import { byReach } from '~~/shared/utils/platform-reach'

const { t } = useI18n()
const { project, query } = useScope()
useHead({ title: t('accounts.title') })

const { data, refresh } = await useFetch<AccountsData>('/api/accounts', { query, key: computed(() => `accounts:${query.value.project ?? 'alle'}`) })
const current = computed(() => (project.value ? data.value?.projects.find(p => p.id === project.value!.id) ?? null : null))

const SHORT: Record<string, string> = { x: 'X', bluesky: 'Bs', mastodon: 'Ma', linkedin: 'in', instagram: 'IG', facebook: 'f', threads: 'Th', tiktok: 'TT', telegram: 'Tg' }
const short = (p: string) => SHORT[p] ?? p.slice(0, 2)
const sorted = <A extends { platform: string }>(list: A[]) => byReach(list, a => a.platform)
</script>

<template>
  <div v-if="data" class="page">
    <div class="page-head">
      <h1>{{ t('accounts.title') }}</h1>
    </div>
    <p v-if="!data.live" class="note hint">{{ t('accounts.dry') }} <NuxtLink to="/einstellungen/veroeffentlichen">{{ t('settings.title') }}</NuxtLink></p>

    <template v-if="current">
      <ProjectAccounts :data="data" :project="current" @changed="refresh" />
      <ProjectListening :project-id="current.id" :listening="current.listening" :admin="data.admin" @changed="refresh" />
    </template>

    <section v-else class="panel">
      <ul class="rows">
        <li v-for="p in data.projects" :key="p.id">
          <NuxtLink :to="`/p/${p.slug}/konten`" class="row-link orow">
            <ProjectMark :color="p.color" :icon="p.icon" :size="28" />
            <span class="oname ellipsis">{{ p.name }}</span>
            <span class="chips">
              <span v-for="a in sorted(p.accounts)" :key="a.id" class="pf" :class="{ bad: a.error }" :title="a.name ?? a.platform">{{ short(a.platform) }}</span>
              <span v-if="p.mailFrom" class="pf" :class="{ bad: p.mailError }" :title="p.mailFrom"><Icon name="mail" :size="12" /></span>
              <span v-if="!p.accounts.length && !p.mailFrom" class="dim small">{{ t('accounts.none') }}</span>
            </span>
            <Icon name="chevron-right" class="dim" />
          </NuxtLink>
        </li>
      </ul>
      <p v-if="data.unassigned.length" class="hint pad">{{ t('accounts.unassigned', { names: data.unassigned.map(u => u.name).join(', ') }) }}</p>
    </section>
  </div>
</template>

<style scoped>
.note {
  margin: -16px 0 0;
}

.orow {
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 10px 16px;
}

.oname {
  flex: 0 1 180px;
  font-weight: 500;
  font-size: 14px;
}

.chips {
  flex: 1 1 160px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.pf {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--panel2);
  border: 1px solid var(--line);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--muted);
}

.pf.bad {
  color: var(--down);
  border-color: var(--down);
}

.small {
  font-size: 12.5px;
}

.pad {
  margin: 0;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--line);
}
</style>
