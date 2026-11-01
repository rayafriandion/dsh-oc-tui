// Git branch switching for the TUI's empty page: listing local and remote
// branches, checking one out, and pulling updates. Everything shells out to
// the `git` on PATH through an argument array (no shell is involved), and
// every entry point is fenced to a real worktree first, so a workspace that
// is not a repository — or a machine with no git at all — reports that
// instead of half-applying anything.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { t } from './i18n.js'

// A network operation can hang on an unreachable host long past the point
// where the user has stopped watching the window, so every spawn carries a
// bound; a kill resolves as a failure rather than leaving the promise open.
const GIT_TIMEOUT_MS = 120_000

// GIT_TERMINAL_PROMPT=0 turns a credential prompt into an immediate error:
// the pipes below already keep git off the terminal, and this makes the
// promise reject instead of blocking on input that can never arrive.
function git(cwd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const stdout = []
    const stderr = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, spawned: true, stdout: '', stderr: t('git.timedOut') })
    }, GIT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => { stdout.push(chunk) })
    child.stderr?.on('data', (chunk) => { stderr.push(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      // A spawn failure (git not on PATH) is not the same as git saying no:
      // `spawned: false` lets callers tell the two apart.
      finish({ ok: false, spawned: false, stdout: '', stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({
        ok: code === 0,
        spawned: true,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function lines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

// The first line of git's output, which is where its errors put the reason
// ("error: pathspec ... did not match"). Later lines are hints and blank
// padding that would only crowd a one-line report.
function firstLine(text) {
  return lines(text)[0] ?? ''
}

// The last line of the combined output: fetch's "Fetching origin" and pull's
// "From ..." lead, while the line that answers "did anything change" —
// "Already up to date.", the fast-forward diffstat — comes last.
function lastLine(text) {
  const all = lines(text)
  return all.length > 0 ? all[all.length - 1].slice(0, 72) : ''
}

// The worktree root, or a throw that says why there is none. Every public
// function starts here. `--show-toplevel` is one spawn that answers both
// questions: it prints the root inside a worktree (an unborn one included)
// and fails inside a bare repository or outside any repository at all.
async function worktreeRoot(cwd) {
  const root = await git(resolve(cwd), ['rev-parse', '--show-toplevel'])
  if (!root.spawned) throw new Error(t('git.gitMissing'))
  if (!root.ok || root.stdout.trim() === '') throw new Error(t('git.notRepo'))
  return root.stdout.trim()
}

// Local branches (the current one included, in git's own alphabetical order)
// and remote-tracking branches. `refs/remotes/*​/HEAD` is a symbolic ref that
// names no branch of its own, so it is filtered out rather than offered as a
// checkout target.
export async function listGitBranches(cwd) {
  const root = await worktreeRoot(cwd)
  const [local, remote, head] = await Promise.all([
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
    // symbolic-ref exits non-zero on a detached or unborn HEAD, which is the
    // honest "no current branch" answer the window renders as (detached).
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ])
  for (const result of [local, remote, head]) {
    if (!result.ok) throw new Error(firstLine(result.stderr) || t('git.listFailed', { error: '' }))
  }
  return {
    root,
    current: head.stdout.trim(),
    local: lines(local.stdout),
    remote: lines(remote.stdout).filter((name) => !/\/HEAD$/.test(name)),
  }
}

// Check out a branch. A remote-tracking ref is switched through the local
// branch git's own DWIM would create for it (`origin/feature` -> `feature`),
// unless a local branch of that name already exists — then that one wins, so
// the user never lands on a second branch tracking the same upstream.
export async function switchGitBranch(cwd, ref, { remote = false } = {}) {
  const root = await worktreeRoot(cwd)
  let target = ref
  if (remote) {
    const slash = ref.indexOf('/')
    const local = slash < 0 ? ref : ref.slice(slash + 1)
    const locals = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    if (!locals.spawned) throw new Error(t('git.gitMissing'))
    if (!locals.ok) throw new Error(firstLine(locals.stderr))
    const localNames = lines(locals.stdout)
    if (!localNames.includes(local)) {
      const created = await git(root, ['checkout', '-b', local, '--track', ref])
      if (!created.spawned) throw new Error(t('git.gitMissing'))
      if (!created.ok) throw new Error(firstLine(created.stderr) || t('git.switchFailed', { branch: ref, error: '' }))
      return { branch: local, root }
    }
    target = local
  }
  const result = await git(root, ['checkout', target])
  if (!result.spawned) throw new Error(t('git.gitMissing'))
  if (!result.ok) throw new Error(firstLine(result.stderr) || t('git.switchFailed', { branch: target, error: '' }))
  return { branch: target, root }
}

// Manual pull: refresh every remote-tracking ref, then fast-forward the
// current branch. `--ff-only` is deliberate — a TUI has no way to resolve a
// merge conflict, so a diverged branch must fail with git's own explanation
// rather than stop halfway with conflict markers in the worktree.
export async function pullGitUpdates(cwd) {
  const root = await worktreeRoot(cwd)
  const fetched = await git(root, ['fetch', '--all', '--prune'])
  if (!fetched.spawned) throw new Error(t('git.gitMissing'))
  if (!fetched.ok) throw new Error(firstLine(fetched.stderr) || t('git.pullFailed', { error: '' }))
  const pulled = await git(root, ['pull', '--ff-only'])
  if (!pulled.spawned) throw new Error(t('git.gitMissing'))
  if (!pulled.ok) throw new Error(firstLine(pulled.stderr) || t('git.pullFailed', { error: '' }))
  return { summary: lastLine(fetched.stderr + '\n' + fetched.stdout + '\n' + pulled.stdout + '\n' + pulled.stderr) }
}
