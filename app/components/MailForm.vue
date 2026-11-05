<script setup lang="ts">
export interface MailInfo {
  imap: { host: string, port: number, secure: boolean, user: string }
  smtp: { host: string, port: number, secure: boolean, user: string }
  from: string
  hint: string
  checkedAt: string | null
  error: string | null
  lastSync: string | null
  markSeen?: boolean
}

const props = defineProps<{ projectId: string, mail: MailInfo | null }>()
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()
const { boot } = useBoot()
const toast = useToast()

const m = props.mail
const parsedFrom = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(m?.from ?? '')
const fromName = ref(parsedFrom ? parsedFrom[1]! : '')
const fromAddress = ref(parsedFrom ? parsedFrom[2]! : (m?.from ?? ''))
const f = ref(m
  ? { imapHost: m.imap.host, imapPort: m.imap.port, imapSecure: m.imap.secure, smtpHost: m.smtp.host === m.imap.host ? '' : m.smtp.host, smtpPort: m.smtp.port, smtpSecure: m.smtp.secure, user: m.imap.user, smtpUser: m.smtp.user === m.imap.user ? '' : m.smtp.user, from: m.from, imapPassword: '', smtpPassword: '' }
  : { imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 587, smtpSecure: false, user: '', smtpUser: '', from: '', imapPassword: '', smtpPassword: '' })
watch(() => f.value.smtpPort, (v) => {
  if (v === 587 || v === 25) f.value.smtpSecure = false
  if (v === 465) f.value.smtpSecure = true
})

const busy = ref(false)
async function save() {
  busy.value = true
  try {
    const v = f.value
    v.from = fromName.value.trim() ? `${fromName.value.trim()} <${fromAddress.value.trim()}>` : fromAddress.value.trim()
    const res = await $fetch<{ ok: boolean, check: { imap: string | null, smtp: string | null, switched?: boolean } }>(`/api/projects/${props.projectId}/mail`, { method: 'PUT', body: { ...v, smtpHost: v.smtpHost || v.imapHost, smtpUser: v.smtpUser || null, imapPassword: v.imapPassword || undefined, smtpPassword: v.smtpPassword || undefined } })
    if (res.check.switched) {
      v.smtpPort = 587
      v.smtpSecure = false
      toast.push(t('mailbox.switched'))
    }
    toast.push(res.ok ? t('mailbox.ok') : [res.check.imap, res.check.smtp].filter(Boolean).join(' / '), res.ok ? 'ok' : 'error')
    if (res.ok) emit('saved')
  }
  catch (err) {
    toast.error(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="form-grid" autocomplete="off" @submit.prevent="save">
    <p class="help wide">{{ t('mailbox.intro') }}</p>
    <label class="field"><span>{{ t('mailbox.fromName') }}</span><input v-model="fromName" class="input" placeholder="Alex Muster"></label>
    <label class="field"><span>{{ t('mailbox.fromAddress') }}</span><input v-model="fromAddress" class="input" type="email" placeholder="alex@example.com" required></label>
    <h3 class="sub wide">{{ t('mailbox.imapTitle') }}</h3>
    <label class="field"><span>{{ t('mailbox.server') }}</span><input v-model="f.imapHost" class="input mono" placeholder="mail.example.com" required></label>
    <label class="field"><span>{{ t('mailbox.port') }}</span><input v-model.number="f.imapPort" class="input mono" type="number" required></label>
    <label class="field"><span>{{ t('mailbox.user') }}</span><input v-model="f.user" class="input" autocomplete="off" required></label>
    <label class="field"><span>{{ t('mailbox.password') }}<template v-if="props.mail"> ({{ t('settings.keyStored', { hint: props.mail.hint }) }})</template></span><input v-model="f.imapPassword" class="input mono" type="password" autocomplete="new-password" :required="!props.mail"></label>
    <label class="check wide"><input v-model="f.imapSecure" type="checkbox"> SSL/TLS</label>
    <h3 class="sub wide">{{ t('mailbox.smtpTitle') }}</h3>
    <label class="field"><span>{{ t('mailbox.server') }} {{ t('mailbox.sameHint') }}</span><input v-model="f.smtpHost" class="input mono" :placeholder="f.imapHost"></label>
    <label class="field"><span>{{ t('mailbox.port') }}</span><input v-model.number="f.smtpPort" class="input mono" type="number" required></label>
    <label class="field"><span>{{ t('mailbox.user') }} {{ t('mailbox.sameHint') }}</span><input v-model="f.smtpUser" class="input" :placeholder="f.user"></label>
    <label class="field"><span>{{ t('mailbox.password') }} {{ t('mailbox.sameHint') }}</span><input v-model="f.smtpPassword" class="input mono" type="password" autocomplete="new-password"></label>
    <label class="check wide"><input v-model="f.smtpSecure" type="checkbox"> SSL/TLS (465)</label>
    <p v-if="f.smtpPort === 465" class="warn wide">{{ t('mailbox.port465') }}</p>
    <p class="hint wide">{{ t('mailbox.hint') }}</p>
    <p class="hint wide">{{ t(boot?.features.hosted ? 'mailbox.thirdPartyHosted' : 'mailbox.thirdParty') }}</p>
    <div class="form-actions wide"><button type="submit" class="btn primary" :disabled="busy">{{ t('mailbox.saveCheck') }}</button></div>
  </form>
</template>

<style scoped>
.form-grid {
  padding: 14px 16px 16px;
  background: var(--panel2);
  border-top: 1px solid var(--line);
}

.help {
  font-size: 13px;
  color: var(--muted);
}


.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
}

.warn {
  font-size: 13px;
  color: var(--warn);
}

.sub {
  font-size: 13px;
  font-weight: 600;
  margin: 6px 0 0;
}

.wide {
  grid-column: 1 / -1;
  margin: 0;
}
</style>
