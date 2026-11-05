import { config } from '~~/server/lib/config'
import { publicHelpDoc } from '~~/server/lib/help'
import { helpSectionUrl } from '~~/shared/utils/help'

export default defineEventHandler((event) => {
  const base = config.appUrl
  const doc = publicHelpDoc('en')
  const lines = [
    '# Aimarage',
    '',
    '> Aimarage is an AI marketing agent: it plans goals, strategy and tasks per project, writes drafts and evaluates results. A human reviews and approves.',
    '',
    `To connect an AI assistant via MCP, read ${helpSectionUrl(base, 'mcp', 'en', '.md')} (German: ${helpSectionUrl(base, 'mcp', 'de', '.md')}). MCP server: ${base}/mcp`,
    '',
    '## Help',
    '',
    `- [All help topics (English)](${helpSectionUrl(base, null, 'en', '.md')})`,
    `- [Alle Hilfe-Themen (Deutsch)](${helpSectionUrl(base, null, 'de', '.md')})`,
    ...doc.sections.map(s => `- [${s.title}](${helpSectionUrl(base, s.id, 'en', '.md')})`),
    '',
  ]
  setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setHeader(event, 'Cache-Control', 'public, max-age=3600')
  return lines.join('\n')
})
