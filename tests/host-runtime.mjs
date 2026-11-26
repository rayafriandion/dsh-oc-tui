import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function hostRuntime() {
  try {
    const output = process.env.DSH_TUI_TEST_HOST || execFileSync(
      process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).split(/\r?\n/).find((line) => line.trim())
    const manifest = createRequire(output).resolve('@deepseek-ai/dsh/package.json')
    const root = dirname(manifest)
    return {
      version: JSON.parse(readFileSync(manifest, 'utf8')).version,
      entry: join(root, 'lib', 'bin.js'),
      load: (name) => import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('@deepseek-ai/' + name)).href),
    }
  } catch { return null }
}
