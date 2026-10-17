// The bundled `mcp-import` skill: the shipped SKILL.md parsed into the shape the
// host's skill registry accepts, and registered on the optional `skills` service.
//
// The skill service is a harness capability, not a dependency of this plugin: a
// host without a skill registry must still boot the TUI, so every entry point
// here answers with a verdict instead of throwing, and nothing imports
// `@deepseek-ai/*` at module scope — that specifier may not resolve at all.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatError } from './util.js'

export const MCP_SKILL_NAME = 'mcp-import'

// Resolved from this module, not from process.cwd(), so the skill is found
// wherever the tarball was unpacked.
const SKILL_FILE = new URL('../skills/mcp-import/SKILL.md', import.meta.url)
const SKILL_DIR = fileURLToPath(new URL('../skills/mcp-import/', import.meta.url))

// The frontmatter this project writes: a `---` fence, `key: value` scalars, a
// closing fence. Only those scalars are read; the host parses the real YAML when
// the skill is discovered from disk, this parser only feeds the runtime channel.
function scalar(text) {
  const value = text.trim()
  if (value.length >= 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1)
    return value[0] === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'")
  }
  return value
}

export function parseSkillFile(text) {
  if (typeof text !== 'string') return null
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  let end = -1
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === '---') { end = index; break }
  }
  if (end < 0) return null
  const fields = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (match) fields[match[1]] = scalar(match[2])
  }
  if (!fields.name || !fields.description) return null
  const skill = {
    name: fields.name,
    description: fields.description,
    content: lines.slice(end + 1).join('\n').trim(),
  }
  if (fields.whenToUse) skill.whenToUse = fields.whenToUse
  return skill
}

export function loadBundledMcpSkill() {
  try {
    return parseSkillFile(readFileSync(SKILL_FILE, 'utf8'))
  } catch {
    return null
  }
}

// Returns a verdict rather than throwing: a host without the service, a broken
// bundled file and a rejecting registry all have to leave the TUI running.
export function registerMcpSkill(ctx) {
  let skills
  try {
    skills = ctx?.get?.('skills')
  } catch (error) {
    return { ok: false, reason: 'skills lookup failed: ' + formatError(error) }
  }
  if (!skills || typeof skills.register !== 'function') {
    return { ok: false, reason: 'the host skill service is unavailable' }
  }
  const skill = loadBundledMcpSkill()
  if (!skill) return { ok: false, reason: 'the bundled ' + MCP_SKILL_NAME + ' skill could not be read' }
  const registration = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    invocation: { modelInvocable: true, userInvocable: true },
  }
  if (skill.whenToUse) registration.whenToUse = skill.whenToUse
  try {
    skills.register(registration)
    return { ok: true, name: skill.name }
  } catch (error) {
    return { ok: false, reason: 'skill registration failed: ' + formatError(error) }
  }
}
