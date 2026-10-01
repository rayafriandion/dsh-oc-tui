# AGENTS.md

Notes for AI coding agents working in this repository. Human-facing documentation
lives in [README.md](README.md) and [docs/用户手册.md](docs/用户手册.md); this file
only carries what an agent must not get wrong.

## A task is not done until the new build is installed

The `tui` profile runs a **tarball** copy of this plugin, and the profile's HMR root
is the profile directory, not this checkout. Editing files here changes nothing at
runtime until you repack and reinstall. So a feature or fix is finished when the new
build is in the profile and you have booted it — not when the code is written or the
tests pass.

Run, in this order:

```sh
npm pack                                        # -> dsh-oc-tui-<version>.tgz
dsh plugin --profile tui remove -w dsh-oc-tui   # detach the old copy FIRST
rm ./*.tgz                                      # then drop the stale tarball(s)
npm pack                                        # repack the current tree
cp ./dsh-oc-tui-<version>.tgz "$USERPROFILE/.dsh/profiles/tui/"
dsh plugin --profile tui add -w ./dsh-oc-tui-<version>.tgz
rm "$USERPROFILE/.dsh/profiles/tui/dsh-oc-tui-<version>.tgz"
```

PowerShell equivalent for the delete step: `Remove-Item .\*.tgz`.

Four things that will bite you:

- **Detach before deleting.** pnpm resolves the profile's existing `file:`
  dependency while adding, so a dependency pointing at a deleted tarball aborts the
  whole install with `ENOENT`.
- **The tarball must be reachable from the profile directory while you add it.**
  dsh passes package specs to pnpm with a fixed `cwd` of the profile directory, and
  pnpm 9.15.9 then looks for `<profile>/dsh-oc-tui-<version>.tgz` by name rather
  than at the absolute path dsh anchored the spec to: without that copy the add
  fails with `ENOENT: no such file or directory, open 'C:\Users\...\.dsh\profiles\tui\dsh-oc-tui-<version>.tgz'`.
  Copying the tarball in first makes the add succeed, and dsh writes the **absolute**
  path into the profile's manifest, so the copy can be deleted right afterwards.
- **Remove before adding, even when the version is unchanged.** dsh appends a new
  bundle to `dsh.profile.bundles` only for dependencies that were *not* already
  there, so adding over an existing `dsh-oc-tui` installs the files and silently
  skips the bundle row. The profile then boots into dsh-base with no TUI.
- **The version string proves nothing.** `dsh plugin add` reports the new version
  even when the old files are still on disk. Verify the swap by hashing the profile's
  copy against this checkout:

```powershell
foreach ($rel in @('lib\index.js','lib\ui.js','lib\util.js','lib\term.js','lib\metrics.js',
                   'lib\interrupt.js','lib\web-settings.js','lib\updates.js','lib\markdown.js',
                   'lib\startup.js','lib\mermaid-ascii.js','bin\dsh-oc-tui.js','cordis.patch.yml','lib\splash-opencode.js')) {
  $a = (Get-FileHash ".\$rel").Hash
  $b = (Get-FileHash "$env:USERPROFILE\.dsh\profiles\tui\node_modules\dsh-oc-tui\$rel").Hash
  if ($a -ne $b) { "DIFFERS: $rel" }
}
```

Any `DIFFERS:` line means the install silently kept the old file — redo the detach,
delete, pack, add sequence. The reverse failure is just as silent and worse: if
`dsh.profile.bundles` does not name `dsh-oc-tui`, the files are current and the
profile still boots dsh-base with no TUI at all. Confirm the layer is composed:

```sh
dsh --profile tui --dump-config | grep -A2 tui-app
```

Then boot it for real. `dsh` refuses to start without a TTY, and this repo's shell is
not one, so a piped or redirected boot only prints `stdin/stdout are not a TTY`.
winpty cannot bridge it either, because it has no console to read a size from. The
practical substitute is to run the test suite against the *installed* copy — the tests
boot the real plugin through a real cordis context with a fake terminal, open a
session by typing, and send a message:

```sh
cp tests/*.mjs "$USERPROFILE/.dsh/profiles/tui/node_modules/dsh-oc-tui/tests/"
(cd "$USERPROFILE/.dsh/profiles/tui/node_modules/dsh-oc-tui" && node tests/smoke.test.mjs)
rm -rf "$USERPROFILE/.dsh/profiles/tui/node_modules/dsh-oc-tui/tests"
```

Reaching the title screen is never enough on its own — the session-open path is where
host API breakage surfaces. Test `--resume` separately, because it is an apply-time
path that can lose a startup race the post-boot paths win.

## Before you pack

```sh
npm run check   # node --check over lib/, bin/
npm test        # standalone smoke tests (no dsh needed)
```

`tests/esc-questions.test.mjs` reports 8 failures on an otherwise clean checkout in
this environment. It is a dependency problem, not a defect in the tree: the installed
`@deepseek-ai/dsh-user-questions` was pinned back to an `rc` revision whose peer
`dsh-agent` conflicts with the rest, and nothing calls
`userQuestions.registerProvider()`. Do not treat those failures as yours to fix, and
do not "fix" them by unpinning the dependency — the pin is what lets the tarball
install cleanly (see the peer-dependency note in the README).

## Conventions

- Match the surrounding code's comment density. Comments state a constraint the code
  cannot show on its own; they do not narrate what the next line does.
- User-facing copy in the TUI is Chinese where the surrounding strings are Chinese;
  code, identifiers, and comments stay English.
- The DeepSeek brand mark is the blue→white gradient text, drawn one line tall. Do
  not reintroduce ASCII-art logo glyphs on the title screen.
- DSH affordances must stay discoverable on the title screen: `Ctrl+P` for settings
  and `Tab` for thinking intensity, in the shortcut row, ahead of any cosmetic hints.

## Repo map

| Path | What it is |
| --- | --- |
| `lib/ui.js` | The view model and renderer (App, THEME, all painting) |
| `lib/index.js` | The plugin entry: cordis apply/inject, key decoding, commands |
| `lib/term.js` | Screen buffer, styles, and the capability-aware emitter |
| `lib/image.js` | Halfblock / graphics-protocol image pipeline |
| `lib/mermaid.js` | Mermaid provider chain (mmdc → mermaid.ink → disk cache) |
| `lib/mermaid-ascii.js` | Native terminal art for mermaid fences (lovely-mermaid), tried before the image path |
| `bin/dsh-oc-tui.js` | Convenience launcher that resolves `dsh` and boots the profile |
| `dsh-plugin.json` | Manifest: bundles, patch rows, version |

`node_modules` in the profile lives at `%USERPROFILE%\.dsh\profiles\tui\node_modules`;
dsh also keeps a shared `%USERPROFILE%\.dsh\profiles\node_modules` fallback that the
plugin's dsh imports resolve through.
