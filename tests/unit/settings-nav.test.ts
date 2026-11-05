import { describe, expect, it } from 'vitest'
import { CORE_SECTIONS, legacySettingsPath } from '~~/app/composables/useSettingsNav'

describe('Einstellungs-Bereiche', () => {
  it('leitet alte Reiter-Links weiter', () => {
    expect(legacySettingsPath({ tab: 'profile' })).toBe('/einstellungen/profil')
    expect(legacySettingsPath({ tab: 'agent' })).toBe('/einstellungen/ki')
    expect(legacySettingsPath({ tab: 'agent', app: 'google' })).toBe('/einstellungen/apps?app=google')
    expect(legacySettingsPath({ tab: 'workspace' })).toBe('/einstellungen/arbeitsbereich')
    expect(legacySettingsPath({ tab: 'x' })).toBe('/einstellungen/profil')
    expect(legacySettingsPath({})).toBeNull()
  })

  it('hat eindeutige Bereiche', () => {
    expect(new Set(CORE_SECTIONS.map(s => s.id)).size).toBe(CORE_SECTIONS.length)
  })
})
