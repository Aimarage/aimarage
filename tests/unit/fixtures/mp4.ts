function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function fakeMp4(opts: { seconds: number, width: number, height: number, rotate?: boolean }): Uint8Array {
  const mvhd = new Uint8Array(100)
  const mv = new DataView(mvhd.buffer)
  mv.setUint32(12, 1000)
  mv.setUint32(16, Math.round(opts.seconds * 1000))
  const tkhd = new Uint8Array(84)
  const tk = new DataView(tkhd.buffer)
  if (opts.rotate) {
    tk.setInt32(44, 65536)
    tk.setInt32(52, -65536)
  }
  else {
    tk.setInt32(40, 65536)
    tk.setInt32(56, 65536)
  }
  tk.setUint32(76, opts.width * 65536)
  tk.setUint32(80, opts.height * 65536)
  const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6F, 0x6D, 0, 0, 0, 0]))
  return concat(ftyp, box('moov', concat(box('mvhd', mvhd), box('trak', box('tkhd', tkhd)))), box('mdat', new Uint8Array(64)))
}
