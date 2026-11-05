<script setup lang="ts">
import { platformRule } from '~~/shared/utils/social'

const props = defineProps<{ platform: string, accounts: { platform: string, name: string }[], possible: boolean }>()
const { t } = useI18n()
const { base } = useScope()
const label = computed(() => (props.platform === 'mail' ? t('outlet.mail') : props.platform === 'forum' ? t('outlet.forum') : platformRule(props.platform).label))
const names = computed(() => props.accounts.map(a => (a.platform === props.platform ? a.name : `${platformRule(a.platform).label} ${a.name}`)).join(', '))
</script>

<template>
  <p class="pt">
    <PlatformMark :platform="props.platform" :size="22" />
    <b>{{ label }}</b>
    <template v-if="props.platform !== 'mail'">
      <span v-if="names" class="ellipsis">- {{ names }}</span>
      <template v-else-if="props.possible">
        <span class="none">- {{ t('outlet.noAccount') }}</span>
        <NuxtLink :to="`${base}/konten`">{{ t('outlet.connect') }}</NuxtLink>
      </template>
      <span v-else class="dim">- {{ t('outlet.manual') }}</span>
    </template>
  </p>
</template>

<style scoped>
.pt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin: 0;
  font-size: 14px;
  min-width: 0;
}

.pt .ellipsis {
  min-width: 0;
  max-width: 100%;
}

.none {
  color: var(--warn);
}
</style>
