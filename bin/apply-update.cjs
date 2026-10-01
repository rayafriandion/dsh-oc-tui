#!/usr/bin/env node
// Detached applier for a TUI-driven update. Spawned by the running TUI
// immediately before it exits: `node bin/apply-update.cjs <plan.json>`.
//
// The plan is a JSON file (written by the TUI into $DSH_HOME/updates) naming
// one package (dsh or dsh-oc-tui), the staged tarball to install from, how to
// verify the result, and how to relaunch. The child waits for the TUI to die
// *first* — that is the whole point of the restart handoff: a global npm
// install (or a profile reinstall) while a dsh process is alive can leave a
// hybrid old/new tree behind, and npm still exits 0.
//
// Deliberately self-contained: it outlives the plugin that spawned it,
// including when that plugin is the package being replaced, so it imports
// nothing from the plugin and stays plain CJS.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { createRequire } = require('node:module')

const PARENT_WAIT_MS = 600_000

function log(line) {
  try { process.stdout.write('[dsh-oc-tui] ' + line + '\n') } catch { /* terminal already gone */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function installedVersion(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

// Re-resolve the dsh bin entry through the shim *after* the install, so a
// layout change inside a new dsh version cannot break the relaunch.
function entryFromShim(shim) {
  if (typeof shim !== 'string' || shim === '') return null
  try {
    const manifestPath = createRequire(path.resolve(shim)).resolve('@deepseek-ai/dsh/package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.dsh
    return typeof entry === 'string' && entry !== '' ? path.resolve(path.dirname(manifestPath), entry) : null
  } catch {
    return null
  }
}

function relaunchTarget(plan) {
  const entry = entryFromShim(plan.dshShim)
  if (entry) return { command: process.execPath, args: [entry, ...(plan.dshArgs ?? [])] }
  const fallback = plan.relaunch
  if (fallback && Array.isArray(fallback.args) && fallback.args.length > 0) return { command: fallback.command ?? process.execPath, args: fallback.args }
  return null
}

function writeMarker(plan, code) {
  try {
    fs.mkdirSync(path.dirname(plan.marker), { recursive: true })
    fs.writeFileSync(plan.marker, JSON.stringify({
      requested: plan.version,
      pkg: plan.pkg === 'tui' ? 'tui' : 'dsh',
      code,
      finishedAt: Date.now(),
    }))
  } catch {
    // Unwritable home: the next boot simply has nothing to verify.
  }
}

// The tarball itself stays in the cache — a rollback to the same version then
// costs no download. Only the "waiting to be applied" record goes.
function dropStaged(plan) {
  try { fs.unlinkSync(path.join(path.dirname(plan.tarball), 'staged.json')) } catch { /* nothing staged */ }
}

function runInstall(plan) {
  if (plan.pkg === 'dsh') {
    if (!plan.npm) {
      log('npm could not be located — install manually: npm install -g @deepseek-ai/dsh@' + plan.version)
      return { code: 1 }
    }
    const result = cp.spawnSync(plan.npm.command, [...plan.npm.args, 'install', '-g', plan.tarball], {
      stdio: 'inherit',
      windowsHide: false,
    })
    return { code: result.status === null ? 1 : result.status }
  }
  if (!plan.dsh) {
    log('the dsh CLI could not be located — reinstall the plugin with: dsh plugin --profile ' + plan.profile + ' add -w ' + plan.tarball)
    return { code: 1 }
  }
  // Reinstalling the same version does not reliably replace the installed
  // copy, so detach the dependency first — the documented dev-loop order.
  const detach = cp.spawnSync(plan.dsh.command, [
    ...plan.dsh.args, 'plugin', '--profile', plan.profile, 'remove', '-w', plan.packageName,
  ], { stdio: 'inherit', windowsHide: false })
  if (detach.status !== 0) log('detaching the previous copy exited ' + detach.status + ' — continuing anyway')
  const add = cp.spawnSync(plan.dsh.command, [
    ...plan.dsh.args, 'plugin', '--profile', plan.profile, 'add', '-w', plan.tarball,
  ], { stdio: 'inherit', windowsHide: false })
  return { code: add.status === null ? 1 : add.status }
}

function apply(plan) {
  log('installing ' + plan.packageName + '@' + plan.version + ' from ' + plan.tarball)
  const result = runInstall(plan)
  const found = plan.verifyPath ? installedVersion(plan.verifyPath) : null
  if (result.code === 0) {
    if (found === plan.version) {
      log('verified ' + plan.packageName + '@' + plan.version)
    } else {
      // npm exit 0 is not proof — the on-disk manifest decides. The marker
      // (code 0, mismatched version) is what the next boot reads back as a
      // damaged install.
      log('WARNING: the install reported success but ' + (plan.verifyPath ?? 'the manifest') +
        ' reports ' + (found ?? 'nothing') + ' (expected ' + plan.version + ')')
    }
  } else {
    log('install failed (exit ' + result.code + ')')
  }
  writeMarker(plan, result.code)
  dropStaged(plan)
  relaunch(plan)
}

function relaunch(plan) {
  const target = relaunchTarget(plan)
  if (!target) {
    log('could not locate the dsh entry — start dsh again yourself')
    process.exit(0)
  }
  log('restarting dsh…')
  try {
    const child = cp.spawn(target.command, target.args, {
      cwd: plan.cwd || undefined,
      detached: true,
      stdio: 'inherit',
      windowsHide: false,
    })
    child.unref()
  } catch (error) {
    log('relaunch failed: ' + (error?.message ?? String(error)) + ' — start dsh again yourself')
  }
  process.exit(0)
}

const planFile = process.argv[2] ?? ''
let plan = null
if (planFile !== '') {
  try {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  } catch {
    plan = null
  }
}
if (!plan || typeof plan.tarball !== 'string' || plan.tarball === '' || typeof plan.version !== 'string' || plan.version === '') {
  log('no usable plan at ' + (planFile || '(no path given)') + ' — nothing to do')
  process.exit(1)
}
if (!plan.marker) {
  log('plan carries no marker path — nothing to do')
  process.exit(1)
}

;(function waitForParent() {
  const deadline = Date.now() + PARENT_WAIT_MS
  if (alive(plan.parentPid) && Date.now() < deadline) {
    // Still inside the window: keep polling. The TUI paints its own screen
    // until it is gone, so nothing is logged before this point.
    setTimeout(waitForParent, 250)
    return
  }
  if (alive(plan.parentPid)) {
    // Never went away (or the pid was reused): never install over a live tree.
    writeMarker(plan, 1)
    log('timed out waiting for the TUI to exit — nothing was installed')
    process.exit(0)
  }
  apply(plan)
})()
