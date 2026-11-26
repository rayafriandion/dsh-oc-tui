import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// A profile can inherit stale peer junctions from profiles/node_modules.
// Bind host APIs to the running dsh, including its MCP client and scope symbols.
export function hostModuleUrl(spec, { entry = process.argv[1], fallback = import.meta.url } = {}) {
  let runtime
  try {
    const candidate = createRequire(entry)
    candidate.resolve('@deepseek-ai/dsh-app-boot')
    runtime = candidate
  } catch { /* standalone tests and consumers use their own peers */ }
  return pathToFileURL((runtime ?? createRequire(fallback)).resolve(spec)).href
}

export const importHost = (spec) => import(hostModuleUrl(spec))
