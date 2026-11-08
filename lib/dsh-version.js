// Whether this build may run on the dsh that started it.
//
// The plugin already declares a supported range in package.json (`engines.dsh`)
// and dsh's own profile preflight reads it: a host outside that range has this
// bundle's rows *disabled* before they mount, which is why an in-app message
// used to be impossible to show. Two gaps are left, and both are what this
// module closes:
//
//   * an exempted host (`dsh plugin allow-version`) loads anyway and then fails
//     somewhere deep — a model switch, a settings write — instead of saying why;
//   * a version *inside* the range can still be incompatible, because the range
//     is a promise about a whole line of releases: 0.2.2-rc.1 sat inside
//     `>=0.1.1-rc.2 <0.3.0-0` and broke every model switch, because it moved the
//     route to `agent.model.select()` and made the old waterfall throw.
//
// So the manifest carries what was actually run (`dshSupport.tested`) beside the
// range, and a boot on anything with no evidence refuses to start. The refusal
// is the point: a half-working interface is worse than one page naming the
// version to install.
//
// Everything here is pure and injectable — no terminal, no settings, no boot —
// so the verdict can be exercised without a host.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compareVersions, detectDshInstall } from './updates.js'

const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// `v0.2.1` and `0.2.1 ` are the same version; an empty or non-string input is
// "unknown", never "matches".
export function normalizeDshVersion(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null
}

// The one range syntax this plugin's manifest uses: space-separated comparators
// are ANDed, `||` separates alternatives. `^`, `~` and `x` wildcards are
// deliberately rejected instead of half-supported — a manifest typo must fail
// here, where a test can see it, rather than quietly widen what we accept.
const COMPARATOR = /^(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

export function parseDshRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return null
  const alternatives = []
  for (const part of range.split('||')) {
    const comparators = []
    for (const token of part.trim().split(/\s+/).filter(Boolean)) {
      const match = COMPARATOR.exec(token)
      if (!match) return null
      comparators.push({ op: match[1] ?? '=', version: match[2] })
    }
    if (comparators.length === 0) return null
    alternatives.push(comparators)
  }
  return alternatives.length === 0 ? null : alternatives
}

// true / false, or null when either side cannot be understood — the caller must
// distinguish "does not match" from "cannot tell", because only the first one
// justifies refusing to start.
export function satisfiesDshRange(version, range) {
  const alternatives = parseDshRange(range)
  const actual = normalizeDshVersion(version)
  if (!alternatives || !actual) return null
  return alternatives.some((comparators) => comparators.every(({ op, version: bound }) => {
    const order = compareVersions(actual, bound)
    switch (op) {
      case '>=': return order >= 0
      case '>': return order > 0
      case '<=': return order <= 0
      case '<': return order < 0
      default: return order === 0
    }
  }))
}

// What this build declares: the hard range dsh itself enforces, the version to
// point a user at, and the ones this build was actually run against.
export function dshSupport(manifest = MANIFEST) {
  const declared = manifest?.dshSupport ?? {}
  const range = typeof manifest?.engines?.dsh === 'string' ? manifest.engines.dsh : ''
  const verified = Array.isArray(declared.tested) ? declared.tested.map(normalizeDshVersion).filter(Boolean) : []
  return {
    range,
    recommended: normalizeDshVersion(declared.recommended) ?? verified.at(-1) ?? '',
    tested: verified,
  }
}

// The verdict for one running version.
//
//   ok          — declared by the range *and* actually run against
//   unverified  — inside the declared range, but this build never saw it
//   unsupported — outside the declared range (dsh normally disables us here)
//   unknown     — the version could not be read, so there is nothing to judge
//
// `unknown` never refuses: bricking a distribution we cannot introspect would be
// a bug in this module, not a fact about the host.
export function evaluateDshSupport(actual, support = dshSupport()) {
  const version = normalizeDshVersion(actual)
  const base = { version, ...support }
  if (!version) return { verdict: 'unknown', ...base }
  const inRange = satisfiesDshRange(version, support.range)
  if (inRange === null) return { verdict: 'unknown', ...base }
  if (!inRange) return { verdict: 'unsupported', ...base }
  if (support.tested.length > 0 && !support.tested.includes(version)) return { verdict: 'unverified', ...base }
  return { verdict: 'ok', ...base }
}

// The version of the harness this process is running under.
//
// Three sources, most authoritative first:
//
//   1. `@deepseek-ai/dsh-app-boot/package.json` resolved from the process entry.
//      That package is what the host itself reads as its runtime version
//      (`getDshRuntimeVersion()` in dsh-app-boot) and it is versioned in lockstep
//      with the CLI, so this answers exactly what a user means by "the dsh
//      version".
//   2. `@deepseek-ai/dsh/package.json` from the same base, for a host that ships
//      the CLI without app-boot.
//   3. the `dsh` on PATH, for a host started some other way (a desktop bundle, an
//      SDK runner) — right whenever the process was launched by the CLI that PATH
//      names.
//
// Nothing found means "unknown", and the gate lets it through.
export function runningDshVersion({ entry = process.argv[1], resolve = resolveFromEntry, detect = detectDshInstall } = {}) {
  if (typeof entry === 'string' && entry !== '') {
    for (const spec of ['@deepseek-ai/dsh-app-boot/package.json', '@deepseek-ai/dsh/package.json']) {
      const manifest = resolve(entry, spec)
      const version = normalizeDshVersion(manifest?.version)
      if (version) return { version, source: spec }
    }
  }
  let install
  try { install = detect() } catch { install = null }
  const version = install?.found ? normalizeDshVersion(install.version) : null
  if (version) return { version, source: 'path' }
  return { version: null, source: 'unknown' }
}

function resolveFromEntry(entry, spec) {
  try {
    return JSON.parse(readFileSync(createRequire(entry).resolve(spec), 'utf8'))
  } catch {
    return null
  }
}

// The boot gate: one call that answers "may this build start?" with everything a
// blocking page needs. `DSH_TUI_IGNORE_DSH_VERSION` is the escape hatch for a
// maintainer testing against a host that is not published or not yet verified.
export function dshBootGate({ env = process.env, support = dshSupport(), probe = runningDshVersion } = {}) {
  const override = String(env?.DSH_TUI_IGNORE_DSH_VERSION ?? '').trim()
  if (override !== '' && override !== '0') return null
  const { version, source } = probe()
  const result = evaluateDshSupport(version, support)
  if (result.verdict === 'ok' || result.verdict === 'unknown') return null
  return { ...result, source }
}
