import { describe, expect, it } from 'vitest'
import { splitLinks } from '../../shared/utils/url'

describe('splitLinks', () => {
  it('trennt URLs vom Text und lässt Satzzeichen draußen', () => {
    expect(splitLinks('Siehe https://bmx.at/a?b=1. Danach fertig')).toEqual([
      { text: 'Siehe ', href: null },
      { text: 'https://bmx.at/a?b=1', href: 'https://bmx.at/a?b=1' },
      { text: '. Danach fertig', href: null },
    ])
  })

  it('lässt Text ohne URL unverändert', () => {
    expect(splitLinks('nur Text')).toEqual([{ text: 'nur Text', href: null }])
  })

  it('erkennt URL in Klammern', () => {
    expect(splitLinks('(https://x.at)').map(p => p.href)).toEqual([null, 'https://x.at', null])
  })
})
