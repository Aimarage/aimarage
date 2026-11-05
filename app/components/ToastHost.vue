<script setup lang="ts">
const { toasts } = useToast()
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  z-index: 100;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(420px, calc(100vw - 32px));
}

.toast {
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  font-size: 13.5px;
  box-shadow: var(--shadow);
}

.toast.error {
  background: var(--down);
  color: #fff;
}
</style>
