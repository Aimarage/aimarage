<template>
  <div class="bare">
    <slot />
  </div>
</template>

<style scoped>
.bare {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--bg);
}
</style>
