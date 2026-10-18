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
                   'lib\startup.js','lib\mermaid-ascii.js','lib\i18n.js','bin\dsh-oc-tui.js',
                   'cordis.patch.yml','lib\splash-opencode.js')) {
  $a = (Get-FileHash ".\$rel").Hash
  $b = (Get-FileHash "$env:USERPROFILE\.dsh\profiles\tui\node_modules\dsh-oc-tui\$rel").Hash
  if ($a -ne $b) { "DIFFERS: $rel" }
}
# The locale catalogs are one directory: compare them all at once.
foreach ($f in Get-ChildItem .\lib\locales\*.js) {
  $b = "$env:USERPROFILE\.dsh\profiles\tui\node_modules\dsh-oc-tui\lib\locales\$($f.Name)"
  if (-not (Test-Path $b) -or (Get-FileHash $f.FullName).Hash -ne (Get-FileHash $b).Hash) { "DIFFERS: lib\locales\$($f.Name)" }
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

## Settings must work on both dsh generations

The two dsh lines store settings in structurally different places, and a row that
exists on only one of them is a shipped bug — this is exactly how the Language row
went missing from the real `Ctrl+P` menu while every test passed.

- **dsh 0.1.x** (`dsh-settings` provider): a namespace registry. `settings.register(ns,
  schema)` makes a namespace, `settings.get(ns)` reads it, `describe()` lists it, and
  the document is `$DSH_HOME/settings.yaml`.
- **dsh 0.2.0** (`SettingsForms`): *no registry at all*. `register` does not exist;
  `describe()` projects the **profile entries' Config schemas** into rows, so a setting
  only appears if the plugin's own exported `Config` declares the field, and the row's
  `ns` is that entry's `options.id` (usually `tui-app`). A field marked
  `.volatile()` is written through the running config reference and announced with
  `loader/volatile-update`, so the value can change without remounting the plugin;
  the document is the profile's `cordis.patch.yml`.

Every TUI-owned setting is therefore declared in three places, all of which must stay
in sync:

1. `lib/web-settings.js` → `TUI_SETTINGS` (legacy namespace + field, and the Config
   field name). This table is the contract; readers and writers go through
   `resolveTuiSetting()` / `readTuiSetting()` rather than assuming a namespace.
2. `lib/index.js` → the exported `Config`, with `volatileField(...)` on each.
3. `lib/web-settings.js` → `WEB_SETTING_SCHEMAS`, for the 0.1.x registry only.

`tests/locale.test.mjs` covers the 0.1.x path and `tests/locale-forms.test.mjs` the
0.2.0 one. A change to how a setting is read or written belongs in both.

## Conventions

- Match the surrounding code's comment density. Comments state a constraint the code
  cannot show on its own; they do not narrate what the next line does.
- **User-facing copy is never a literal.** Every string the TUI draws goes through
  `t()` / `tn()` / `tv()` from `lib/i18n.js` and lives in `lib/locales/en.js`; a new
  literal in `lib/ui.js` or `lib/index.js` is a bug, and a key added to English
  without its 16 translations fails `npm test`. Keep `{placeholders}`, leading and
  trailing spaces, and plural families intact when translating. Product and protocol
  tokens (`DeepSeek Harness`, `dsh`, `MCP`, `stdio`, `Ctrl+P`, `Tab`, `Esc`, `Enter`,
  `git`, `npm`) stay literal in every locale. `lib/std/command-list.js` must keep
  zero imports, so its descriptions are resolved in `lib/index.js` instead.
- The DeepSeek brand mark is the blue→white gradient text, drawn one line tall. Do
  not reintroduce ASCII-art logo glyphs on the title screen.
- DSH affordances must stay discoverable on the title screen: `Ctrl+P` for settings
  and `Tab` for thinking intensity, in the shortcut row, ahead of any cosmetic hints.

## Repo map

| Path | What it is |
| --- | --- |
| `lib/ui.js` | The view model and renderer (App, THEME, all painting) |
| `lib/index.js` | The plugin entry: cordis apply/inject, key decoding, commands |
| `lib/i18n.js` | Locale resolution, the catalog registry, `t()` / `tn()` / `tv()` |
| `lib/locales/*.js` | One flat catalog per language; `en.js` is the source of truth |
| `lib/term.js` | Screen buffer, styles, and the capability-aware emitter |
| `lib/image.js` | Halfblock / graphics-protocol image pipeline |
| `lib/mermaid.js` | Mermaid provider chain (mmdc → mermaid.ink → disk cache) |
| `lib/mermaid-ascii.js` | Native terminal art for mermaid fences (lovely-mermaid), tried before the image path |
| `bin/dsh-oc-tui.js` | Convenience launcher that resolves `dsh` and boots the profile |
| `dsh-plugin.json` | Manifest: bundles, patch rows, version |

`node_modules` in the profile lives at `%USERPROFILE%\.dsh\profiles\tui\node_modules`;
dsh also keeps a shared `%USERPROFILE%\.dsh\profiles\node_modules` fallback that the
plugin's dsh imports resolve through.
