function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inline(text: string): string {
  let t = esc(text)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])/g, '<em>$1</em>')
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    const u = url.replace(/&amp;/g, '&')
    return /^(https?:\/\/|\/|#|mailto:)/.test(u) ? `<a href="${esc(u)}">${label}</a>` : label
  })
  return t
}

export function markdownToHtml(md: string): string {
  const blocks = md.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/)
  let html = ''
  for (const block of blocks) {
    const lines = block.split('\n')
    const h = /^(#{2,4})\s+(.*)$/.exec(lines[0]!)
    if (h && lines.length === 1) {
      html += `<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>\n`
    }
    else if (/^[-*]\s+/.test(lines[0]!) || /^\d+\.\s+/.test(lines[0]!)) {
      const tag = /^\d+\./.test(lines[0]!) ? 'ol' : 'ul'
      const items: string[] = []
      for (const l of lines) {
        const m = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(l)
        if (m) items.push(m[1]!)
        else if (items.length) items[items.length - 1] += ` ${l.trim()}`
      }
      html += `<${tag}>${items.map(i => `<li>${inline(i)}</li>`).join('')}</${tag}>\n`
    }
    else if (/^>\s?/.test(lines[0]!)) {
      html += `<blockquote><p>${inline(lines.map(l => l.replace(/^>\s?/, '')).join(' '))}</p></blockquote>\n`
    }
    else {
      html += `<p>${inline(lines.map(l => l.trim()).join(' '))}</p>\n`
    }
  }
  return html
}
