<script setup lang="ts">
definePageMeta({ layout: 'bare' })

interface Info {
  client?: { name: string, redirectHost: string, uri: string | null }
  requested?: 'read' | 'write'
  canWrite?: boolean
  account?: { name: string, email: string, workspace: string }
  error?: { code: string, message: string }
  redirect?: string | null
}

const { t } = useI18n()
const route = useRoute()
const toast = useToast()
useHead({ title: t('oauth.title') })

const params = computed(() => Object.fromEntries(Object.entries(route.query).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
const { data } = await useFetch<Info>('/api/oauth/authorize', { query: params, key: `oauth:${JSON.stringify(params.value)}` })
const write = ref(true)
const busy = ref(false)

async function decide(decision: 'approve' | 'deny') {
  busy.value = true
  try {
    const r = await $fetch<{ redirect: string }>('/api/oauth/authorize', { method: 'POST', body: { ...params.value, decision, write: write.value && !!data.value?.canWrite && data.value?.requested === 'write' } })
    window.location.href = r.redirect
  }
  catch (err) {
    toast.error(err)
    busy.value = false
  }
}
</script>

<template>
  <div class="card panel">
    <div class="brand">
      <AppLogo :size="28" />
      Aimarage
    </div>
    <template v-if="data?.error">
      <h1>{{ t('oauth.errorTitle') }}</h1>
      <p class="error" role="alert">{{ data.error.message }}</p>
      <a v-if="data.redirect" class="btn" :href="data.redirect">{{ t('oauth.back') }}</a>
    </template>
    <template v-else-if="data?.client">
      <h1>{{ t('oauth.ask', { app: data.client.name }) }}</h1>
      <p class="hint">{{ t('oauth.account', { name: data.account?.name, workspace: data.account?.workspace }) }}</p>
      <ul class="list">
        <li>{{ t('oauth.read') }}</li>
        <li v-if="data.requested === 'write' && data.canWrite">
          <label class="check"><input v-model="write" type="checkbox"> {{ t('oauth.write') }}</label>
        </li>
        <li>{{ t('oauth.never') }}</li>
      </ul>
      <p class="hint">{{ t('oauth.redirect', { host: data.client.redirectHost }) }}</p>
      <div class="actions">
        <button type="button" class="btn primary" :disabled="busy" @click="decide('approve')">{{ t('oauth.allow') }}</button>
        <button type="button" class="btn" :disabled="busy" @click="decide('deny')">{{ t('oauth.deny') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.card {
  width: min(440px, 100%);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 15px;
}

h1 {
  font-size: 21px;
  font-weight: var(--head-weight);
  overflow-wrap: anywhere;
}

.hint {
  margin: 0;
}

.list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.check input {
  width: 18px;
  height: 18px;
  accent-color: var(--primary);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.actions .btn {
  min-height: 44px;
  flex: 1 1 140px;
}
</style>
