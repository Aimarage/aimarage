export default defineNuxtPlugin(() => {
  const limit = useLimit()
  const base = globalThis.$fetch
  globalThis.$fetch = base.create({
    onResponseError({ response }) {
      const d = (response._data as { data?: { code?: string, kind?: string } } | undefined)?.data
      if (response.status === 402 && d?.code === 'limit') limit.show(d.kind ?? 'other')
    },
  }) as typeof base
})
