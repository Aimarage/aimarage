import { markRaw, shallowReactive, type Component } from 'vue'

export type SlotName = 'banner' | 'settings-workspace' | 'login-footer' | 'account-menu' | 'legal-links'

export interface SlotEntry {
  id: string
  component: Component
  order: number
}

const slots = shallowReactive(new Map<SlotName, SlotEntry[]>())

export function registerSlot(name: SlotName, id: string, component: Component, order = 0): void {
  const list = (slots.get(name) ?? []).filter(e => e.id !== id)
  list.push({ id, component: markRaw(component), order })
  list.sort((a, b) => a.order - b.order)
  slots.set(name, list)
}

export function slotEntries(name: SlotName): SlotEntry[] {
  return slots.get(name) ?? []
}

export type SettingsGroup = 'me' | 'ai' | 'links' | 'company' | 'ops'

export interface SettingsSection {
  id: string
  group: SettingsGroup
  icon: string
  label: string
  order: number
  to?: string
  component?: Component
  show?: () => boolean
}

const sections = shallowReactive(new Map<string, SettingsSection>())

export function registerSettingsSection(s: SettingsSection): void {
  sections.set(s.id, s.component ? { ...s, component: markRaw(s.component) } : s)
}

export function settingsExtSections(): SettingsSection[] {
  return [...sections.values()]
}
