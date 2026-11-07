<script setup lang="ts">
interface Teaser {
  summary: string
  positioning: string | null
  channels: { name: string, why: string }[]
  posts: { channel: string, text: string }[]
}

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()
const { data } = useFetch<{ teaser?: Teaser | null, hidden?: number }>(() => `/api/onboarding/${props.projectId}`, { key: computed(() => `preview:${props.projectId}`) })
const teaser = computed(() => data.value?.teaser ?? null)
</script>

<template>
  <section v-if="teaser" class="panel">
    <div class="panel-head"><h2>{{ t('preview.title') }}</h2><span class="hint">{{ t('preview.hint') }}</span></div>
    <div class="pad16 tz">
      <p v-if="teaser.positioning" class="lead">{{ teaser.positioning }}</p>
      <p v-if="teaser.summary" class="muted">{{ teaser.summary }}</p>

      <h3>{{ t('preview.channels') }}</h3>
      <ol class="chans">
        <li v-for="c in teaser.channels" :key="c.name"><b>{{ c.name }}</b><span class="muted">{{ c.why }}</span></li>
      </ol>

      <template v-if="teaser.posts.length">
        <h3>{{ t('preview.posts') }}</h3>
        <div class="posts">
          <article v-for="(p, i) in teaser.posts" :key="i" class="post">
            <span class="dim mono small">{{ p.channel }}</span>
            <p>{{ p.text }}</p>
          </article>
        </div>
      </template>

      <div class="locked" aria-hidden="false">
        <ul class="blur" aria-hidden="true">
          <li v-for="n in 4" :key="n"><span class="bar w1" /><span class="bar w2" /></li>
        </ul>
        <div class="over">
          <Icon name="key" />
          <b>{{ t('preview.lockedTitle', { n: data?.hidden ?? 0 }) }}</b>
          <span class="muted small">{{ t('preview.lockedText') }}</span>
          <NuxtLink to="/abo" class="btn primary">{{ t('preview.cta') }}</NuxtLink>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tz {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tz h3 {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--muted);
  font-weight: var(--head-weight);
}

.lead {
  margin: 0;
  font-size: 15px;
  line-height: 1.5;
}

.muted {
  color: var(--muted);
  line-height: 1.5;
}

.tz > p {
  margin: 0;
}

.chans {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding-left: 18px;
}

.chans li span {
  display: block;
  font-size: 13px;
}

.posts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
}

.post {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 10px 12px;
}

.post p {
  margin: 6px 0 0;
  white-space: pre-line;
  line-height: 1.5;
  font-size: 13px;
}

.locked {
  position: relative;
  margin-top: 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
}

.blur {
  margin: 0;
  padding: 16px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  filter: blur(3px);
  opacity: 0.5;
}

.blur li {
  display: flex;
  gap: 10px;
}

.bar {
  height: 10px;
  border-radius: 5px;
  background: var(--muted);
}

.w1 {
  width: 30%;
}

.w2 {
  width: 55%;
}

.over {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  text-align: center;
}

.small {
  font-size: 12px;
}
</style>
