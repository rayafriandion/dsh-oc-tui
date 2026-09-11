import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backupRootFor,
  canRestoreFiles,
  contentLabel,
  createdPathsAfter,
  formatRestore,
  listRewindPoints,
  mutationPathsAfter,
  parseRewindArgs,
  resolvePoint,
  restoreGitPaths,
  rewindCut,
} from '../lib/rewind.js'

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) console.log('ok   ' + name)
  else { console.log('FAIL ' + name + '  got ' + a + '  want ' + e); failed++ }
}
const ok = (name, cond) => cond ? console.log('ok   ' + name) : (console.log('FAIL ' + name), failed++)

function ev(seq, type, data = {}) {
  return { seq, time: seq * 1000, type, data }
}
function user(seq, text) {
  return ev(seq, 'user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

eq('contentLabel joins text', contentLabel([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a b')

const points = listRewindPoints([
  user(0, 'first'),
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'user/message', {
    source: { kind: 'compaction' },
    content: [{ type: 'text', text: 'hidden' }],
  }),
  user(3, 'second prompt that is quite long and should be clipped in the label so the picker stays readable'),
])
eq('listRewindPoints length', points.length, 2)
eq('listRewindPoints first', points[0].label, 'first')
ok('listRewindPoints clips', points[1].label.endsWith('…'))

const events = [
  ev(0, 'turn/start', { turn: 1 }),
  user(1, 'one'),
  ev(2, 'assistant/message', {}),
  ev(3, 'turn/end', { turn: 1 }),
  ev(4, 'session/title', { title: 't' }),
  ev(5, 'turn/start', { turn: 2 }),
  user(6, 'two'),
  ev(7, 'tool/call', { name: 'write', arguments: '{"file_path":"src/a.ts"}' }),
  ev(8, 'turn/end', { turn: 2 }),
  ev(9, 'turn/start', { turn: 3 }),
  user(10, 'three'),
]
eq('rewindCut drops selected turn', rewindCut(events, 6), 5)
eq('rewindCut first turn', rewindCut(events, 1), 0)
eq('rewindCut open turn', rewindCut(events, 10), 9)

eq('mutationPathsAfter', mutationPathsAfter([
  ev(0, 'tool/call', { name: 'read', arguments: '{"file_path":"skip.ts"}' }),
  ev(1, 'tool/call', { name: 'write', arguments: '{"file_path":"src/a.ts"}' }),
  ev(2, 'tool/call', { name: 'edit', arguments: '{"file_path":"src/a.ts"}' }),
  ev(3, 'tool/call', { name: 'edit', arguments: '{"file_path":"src/b.ts"}' }),
], 1), ['src/a.ts', 'src/b.ts'])
eq('mutationPathsAfter object args', mutationPathsAfter([
  ev(1, 'tool/call', { name: 'write', arguments: { file_path: 'src/c.ts' } }),
], 0), ['src/c.ts'])

eq('parseRewindArgs empty', parseRewindArgs(''), { selector: undefined, mode: 'both' })
eq('parseRewindArgs last code', parseRewindArgs('last code'), { selector: 'last', mode: 'code' })
eq('parseRewindArgs files', parseRewindArgs('files'), { selector: undefined, mode: 'code' })

const resolved = listRewindPoints([user(0, 'a'), user(4, 'b')])
eq('resolvePoint last', resolvePoint(resolved, 'last').seq, 4)
eq('resolvePoint 1', resolvePoint(resolved, '1').seq, 0)

try { resolvePoint(resolved, '9'); failed++ } catch { console.log('ok   resolvePoint miss') }

eq('contentLabel marks an image-only prompt', contentLabel([{ type: 'image', attachment: 'a' }]), '[image]')
eq('contentLabel marks several images', contentLabel([
  { type: 'image', attachment: 'a' },
  { type: 'image', attachment: 'b' },
]), '[2 images]')

// A path first mutated before the cut is not evidence the turn created it.
const createdEvents = [
  ev(0, 'tool/call', { name: 'edit', arguments: '{"file_path":"old.ts"}' }),
  ev(1, 'tool/call', { name: 'write', arguments: '{"file_path":"new.ts"}' }),
  ev(2, 'tool/call', { name: 'write', arguments: '{"file_path":"old.ts"}' }),
]
eq('createdPathsAfter keeps only first-touch paths', [...createdPathsAfter(createdEvents, 1)], ['new.ts'])

// ---- restoreGitPaths: the one destructive path ---------------------------
// Undoing writes must never remove a file it cannot account for, and must work
// outside a git repository by refusing instead of deleting.
const scratch = []
const scratchDir = (name) => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-' + name + '-'))
  scratch.push(dir)
  return dir
}
const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const gitIn = (dir, args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString()

// 1. Not a git worktree: refuse, and leave every file exactly where it was.
{
  const dir = scratchDir('nogit')
  writeFileSync(join(dir, 'app.js'), 'kept\n')
  writeFileSync(join(dir, 'config.json'), '{}\n')
  const result = await restoreGitPaths(dir, ['app.js', 'config.json'], { backupRoot: join(dir, 'backup') })
  eq('non-git restore refuses', { ok: result.ok, reason: result.reason }, { ok: false, reason: 'not a git worktree' })
  ok('non-git restore keeps app.js', existsSync(join(dir, 'app.js')))
  ok('non-git restore keeps config.json', existsSync(join(dir, 'config.json')))
  ok('non-git refusal reports the reason', formatRestore(result).includes('not a git worktree'))
  eq('non-git restore counts everything as skipped', result.skipped.length, 2)
  eq('canRestoreFiles is false outside a worktree', await canRestoreFiles(dir), false)
}
// 2. A backup location is required before anything is touched.
{
  const dir = scratchDir('nobackup')
  writeFileSync(join(dir, 'app.js'), 'kept\n')
  const result = await restoreGitPaths(dir, ['app.js'], {})
  eq('restore without a backup refuses', result.ok, false)
  ok('restore without a backup changes nothing', readFileSync(join(dir, 'app.js'), 'utf8') === 'kept\n')
}

if (!hasGit) {
  console.log('skip git-backed restore tests (git not on PATH)')
} else {
  const repoInit = (dir) => {
    gitIn(dir, ['init', '-q'])
    gitIn(dir, ['config', 'user.email', 'rewind@example.com'])
    gitIn(dir, ['config', 'user.name', 'rewind test'])
  }

  // 3. Tracked file: restored from HEAD (worktree only), previous content backed
  //    up, and an already-staged change is left staged.
  {
    const dir = scratchDir('tracked')
    const backup = join(dir, '..', 'rewind-backup-tracked')
    repoInit(dir)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'committed\n')
    gitIn(dir, ['add', '.'])
    gitIn(dir, ['commit', '-qm', 'base'])
    writeFileSync(join(dir, 'src', 'a.ts'), 'staged\n')
    gitIn(dir, ['add', 'src/a.ts'])
    writeFileSync(join(dir, 'src', 'a.ts'), 'written by the turn\n')

    const result = await restoreGitPaths(dir, ['src/a.ts'], { backupRoot: backup })
    eq('tracked restore reports', { restored: result.restored, removed: result.removed, skipped: result.skipped },
      { restored: [join('src', 'a.ts')], removed: [], skipped: [] })
    eq('tracked file returns to HEAD', readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'committed\n')
    eq('pre-restore content is backed up', readFileSync(join(backup, 'src', 'a.ts'), 'utf8'), 'written by the turn\n')
    eq('the index is not rewritten', gitIn(dir, ['diff', '--cached', '--name-only']).trim(), 'src/a.ts')
    ok('backup path is reported', formatRestore(result).includes(backup))
  }

  // 4. Untracked file: removed only with evidence the turn created it, and only
  //    after its content is saved.
  {
    const dir = scratchDir('untracked')
    const backup = join(dir, '..', 'rewind-backup-untracked')
    repoInit(dir)
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    gitIn(dir, ['add', '.'])
    gitIn(dir, ['commit', '-qm', 'base'])
    writeFileSync(join(dir, 'created-by-turn.txt'), 'new file\n')
    writeFileSync(join(dir, 'edited-untracked.txt'), 'pre-existing, then edited\n')

    const result = await restoreGitPaths(dir, ['created-by-turn.txt', 'edited-untracked.txt'], {
      backupRoot: backup,
      createdPaths: new Set(['created-by-turn.txt']),
    })
    ok('untracked file with evidence is removed', !existsSync(join(dir, 'created-by-turn.txt')))
    ok('untracked file with evidence is backed up', readFileSync(join(backup, 'created-by-turn.txt'), 'utf8') === 'new file\n')
    ok('untracked file without evidence is left alone', existsSync(join(dir, 'edited-untracked.txt')))
    eq('untracked removal is reported', result.removed, ['created-by-turn.txt'])
    eq('untracked doubt is reported as skipped', result.skipped, ['edited-untracked.txt'])
  }

  // 5. Paths outside the session's working directory are never touched.
  {
    const dir = scratchDir('outside')
    const other = scratchDir('outside-elsewhere')
    repoInit(dir)
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    gitIn(dir, ['add', '.'])
    gitIn(dir, ['commit', '-qm', 'base'])
    const outside = join(other, 'secret.txt')
    writeFileSync(outside, 'not mine to touch\n')
    const result = await restoreGitPaths(dir, [outside], { backupRoot: join(dir, '..', 'rewind-backup-outside') })
    ok('a path outside cwd is skipped', result.skipped.includes(outside))
    ok('a path outside cwd still exists', existsSync(outside))
  }
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

eq('backupRootFor is stamped under the harness home', backupRootFor('H:/home', 's1', 0).replace(/\\/g, '/'),
  'H:/home/rewind-backups/s1/1970-01-01T00-00-00-000Z')

if (failed > 0) process.exit(1)
console.log('rewind tests passed')
