import { handleMcp } from '~~/server/lib/mcp/handler'

export default defineEventHandler(event => handleMcp(event))
