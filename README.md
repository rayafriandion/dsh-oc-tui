# dsh-oc-tui

**A terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — an opencode-inspired chat client that boots inside the `dsh` process as a profile app plugin.

[![npm latest](https://img.shields.io/npm/v/dsh-oc-tui?label=npm&color=BF392B)](https://www.npmjs.com/package/dsh-oc-tui)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-marketplace-BF392B)](https://awesome-dsh-plugin.com/zh/p/rayafriandion/dsh-oc-tui/)
[![License: LGPL-3.0-or-later](https://img.shields.io/badge/license-LGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org)

`dsh-oc-tui` renders the harness's durable event stream in your terminal — streaming replies, tool cards, todo lists, thinking blocks — and routes what you type back into the agent. Model routing, tool execution, approvals, commands, durable sessions, and credentials stay owned by DSH; this package owns terminal input and presentation.

Published on **npm** as [`dsh-oc-tui`](https://www.npmjs.com/package/dsh-oc-tui) and listed in the [**awesome-dsh-plugin**](https://awesome-dsh-plugin.com/zh/p/rayafriandion/dsh-oc-tui/) marketplace.

> 中文文档：[docs/用户手册.md](docs/用户手册.md)

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [Keybindings](#keybindings)
  - [Slash commands](#slash-commands)
  - [Interactive prompts](#interactive-prompts)
  - [Thinking intensity](#thinking-intensity)
  - [Context meter and telemetry](#context-meter-and-telemetry)
  - [Settings](#settings)
  - [In-app updates](#in-app-updates)
- [How it works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Layout](#layout)
- [License](#license)

## Features

| | |
| --- | --- |
| **Durable sessions** | Create, resume, list, and delete sessions; the transcript is rebuilt from the persisted event log, so a resumed session looks exactly like the one you left. |
| **Live streaming** | Assistant text and reasoning stream token by token; thinking renders in its own collapsible box that stays collapsed while streaming. |
| **Tool activity** | Tool cards with a one-line summary (`read src/app.ts`, `run npm test`), flowing spinners while running, and markdown-rendered results. |
| **Interactive questions** | The model can pause and ask you — option lists, multi-select, free text, and a scrollable plan review — all inline in the terminal. See [Interactive prompts](#interactive-prompts). |
| **Inline approvals** | `approval/request` prompts are answered with `y` / `n` without leaving the UI. |
| **Telemetry footer** | Session tokens, average time to first token, decode throughput, and cache-hit rate, folded from durable events. |
| **Context meter** | Live context occupancy (`ctx ▓▓░░ 32K/128K 25%`) with a click-through composition breakdown. |
| **Thinking intensity** | `Tab` cycles the current model's real reasoning levels; `Ctrl+E` opens a slider. The level is applied per request and persisted. |
| **Shared settings** | The same host settings namespaces the Web UI uses — general, sessions, per-provider model configuration, credentials — persisted to `$DSH_HOME/settings.yaml`. |
| **In-app updates** | Detect and switch versions of `@deepseek-ai/dsh` and `dsh-oc-tui` from inside the TUI, with Windows-safe deferred installs. |
| **Zero-dependency terminal engine** | Raw mode, alternate screen, a diffing cell buffer, truecolor ANSI, CJK-aware widths, SGR + legacy X10 mouse decoding, and IME caret anchoring. |

## Requirements

| | |
| --- | --- |
| Node.js | >= 22 |
| dsh CLI | `@deepseek-ai/dsh` — e.g. `npm install -g @deepseek-ai/dsh` |
| pnpm | on `PATH`; `dsh plugin` forwards to it |
| Terminal | an interactive terminal (Windows Terminal / ConPTY, iTerm2, GNOME Terminal, …) |
| Model route | a usable route in `$DSH_HOME/settings.yaml` + `$DSH_HOME/.credentials.yaml` (the same setup the Web GUI uses) |

```sh
dsh --version
pnpm --version
```

**Compatibility.** Verified against dsh `0.1.2-rc.1` (and `0.1.1-rc.2`). DSH renamed parts of the session API in 0.1.2 — `Session.events` became `snapshotEvents()` — and this plugin reads whichever accessor the host provides, so one build serves both lines.

## Install

### From npm

The package is published on npm as [`dsh-oc-tui`](https://www.npmjs.com/package/dsh-oc-tui). Install it into the `tui` profile:

```sh
dsh plugin --profile tui add -w dsh-oc-tui
```

Or install the launcher globally — that puts the `dsh-oc-tui` command on `PATH`, which then boots `dsh --profile tui`:

```sh
npm install -g dsh-oc-tui
```

### Version channels

The **npm package** and the **[awesome-dsh-plugin](https://awesome-dsh-plugin.com/zh/p/rayafriandion/dsh-oc-tui/) marketplace entry** both ship **stable releases only** — pre-releases are never published to either. `npm install` therefore gives you the latest stable version, not a release candidate.

This README describes the current source tree, which can be ahead of the published release — a feature documented here is only guaranteed to exist in a stable build once that version is on npm.

To run a pre-release, or unreleased work from this repository, install it explicitly from source:

```sh
npm pack                                   # -> dsh-oc-tui-<version>.tgz
dsh plugin --profile tui add -w ./dsh-oc-tui-<version>.tgz
```

### One-command installers

The repository ships installers that check Node >= 22, make sure `pnpm` exists, install the plugin into the `tui` profile, and can also add the `dsh-oc-tui` launcher globally.

```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/rayafriandion/dsh-oc-tui/main/install.sh | bash
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/rayafriandion/dsh-oc-tui/main/install.ps1 -OutFile install.ps1; & .\install.ps1"
```

Run `./install.sh` / `.\install.ps1` from a checkout instead, and add `--launcher` / `-Launcher` to also put the `dsh-oc-tui` command on `PATH`. Other flags: `--local` (`-Local`) installs the current checkout, `--source <spec>` (`-Source <spec>`) uses a custom source, `--profile <name>` (`-Profile <name>`) targets another profile.

### From a checkout or tarball

```sh
npm pack                                             # -> dsh-oc-tui-<version>.tgz
dsh plugin --profile tui add -w ./dsh-oc-tui-<version>.tgz
```

`dsh plugin` anchors relative paths to the directory you invoke it from before forwarding to pnpm.

### Why `-w`

The profile directory declares itself a pnpm workspace root (`pnpm-workspace.yaml` → `packages: [.]`), so pnpm refuses a bare `add` with `ERR_PNPM_ADDING_TO_ROOT`. `-w` makes the dependency land in the profile's own manifest — which is exactly what it is. `dsh plugin` then reconciles `dsh.profile.bundles` against what is installed.

### What the install does

1. `dsh plugin` initializes `$DSH_HOME/profiles/tui` on first use (`@deepseek-ai/dsh-base` plus an empty user patch layer).
2. pnpm installs `dsh-oc-tui` into the profile's `node_modules`.
3. Because the package declares `dsh.bundle.patch`, dsh appends `dsh-oc-tui` to `dsh.profile.bundles`.
4. `dsh --profile tui` composes the base layer, this bundle's rows, and your own patch — no manual editing required.

Verify without booting:

```sh
dsh --profile tui --dump-config
```

The dump shows a `# == dsh-oc-tui` layer containing `tui-startup`, `tui-app`, the `agent-presets` roster row, and the `tool-ask-user` row.

## Quick start

```sh
dsh --profile tui                        # title screen; your first message creates a session
dsh --profile tui --resume <sessionId>   # resume a persisted session
dsh --profile tui --model <modelId>      # default model for new sessions
dsh --profile tui --provider <route>     # default provider route
dsh --profile tui --no-sidebar           # start without the session rail
dsh --profile tui --help                 # the TUI's own flags
```

The stock launcher hardcodes only `web` and `plugin` as bare subcommands, so `--profile tui` is the intended shape. Want the literal `dsh tui`? Add a shell alias:

```powershell
function tui { dsh --profile tui @args }   # PowerShell $PROFILE
```

```bat
doskey tui=dsh --profile tui $*            :: CMD
```

### Convenience launcher

The package also ships a `dsh-oc-tui` binary that is equivalent to `dsh --profile tui`, but checks first that the profile actually has the plugin installed and prints the one-time install command when it does not.

```sh
dsh-oc-tui                 # boot the tui profile
dsh-oc-tui --profile mytui # boot a different profile
dsh-oc-tui --help          # launcher help
dsh-oc-tui --version       # launcher version
```

It prefers the `dsh` on `PATH` and falls back to `npx --yes @deepseek-ai/dsh`. Install it with `npm install -g dsh-oc-tui`.

| Environment variable | Effect |
| --- | --- |
| `DSH_TUI_PROFILE` | Default profile when `--profile` is absent (default `tui`). |
| `DSH_TUI_SKIP_CHECK` | Set to `1` to skip the profile preflight (advanced installs). |

## Usage

### Keybindings

| Key | Action |
| --- | --- |
| `Enter` | Send the message. |
| `Ctrl+Enter` / `Shift+Enter` / `Alt+Enter` | Insert a newline. |
| `Ctrl+C` | Clear a non-empty prompt, cancel the running turn, or press twice while idle to exit. |
| `Ctrl+P` | Open Settings. |
| `Ctrl+E` | Toggle the thinking-intensity slider below the composer. |
| `Tab` | Session page: cycle the thinking intensity. Settings page: switch the left menu. |
| `Ctrl+N` | New session. |
| `Ctrl+D` | In Settings → Manage sessions: delete the focused session (press twice to confirm). |
| `Ctrl+L` | Clear the transcript view. |
| `Up` / `Down` | Move the caret across a multi-line prompt; on the first/last row, step through input history. |
| `Left` / `Right` | Move the caret within the input box. |
| `PgUp` / `PgDn` | Scroll the transcript. |
| `Esc` | Close the context-meter panel, the thinking slider, or help; cancel an approval. |
| `Esc Esc` | Idle with an empty prompt: open the rewind picker. |
| `y` / `n` | Answer an inline approval prompt. |

**Mouse.** The wheel scrolls the transcript (or the Settings window while it is open). Hold the left button and drag across the transcript to select text, then press the right button to copy the selection.

### Slash commands

Built in: `/help` `/settings` `/new` `/resume <id>` `/model <id>` `/provider <route>` `/rewind` `/clear` `/cancel` `/quit` (`/exit` also works).

Harness commands — `/compact`, `/goal`, `/plan`, … — are forwarded to `ctx.commands` and run without a model turn. They need a live session: on the title screen the TUI answers `/<name>: start a session first` instead of dropping the command silently.

### Interactive prompts

**Approvals.** When a tool needs permission, the composer area shows `Approval · <tool> · y allow / n deny`. `y` allows once, `n` rejects, `Esc` cancels. The plugin also honours the effective permission preset, so an auto-approving preset does not prompt at all.

**Questions.** The model can ask you directly through the `ask_user_question` tool. The tool is declared by this bundle's `tool-ask-user` row — `dsh-base` mounts the `user-questions` service but not the tool, and a TUI session composes from the base rather than from an agent preset — and it is answered by a modal:

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move between options (wrapping). |
| `Space` | Toggle the highlighted option (multi-select) or select it (single choice). |
| `Enter` | Continue: a single choice is selected and advances; on the free-text row it starts editing; in a multi-select it confirms the toggled set. |
| any printable key | Jump into the free-text row and start typing. |
| `PgUp` / `PgDn`, wheel | Scroll a long plan or detail pane. |
| `Esc` | Defer: decline to answer here (`Esc` while editing returns to the options). |
| `Ctrl+C` | Still cancels the running turn; the pending question is withdrawn. |

Questions are staged one at a time, exactly as the Web UI composer stages them, and the answer encoding is identical: a free-text answer replaces the selection for a single-select question and accompanies it for a multi-select one.

A question carrying the `plan-review` intent — what `exit_plan_mode` sends — renders the plan markdown in a scrollable pane above `Approve` / `Keep planning`. Answering `Approve` exits plan mode and the model continues; anything else keeps planning.

Deferring is deliberate, not a cancel: with no other answerer the tool reports `no user-questions answerer accepted the request`, which cannot be mistaken for a human choice.

### Thinking intensity

The effective level sits on the composer's top-right border as the bare level name, diagonally opposite the `provider · model` label.

- `Tab` on the session page cycles the levels of the **current model** (wrapping strongest → weakest); `Shift+Tab` steps backwards.
- `Ctrl+E` opens a slider below the composer: `Tab` or `←`/`→` adjust and persist, `Esc` or `Ctrl+E` close it.
- Levels come from the provider adapter (`ctx.llm.resolveModelInfo`), so a boolean-thinking model shows exactly its two ends, DeepSeek's `Off`/`High`/`Max` shows those three, and a full-range model shows every advertised level — never a blanket `none → max` scale.

The choice is applied to the session's requests through the `agent/request` waterfall and stored in `agent-default-model.reasoningEffort`.

### Context meter and telemetry

The status row carries a live context-occupancy bar fed by the token-meter `contextPressure` projection — the same source as the Web UI's composer ring: current context length over the model's context window, shifting to the warning and error palette as occupancy climbs. Clicking it opens a breakdown panel (click again or `Esc` to close) with the occupancy reading and the heuristic composition shares — system prompt, tools, and messages — matching the Web UI's ContextMeter dialog. The meter hides itself when the profile has no token-meter projections.

The footer reports session tokens, average time to first token, decode throughput, and cache-hit rate, folded from durable step, chunk, and message events.

### Settings

`Ctrl+P` opens a settings menu over the same host settings namespaces as the Web UI, persisted through `ctx.settings` to `$DSH_HOME/settings.yaml`. A left menu splits it into three tabs (`Tab` or click to switch):

- **Main** — General (busy-Enter behaviour, default agent preset, permission preset), Sessions (new session, manage sessions), System (provider API hints, update-manager shortcut, settings file path).
- **Model** — the default provider/model/reasoning choice, then one group per provider holding its URL, API key, and model list. Pressing `Enter` on **Models** fetches the provider's advertised catalog (`ctx.llm.discoverModels`) and opens a checkbox window; pressing `Enter` on a listed model makes it the default route.
- **Update** — see [In-app updates](#in-app-updates).

Only providers you actually added (present in your user settings layer) are listed; a provider that was never added stays hidden. The default agent preset comes from the roster the profile mounts (the shipped presets plus any you authored under `$DSH_HOME/.agent-presets`) — note that a TUI session composes process-wide from the base, so the stored default applies where a session is created from a preset. Web-UI-only options (`ui-theme` appearance, `locale`) are not shown because they have no effect in the TUI.

### In-app updates

`Ctrl+P → Update` shows the installed versions of `@deepseek-ai/dsh` and `dsh-oc-tui`, the latest npm dist-tag, and a status line that only ever targets **stable** releases:

- `Update available → x.y.z` — a newer stable release exists.
- `Up to date` — nothing to do.
- `No stable release — pick from Versions` — the registry has no stable release yet; pick one manually.
- `Install damaged — reinstall below` — the global dsh tree is in a mixed old/new state; reinstall it.

`Enter` on a package's **Versions** row opens the full registry list (newest first, `[latest]`/`[next]`/other tags and `(installed)` colour-coded) where you can pick any version — including pre-releases — for a y/n-confirmed install through `npm`/`dsh plugin`. `Check now` re-reads the registry; `Startup check` toggles the silent boot-time stable-release check. Installs run in the background, never block the UI, and need a restart to apply.

<details>
<summary><strong>Windows: why dsh installs are deferred to exit</strong></summary>

On Windows, updating dsh while any dsh process runs can *silently corrupt* the global install: npm replaces the directory while the running process holds memory-mapped native DLLs, still exits 0, and the resulting old/new hybrid tree fails to boot. The updater guards this in three layers:

1. **dsh installs are deferred to TUI exit** — a detached helper waits for the TUI to close, runs the install, and records the outcome in `$DSH_HOME/tui-dsh-install.json`, which the Update page verifies on the next visit.
2. **The on-disk version is compared** against the requested target after every direct install, so a silent corruption surfaces as an `install corrupt` toast with repair instructions.
3. **An already-damaged install is flagged** in the Status row rather than reported as a bogus success.

macOS/Linux have no DLL lock, but an install is refused while other dsh processes are running.
</details>

## How it works

- The plugin is a Cordis function plugin loaded by the `tui` profile. `lib/startup.js` parses the app's flags and provides the `tuiStartup` service; `lib/index.js` owns the UI loop.
- `lib/term.js` is a zero-dependency terminal engine: raw mode, alternate screen, a diffing cell buffer, and a key decoder (truecolor ANSI, CJK-aware widths). It parks the hidden terminal cursor at the input caret so the OS IME anchors its composition window inside the composer, and it understands both SGR and legacy X10 mouse encodings so wheel and click bytes can never leak into the input text.
- `lib/ui.js` is the responsive view model and renderer (DeepSeek blue-white theme, session rail, transcript, multiline composer, command suggestions, telemetry footer). Transcript lines are cached per block, only the visible window is materialised each frame, streaming paints are coalesced, and the live block re-renders on a short throttle — so render cost stays bounded as history grows. Thinking collapses to keep the transcript readable, and running tools and thinking blocks animate with flowing spinners.
- `lib/metrics.js` folds durable step/chunk/message events into token, TTFT, throughput, and cache-hit metrics.
- `lib/interrupt.js` owns the clear/cancel/double-exit state machine used by stdin and `SIGINT`.
- `lib/markdown.js` renders model output (headings, lists, quotes, code, inline spans) to styled lines.
- `lib/updates.js` isolates every npm/pnpm interaction for the Update tab — registry queries, dependency-free semver comparison, dsh install detection, and installs — all through `child_process.spawn`, never `spawnSync`.
- Agents are created and resumed through `ctx.agents`, the transcript is rebuilt from the session's durable log and fed live by `session/event` (including `assistant/chunk`), model defaults come from `ctx.agentDefaultModel`, and approvals answer the `approval/request` waterfall inline.
- `ask_user_question` is answered over the `user-questions/request` waterfall: a scoped Cordis waterfall where the modal either returns an answer or delegates with `next()`. An aborted request rejects so the service reports its own `ASK_ABORTED`; requests addressed to another agent are delegated untouched.

## Development

```sh
npm run check   # node --check over lib/, bin/
npm test        # standalone smoke tests (no dsh needed)
```

**The install is a build, so edit → build → install.** The profile contains a *tarball* copy of the plugin, and the profile's HMR root is the profile directory, not the plugin directory — editing this checkout changes nothing until you repack and reinstall:

```sh
npm pack                                        # -> dsh-oc-tui-<version>.tgz
dsh plugin --profile tui remove -w dsh-oc-tui   # detach the old copy FIRST
Remove-Item .\*.tgz                             # then drop the stale tarball
npm pack
dsh plugin --profile tui add -w .\dsh-oc-tui-<version>.tgz
```

Detach before deleting: pnpm resolves the profile's existing `file:` dependency while adding, so a dependency pointing at a deleted tarball aborts the whole install with `ENOENT`.

Verify the swap actually landed — the version string proves nothing:

```powershell
foreach ($rel in @('lib\index.js','lib\ui.js','lib\util.js','lib\term.js','lib\metrics.js',
                   'lib\interrupt.js','lib\web-settings.js','lib\updates.js','lib\markdown.js',
                   'lib\startup.js','bin\dsh-oc-tui.js','cordis.patch.yml')) {
  $a = (Get-FileHash ".\$rel").Hash
  $b = (Get-FileHash "$env:USERPROFILE\.dsh\profiles\tui\node_modules\dsh-oc-tui\$rel").Hash
  if ($a -ne $b) { "DIFFERS: $rel" }
}
```

Then boot it for real. Reaching the title screen is not enough — the session-open path is where host API breaks surface, so send a message. Test `--resume` separately, because it is an apply-time path that can lose a startup race the post-boot paths win.

For a zero-install bootstrap that skips packaging entirely, create the profile once and point its patch at this checkout:

```sh
dsh --profile tui --dump-config   # initializes the base profile once
```

```yaml
# $DSH_HOME/profiles/tui/cordis.patch.yml
- insert:
    - id: tui-startup
      name: 'file:///D:/Projects/DeepSeekHarnessPlugins/dsh-oc-tui/lib/startup.js'
    - id: tui-app
      name: 'file:///D:/Projects/DeepSeekHarnessPlugins/dsh-oc-tui/lib/index.js'
      config:
        sidebar: true
        showReasoning: true
```

The plugin's dsh imports resolve through the shared `$DSH_HOME/profiles/node_modules` fallback that dsh maintains, so nothing has to be installed into the plugin directory.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `pnpm failed in profile directory` / `ERR_PNPM_ADDING_TO_ROOT` | The profile is a pnpm workspace root; add `-w` to the `add`/`remove` command. |
| `ENOENT: … dsh-oc-tui-<v>.tgz` during install | The profile still references a tarball you deleted. `dsh plugin --profile tui remove -w dsh-oc-tui`, then add again. |
| `pnpm not found on PATH` | Install pnpm (`npm install -g pnpm`) and retry. |
| `--dump-config` has no TUI layer | The install did not complete, or the package name is misspelled. Re-run the `add` and check `dsh.profile.bundles`. |
| Exits immediately / no UI | stdin and stdout must both be a TTY — do not pipe or redirect. Then verify the model route and credentials exist. |
| `--resume` or Manage sessions unavailable | Both need the shared `sessionQuery` service; keep `@deepseek-ai/dsh-base` first in `dsh.profile.bundles`. |
| `no agent factory registered` on `--resume` | A startup race with the agent-loop row; current builds retry it. On an older build, run `/resume <id>` after boot instead. |
| Loader errors after updating dsh (`State`, `./internal`) | The global dsh install is a mixed old/new tree. Close every dsh process and reinstall: `npm install -g @deepseek-ai/dsh@<version>`. |
| Source edits have no effect | The installed copy is a tarball; repack and reinstall (see [Development](#development)). |

More detail, in Chinese: [docs/用户手册.md](docs/用户手册.md).

## Known limitations

- IME composition is not exposed by the zero-dependency terminal engine yet. Pasted images are: a bracketed paste of raw image bytes, a `data:image/...;base64,...` URL, a local image path, or an image URL becomes a `[Image N]` attachment, and pasting text nothing recognizes asks the terminal for its clipboard (OSC 52).
- The plugin does not hot-reload: the profile's HMR root is the profile directory, so a running TUI keeps the copy it booted with.
- `dsh tui` as a bare subcommand needs a shell alias — the stock launcher hardcodes only `web` and `plugin`.
- Harness slash commands need a live session; on the title screen the TUI tells you to start one first.
- Deferring a question with `Esc` does not cancel the tool call — it delegates, and with no other answerer the tool call fails. Per-question skip (as the Web UI composer offers) is not implemented.
- `--resume`, Settings → Manage sessions, and the context meter depend on services mounted by `@deepseek-ai/dsh-base` (`sessionQuery`, `sessionProjections`); a hand-built profile must provide them.
- The deferred dsh install on Windows waits for the TUI that scheduled it, not for every dsh process on the machine — close other TUI windows (and `dsh web`) before it runs.

## Layout

```
lib/index.js         plugin entry: agents, events, input, commands, approvals, user questions
lib/startup.js       command-line provider (tuiStartup service)
lib/term.js          terminal engine (raw mode, screen, key decoding)
lib/ui.js            responsive view model + renderer (includes the question modal)
lib/metrics.js       durable event telemetry fold
lib/interrupt.js     Ctrl+C lifecycle state
lib/web-settings.js  shared WebUI settings projection
lib/updates.js       in-app update manager (npm registry + installs)
lib/markdown.js      markdown -> styled lines
lib/util.js          text/display helpers
bin/dsh-oc-tui.js    convenience launcher for `dsh --profile tui`
install.sh           one-command installer (Linux/macOS)
install.ps1          one-command installer (Windows)
cordis.patch.yml     bundle patch layer (TUI rows, agent-presets roster, ask-user tool)
docs/用户手册.md       Chinese user manual
tests/smoke.test.mjs standalone smoke tests
```

## License

[LGPL-3.0-or-later](LICENSE).
