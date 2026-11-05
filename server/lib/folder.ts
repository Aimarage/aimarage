import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { config, isProduction } from './config'

export interface FolderResult {
  path: string
  files: { name: string, text: string }[]
  error: string | null
}

export function foldersAllowed(): boolean {
  if (config.hosted) return false
  const v = process.env.ALLOW_PROJECT_FOLDERS
  if (v) return v === 'true' || v === '1'
  return !isProduction
}

const NAMES = /^(readme|notes|notizen|marketing|marketingplan|about|todo|changelog|konzept|plan)[\w.-]*\.(md|txt)$/i

export function readProjectFolder(raw: string, root = process.env.PROJECT_FOLDER_ROOT || homedir()): FolderResult {
  const path = resolve(raw.replace(/^~(?=$|\/)/, homedir()))
  if (!foldersAllowed()) return { path, files: [], error: 'Projektordner sind auf diesem Server abgeschaltet' }
  const base = resolve(root)
  if (path !== base && !path.startsWith(base + sep)) return { path, files: [], error: 'Ordner liegt außerhalb des erlaubten Bereichs' }
  try {
    if (!statSync(path).isDirectory()) return { path, files: [], error: 'Kein Ordner' }
  }
  catch {
    return { path, files: [], error: 'Ordner nicht gefunden' }
  }
  const files: FolderResult['files'] = []
  const pick = (dir: string, prefix: string, all: boolean) => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    }
    catch {
      return
    }
    const list = names.filter(n => (all ? /\.(md|txt)$/i.test(n) : NAMES.test(n))).sort().reverse()
    for (const n of list) {
      if (files.length >= 8) return
      const full = join(dir, n)
      try {
        const st = statSync(full)
        if (!st.isFile() || st.size > 200_000) continue
        files.push({ name: prefix + n, text: readFileSync(full, 'utf8').slice(0, 6000) })
      }
      catch {}
    }
  }
  pick(path, '', false)
  pick(join(path, 'memory'), 'memory/', true)
  pick(join(path, 'docs'), 'docs/', false)
  return { path, files, error: files.length ? null : 'Keine README oder Notizen gefunden' }
}

export function folderDigest(f: FolderResult, max = 6000): string {
  return f.files.map(x => `Datei ${x.name}:\n${x.text}`).join('\n\n').slice(0, max)
}
