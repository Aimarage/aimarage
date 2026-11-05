import type { ListenVoice } from '~~/server/db/schema'
import { cleanHandle, voiceKey } from '~~/server/lib/conversation'
import { patchListening } from '~~/server/lib/listening'
import { CONVO_PLATFORMS } from '~~/shared/utils/listening'

// Mitreden: Plattformen ein/aus, Vorbilder anheften, sperren, ergänzen oder entfernen.
const body = z.object({
  convo: z.record(z.enum(CONVO_PLATFORMS), z.boolean()).optional(),
  voice: z.object({ platform: z.enum(CONVO_PLATFORMS), handle: z.string().trim().min(1).max(200), action: z.enum(['pin', 'unpin', 'block', 'unblock', 'add', 'remove']) }).optional(),
})

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'admin')
  const input = await parseBody(event, body)
  const st = p.setup?.listening ?? {}
  if (input.convo) await patchListening(db, p.id, { convo: { ...st.convo, ...input.convo } })
  if (input.voice) {
    const v = input.voice
    const handle = cleanHandle(v.platform, v.handle)
    if (!handle) throw createError({ statusCode: 400, statusMessage: 'Handle nicht lesbar' })
    const key = voiceKey({ platform: v.platform, handle })
    let list: ListenVoice[] = [...(st.voices?.list ?? [])]
    const cur = list.find(x => voiceKey(x) === key)
    if (v.action === 'remove') list = list.filter(x => voiceKey(x) !== key)
    else if (v.action === 'add') {
      if (cur) Object.assign(cur, { pinned: true, blocked: false })
      else list.unshift({ platform: v.platform, handle, name: null, followers: null, pinned: true, source: 'hand' })
    }
    else {
      const next: ListenVoice = cur ?? { platform: v.platform, handle, name: null, followers: null, source: 'hand' }
      if (v.action === 'pin') Object.assign(next, { pinned: true, blocked: false })
      if (v.action === 'unpin') next.pinned = false
      if (v.action === 'block') Object.assign(next, { blocked: true, pinned: false })
      if (v.action === 'unblock') next.blocked = false
      if (!cur) list.unshift(next)
    }
    await patchListening(db, p.id, { voices: { list, at: st.voices?.at ?? null } })
  }
  return { ok: true }
})
