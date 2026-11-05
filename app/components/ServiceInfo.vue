<script setup lang="ts">
import type { TaskService } from '~~/shared/utils/service'

const props = defineProps<{ service: TaskService }>()
const { t } = useI18n()
const s = computed(() => props.service)
const account = computed(() => (s.value.account === 'vorhanden' ? t('service.accountHave') : s.value.register ? t('service.accountNewHow', { how: s.value.register }) : t('service.accountNew')))
</script>

<template>
  <div class="svc">
    <p v-if="s.what"><b>{{ t('service.what') }}</b> {{ s.what }}</p>
    <p v-if="s.why"><b>{{ t('service.why') }}</b> {{ s.why }}</p>
    <p class="facts">
      <span v-if="s.cost"><b>{{ t('service.cost') }}</b> {{ s.cost }}</span>
      <span><b>{{ t('service.account') }}</b> {{ account }}</span>
    </p>
    <p v-if="!s.fits && s.fitReason" class="warn">{{ s.fitReason }}</p>
  </div>
</template>

<style scoped>
.svc {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
}

.svc p {
  margin: 0;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.warn {
  color: var(--warn);
}
</style>
