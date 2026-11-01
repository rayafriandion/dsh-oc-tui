// Git branch switching: the core module against real temporary repositories,
// the App-level picker state and painting, and the wired plugin through a real
// cordis context — the empty-page shortcut, the /branch command, an actual
// checkout, a pull, and the in-session gate that must answer with a toast
// instead of the window.
//
// Runs standalone — no dsh, no network (the "remote" is a bare repo on disk).
//   node tests/git-branch.test.mjs
// The assertions are on English chrome text, so the run is pinned to English
// instead of following the machine locale.
process.env.DSH_TUI_LOCALE = 'en'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listGitBranches, pullGitUpdates, switchGitBranch } from '../lib/git-branch.js'
import { App, THEME } from '../lib/ui.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { console.log('ok   ' + name); return }
  failed++
  console.log('FAIL ' + name + (extra ? '  ' + extra : ''))
}
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log('ok   ' + name); return }
  failed++
  console.log('FAIL ' + name + '\n     actual:   ' + a + '\n     expected: ' + e)
}
// git prints the worktree root with forward slashes on Windows while
// node:path builds it with backslashes, so a root comparison goes through the
// last segment rather than the raw string.
const lastSegment = (path) => String(path).split(/[\\/]/).filter(Boolean).pop()

// ---- the core module against real repositories -----------------------------
const scratch = []
const scratchDir = (name) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-branch-' + name + '-'))
  scratch.push(dir)
  return dir
}
const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()

if (!hasGit) {
  console.log('skip git-backed branch tests (git not on PATH)')
} else {
  const gitIn = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
  const initRepo = (dir) => {
    gitIn(dir, ['init', '-q'])
    gitIn(dir, ['config', 'user.email', 'branch@example.com'])
    gitIn(dir, ['config', 'user.name', 'branch test'])
  }
  // A clone of a bare on-disk "remote", with main and feature pushed, so the
  // remote-tracking refs exist without any network access.
  const makeClone = () => {
    const dir = scratchDir('clone')
    gitIn(dir, ['init', '-q', '--bare', 'remote.git'])
    gitIn(dir, ['clone', '-q', 'remote.git', 'work'])
    const work = join(dir, 'work')
    gitIn(work, ['config', 'user.email', 'branch@example.com'])
    gitIn(work, ['config', 'user.name', 'branch test'])
    gitIn(work, ['checkout', '-q', '-b', 'main'])
    writeFileSync(join(work, 'a.txt'), 'a\n')
    gitIn(work, ['add', '.'])
    gitIn(work, ['commit', '-qm', 'base'])
    // --set-upstream is what a real `git clone` gives the default branch; the
    // artificial clone-of-an-empty-repo has to be told, or every pull would
    // rightly fail with "no tracking information".
    gitIn(work, ['push', '-q', '--set-upstream', 'origin', 'main'])
    gitIn(work, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(work, 'b.txt'), 'b\n')
    gitIn(work, ['add', '.'])
    gitIn(work, ['commit', '-qm', 'feat'])
    gitIn(work, ['push', '-q', '--set-upstream', 'origin', 'feature'])
    return { dir, work }
  }

  // 1. Not a worktree: the listing refuses instead of half-applying anything.
  {
    const dir = scratchDir('nogit')
    writeFileSync(join(dir, 'app.js'), 'kept\n')
    let message = ''
    try { await listGitBranches(dir) } catch (error) { message = error.message }
    eq('non-repository listing refuses', message, 'not a git worktree')
  }

  // 2. An empty repository lists no branches and names the unborn HEAD after
  //    git's own convention (`git status` says "On branch master").
  {
    const dir = scratchDir('empty')
    initRepo(dir)
    const listed = await listGitBranches(dir)
    eq('empty repo reports the unborn branch', listed.current, gitIn(dir, ['symbolic-ref', '--short', 'HEAD']).trim())
    eq('empty repo has no local branches', listed.local, [])
    eq('empty repo has no remote branches', listed.remote, [])
    ok('the worktree root is still reported', listed.root.endsWith(lastSegment(dir)))
  }

  // 3. Listing names local branches, remote-tracking branches and the current
  //    branch; the symbolic origin/HEAD ref is not offered as a target.
  {
    const { work } = makeClone()
    const listed = await listGitBranches(work)
    eq('current branch is the checked-out one', listed.current, 'feature')
    eq('local branches', listed.local, ['feature', 'main'])
    eq('remote branches', listed.remote, ['origin/feature', 'origin/main'])
    ok('the worktree root is reported', listed.root.endsWith('work'))
  }

  // 4. Switching a local branch checks it out and moves the current marker.
  {
    const { work } = makeClone()
    eq('switch returns the branch', (await switchGitBranch(work, 'main')).branch, 'main')
    eq('current branch follows the switch', (await listGitBranches(work)).current, 'main')
    eq('the worktree moved with it', gitIn(work, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main')
  }

  // 5. A remote-tracking branch with no local counterpart is switched through
  //    the tracking branch git's own DWIM would create for it.
  {
    const { work } = makeClone()
    gitIn(work, ['checkout', '-q', 'main'])
    gitIn(work, ['push', '-q', 'origin', 'main:solo'])
    eq('switch creates the tracking branch', (await switchGitBranch(work, 'origin/solo', { remote: true })).branch, 'solo')
    eq('the new branch tracks its upstream', gitIn(work, ['rev-parse', '--abbrev-ref', 'solo@{u}']).trim(), 'origin/solo')
    ok('the new branch is local now', (await listGitBranches(work)).local.includes('solo'))
  }

  // 6. A remote-tracking branch whose local counterpart already exists switches
  //    to that one instead of forking a second branch onto the same upstream.
  {
    const { work } = makeClone()
    eq('existing local branch wins', (await switchGitBranch(work, 'origin/feature', { remote: true })).branch, 'feature')
    eq('no duplicate local branch', (await listGitBranches(work)).local.filter((name) => name === 'feature').length, 1)
  }

  // 7. An unknown branch fails with git's own reason and changes nothing.
  {
    const { work } = makeClone()
    let message = ''
    try { await switchGitBranch(work, 'nope') } catch (error) { message = error.message }
    ok('unknown branch fails with git\'s reason', /did not match/.test(message), message)
    eq('the checkout did not happen', (await listGitBranches(work)).current, 'feature')
  }

  // 8. A pull fast-forwards from the on-disk remote and reports what changed.
  {
    const { dir, work } = makeClone()
    gitIn(dir, ['clone', '-q', 'remote.git', 'work2'])
    const work2 = join(dir, 'work2')
    gitIn(work2, ['config', 'user.email', 'branch@example.com'])
    gitIn(work2, ['config', 'user.name', 'branch test'])
    gitIn(work2, ['checkout', '-q', 'main'])
    writeFileSync(join(work2, 'a.txt'), 'a\nmore\n')
    gitIn(work2, ['commit', '-qam', 'more'])
    gitIn(work2, ['push', '-q', 'origin', 'main'])
    gitIn(work, ['checkout', '-q', 'main'])
    const pulled = await pullGitUpdates(work)
    ok('the pull reports the change', pulled.summary.length > 0, pulled.summary)
    ok('the worktree fast-forwarded', readFileSync(join(work, 'a.txt'), 'utf8').includes('more'))
    ok('the refreshed remote list is current', (await listGitBranches(work)).remote.includes('origin/main'))
  }

  // 9. A diverged branch refuses the pull rather than merging: --ff-only keeps
  //    conflict markers out of a worktree the TUI cannot resolve them in.
  {
    const { dir, work } = makeClone()
    gitIn(dir, ['clone', '-q', 'remote.git', 'work2'])
    const work2 = join(dir, 'work2')
    gitIn(work2, ['config', 'user.email', 'branch@example.com'])
    gitIn(work2, ['config', 'user.name', 'branch test'])
    gitIn(work2, ['checkout', '-q', 'main'])
    writeFileSync(join(work2, 'a.txt'), 'a\ntheirs\n')
    gitIn(work2, ['commit', '-qam', 'theirs'])
    gitIn(work2, ['push', '-q', 'origin', 'main'])
    gitIn(work, ['checkout', '-q', 'main'])
    writeFileSync(join(work, 'a.txt'), 'a\nmine\n')
    gitIn(work, ['commit', '-qam', 'mine'])
    let message = ''
    try { await pullGitUpdates(work) } catch (error) { message = error.message }
    ok('a diverged pull is refused', message.length > 0, message)
    ok('no merge was started', !existsSync(join(work, '.git', 'MERGE_HEAD')))
  }
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

// ---- the App-level picker --------------------------------------------------
{
  const fakeTerm = { cols: 100, rows: 30, on() {} }
  const grid = (app) => app.render().cells.map((row) => row.map((cell) => cell.ch).join('')).join('\n')

  const app = new App(fakeTerm)
  app.setWelcome({ workingDirectory: 'D:/Projects/example', gitBranch: 'main' })
  app.openGitBranches({
    cwd: 'D:/Projects/example',
    root: 'D:/Projects/example',
    current: 'main',
    local: ['main', 'feature'],
    remote: ['origin/main', 'origin/feature'],
  })
  eq('the window is the active overlay', app.overlay, 'git-branches')
  eq('rows are headers plus branches', app.gitBranches.items.map((item) => item.kind).join(','), 'header,branch,branch,header,branch,branch')
  eq('the current branch is marked', app.gitBranches.items[1].current, true)
  ok('remote rows carry the remote flag', app.gitBranches.items[4].remote === true)
  eq('the selection lands on the current branch', app.gitBranches.selected, 1)

  app.moveGitBranches(1)
  eq('down moves to the next branch', app.gitBranches.selected, 2)
  app.moveGitBranches(1)
  eq('down steps over the remote header', app.gitBranches.selected, 4)
  app.moveGitBranches(-1)
  eq('up steps over the header back', app.gitBranches.selected, 2)
  app.moveGitBranches(-1)
  app.moveGitBranches(-1)
  eq('up wraps to the last branch', app.gitBranches.selected, 5)
  app.moveGitBranches(1)
  eq('down wraps to the first branch', app.gitBranches.selected, 1)

  // The selection is on 'main' now. A refresh that keeps it available keeps
  // the selection where it was, so a pull that only updates the remote set
  // does not yank the cursor elsewhere.
  app.setGitBranchList({ current: 'main', local: ['main', 'feature'], remote: ['origin/main', 'origin/feature', 'origin/new'] })
  eq('a refresh keeps the selected branch', app.gitBranches.items[app.gitBranches.selected].ref, 'main')
  // A list that no longer carries the selected branch lands on the new current
  // one instead — the selection can never rest on a row that is gone.
  app.setGitBranchList({ current: 'other', local: ['feature', 'other'], remote: [] })
  eq('a stale selection falls back to the current branch', app.gitBranches.items[app.gitBranches.selected].ref, 'other')
  eq('a repo without remotes drops the remote section', app.gitBranches.items.map((item) => item.kind).join(','), 'header,branch,branch')

  app.closeGitBranches()
  eq('closing drops the overlay', app.overlay, null)
  eq('closing drops the state', app.gitBranches, null)

  // Painting, on a window with both sections and a current branch.
  const paintApp = new App(fakeTerm)
  paintApp.setWelcome({ workingDirectory: 'D:/Projects/example', gitBranch: 'main' })
  paintApp.openGitBranches({
    cwd: 'D:/Projects/example',
    root: 'D:/Projects/example',
    current: 'main',
    local: ['main', 'feature'],
    remote: ['origin/main', 'origin/feature'],
  })
  const rendered = grid(paintApp)
  ok('the window paints its title', rendered.includes('Git Branches'))
  ok('the window paints both sections', rendered.includes('Local branches') && rendered.includes('Remote branches'))
  ok('the window paints the branches', rendered.includes('main') && rendered.includes('origin/feature'))
  ok('the current branch carries git\'s own marker', rendered.includes('* main'))
  ok('the window documents its keys', rendered.includes('P pull') && rendered.includes('Esc close'))
  // The footer's key tokens must read apart from their descriptions: every key
  // cell carries the accent color and bold, the description cells stay muted.
  const cells = paintApp.render().cells
  const footerY = cells.findIndex((row) => row.map((cell) => cell.ch).join('').includes('P pull'))
  const footerX = cells[footerY].findIndex((cell) => cell.ch === 'P')
  const keyCell = cells[footerY][footerX]
  const descCell = cells[footerY][footerX + 2]
  ok('the footer key cell is accent and bold',
    keyCell?.style?.fg === THEME.accent && keyCell?.style?.bold === true,
    JSON.stringify(keyCell?.style))
  ok('the footer description cell stays muted',
    descCell?.style?.fg === THEME.textMuted && descCell?.style?.bold === false,
    JSON.stringify(descCell?.style))
  ok('the subtitle names the current branch', rendered.includes('Current: main'))
  ok('branch rows are mouse targets', paintApp.hitRegions.filter((region) => region.kind === 'git-branch-item').length === 4)
  ok('header rows are not mouse targets', paintApp.hitRegions.every((region) => region.kind !== 'git-branch-item' || paintApp.gitBranches.items[region.branchIndex]?.kind === 'branch'))

  // An empty repository renders its empty note; a detached head is named.
  const emptyApp = new App(fakeTerm)
  emptyApp.openGitBranches({ cwd: 'D:/x', root: 'D:/x', current: '', local: [], remote: [] })
  ok('an empty repository says so', grid(emptyApp).includes('No branches in this repository.'))
  ok('a detached head is named as such', grid(emptyApp).includes('(detached)'))
}

// ---- the wired plugin: real cordis, real keys, a real checkout --------------
// The same harness as the esc-questions and resume suites: REAL lib/index.js
// apply(), REAL lib/term.js decoding, a headless TTY. The plugin's cwd is the
// workspace every path resolves from, so the run chdirs into a throwaway clone
// before the plugin applies — the branch window then lists, switches and pulls
// inside that clone, never the checkout this test lives in.
{
  const { EventEmitter } = await import('node:events')
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const { Terminal } = await import('../lib/term.js')

  const smokeHome = mkdtempSync(join(tmpdir(), 'dsh-oc-tui-branch-'))
  process.env.DSH_HOME = smokeHome
  process.on('exit', () => {
    try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // Every wired path below is asynchronous (git spawns, the cordis session
  // open), and a cold `git` on Windows costs the better part of a second per
  // spawn, so the suite waits on what the screen says rather than on a fixed
  // number of ticks — a slow disk must not turn a green run red.
  const waitFor = async (predicate, rounds = 400) => {
    for (let i = 0; i < rounds; i++) {
      if (predicate()) return true
      await sleep(10)
    }
    return false
  }

  class FakeIn extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.rawMode = null }
    setRawMode(value) { this.rawMode = value; return this }
    resume() { return this }
    pause() { return this }
    send(text) { this.emit('data', Buffer.from(text, 'utf8')) }
  }
  class FakeOut extends EventEmitter {
    constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows; this.chunks = [] }
    write(s) { this.chunks.push(String(s)); return true }
  }

  const stdin = new FakeIn()
  const stdout = new FakeOut(110, 32)
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  const realStdout = Object.getOwnPropertyDescriptor(process, 'stdout')
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true })

  const frames = []
  const realPaint = Terminal.prototype.paint
  Terminal.prototype.paint = function (screen) {
    const rows = []
    for (let y = 0; y < screen.rows; y++) {
      let line = ''
      for (let x = 0; x < screen.cols; x++) line += screen.cells[y][x].ch ?? ''
      rows.push(line.replace(/\s+$/, ''))
    }
    frames.push(rows.join('\n'))
    return realPaint.call(this, screen)
  }
  const lastFrame = () => frames.at(-1) ?? ''
  const since = (mark) => frames.slice(mark).join('\n')

  // The throwaway workspace: a clone with main and feature, so the window has
  // a local and a remote section to show.
  const workDir = mkdtempSync(join(tmpdir(), 'git-branch-plugin-'))
  const gitIn = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
  gitIn(workDir, ['init', '-q', '--bare', 'remote.git'])
  gitIn(workDir, ['clone', '-q', 'remote.git', 'work'])
  const workRepo = join(workDir, 'work')
  gitIn(workRepo, ['config', 'user.email', 'branch@example.com'])
  gitIn(workRepo, ['config', 'user.name', 'branch test'])
  gitIn(workRepo, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(workRepo, 'a.txt'), 'a\n')
  gitIn(workRepo, ['add', '.'])
  gitIn(workRepo, ['commit', '-qm', 'base'])
  gitIn(workRepo, ['push', '-q', '--set-upstream', 'origin', 'main'])
  gitIn(workRepo, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(workRepo, 'b.txt'), 'b\n')
  gitIn(workRepo, ['add', '.'])
  gitIn(workRepo, ['commit', '-qm', 'feat'])
  gitIn(workRepo, ['push', '-q', '--set-upstream', 'origin', 'feature'])

  const previousCwd = process.cwd()
  process.chdir(workRepo)

  class AgentsStub extends Service {
    constructor(ctx) { super(ctx, 'agents'); this.agents = new Map(); this.rootList = [] }
    get(id) { return this.agents.get(id) }
    roots() { return this.rootList }
    async create({ sessionId, meta }) {
      const agent = {
        id: String(sessionId),
        options: { model: 'branch-model', provider: 'branch-provider' },
        session: { id: String(sessionId), header: { cwd: meta?.cwd ?? process.cwd() }, snapshotEvents: () => [] },
        cancel() {}, followup() {}, steer() {},
      }
      this.agents.set(agent.id, agent)
      this.rootList.push(agent)
      return { agent, dispose: async () => {} }
    }
  }
  class CommandsStub extends Service {
    constructor(ctx) { super(ctx, 'commands') }
    // The TUI asks before falling back to its own switch; a host with no
    // commands of its own answers "none", exactly like a harness that has
    // not registered one.
    find() { return undefined }
  }
  class SessionPersistenceStub extends Service { constructor(ctx) { super(ctx, 'sessionPersistence') } }
  class TuiStartupStub extends Service { constructor(ctx) { super(ctx, 'tuiStartup') } }
  class SettingsStub extends Service {
    constructor(ctx) {
      super(ctx, 'settings')
      this.writable = true
      this.documentPath = join(smokeHome, 'settings.json')
      this.registry = new Map()
      this.values = new Map()
      this.mutations = []
    }
    register(ns, schema) { this.registry.set(String(ns), schema) }
    describe() {
      return [...this.registry].map(([ns, schema]) => ({
        ns,
        value: this.values.get(ns) ?? schema(),
        revision: 0,
      }))
    }
    async mutate(ns, ops) { this.mutations.push({ ns, ops }) }
  }

  const ctx = new Context()
  new AgentsStub(ctx)
  new CommandsStub(ctx)
  new SessionPersistenceStub(ctx)
  new TuiStartupStub(ctx)
  new SettingsStub(ctx)

  const tui = await import('../lib/index.js')
  await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
  await waitFor(() => stdout.chunks.length > 0)
  // The startup update check would reach for the registry two seconds in; the
  // suite can outlive that, so the check is turned off for this run.
  ctx.get('settings').values.set('tui-updates', { startupCheck: 'off' })
  ok('the plugin booted into the empty page', lastFrame().length > 0)

  // 1. Ctrl+G on the empty page opens the branch window.
  stdin.send('\x07') // Ctrl+G
  ok('Ctrl+G opens the branch window on the empty page',
    await waitFor(() => lastFrame().includes('Git Branches')), 'last frame:\n' + lastFrame())
  ok('the window lists the local branches', lastFrame().includes('Local branches') && lastFrame().includes('feature'))
  ok('the window lists the remote branches', lastFrame().includes('Remote branches') && lastFrame().includes('origin/feature'))
  ok('the subtitle names the current branch', lastFrame().includes('Current: feature'))

  // 2. Esc closes it again.
  stdin.send('\x1b')
  await waitFor(() => !lastFrame().includes('Git Branches'))
  ok('Esc closes the branch window', !lastFrame().includes('Git Branches'))

  // 3. The /branch command opens the same window.
  stdin.send('/branch')
  await waitFor(() => lastFrame().includes('/branch'))
  stdin.send('\r')
  ok('/branch opens the window on the empty page',
    await waitFor(() => lastFrame().includes('Git Branches')), 'last frame:\n' + lastFrame())

  // 4. Enter checks the selected branch out. The selection starts on the
  //    current branch (feature); Down lands on the next local branch (main).
  stdin.send('\x1b[B') // Down
  await waitFor(() => lastFrame().includes('▸   main') || lastFrame().includes('▸ * main'))
  stdin.send('\r')
  ok('Enter switches the branch',
    await waitFor(() => lastFrame().includes('Switched to branch main')), 'last frame:\n' + lastFrame())
  eq('the worktree is on the new branch', gitIn(workRepo, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main')
  ok('the window follows the new current branch', lastFrame().includes('* main'))

  // 5. p pulls updates from the on-disk remote.
  stdin.send('p')
  ok('p pulls and reports the outcome',
    await waitFor(() => /Already up to date\.|Updates pulled|Cannot pull/.test(lastFrame()), 700),
    'last frame:\n' + lastFrame())
  ok('the pull reports nothing to do', lastFrame().includes('Already up to date.'))

  // 6. r refreshes the list without touching the network.
  stdin.send('r')
  ok('r refreshes the list',
    await waitFor(() => lastFrame().includes('Git Branches') && !lastFrame().includes('Working')),
    'last frame:\n' + lastFrame())

  // 7. Inside a session the same shortcut answers with a pointer instead.
  stdin.send('\x1b')
  await waitFor(() => !lastFrame().includes('Git Branches'))
  stdin.send('x')
  await waitFor(() => lastFrame().includes('x'))
  stdin.send('\r')
  ok('a session is open', await waitFor(() => ctx.get('agents').roots().length === 1))
  let mark = frames.length
  stdin.send('\x07') // Ctrl+G
  ok('Ctrl+G in a session points at the empty page',
    await waitFor(() => lastFrame().includes('only available on the empty page')), 'last frame:\n' + lastFrame())
  ok('Ctrl+G in a session does not open the window', !since(mark).includes('Git Branches'),
    'frames since the key:\n' + since(mark))

  // 8. And so does the command.
  mark = frames.length
  stdin.send('/branch')
  await waitFor(() => lastFrame().includes('/branch'))
  stdin.send('\r')
  ok('/branch in a session points at the empty page',
    await waitFor(() => lastFrame().includes('only available on the empty page')), 'last frame:\n' + lastFrame())
  ok('/branch in a session does not open the window', !since(mark).includes('Git Branches'),
    'frames since the command:\n' + since(mark))

  // ---- teardown -------------------------------------------------------------
  Terminal.prototype.paint = realPaint
  Object.defineProperty(process, 'stdin', realStdin)
  Object.defineProperty(process, 'stdout', realStdout)
  process.chdir(previousCwd)
  try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (failed > 0) {
  console.log('\n' + failed + ' git-branch test(s) failed')
  process.exit(1)
}
console.log('\nall git-branch tests passed')
// The live plugin owns a paint interval, a settings poll and an MCP fiber, so
// the loop would otherwise stay alive; every suite here exits explicitly.
process.exit(0)
