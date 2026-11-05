export interface VideoInfo {
  seconds: number | null
  width: number | null
  height: number | null
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta'])

function boxes(data: Uint8Array, start: number, end: number, visit: (type: string, body: number, stop: number) => void): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let at = start
  while (at + 8 <= end) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!)
    let head = 8
    if (size === 1) {
      if (at + 16 > end) return
      size = Number(view.getBigUint64(at + 8))
      head = 16
    }
    else if (size === 0) {
      size = end - at
    }
    if (size < head || at + size > end) return
    visit(type, at + head, at + size)
    if (CONTAINERS.has(type)) boxes(data, at + head, at + size, visit)
    at += size
  }
}

export function videoInfo(data: Uint8Array): VideoInfo {
  const out: VideoInfo = { seconds: null, width: null, height: null }
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    boxes(data, 0, data.byteLength, (type, body) => {
      if (type === 'mvhd' && out.seconds === null) {
        const v = data[body]!
        const scale = v === 1 ? view.getUint32(body + 20) : view.getUint32(body + 12)
        const dur = v === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16)
        if (scale > 0) out.seconds = Math.round((dur / scale) * 10) / 10
      }
      if (type === 'tkhd' && !out.width) {
        const v = data[body]!
        const m = body + (v === 1 ? 52 : 40)
        const w = view.getUint32(m + 36) / 65536
        const h = view.getUint32(m + 40) / 65536
        if (w > 0 && h > 0) {
          const b = view.getInt32(m + 4)
          const c = view.getInt32(m + 12)
          const turned = b !== 0 && c !== 0
          out.width = Math.round(turned ? h : w)
          out.height = Math.round(turned ? w : h)
        }
      }
    })
  }
  catch {
    return out
  }
  return out
}

export function isVertical(info: VideoInfo): boolean | null {
  if (!info.width || !info.height) return null
  return info.height >= info.width
}
