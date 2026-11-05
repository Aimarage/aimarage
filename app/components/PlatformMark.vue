<script setup lang="ts">
import { platformRule } from '~~/shared/utils/social'

const props = withDefaults(defineProps<{ platform: string, size?: number, missing?: boolean }>(), { size: 18 })
const { t } = useI18n()
const SHORT: Record<string, string> = { x: 'X', bluesky: 'Bs', mastodon: 'Ma', linkedin: 'in', instagram: 'IG', facebook: 'f', threads: 'Th', tiktok: 'TT', telegram: 'Tg', youtube: 'YT', reddit: 'r/', pinterest: 'P' }
const ICONS: Record<string, string> = { mail: 'mail', forum: 'chat', blog: 'doc', directory: 'list', external: 'external' }
const name = computed(() => (props.platform === 'mail' ? t('outlet.mail') : props.platform === 'forum' ? t('outlet.forum') : ICONS[props.platform] ? t(`where.mark.${props.platform}`) : platformRule(props.platform).label))
const label = computed(() => (props.missing ? `${name.value}: ${ICONS[props.platform] ? t('where.noTarget') : t('outlet.noAccount')}` : name.value))
</script>

<template>
  <span class="pm" :class="{ missing: props.missing }" :data-p="props.platform" :style="{ width: `${props.size}px`, height: `${props.size}px`, fontSize: `${Math.round(props.size * 0.42)}px` }" :title="label" role="img" :aria-label="label">
    <Icon v-if="ICONS[props.platform]" :name="ICONS[props.platform]!" :size="Math.round(props.size * 0.6)" />
    <template v-else>{{ SHORT[props.platform] ?? name.slice(0, 2) }}</template>
  </span>
</template>

<style scoped>
.pm {
  flex: none;
  display: inline-grid;
  place-items: center;
  border-radius: 5px;
  background: var(--panel2);
  border: 1px solid var(--line);
  font-weight: 600;
  line-height: 1;
  color: var(--muted);
}

.pm[data-p='bluesky'] {
  color: #1185fe;
}

.pm[data-p='mastodon'] {
  color: #6364ff;
}

.pm[data-p='linkedin'] {
  color: #0a66c2;
}

.pm[data-p='instagram'] {
  color: #d62976;
}

.pm[data-p='facebook'] {
  color: #1877f2;
}

.pm[data-p='reddit'] {
  color: #ff4500;
}

.pm[data-p='youtube'] {
  color: #e62117;
}

.pm[data-p='telegram'] {
  color: #229ed9;
}

.pm.missing {
  color: var(--warn);
  border: 1px dashed var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, var(--panel));
}
</style>
