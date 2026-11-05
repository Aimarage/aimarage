import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createError, getHeader, setHeader, setResponseStatus, toWebRequest, type H3Event } from 'h3'
import { apiCors, authenticate, clientIp, siteBase } from '../api/http'
import { noteClient } from '../api/tokens'
import { apiActor } from '../api/principal'
import { getDb } from '../db'
import { mcpAllowed } from '../limits'
import { buildMcpServer, logHiddenCalls } from './server'

export async function handleMcp(event: H3Event) {
  apiCors(event, 'GET, POST, DELETE, OPTIONS')
  setHeader(event, 'Cache-Control', 'no-store')
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }
  const db = await getDb()
  const auth = await authenticate(db, event, 'mcp')
  if (!auth.ok) {
    if (auth.retryAfter) setHeader(event, 'Retry-After', auth.retryAfter)
    setResponseStatus(event, auth.status)
    return { jsonrpc: '2.0', id: null, error: { code: auth.status === 429 ? -32000 : -32001, message: auth.message } }
  }
  if (event.method !== 'POST') {
    setHeader(event, 'Allow', 'POST, OPTIONS')
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  const ua = (getHeader(event, 'user-agent') ?? '').slice(0, 120) || null
  const ctx = { db, actor: await apiActor(db, auth.principal), principal: auth.principal, deps: {}, client: ua, ip: clientIp(event) }
  if (!mcpAllowed(ctx.actor.workspace, 'read')) {
    setResponseStatus(event, 402)
    return { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'MCP ist im aktuellen Tarif nicht enthalten', data: { code: 'limit', kind: 'mcp' } } }
  }
  const server = buildMcpServer(ctx, siteBase())
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    const req = toWebRequest(event)
    const raw = await req.clone().text().catch(() => '')
    try {
      if (raw.includes('tools/call')) await logHiddenCalls(ctx, JSON.parse(raw))
    }
    catch {}
    const res = await transport.handleRequest(req)
    const info = server.server.getClientVersion()
    if (auth.principal.tokenId) await noteClient(db, auth.principal.tokenId, info ? `${info.name}${info.version ? ` ${info.version}` : ''}` : ua, !info).catch(() => {})
    return res
  }
  finally {
    await server.close().catch(() => {})
  }
}
