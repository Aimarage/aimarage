import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { llmUrlError } from '../../server/lib/llm'
import { assertMailServer, assertPublicHost, isPrivateIp, safeFetch } from '../../server/lib/site'

const saved = { ...process.env }
beforeEach(() => {
  process.env.SITE_ALLOW_PRIVATE = 'false'
})
afterEach(() => {
  for (const k of ['SITE_ALLOW_PRIVATE', 'HOSTED']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('SSRF-Schutz', () => {
  it('erkennt interne, reservierte und eingebettete Adressen', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.255.255.250', '255.255.255.255', '192.0.2.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', '2001:db8::1', 'kaputt']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '100.63.255.255', '100.128.0.1', '198.20.0.1', '1.1.1.1', '2a01:4f8::1', '::ffff:8.8.8.8', '2606:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })

  it('lehnt interne Hosts und fremde Protokolle ab', async () => {
    await expect(assertPublicHost('http://127.0.0.1/')).rejects.toThrow(/Interne/)
    await expect(assertPublicHost('http://[::ffff:169.254.169.254]/')).rejects.toThrow(/Interne/)
    await expect(assertPublicHost('http://localhost:3000/')).rejects.toThrow(/Interne/)
    await expect(assertPublicHost('file:///etc/passwd')).rejects.toThrow(/http/)
    await expect(assertPublicHost('http://8.8.8.8/')).resolves.toBeUndefined()
  })

  it('folgt Weiterleitungen selbst und prüft jedes Ziel', async () => {
    const seen: { url: string, redirect?: RequestRedirect }[] = []
    const f = async (url: string, init: RequestInit) => {
      seen.push({ url, redirect: init.redirect })
      if (url === 'http://8.8.8.8/a') return new Response('', { status: 302, headers: { location: '/b' } })
      if (url === 'http://8.8.8.8/b') return new Response('', { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      return new Response('ok', { status: 200 })
    }
    await expect(safeFetch('http://8.8.8.8/a', { method: 'GET' }, f)).rejects.toThrow(/Interne/)
    expect(seen.map(s => s.url)).toEqual(['http://8.8.8.8/a', 'http://8.8.8.8/b'])
    expect(seen.every(s => s.redirect === 'manual')).toBe(true)
    const ok = await safeFetch('http://8.8.8.8/a', { method: 'GET' }, async (url: string) => url.endsWith('/a') ? new Response('', { status: 307, headers: { location: 'http://1.1.1.1/z' } }) : new Response('fertig', { status: 200 }))
    expect(ok.url).toBe('http://1.1.1.1/z')
    expect(await ok.text()).toBe('fertig')
    const loop = async () => new Response('', { status: 302, headers: { location: 'http://8.8.8.8/x' } })
    await expect(safeFetch('http://8.8.8.8/x', {}, loop)).rejects.toThrow(/Weiterleitungen/)
  })

  it('IMAP/SMTP nur auf Standard-Ports und öffentlichen Servern', async () => {
    await expect(assertMailServer('imap', '8.8.8.8', 993)).resolves.toBeUndefined()
    await expect(assertMailServer('smtp', '8.8.8.8', 587)).resolves.toBeUndefined()
    await expect(assertMailServer('imap', '8.8.8.8', 6379)).rejects.toThrow(/Port 6379/)
    await expect(assertMailServer('smtp', '8.8.8.8', 993)).rejects.toThrow(/Port 993/)
    await expect(assertMailServer('smtp', '10.0.0.5', 25)).rejects.toThrow(/Interne/)
    await expect(assertMailServer('imap', 'localhost', 143)).rejects.toThrow(/Interne/)
  })

  it('eigene KI-Adresse: localhost nur im Selbst-Host-Modus', async () => {
    expect(await llmUrlError('http://localhost:11434/v1')).toBeNull()
    expect(await llmUrlError('http://10.0.0.7:8000/v1')).toMatch(/nicht erlaubt/)
    expect(await llmUrlError('ftp://x')).toMatch(/http/)
    process.env.HOSTED = 'true'
    expect(await llmUrlError('http://localhost:11434/v1')).toMatch(/nicht erlaubt/)
    expect(await llmUrlError('http://[::ffff:127.0.0.1]:8080/v1')).toMatch(/nicht erlaubt/)
    expect(await llmUrlError('https://api.mistral.ai/v1')).toBeNull()
  })
})
