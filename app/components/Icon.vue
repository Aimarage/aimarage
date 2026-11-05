<script setup lang="ts">
const props = withDefaults(defineProps<{ name: string, size?: number }>(), { size: 16 })

const paths: Record<string, string> = {
  'dashboard': '<path d="M2 2h5v6H2zM9 2h5v3H9zM9 7h5v7H9zM2 10h5v4H2z" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  'approvals': '<rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 8.2 7 10.2 11 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  'calendar': '<rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.3"/>',
  'tasks': '<path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  'history': '<circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.8V8l2.2 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  'reports': '<path d="M3 13V8M8 13V3M13 13V6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  'chevron-down': '<path d="M4.5 6.2 8 9.8l3.5-3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  'chevron-right': '<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  'chevron-left': '<path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  'mic': '<rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3v2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  'stop': '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>',
  'plus': '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  'check': '<path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  'users': '<circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.8 13.5c.4-2.4 2.1-3.8 4.2-3.8s3.8 1.4 4.2 3.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="11.2" cy="6" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M11.6 9.8c1.4.2 2.4 1.3 2.7 3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  'grid': '<rect x="2" y="2" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="2" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="9" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  'settings': '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  'key': '<circle cx="5.5" cy="10.5" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7.7 8.3 13.5 2.5M11 5l1.8 1.8M9.6 6.4l1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  'logout': '<path d="M6 2.5H3.5v11H6M10 5l3 3-3 3M13 8H6.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  'link': '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  'mail': '<rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m2.5 4.5 5.5 4.2 5.5-4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  'copy': '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  'external': '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.2c0 .5-.3.8-.8.8H3.3c-.5 0-.8-.3-.8-.8V4.8c0-.5.3-.8.8-.8h3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  'edit': '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  'x': '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  'list': '<path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="2.8" cy="4" r=".9" fill="currentColor"/><circle cx="2.8" cy="8" r=".9" fill="currentColor"/><circle cx="2.8" cy="12" r=".9" fill="currentColor"/>',
  'board': '<rect x="2" y="2.5" width="3.4" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="10.6" y="2.5" width="3.4" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  'agent': '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  'post': '<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  'doc': '<path d="M4 2h5.5L12 4.5V14H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 7.5h4M6 10h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  'search': '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.2 10.2 3.3 3.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  'play': '<path d="M5 3.5v9l7-4.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  'target': '<circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>',
  'chat': '<path d="M2.5 3.5h11v7.5H7.5L4.5 13.5V11h-2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.5 6.5h5M5.5 8.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  'send': '<path d="M2.5 8 13.5 2.8 10.5 13.5 7.6 9 2.5 8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7.6 9 13.5 2.8" stroke="currentColor" stroke-width="1.3"/>',
  'up': '<path d="M8 13V3.5M4 7.5 8 3.5l4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  'down': '<path d="M8 3v9.5M4 8.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  'pause': '<path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  'clip': '<path d="M10.5 5.5 6.2 9.8a1.3 1.3 0 0 0 1.8 1.8l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.3 7.9a3.9 3.9 0 0 0 5.5 5.5l3.7-3.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  'image': '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.5" r="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="m2.5 12 3.8-3.6 2.4 2.2 2-1.8 2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  'help': '<circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.4 6.3a1.7 1.7 0 0 1 3.3.5c0 1.1-1.7 1.4-1.7 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".8" fill="currentColor"/>',
  'menu': '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
}
</script>

<template>
  <svg :width="props.size" :height="props.size" viewBox="0 0 16 16" aria-hidden="true" style="flex: none" v-html="paths[props.name] ?? ''" />
</template>
