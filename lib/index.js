// The dsh-oc-tui app plugin: boots a terminal UI inside a dsh profile, drives
// agents through ctx.agents, renders the durable session/event feed, and
// routes human input back via followup/steer.
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { Terminal } from './term.js'
import { captureDiagnostics } from './diagnostics.js'
import { filterMcpStderrWrites } from './mcp-monitor.js'
import { dshBootGate } from './dsh-version.js'
import { renderBootBlock } from './boot-block.js'
import { App, noteFromContext, cursorAtVisual } from './ui.js'
import { DEFAULT_THEME, THEME_IDS } from './themes.js'
import { probeCapabilities } from './caps.js'
import { renderImage, sha16 } from './image.js'
import { saveScreenshot } from './screenshot.js'
import { createMermaidRenderer } from './mermaid.js'
import { SessionMetrics, mergeSessionStats } from './metrics.js'
import { InterruptState } from './interrupt.js'
import { SETTINGS_MENU, applyLocalePreference, buildMcpFormItems, describeLocale, installWebSettingSchemas, loadMcpSettings, loadModelSettings, loadProviderModels, loadWebSettings, readTuiSetting, saveWebSetting } from './web-settings.js'
import {
  adoptDiscovered,
  buildCreateFormItems,
  buildModelFormItems,
  createDraft,
  declareNamespace,
  deriveRoute,
  discoverDraftModels,
  draftModelItems,
  mergeModelSelection,
  modelDraftFrom,
  modelEntryId,
  modelFromDraft,
  protocolChoices,
  providerDirectory,
  providerPickerItems,
  removeModelEntry,
  saveCreateDraft,
  saveModelEntry,
  validateCreateDraft,
  validateModelDraft,
} from './providers.js'
import { McpManager, collectServers, createToolProbe, draftFromEntry, emptyDraft, pathConfigPath, removeServer, saveDraft, userConfigPath, validateDraft } from './mcp.js'
import { registerMcpSkill } from './mcp-skill.js'
import { legacyRouteOverrides, recordSelection, recordsSelections } from './model-route.js'
import { contentImages, contentText, decodeDataUrl, detectImageMediaType, fieldPasteText, formatError, localImagePath, shortenPath, timeString, userContentBlocks } from './util.js'
import { DSH_PACKAGE, TUI_PACKAGE, buildVersionItems, cachedTarballVersions, clearStagedInstall, detectDshInstall, detectDshLocks, dshManifestPath, dshProcessArgs, dshShimPath, formatDownloadProgress, installMarkerPath, loadUpdateView, registryInfo, restartPlan, spawnApplyUpdater, stageInstall, tarballCachePath, tuiInstallIsLocal, tuiInstalledManifestPath, tuiInstalledVersion, updateStatus } from './updates.js'
import {
  backupRootFor,
  canRestoreFiles,
  createdPathsAfter,
  formatRestore,
  listRewindPoints,
  mutationPathsAfter,
  parseRewindArgs,
  resolvePoint,
  restoreGitPaths,
  rewindCut,
} from './rewind.js'
import { listGitBranches, pullGitUpdates, switchGitBranch } from './git-branch.js'
import { registerLiveTui } from './bridge.js'
import { notificationLevel, approvalOutcome, copyTextOptions, deadlineDelay, toTuiQuestions, fromTuiAnswers } from './std/adapt.js'
// Peer-free on purpose: lib/std/commands.js statically imports the optional
// @dsh-std/command, and lib/index.js is the bundle entry loaded on every
// profile start, so importing that module here would make the TUI fail to load
// wherever the optional peer is absent.
import { TUI_OWNED_COMMANDS, COMMAND_DESCRIPTIONS } from './std/command-list.js'
import { getLocale, resolveLocale, setLocale, t, tn } from './i18n.js'

const ESC_DOUBLE_MS = 800
// The outcome of a modal wait whose request deadline passed. A Symbol on
// purpose: it cannot be mistaken for an answer object, a secret string, a
// deferral's return value, or a cancellation, so the standard path can map it
// to `expired` without guessing.
const EXPIRED = Symbol('expired')
// Commands the TUI refuses to yield to the harness even when it registers a
// command of the same name. The rest of runCommand's switch is a fallback: a
// harness-registered command wins there (see the ctx.commands.find check).
const TUI_EXCLUSIVE_COMMANDS = new Set(['rewind'])
// The conversation-only restore is first so the default Enter never touches the
// working tree: undoing file writes is destructive and opt-in.
const REWIND_RESTORE_OPTIONS = [
  { id: 'conversation', get label() { return t('rewind.option.conversation') } },
  { id: 'both', get label() { return t('rewind.option.both') } },
  { id: 'code', get label() { return t('rewind.option.code') } },
  { id: 'cancel', get label() { return t('rewind.option.cancel') } },
]

// Remove one persisted session by deleting its own directory under the harness
// home. The store is `<DSH_HOME>/sessions/<workspace-slug>/<sessionId>/`
// holding the session's log (`session.v3.jsonl.zstd` from format V3 on) with
// any lock or metadata siblings, so the directory is the whole artifact. The
// workspace slug is derived from the session's working directory, not recorded
// anywhere the TUI can read back, so every workspace is scanned for the id.
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

async function deleteSessionDirectory(sessionId) {
  const sessionsRoot = join(dshHome(), 'sessions')
  let roots
  try {
    roots = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error('cannot read the session store at ' + sessionsRoot + ': ' + formatError(error))
  }
  for (const root of roots) {
    if (!root.isDirectory()) continue
    const rootPath = join(sessionsRoot, root.name)
    let entries
    try {
      entries = await readdir(rootPath, { withFileTypes: true })
    } catch {
      // An unreadable workspace directory cannot hold this session; keep looking
      // rather than failing the delete.
      continue
    }
    if (!entries.some((entry) => entry.isDirectory() && entry.name === sessionId)) continue
    await rm(join(rootPath, sessionId), { recursive: true, force: false })
    return true
  }
  return false
}

async function gitBranchAt(startPath) {
  let directory = resolve(startPath)
  const root = parse(directory).root
  while (true) {
    const marker = join(directory, '.git')
    try {
      let gitDirectory = marker
      const markerText = await readFile(marker, 'utf8')
      const match = /^gitdir:\s*(.+)$/im.exec(markerText)
      if (match) gitDirectory = isAbsolute(match[1].trim()) ? match[1].trim() : resolve(directory, match[1].trim())
      const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim()
      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 12)
    } catch {
      try {
        const head = (await readFile(join(marker, 'HEAD'), 'utf8')).trim()
        return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 12)
      } catch { /* continue to parent */ }
    }
    if (directory === root) return ''
    directory = dirname(directory)
  }
}

export const name = 'dsh-oc-tui'

export const inject = ['agents', 'commands', 'sessionPersistence', 'tuiStartup']

// dsh 0.2.0 derives the settings page from per-entry Config forms instead of a
// namespace registry, so a field the TUI owns has to be declared here to have a
// row at all — and `volatile()` is what lets the host push an edit into the
// running config reference without remounting the plugin (a language switch
// that remounted the TUI would lose the session view). An older schemastery
// without `volatile` keeps working: the field is then plain, which is exactly
// what a 0.1.x host expects.
const volatileField = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema)

export const Config = Schema.object({
  sidebar: Schema.boolean().default(true),
  showReasoning: Schema.boolean().default(true),
  defaultModel: Schema.string(),
  defaultProvider: Schema.string(),
  // The settings this plugin owns, mirrored onto its Config so a 0.2.0 host
  // (whose settings page is derived from Config forms, not a namespace
  // registry) shows a row for each and can push an edit into the running
  // reference without remounting the TUI. lib/web-settings.js owns the
  // legacy-namespace names and the read/write resolution; these field names are
  // the contract between the two.
  locale: volatileField(Schema.string().default('system')),
  theme: volatileField(Schema.union(THEME_IDS).default(DEFAULT_THEME)),
  busyEnter: volatileField(Schema.union(['queue', 'steer']).default('queue')),
  graphics: volatileField(Schema.union(['auto', 'off']).default('auto')),
  imageFallback: volatileField(Schema.union(['halfblock', 'chip']).default('halfblock')),
  imageMaxRows: volatileField(Schema.union(['10', '15', '20', '28', '40']).default('20')),
  mermaid: volatileField(Schema.union(['auto', 'local', 'off']).default('auto')),
  startupCheck: volatileField(Schema.union(['on', 'off']).default('on')),
  screenshotDirectory: volatileField(Schema.string().default('')),
  // Developer option: whether the transcript draws the harness's own plumbing
  // boxes (runtime-context snapshot, system prompt, system reminders).
  contextDetails: volatileField(Schema.union(['show', 'hide']).default('show')),
})

export function apply(ctx, config) {
  const startup = ctx.tuiStartup ?? {}
  installWebSettingSchemas(ctx)
  // Resolve the interface language before anything paints. The stored
  // preference wins; `system` falls through to the OS language variables, and
  // an unrecognised language lands on English rather than an empty screen.
  applyLocalePreference(ctx, config)

  // The version gate moved inside the terminal: it paints a page instead of the
  // interface, and it needs a TTY to be read and dismissed. See showBootBlock.
  const term = new Terminal()
  if (!term.isTTY()) {
    console.error('dsh-oc-tui: stdin/stdout are not a TTY; run in an interactive terminal (dsh --profile tui)')
    const exit = ctx.get('appExit')
    if (exit) exit(1)
    return
  }
  term.start()
  const app = new App(term)
  app.setTheme(readTuiSetting(ctx, config, 'tui-theme', 'preference'))
  app.setContextDetails(readTuiSetting(ctx, config, 'tui-dev', 'contextDetails'))

  // Paint the refusal and accept nothing but quit.
  //
  // The page replaces the interface instead of sitting on top of it, because
  // there is no interface to reach: no session, no settings, no update check.
  // The streams are diverted the same way the real boot diverts them — a host
  // warning must not paint over the one screen the reader is supposed to act on —
  // and restored before the terminal is handed back, so that text lands in the
  // diagnostics log while the frame stays intact.
  function showBootBlock(info) {
    const diagnostics = captureDiagnostics({
      logPath: join(dshHome(), 'tui-diagnostics.log'),
      onFirst: () => paintBlock(),
    })
    const restoreMcpStderr = filterMcpStderrWrites()
    function paintBlock() {
      if (term.started) term.paint(renderBootBlock(term.cols, term.rows, app.theme, info))
    }
    // Three spellings of the same exit, because this page has no status bar to
    // teach either one: Esc and Ctrl+C are what a stuck user reaches for, and
    // Ctrl+D ends a terminal session everywhere else.
    function onKey(key) {
      if (!key) return
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) quitBlocked()
    }
    function quitBlocked() {
      term.off('key', onKey)
      term.off('resize', paintBlock)
      term.stop()
      diagnostics.restore()
      restoreMcpStderr()
      // A non-zero status: the profile did not come up, and a wrapper script
      // reading the exit code should say so rather than report a clean run.
      const exit = ctx.get('appExit')
      if (exit) exit(1)
      else process.exit(1)
    }
    term.on('key', onKey)
    term.on('resize', paintBlock)
    paintBlock()
  }

  // ---- dsh version gate ----------------------------------------------------
  // Nothing below this line may run on a dsh this build has no evidence for: a
  // mismatch does not show up as a failed start but as one broken corner — a
  // model switch that throws, a settings write that lands nowhere — and the page
  // below is what turns that into one actionable sentence. dsh disables an
  // out-of-range bundle row before it mounts, so in practice this catches the
  // exempted host (`dsh plugin allow-version`) and the in-range version that was
  // never actually run (0.2.2-rc.1 broke the model override while sitting inside
  // the declared range). `null` means usable — or unreadable, which is not
  // evidence against the host.
  const bootGate = dshBootGate()
  if (bootGate) {
    showBootBlock(bootGate)
    return
  }

  // From here until the alt screen is released, anything the host or a plugin
  // writes to the process streams would land on top of the frame. Divert it to
  // a log instead, and say so once — silently swallowing an adapter's refusal
  // would make a broken provider look like a broken TUI.
  const diagnosticsLog = join(dshHome(), 'tui-diagnostics.log')
  const diagnostics = captureDiagnostics({
    logPath: diagnosticsLog,
    onFirst: () => {
      app.showToast(t('diagnostics.notice', { path: shortenPath(diagnosticsLog, 48) }), 'warn')
      // Deferred, not direct: the capture can fire while this startup scope is
      // still being evaluated, before `paint` below is initialized.
      setTimeout(() => { if (term.started) paint() }, 0)
    },
  })
  // The capture above takes the streams for the alt screen; the MCP filter
  // goes on top of it, so a host audit about an MCP server is dropped instead
  // of being recorded and replayed on exit.
  const restoreMcpStderr = filterMcpStderrWrites()
  // Session history is available from Settings -> Manage sessions.
  app.sidebarVisible = false
  // The status rail's footer names the running builds: this plugin's own
  // manifest and the dsh install on PATH (both reads are millisecond-scale,
  // no spawn).
  app.versions = { tui: tuiInstalledVersion() ?? '', dsh: detectDshInstall().version ?? '' }

  // ---- image pipeline -----------------------------------------------------
  // The view model only decides WHEN an image is needed; byte resolution and
  // rendering happen here. Paste-path sources carry their bytes already, event
  // and replay sources carry stored attachment refs, markdown sources carry
  // remote URLs. A protocol render also registers its payload with the
  // terminal so paint() can transmit/place it.
  app.onImageRequest = (src) => { void resolveImage(src) }
  // One render per key and geometry at a time. A resize during a decode asks
  // again under a new signature; without this the old decode keeps running and
  // the same image is encoded twice for one frame.
  const imageRendersInFlight = new Map()
  async function resolveImage(src) {
    const sig = app.imageRenderSignature()
    const options = app.imageRenderOptions()
    if (imageRendersInFlight.get(src.key) === sig) return
    imageRendersInFlight.set(src.key, sig)
    try {
      const bytes = await resolveImageBytes(src)
      // cropCells arrives on a source the view re-requested because the
      // transcript scrolled past the top of the image: the variant carries only
      // the rows still on screen.
      const render = await renderImage({ bytes }, { ...options, cropCells: src.cropCells ?? 0 })
      if (sig !== app.imageRenderSignature()) return
      if (render.protocol === 'error') {
        app.setImageResult(src.key, { state: 'error', error: render.error })
      } else {
        if (render.payload) term._imagePayloads.set(src.key, render.payload)
        app.setImageResult(src.key, {
          state: 'done',
          protocol: render.protocol,
          cellsW: render.cellsW,
          cellsH: render.cellsH,
          segLines: render.segLines,
        })
      }
    } catch (error) {
      if (sig === app.imageRenderSignature()) app.setImageResult(src.key, { state: 'error', error: formatError(error) })
    } finally {
      if (imageRendersInFlight.get(src.key) === sig) imageRendersInFlight.delete(src.key)
      paintSoon()
    }
  }
  async function resolveImageBytes(src) {
    if (src.kind === 'bytes') {
      if (src.bytes) return src.bytes
      throw new Error('image bytes unavailable')
    }
    if (src.kind === 'ref') {
      const attachments = ctx.get('attachments')
      if (typeof attachments?.readImage === 'function') {
        const stored = await attachments.readImage(src.ref)
        const data = stored?.data ?? stored?.bytes
        if (data) return Buffer.from(data)
      }
      const hostPath = typeof attachments?.imageHostPath === 'function' ? attachments.imageHostPath(src.ref) : undefined
      if (hostPath) return readFile(hostPath)
      throw new Error('attachment store unavailable')
    }
    if (src.kind === 'url') {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error('fetch failed: ' + res.status)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 20 * 1024 * 1024) throw new Error('image larger than 20MB')
      return buf
    }
    throw new Error('unknown image source')
  }
  // Terminal capability probing runs in parallel with the first frame (the
  // probes are escape sequences the client terminal answers, so they work
  // unchanged over SSH). When they land, the render protocol upgrades and the
  // screen repaints; until then images render as ANSI halfblocks.
  let probedProtocol = 'halfblock'
  function graphicsSettings() {
    const read = (field, fallback) => readTuiSetting(ctx, config, 'tui-graphics', field) ?? fallback
    return {
      graphics: read('graphics', 'auto'),
      imageFallback: read('imageFallback', 'halfblock'),
      imageMaxRows: read('imageMaxRows', '20'),
      mermaid: read('mermaid', 'auto'),
    }
  }
  function applyGraphicsSettings() {
    const g = graphicsSettings()
    const off = g.graphics === 'off'
    app.graphicsProtocol = off ? 'halfblock' : probedProtocol
    // Chip fallback: on a no-protocol terminal the user can keep text chips
    // instead of halfblock pixels; `graphics: off` suppresses pixels on any
    // terminal.
    app.imagePixels = off ? g.imageFallback === 'halfblock' : (probedProtocol !== 'halfblock' || g.imageFallback !== 'chip')
    const rows = Number(g.imageMaxRows ?? '20')
    app.imageMaxRows = Number.isFinite(rows) ? Math.min(40, Math.max(4, rows)) : 20
    // `off` turns a diagram back into its source: no native art, no provider
    // chain, nothing leaves the machine.
    app.mermaidMode = g.mermaid ?? 'auto'
  }
  applyGraphicsSettings()
  probeCapabilities(term).then((caps) => {
    // Hand the probe result to the terminal itself: paint() gates every
    // graphics-protocol emission on term.caps, so without this the App would
    // reserve image rows the terminal never paints (blank bubbles).
    term.caps = caps
    probedProtocol = caps.kitty ? 'kitty' : caps.iterm2 ? 'iterm2' : caps.sixel ? 'sixel' : 'halfblock'
    app.imageCellW = caps.cellW
    app.imageCellH = caps.cellH
    applyGraphicsSettings()
    paintSoon()
  }).catch(() => { /* probing is best-effort; halfblock stays */ })
  // Mermaid diagrams the engine cannot draw natively fall back to the provider
  // chain (local mmdc, then the mermaid.ink network service per the mermaid
  // setting) into the same image pipeline; a chain failure keeps the
  // highlighted source.
  const renderMermaid = createMermaidRenderer({ mode: () => graphicsSettings().mermaid ?? 'auto' })
  app.onMermaidRequest = (code, key) => { void resolveMermaid(code, key) }
  async function resolveMermaid(code, key) {
    try {
      const opts = app.imageRenderOptions()
      const rendered = await renderMermaid(code, { pxWidth: Math.min(1600, opts.maxCellsW * opts.cellW) })
      if (!rendered) {
        app.setMermaidResult(key, { state: 'fallback' })
      } else {
        const imageKey = key.replace('mermaid:', 'mermaid-img:')
        let render
        let imageSig
        do {
          imageSig = app.imageRenderSignature()
          render = await renderImage({ bytes: rendered.bytes }, app.imageRenderOptions())
        } while (imageSig !== app.imageRenderSignature())
        if (render.protocol === 'error') {
          app.setMermaidResult(key, { state: 'fallback' })
        } else {
          if (render.payload) term._imagePayloads.set(imageKey, render.payload)
          app.setImageResult(imageKey, {
            state: 'done',
            protocol: render.protocol,
            cellsW: render.cellsW,
            cellsH: render.cellsH,
            segLines: render.segLines,
          })
          app.setMermaidResult(key, { state: 'done', imageKey, bytes: rendered.bytes })
        }
      }
    } catch {
      app.setMermaidResult(key, { state: 'fallback' })
    }
    paintSoon()
  }

  // ---- MCP -----------------------------------------------------------------
  // MCP servers are mounted per session: each configured server becomes one
  // `@deepseek-ai/dsh-mcp-client` plugin instance on the live agent's scope,
  // which registers its tools as `mcp__<name>__<tool>` on that agent. Nothing
  // here is required for the TUI to run — the host client, the scope key and
  // the tool registry are all optional, and every one of them failing leaves a
  // row on the MCP settings page instead of a broken session.
  //
  // The server list lives in `mcp.json` files (user scope + any ancestor
  // project scope), not in DSH settings: the host's 0.2.0 settings service only
  // writes fields of a composed plugin entry, and per-directory scope needs
  // files anyway. `lib/mcp.js` owns that format.
  let mcpProbe = null
  const mcpManager = new McpManager({
    probe: (agentCtx, serverName) => (mcpProbe ? mcpProbe(agentCtx, serverName) : null),
    // A server the TUI mounts reports its own state: the notice is the same
    // one a host-mounted server produces, and it is shown once per state.
    onState: (name, status) => { startup.mcpNotifier?.report(name, status) },
  })
  createToolProbe().then((probe) => { mcpProbe = probe }).catch(() => { mcpProbe = null })

  // Read the files for one working directory and hand the result to the
  // manager. A read failure is an empty list, never an exception into the
  // session; the page reports the unreadable file on its own row.
  async function loadMcpConfigured(cwd) {
    try {
      const collected = await collectServers(cwd)
      mcpManager.setConfigured(collected.servers)
      return collected
    } catch (error) {
      mcpManager.setConfigured([])
      return { servers: [], files: [], error }
    }
  }

  // The bundled mcp-import skill teaches a model to add servers by writing
  // exactly these files. Best effort: a host without the skill service still
  // gets the settings page, and the model simply does not see the skill.
  try {
    const registered = registerMcpSkill(ctx)
    if (!registered.ok) ctx.logger?.debug?.('dsh-oc-tui: mcp-import skill not registered: ' + registered.reason)
  } catch (error) {
    try { ctx.logger?.warn?.('dsh-oc-tui: mcp-import skill registration failed: ' + formatError(error)) } catch { /* logging is optional */ }
  }

  // Live session state.
  let handle = null
  let currentAgent = null
  let openingSession = null
  let openingVersion = 0
  let lifecycleVersion = 0
  // User blocks the composer drew optimistically, oldest first: the text with
  // `[Image N]` markers stripped, when it was submitted, and whether the block
  // already shows images. The durable `user/message` that echoes a submit has
  // to be matched against one of these — a steered turn is echoed too, only
  // later (the loop claims it from the inbox at the next step boundary, which
  // can be tens of seconds into a running turn), so a single "last submit"
  // slot lost the match and drew the same prompt twice, the second copy badged
  // as steering. The same list is what keeps two prompts queued back to back
  // from producing a second block each.
  let pendingUserEchoes = []
  // A prompt submitted while the agent was idle is echoed within milliseconds,
  // so a stale entry from a submit the loop never took can only be matched
  // inside a short window. A steered prompt is echoed much later — when the
  // loop claims it from the inbox, at the next step boundary of a turn that may
  // still be running for a while — so that path gets a longer one.
  const ECHO_FRESH_MS = 10 * 1000
  const ECHO_STEER_MS = 2 * 60 * 1000
  let lastEscAt = 0
  // Optimistic submits carry `[Image N]` markers that the durable event drops
  // (replaced by image blocks); both sides compare marker-stripped.
  const stripImageMarkers = (s) => String(s ?? '').replace(/\[Image \d+\]/g, '').trim()
  function rememberUserEcho(text, hadImages) {
    const now = Date.now()
    pendingUserEchoes = pendingUserEchoes.filter((entry) => now - entry.time < ECHO_STEER_MS)
    pendingUserEchoes.push({ text, time: now, hadImages })
    if (pendingUserEchoes.length > 32) pendingUserEchoes.shift()
  }
  // The optimistic submit a durable `user/message` echoes, or null. The newest
  // match wins: identical prompts queued in a row echo in submit order, so
  // consuming from the end keeps one block per submit.
  function takeUserEcho(text, maxAge = ECHO_FRESH_MS) {
    const now = Date.now()
    for (let i = pendingUserEchoes.length - 1; i >= 0; i--) {
      const entry = pendingUserEchoes[i]
      if (now - entry.time >= maxAge) continue
      if (entry.text !== text) continue
      pendingUserEchoes.splice(i, 1)
      return entry
    }
    return null
  }
  const metrics = new SessionMetrics()
  const interrupt = new InterruptState()
  let showReasoning = config.showReasoning !== false
  const modelPreference = {
    model: startup.model ?? config.defaultModel ?? undefined,
    provider: startup.provider ?? config.defaultProvider ?? undefined,
  }
  // Effective default model/provider. The persisted `agent-default-model`
  // settings (what the Settings panel shows and saves) win over the harness
  // composition entry, which `agentDefaultModel.currentSelection()` may still
  // report before the settings scope has been attached. TUI reads the settings
  // service live so the title bar and new sessions agree with the Settings UI.
  function defaultModelSelection() {
    const settings = ctx.get('settings')
    if (settings) {
      try {
        const descriptor = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === 'agent-default-model')
        const value = descriptor?.value
        if (value && typeof value === 'object') {
          return { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort }
        }
      } catch { /* settings unavailable; fall back to composition selection */ }
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    return selection ?? {}
  }

  function resolveAgentOptions(base = {}) {
    const defaultSelection = defaultModelSelection()
    const provider = modelPreference.provider ?? base.provider ?? defaultSelection?.provider
    const model = modelPreference.model ?? base.model ?? defaultSelection?.model
    return {
      ...base,
      ...provider ? { provider } : {},
      ...model ? { model } : {},
    }
  }

  // The route an open agent will actually use. A 0.2.2 host keeps a durable
  // `model/selection` that outranks the options the session was created with —
  // a resumed session carries whatever it recorded last time — so the header
  // reads that first and falls back to the creation options. Older hosts have no
  // selection object and answer from the options, which is all they have.
  function agentRoute(agent) {
    let recorded = {}
    try { recorded = agent?.model?.current?.() ?? {} } catch { recorded = {} }
    return {
      model: recorded.model ?? agent?.options?.model ?? '',
      provider: recorded.provider ?? agent?.options?.provider ?? '',
    }
  }

  // Draw a route change without writing it anywhere. The durable side belongs to
  // `selectModel` / `recordSelection`; a `model/selection` event another surface
  // recorded arrives here too, and re-recording it would append the same choice
  // back to the log.
  function showModelSelection(selection) {
    const from = { model: app.model, provider: app.provider }
    app.setSession(selection)
    if (currentAgent) {
      app.addModelChange(from, { model: app.model, provider: app.provider }, { defer: true })
    }
  }

  function selectModel(selection) {
    showModelSelection(selection)
    recordRoute()
  }

  // Record the TUI's route choice on the agent. A no-op on hosts without an
  // agent-owned selection (0.2.1 and older), where `agent/request` does it.
  function recordRoute({ withEffort = false, effort } = {}) {
    return recordSelection(currentAgent, modelPreference, { provider: app.provider, model: app.model }, { withEffort, effort })
  }

  // The effective reasoning effort for the current model's requests: the
  // slider/settings selection, recorded on the agent (or, on a host without an
  // agent-owned selection, applied through agent/request). `undefined` keeps the
  // provider's own default behavior.
  let effortPreference = undefined
  let effortLoadVersion = 0

  const paint = () => term.paint(app.render())
  // High-frequency paints (streaming chunks, mouse motion) are coalesced so a
  // busy AI turn never starves the event loop — the wheel and keyboard stay
  // responsive while tokens stream in. Interactive actions paint immediately.
  let paintTimer = null
  const paintSoon = () => {
    if (paintTimer) return
    paintTimer = setTimeout(() => {
      paintTimer = null
      if (term.started) paint()
    }, 40)
  }
  const paintNow = () => {
    if (paintTimer) {
      clearTimeout(paintTimer)
      paintTimer = null
    }
    paint()
  }
  // An MCP server's connection result is a short notice in the corner, never
  // text on the frame: a server whose program is not running must not break
  // the TUI. The notice is shown once per state — a reconnect that succeeds
  // is a new state and is shown again.
  startup.mcpNotifier?.subscribe((name, status) => {
    app.showMcpNotice(name, status)
    paintSoon()
  })
  startup.mcpMonitor?.attach((event) => { startup.mcpNotifier?.report(event.name, event.status) })
  // Coalesced, not immediate: dragging a window edge fires one resize per
  // pixel column, and each immediate paint rebuilds the whole screen — and,
  // since the image renders key on the grid, can queue a re-render per column.
  // 40ms is below what a resize is perceived at.
  term.on('resize', () => paintSoon())
  // The language is a live setting. A host that writes it through its own
  // settings surface — or a profile patch edited by hand while the TUI runs —
  // pushes the new value into the volatile Config reference instead of
  // remounting this plugin, so the running interface has to re-read it and
  // repaint itself from the new catalog. A committed row takes the direct path
  // in commitSetting below; this covers every other writer.
  //
  // While a locale commit of our own is in flight the host announces the same
  // change mid-write. Rebuilding from that announcement would race the refresh
  // commitSetting is about to do, and would rebuild it with the index of the
  // option list that is still open rather than the row it was opened from — the
  // highlight would land a few rows down. commitSetting already repaints the
  // page in the new language, so the announcement has nothing to add here.
  let localeCommitInFlight = false
  let themeCommitInFlight = false
  ctx.on('loader/volatile-update', () => {
    if (localeCommitInFlight || themeCommitInFlight) return
    const before = getLocale()
    applyLocalePreference(ctx, config)
    const themeChanged = app.setTheme(readTuiSetting(ctx, config, 'tui-theme', 'preference'))
    const detailsChanged = app.setContextDetails(readTuiSetting(ctx, config, 'tui-dev', 'contextDetails'))
    if (getLocale() === before && !themeChanged && !detailsChanged) return
    if (app.overlay === 'settings') void refreshSettings(app.settingsSelection)
    paint()
  })
  // The mermaid engine loads on the first ```mermaid fence and arrives after
  // the paint that showed its placeholder; a late art asks for a repaint here.
  app._needsRepaint = paintSoon
  paint()

  // ---- session stats (web stats strip / token usage port) -----------------
  // Whole-session figures for the stats strip and its details window: turn and
  // step counts, model/tool/first-token wall times, decode throughput, the
  // durable billing buckets, and the context occupancy plus its heuristic
  // composition.
  //
  // The projection registry is preferred for every figure it serves —
  // `sessionStats` (a web-app-layer row), `tokenUsage`, `contextPressure`, and
  // `contextBreakdown` — and the plugin's own whole-log fold backs whatever the
  // profile does not mount, so a composition without those rows still shows the
  // same window from the events this process already consumed. The meter and
  // the billing buckets stay hidden when nothing reports them.
  function refreshSessionStats() {
    const projections = ctx.get('sessionProjections')
    let values = null
    if (currentAgent && projections) {
      try {
        values = projections.snapshot(currentAgent.session).values
      } catch {
        // A projection read that fails must not take the strip down with it;
        // the local fold below still describes the session.
        values = null
      }
    }
    app.setStats({
      stats: mergeSessionStats(metrics.snapshot(), values),
      pressure: values?.contextPressure,
      breakdown: values?.contextBreakdown,
    })
    // The status rail's GOAL section reads the `goal` projection the harness's
    // dsh-goal row registers; a profile without it simply leaves null here.
    app.setGoal(values?.goal ?? null)
  }
  {
    const projections = ctx.get('sessionProjections')
    if (projections) {
      projections.onChanged((session, key) => {
        if (!currentAgent || session.id !== currentAgent.session.id) return
        if (key !== 'sessionStats' && key !== 'tokenUsage'
          && key !== 'contextPressure' && key !== 'contextBreakdown'
          && key !== 'goal') return
        refreshSessionStats()
        paintSoon()
      })
    }
  }

  // ---- status rail: subagent activity --------------------------------------
  // The rail's SUBAGENTS section lists the delegation tree rooted at the open
  // session (`ctx.subagents.listDescendants`). The service is optional — a
  // composition without dsh-subagent leaves the section empty. Lifecycle edges
  // are published scoped to the delegating parent, so the listeners register
  // globally and just trigger a re-list rooted at the current session.
  let subagentListVersion = 0
  async function refreshSubagents() {
    const version = ++subagentListVersion
    const agent = currentAgent
    const subagents = agent ? ctx.get('subagents') : null
    let rows = []
    if (agent && subagents && typeof subagents.listDescendants === 'function') {
      try {
        const listed = await subagents.listDescendants(String(agent.session.id))
        // The list resolves after an async gap; a session switch in between
        // must not describe the old session in the new one's rail.
        if (version !== subagentListVersion || !currentAgent
          || String(currentAgent.session.id) !== String(agent.session.id)) return
        rows = Array.isArray(listed) ? listed : []
      } catch {
        // Listing is best-effort; an unavailable store shows an empty section
        // rather than taking the frame down.
        rows = []
      }
    }
    if (version !== subagentListVersion) return
    app.setSubagents(rows)
    paintSoon()
  }
  ctx.on('subagent/start', () => { void refreshSubagents() }, { global: true })
  ctx.on('subagent/end', () => { void refreshSubagents() }, { global: true })

  // Drive the activity animations (flowing spinners for thinking / running
  // tools like read/write). Paints are cheap (bounded render), and the loop
  // only repaints while something is actually animating.
  const animationTimer = setInterval(() => {
    if (term.started && app.hasAnimation()) paint()
  }, 80)
  // While the MCP page is open, re-read the config files and the live
  // connections: a mount that has not settled yet shows its outcome, a server
  // whose tool list changed after connecting is corrected, and a server the
  // model imported through the bundled skill (which writes the same files)
  // appears and connects without restarting the session.
  const mcpPollTimer = setInterval(() => {
    // Re-rendering means openSettings, which puts the overlay back up: the
    // poll has to stop the moment the dialog is dismissed, or Esc never sticks.
    if (app.overlay !== 'settings') return
    if (settingsView.kind !== 'mcp' && settingsView.kind !== 'mcp-form') return
    if (app.settingsEditing !== null || app.settingsConfirm) return
    // Re-probing every tool schema in the agent scope is the expensive half of
    // a refresh and a connected server rarely changes its tools, so it runs on
    // a slow beat rather than on every tick. A mount still in flight needs no
    // help either: it records its own tools when it settles.
    mcpRefreshTicks = (mcpRefreshTicks + 1) % MCP_REFRESH_TICKS
    if (mcpRefreshTicks === 0) mcpManager.refresh()
    if (settingsView.kind === 'mcp') void pollMcpList()
    else renderMcpForm(mcpFormDraft, mcpFormIsEdit, app.settingsSelection)
  }, 500)

  // ---- session lifecycle -------------------------------------------------

  function newSessionId() {
    return 'tui-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  }

  async function showTitleScreen() {
    const version = ++lifecycleVersion
    if (handle) {
      const old = handle
      handle = null
      currentAgent = null
      void mcpManager.detachAgent()
      try { await old.dispose() } catch { /* already settling */ }
    }
    if (version !== lifecycleVersion) return
    const workingDirectory = process.cwd()
    app.closeRewind()
    app.overlay = null
    app.statsOpen = false
    app.inputText = ''
    app.inputCursor = 0
    app.inputImages = []
    app.resetView()
    // Show the effective default model/provider on the title page (the same
    // resolution used when a session is opened) instead of a bare placeholder.
    const defaultSelection = defaultModelSelection()
    app.setWelcome({
      workingDirectory,
      model: modelPreference.model ?? defaultSelection?.model ?? '',
      provider: modelPreference.provider ?? defaultSelection?.provider ?? '',
    })
    app.setStatus('idle')
    metrics.reset()
    refreshSessionStats()
    paint()
    let gitBranch = ''
    try { gitBranch = await gitBranchAt(workingDirectory) } catch (error) {
      app.showToast('git: ' + formatError(error), 'warn')
    }
    if (version === lifecycleVersion && !currentAgent) {
      // Re-resolve the default model/provider after the async gap: the settings
      // scope may not have been attached when the title screen first painted.
      const defaultSelection = defaultModelSelection()
      app.setWelcome({
        workingDirectory,
        gitBranch,
        model: modelPreference.model ?? defaultSelection?.model ?? '',
        provider: modelPreference.provider ?? defaultSelection?.provider ?? '',
      })
      paint()
    }
  }

  // `ctx.agents` rejects create/resume until an agent factory is registered
  // (`ctx.agents.setFactory`, done by the dsh-agent-loop row). `--resume` opens
  // the session during apply, which can run before that row has registered, so
  // retry that one condition briefly instead of failing the launch. Any other
  // error is reported immediately.
  async function openWithFactoryRetry(open) {
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        return await open()
      } catch (error) {
        const retryable = /no agent factory registered/i.test(String(error?.message ?? error))
        if (!retryable || Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }

  async function openSession({ resume = null, announce = true } = {}) {
    const version = ++lifecycleVersion
    app.closeRewind()
    app.overlay = null
    app.statsOpen = false
    // Tear down the previous agent to quiescence.
    if (handle) {
      const old = handle
      handle = null
      currentAgent = null
      void mcpManager.detachAgent()
      try { await old.dispose() } catch { /* already settling */ }
    }
    if (version !== lifecycleVersion) return false
    pendingUserEchoes = []
    app.inputText = ''
    app.inputCursor = 0
    app.inputImages = []
    app.sidebarSelection = -1
    app.resetView()
    app.setSession({ title: '' })
    // Resolve the model selection: explicit preference (flag/config//model)
    // wins, then the deployment's agent-default-model service (settings).
    const agentOptions = resolveAgentOptions()
    try {
      const openedHandle = resume
        ? await openWithFactoryRetry(() => ctx.agents.resume({
            resumeSessionId: SessionId(resume),
            agentOptions,
          }))
        : await ctx.agents.create({
            sessionId: SessionId(newSessionId()),
            meta: { cwd: process.cwd() },
            agentOptions,
          })
      if (version !== lifecycleVersion) {
        try { await openedHandle.dispose() } catch { /* already settling */ }
        return false
      }
      handle = openedHandle
      currentAgent = openedHandle.agent
      // The configured MCP servers connect to this agent's scope: a server that
      // fails to connect is recorded on its MCP page row, and the session keeps
      // running without it. The list is read first (it lives in files), then the
      // mount starts — attachAgent is not awaited, so a slow server cannot hold
      // up the first frame.
      const mcpCwd = currentAgent.session?.header?.cwd ?? process.cwd()
      void loadMcpConfigured(mcpCwd).then(() => mcpManager.attachAgent(currentAgent.ctx, mcpCwd))
      app.setSession({ id: String(currentAgent.session.id), ...agentRoute(currentAgent) })
      showWorkspace(currentAgent.session)
      void loadEffortSlider()
      replay(currentAgent.session)
      refreshSessionStats()
      void refreshSubagents()
      app.addSystem(t(resume ? 'session.resumed' : 'session.started', { id: currentAgent.session.id }) + ' · ' + process.cwd(), 'info')
      app.setStatus('idle')
      void refreshRecentSessions({ force: true })
      paint()
      return true
    } catch (error) {
      if (version !== lifecycleVersion) return false
      handle = null
      currentAgent = null
      app.addSystem(t('session.openFailed', { error: formatError(error) }), 'error')
      app.setStatus('idle')
      paint()
      return false
    }
  }

  // The header names the workspace the current session is rooted in: a resumed or
  // forked session carries its own header cwd, which need not be the process cwd.
  // The branch is resolved in the background so painting is never held up.
  function showWorkspace(session) {
    const cwd = session?.header?.cwd ?? process.cwd()
    const id = String(session?.id ?? '')
    app.setWorkspace({ workingDirectory: cwd, gitBranch: '' })
    void gitBranchAt(cwd)
      .then((branch) => {
        if (app.sessionId !== id) return
        app.setWorkspace({ gitBranch: branch ?? '' })
        paint()
      })
      .catch(() => undefined)
  }

  // A user/message the human never typed: labeled context (system-reminder /
  // compaction) becomes a collapsible note box; anything else stays a dim
  // system line.
  function addContextMessage(src, text) {
    if (src?.kind === 'model-selection') return
    const note = noteFromContext(src, text)
    if (note) app.addNote(note.text, note.label)
    else app.addSystem('[' + (src?.kind ?? 'context') + '] ' + text, 'dim')
  }

  // DSH 0.1.2 replaced the `Session.events` getter with `snapshotEvents()`
  // (plus `ownEvents()`/`eventAt()`); read whichever the host provides so one
  // build serves both versions. `snapshotEvents()` with no arguments is
  // semantically identical to the old getter — same frozen full-log snapshot.
  function sessionEvents(session) {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
    return session.events ?? []
  }

  // Build the transcript from a session's durable log (resume/replay path).
  function replay(session) {
    metrics.reset()
    let lastRoute
    const observeRoute = (route, { beforeLatestUser = true } = {}) => {
      if (typeof route?.model !== 'string' || !route.model) return
      const next = {
        model: route.model,
        provider: typeof route.provider === 'string' ? route.provider : (lastRoute?.model === route.model ? lastRoute.provider : ''),
      }
      if (lastRoute && (lastRoute.model !== next.model
        || (lastRoute.provider && next.provider && lastRoute.provider !== next.provider))) {
        app.addModelChange(lastRoute, next, { beforeLatestUser })
      }
      lastRoute = next
    }
    for (const event of sessionEvents(session)) {
      metrics.consume(event)
      switch (event.type) {
        case 'request/header':
          app.setRequestModel(event.data.header?.config?.model)
          observeRoute(event.data.header?.config)
          break
        case 'request/context':
          app.setRequestModel(event.data.model)
          observeRoute(event.data)
          break
        case 'model/selection':
          observeRoute(event.data, { beforeLatestUser: false })
          break
        case 'user/message': {
          const src = event.data.source
          const text = contentText(event.data.content)
          // A log-replayed steering message was already claimed from the inbox
          // by a preceding splice, so it is labeled rather than treated as a
          // fresh turn.
          const steering = app.consumeClaimed(event.data.id)
          if (src?.kind === 'user') app.addUser(text, { steering, images: contentImages(event.data.content), time: event.time })
          else addContextMessage(src, text)
          break
        }
        case 'compact/summary':
        case 'compaction/summary': {
          const text = contentText(event.data.summary)
          if (text) app.addNote(text, 'compaction')
          break
        }
        case 'assistant/message': {
          const msg = event.data.message
          // Reasoning lives in its own box; never mix it into the visible text.
          const text = contentText(msg.content, { skipReasoning: true })
          const reasoning = msg.content
            .filter((b) => b.type === 'reasoning')
            .map((b) => b.text)
            .join('')
          const asst = app.ensureAssistantBlock(event.time)
          asst.text = text
          if (reasoning) asst.reasoning = showReasoning ? reasoning : ''
          // Otherwise keep whatever reasoning streamed into this block already.
          asst.streaming = false
          asst.time = event.time
          asst.rev = (asst.rev ?? 0) + 1
          if (asst.reasoning && asst.thinkingCollapsed === undefined) asst.thinkingCollapsed = true
          const asstImages = contentImages(msg.content)
          if (asstImages.length > 0) asst.images = asstImages
          for (const block of msg.content) {
            if (block.type === 'tool-call') {
              app.startTool({ callId: block.id, name: block.name, args: block.arguments })
            }
          }
          break
        }
        case 'tool/result': {
          const msg = event.data.message
          const text = contentText(msg.content)
          const isError = event.data.error !== undefined
            || msg.content[0]?.isError === true
          app.updateTool(msg.source.callId, {
            status: isError ? 'error' : 'ok',
            result: text,
            ...(contentImages(msg.content).length > 0 ? { images: contentImages(msg.content) } : {}),
          })
          break
        }
        case 'todo/write': {
          app.setTodo(event.data.todos)
          break
        }
        case 'agent/inbox/spliced': {
          // Rebuild the pending lists from the log; the block is parked at the
          // end of the replay so a tail that is still unclaimed stays visible.
          app.applyInboxSplice(event.data)
          break
        }
        case 'system/message': {
          addSystemMessage(event.data.message)
          break
        }
        default:
          break
      }
    }
    app.updateInboxBlock()
    app.setMetrics(metrics.snapshot())
    const titleEvent = [...sessionEvents(session)].reverse().find((e) => e.type === 'session/title')
    if (titleEvent) app.setSession({ title: titleEvent.data.title })
  }

  // The session's system prompt as an event (dsh 0.1.5 session format V3): the
  // first step carries an empty head, and a later request header whose prompt
  // differs inserts a replacement immediately before that header. An empty head
  // contributes nothing, so the text decides rather than the provenance.
  function addSystemMessage(message) {
    if (!message) return false
    return app.setSystemPrompt(contentText(message.content))
  }

  // ---- durable event stream ----------------------------------------------

  ctx.on('session/event', (session, event) => {
    // A title is the one thing about a listing that changes after the fact, and
    // it changes once — so it forces the re-read. An ordinary message is
    // throttled by the listing TTL: it adds no new row and moves no timestamp,
    // and re-reading every session directory per message was pure waste.
    if (event.type === 'session/title') {
      void Promise.resolve().then(() => refreshRecentSessions({ force: true }))
    } else if (event.type === 'user/message') {
      void Promise.resolve().then(() => refreshRecentSessions())
    }
    if (!currentAgent || session.id !== currentAgent.session.id) return
    metrics.consume(event)
    app.setMetrics(metrics.snapshot())
    handleSessionEvent(event)
    paintSoon()
  }, { global: true })

  ctx.on('session/created', () => {
    void Promise.resolve().then(() => refreshRecentSessions({ force: true }))
  }, { global: true })

  function handleSessionEvent(event) {
    switch (event.type) {
      case 'request/header':
        app.setRequestModel(event.data.header?.config?.model)
        break
      case 'request/context':
        app.setRequestModel(event.data.model)
        break
      case 'model/selection':
        if (typeof event.data.model === 'string' && event.data.model
          && typeof event.data.provider === 'string' && event.data.provider) {
          modelPreference.model = event.data.model
          modelPreference.provider = event.data.provider
          showModelSelection({ model: event.data.model, provider: event.data.provider })
          void loadEffortSlider()
        }
        break
      case 'user/message': {
        const src = event.data.source
        const text = contentText(event.data.content)
        const images = contentImages(event.data.content)
        // `user/message` is the only admission log the loop writes, so the
        // preceding inbox splice is what distinguishes a steered turn from a
        // fresh one. Consuming the classification also keeps the id from
        // leaking into a later message.
        const steering = app.consumeClaimed(event.data.id)
        if (src?.kind === 'user') {
          // The optimistic submit already drew this turn: the composer block is
          // the same prompt, so the event only contributes what the optimistic
          // path could not know — images the block is missing (a turn queued
          // from another surface), and the steering classification, which is
          // only decided here. Drawing a second block instead is what made a
          // steered prompt appear twice, side by side.
          const echo = takeUserEcho(stripImageMarkers(text), steering ? ECHO_STEER_MS : ECHO_FRESH_MS)
          if (echo) {
            if (images.length > 0 && !echo.hadImages) app.attachImagesToLastUser(images)
            if (steering) app.markLastUserSteering()
            return
          }
          app.addUser(text, { steering, images, time: event.time })
        } else {
          addContextMessage(src, text)
        }
        break
      }
      case 'compact/summary':
      case 'compaction/summary': {
        const text = contentText(event.data.summary)
        if (text) app.addNote(text, 'compaction')
        break
      }
      case 'agent/inbox/spliced': {
        // Admitted-but-unclaimed input: fold the splice and re-derive the
        // parked pending block, so queueing, steering, edits and removals all
        // show up the moment the loop commits them.
        app.applyInboxSplice(event.data)
        app.updateInboxBlock()
        break
      }
      case 'system/message': {
        addSystemMessage(event.data.message)
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') app.streamChunk(chunk)
        else if (chunk.type === 'reasoning-delta' && showReasoning) {
          app.streamChunk(chunk)
        }
        break
      }
      case 'assistant/message': {
        const msg = event.data.message
        // Reasoning lives in its own box; never mix it into the visible text.
        const text = contentText(msg.content, { skipReasoning: true })
        const reasoning = msg.content
          .filter((b) => b.type === 'reasoning')
          .map((b) => b.text)
          .join('')
        const asst = app.ensureAssistantBlock(event.time)
        asst.text = text
        if (reasoning) asst.reasoning = showReasoning ? reasoning : ''
        // Otherwise keep whatever reasoning streamed into this block already.
        asst.streaming = false
        asst.time = event.time
        asst.rev = (asst.rev ?? 0) + 1
        if (asst.reasoning && asst.thinkingCollapsed === undefined) asst.thinkingCollapsed = true
        const asstImages = contentImages(msg.content)
        if (asstImages.length > 0) asst.images = asstImages
        for (const block of msg.content) {
          if (block.type === 'tool-call') {
            app.startTool({ callId: block.id, name: block.name, args: block.arguments })
          }
        }
        break
      }
      case 'tool/call': {
        const d = event.data
        const existing = app.updateTool(d.callId, { name: d.name, args: d.arguments })
        if (!existing) app.startTool({ callId: d.callId, name: d.name, args: d.arguments })
        break
      }
      case 'tool/result': {
        const msg = event.data.message
        const text = contentText(msg.content)
        const isError = event.data.error !== undefined || msg.content[0]?.isError === true
        app.updateTool(msg.source.callId, {
          status: isError ? 'error' : 'ok',
          result: text,
          ...(contentImages(msg.content).length > 0 ? { images: contentImages(msg.content) } : {}),
        })
        break
      }
      case 'todo/write': {
        app.setTodo(event.data.todos)
        break
      }
      case 'session/title': {
        app.setSession({ title: event.data.title })
        break
      }
      case 'turn/end': {
        app.setStatus('idle')
        break
      }
      default:
        break
    }
  }

  // ---- agent lifecycle / sidebar -----------------------------------------

  ctx.on('agent/status', ({ agent, status }) => {
    if (!currentAgent || agent.id !== currentAgent.id) return
    app.setStatus(status)
    paint()
  })
  ctx.on('agent/error', ({ agent, error }) => {
    if (!currentAgent || agent.id !== currentAgent.id) return
    app.addSystem(t('session.error', { error: formatError(error) }), 'error')
    app.setStatus('idle')
    paint()
  })

  // One listing of the persisted sessions, shared by the sidebar and
  // Settings -> Manage sessions.
  //
  // `listSessions()` stats every session directory and `readTitleSnapshots()`
  // reads one file per session, so a listing is the slowest thing this dialog
  // does. It used to run on every entry — and once more after every delete —
  // which is what made the page feel like it reloaded twice for nothing.
  // Callers now draw the rows already in hand and revalidate behind them; the
  // TTL keeps a re-open within it from touching the disk at all, and an
  // in-flight listing is shared rather than started twice.
  const SESSIONS_TTL_MS = 15000
  let sessionsLoadedAt = 0
  let sessionsListing = null
  function sessionRowsSignature(rows) {
    return Array.isArray(rows) ? rows.map((row) => row.id + '\u0000' + row.label + '\u0000' + row.time).join('\u0001') : ''
  }
  async function refreshRecentSessions({ force = false } = {}) {
    const sq = ctx.get('sessionQuery')
    if (!sq) return
    if (!force && sessionsLoadedAt > 0 && Date.now() - sessionsLoadedAt < SESSIONS_TTL_MS) return
    if (sessionsListing) return sessionsListing
    sessionsListing = (async () => {
      try {
        const records = await sq.listSessions()
        const top = records.filter((r) => r.header.origin !== 'subagent').slice(0, 25)
        const results = await sq.readTitleSnapshots(top.map((r) => r.header.id))
        const rows = top.map((r, i) => {
          const res = results[i]
          const title = res?.status === 'fulfilled' && res.value.title
            ? res.value.title.title
            : String(r.header.id)
          return { id: String(r.header.id), label: title, time: r.header.createdAt }
        })
        rows.sort((a, b) => b.time - a.time)
        app.sidebarSessions = rows
        sessionsLoadedAt = Date.now()
        paint()
      } catch {
        // Session listing is best-effort; leave the sidebar as-is.
      } finally {
        sessionsListing = null
      }
    })()
    return sessionsListing
  }

  // Undo the file writes the log records after `cut`. Refuses (and reports) any
  // workspace that is not a git worktree instead of deleting files it cannot
  // prove the turn created.
  async function restoreFilesAfter(agent, cut) {
    const cwd = agent.session.header.cwd ?? process.cwd()
    const events = sessionEvents(agent.session)
    const paths = mutationPathsAfter(events, cut)
    if (paths.length === 0) {
      return { cwd, result: { ok: true, restored: [], removed: [], skipped: [], backupRoot: null } }
    }
    const backupRoot = await canRestoreFiles(cwd) ? backupRootFor(dshHome(), agent.session.id) : null
    const createdPaths = createdPathsAfter(events, cut)
    return { cwd, result: await restoreGitPaths(cwd, paths, { backupRoot, createdPaths }) }
  }

  // Pending inbox input a fork inherited from its seed; see the call site in
  // `forkAndSwitch`. Both are tolerant of hosts without the inbox service.
  function pendingInputCount(agent) {
    const inbox = agent?.inbox
    if (!inbox) return 0
    return (inbox.nextStep?.length ?? 0) + (inbox.nextTurn?.length ?? 0)
  }

  function clearPendingInput(agent) {
    try {
      agent?.inbox?.clear?.()
    } catch {
      // Nothing to clear on a host whose inbox service is absent.
    }
  }

  async function forkAndSwitch({ cut, restoreFiles, label }) {
    if (!currentAgent) throw new Error(t('session.startFirst'))
    if (app.status === 'running') throw new Error(t('session.interruptFirst'))
    const version = ++lifecycleVersion
    const parent = currentAgent
    const events = sessionEvents(parent.session)
    const cwd = parent.session.header.cwd ?? process.cwd()
    const parentId = parent.session.id
    let fileNote = t('session.conversationOnly')
    let fileLevel = 'info'
    if (restoreFiles) {
      const { result } = await restoreFilesAfter(parent, cut)
      fileNote = formatRestore(result)
      if (result.ok === false) fileLevel = 'warn'
    }
    const seed = events.slice(0, cut)
    // Fork lineage the way the harness's own `session/fork` builds it: the
    // inherited prefix is marked seeded and handed over with its exact length,
    // so the durable header, the inherited end-seed marker, and every host
    // consumer that reads `isSeeded` agree that this is a fork. `seedLength` is
    // the same boundary under its pre-0.1.5 name (hosts before the V3 rewrite
    // take fork lineage from `meta.seedLength` and ignore both fields above).
    const childHandle = await ctx.agents.create({
      sessionId: SessionId(newSessionId()),
      seed,
      inheritedEventCount: seed.length,
      meta: { cwd, parentSession: parentId, isSeeded: true, seedLength: seed.length },
      agentOptions: resolveAgentOptions(parent.options),
    })
    if (version !== lifecycleVersion) {
      await childHandle.dispose().catch(() => undefined)
      return
    }
    // The cut ends before a turn/start, which also cuts the inbox CLAIM that the
    // dropped turn performed: the seed keeps the `agent/inbox/spliced` insertion
    // that queued the prompt driving that turn, while the removal lives inside
    // the turn itself. The child rebuilds its inbox from those events, so it
    // would deliver the parent's already-consumed prompt again at its first turn
    // — as steering inside the turn the human just started. A fork therefore
    // begins with an empty inbox; anything genuinely still pending stays behind
    // in the parent session's log.
    const inheritedPending = pendingInputCount(childHandle.agent)
    if (inheritedPending > 0) clearPendingInput(childHandle.agent)
    const old = handle
    handle = childHandle
    currentAgent = childHandle.agent
    pendingUserEchoes = []
    app.resetView()
    app.setSession({ id: String(currentAgent.session.id), ...agentRoute(currentAgent) })
    replay(currentAgent.session)
    showWorkspace(currentAgent.session)
    refreshSessionStats()
    void refreshSubagents()
    void loadEffortSlider()
    app.addSystem(t('session.forkSummary', { label, parent: parentId, files: fileNote })
      + (inheritedPending > 0 ? t('session.forkDropped', { count: inheritedPending }) : ''), fileLevel)
    app.setStatus('idle')
    app.closeRewind()
    void refreshRecentSessions({ force: true })
    paint()
    if (old) void old.dispose().catch(() => undefined)
  }

  function openRewindOverlay() {
    if (!currentAgent) {
      app.showToast(t('session.startFirst'), 'warn')
      paint()
      return
    }
    if (app.status === 'running') {
      app.showToast(t('session.interruptFirstEsc'), 'warn')
      paint()
      return
    }
    const points = listRewindPoints(sessionEvents(currentAgent.session))
    const items = points.map((point) => ({
      n: point.n,
      seq: point.seq,
      time: point.time,
      label: point.n + '. ' + point.label,
    }))
    items.push({ n: items.length + 1, seq: null, label: t('rewind.current'), current: true })
    // Land on the most recent real point: the trailing "(current)" row is a
    // no-op, so defaulting to it would make Enter-Enter do nothing.
    app.openRewind({ items, restoreOptions: REWIND_RESTORE_OPTIONS, defaultIndex: Math.max(0, points.length - 1) })
    paint()
  }

  // ---- git branch switching (empty page only) ------------------------------
  // Checking out a branch rewrites the working tree that every session in
  // this process is rooted in, so the window is offered on the title screen
  // only. Inside a session both the shortcut and the command answer with a
  // pointer instead of opening it.

  function gitBranchWindowBlocked() {
    if (!currentAgent) return false
    app.showToast(t('git.onlyTitleScreen'), 'warn')
    paint()
    return true
  }

  async function openGitBranchOverlay() {
    if (gitBranchWindowBlocked()) return
    let info
    try {
      info = await listGitBranches(process.cwd())
    } catch (error) {
      app.showToast(t('git.listFailed', { error: formatError(error) }), 'warn')
      paint()
      return
    }
    app.openGitBranches({
      cwd: process.cwd(),
      root: info.root,
      current: info.current,
      local: info.local,
      remote: info.remote,
    })
    paint()
  }

  // Re-read the refs after anything that can change them (a switch, a pull),
  // so the current marker and the remote set never go stale in an open
  // window. A failure here is only worth reporting when the refresh is the
  // action the user asked for — after a successful switch the window keeps
  // its outcome line instead of being overwritten by a listing error.
  async function refreshGitBranchList({ reportError = true } = {}) {
    const picker = app.gitBranches
    if (!picker) return
    try {
      const info = await listGitBranches(picker.cwd)
      app.setGitBranchList(info)
    } catch (error) {
      if (reportError) throw new Error(t('git.listFailed', { error: formatError(error) }))
    }
  }

  // The title screen's `git: <branch>` line is resolved once at boot; a
  // switch has to re-resolve it or the splash keeps naming the old branch.
  async function refreshTitleGitBranch() {
    const cwd = process.cwd()
    let gitBranch = ''
    try { gitBranch = await gitBranchAt(cwd) } catch { /* the splash omits the line */ }
    app.setWelcome({ workingDirectory: cwd, gitBranch })
    paint()
  }

  // Every window action runs through here so the busy flag, the report reset
  // and the repaint happen exactly once, whatever the action does. The catch
  // is a safety net: the actions below already localize their own failures.
  async function withGitBranchBusy(action) {
    const picker = app.gitBranches
    if (!picker || picker.busy) return
    picker.busy = true
    picker.error = ''
    picker.status = ''
    paint()
    try {
      await action()
    } catch (error) {
      picker.error = formatError(error)
    }
    picker.busy = false
    paint()
  }

  async function confirmGitBranch() {
    const picker = app.gitBranches
    const row = picker?.items[picker.selected]
    if (!row || row.kind !== 'branch') return
    try {
      const result = await switchGitBranch(picker.cwd, row.ref, { remote: row.remote })
      await refreshGitBranchList({ reportError: false })
      picker.status = t('git.switched', { branch: result.branch })
      void refreshTitleGitBranch()
    } catch (error) {
      throw new Error(t('git.switchFailed', { branch: row.ref, error: formatError(error) }))
    }
  }

  async function pullGitBranches() {
    const picker = app.gitBranches
    try {
      const result = await pullGitUpdates(picker.cwd)
      await refreshGitBranchList()
      picker.status = result.summary || t('git.pullDone')
    } catch (error) {
      throw new Error(t('git.pullFailed', { error: formatError(error) }))
    }
  }

  function handleGitBranchKey(key) {
    const picker = app.gitBranches
    if (!picker) return
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      handleCtrlKey(key.name)
      return
    }
    if (picker.busy) return
    if (key.name === 'escape') {
      app.closeGitBranches()
      paint()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      void withGitBranchBusy(confirmGitBranch)
      return
    }
    const letter = String(key.name ?? key.text ?? '').toLowerCase()
    if (key.name === 'up' || letter === 'k' || (key.ctrl && letter === 'p')) {
      app.moveGitBranches(-1)
      paint()
      return
    }
    if (key.name === 'down' || letter === 'j' || (key.ctrl && letter === 'n')) {
      app.moveGitBranches(1)
      paint()
      return
    }
    if (key.name === 'pageup') {
      app.moveGitBranches(-7)
      paint()
      return
    }
    if (key.name === 'pagedown') {
      app.moveGitBranches(7)
      paint()
      return
    }
    if (letter === 'p') {
      void withGitBranchBusy(pullGitBranches)
      return
    }
    if (letter === 'r') {
      void withGitBranchBusy(() => refreshGitBranchList())
      return
    }
  }

  async function applyRewindChoice(item, mode) {
    if (!currentAgent) throw new Error(t('session.startFirst'))
    if (item?.current || item?.seq == null) {
      app.closeRewind()
      paint()
      return
    }
    const events = sessionEvents(currentAgent.session)
    if (mode === 'code') {
      const { result } = await restoreFilesAfter(currentAgent, rewindCut(events, item.seq))
      app.closeRewind()
      app.addSystem(t('session.files', { summary: formatRestore(result) }), result.ok === false ? 'warn' : 'info')
      paint()
      return
    }
    await forkAndSwitch({
      cut: rewindCut(events, item.seq),
      restoreFiles: mode !== 'conversation',
      label: t('session.rewindLabel', { n: item.n }),
    })
  }

  async function confirmRewindPicker() {
    const picker = app.rewind
    if (!picker || picker.busy) return
    if (picker.step === 'restore') {
      const option = picker.restoreOptions[picker.modeIndex]
      if (!option || option.id === 'cancel') {
        picker.step = 'list'
        picker.error = ''
        app._clampRewindScroll()
        paint()
        return
      }
      const item = picker.items[picker.selected]
      picker.busy = true
      paint()
      try {
        await applyRewindChoice(item, option.id)
      } catch (error) {
        picker.busy = false
        picker.error = formatError(error)
        paint()
      }
      return
    }
    const item = picker.items[picker.selected]
    if (!item || item.current) {
      app.closeRewind()
      paint()
      return
    }
    picker.step = 'restore'
    picker.modeIndex = 0
    picker.scroll = 0
    picker.error = ''
    paint()
  }

  function handleRewindKey(key) {
    const picker = app.rewind
    if (!picker || picker.busy) return
    if (key.name === 'escape') {
      if (picker.step === 'restore') {
        picker.step = 'list'
        picker.error = ''
        app._clampRewindScroll()
      } else {
        app.closeRewind()
      }
      paint()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      void confirmRewindPicker()
      return
    }
    const letter = String(key.name ?? key.text ?? '').toLowerCase()
    if (key.name === 'up' || letter === 'k' || (key.ctrl && letter === 'p')) {
      app.moveRewind(-1)
      paint()
      return
    }
    if (key.name === 'down' || letter === 'j' || (key.ctrl && letter === 'n')) {
      app.moveRewind(1)
      paint()
      return
    }
    if (key.name === 'pageup') {
      app.moveRewind(-7)
      paint()
      return
    }
    if (key.name === 'pagedown') {
      app.moveRewind(7)
      paint()
      return
    }
    if (key.name === 'home') {
      if (picker.step === 'restore') picker.modeIndex = 0
      else picker.selected = 0
      app._clampRewindScroll()
      paint()
      return
    }
    if (key.name === 'end') {
      if (picker.step === 'restore') picker.modeIndex = Math.max(0, picker.restoreOptions.length - 1)
      else picker.selected = Math.max(0, picker.items.length - 1)
      app._clampRewindScroll()
      paint()
    }
  }

  // ---- reasoning levels and route selection --------------------------------

  // Load the current model's real reasoning levels into the slider. Levels
  // come from the adapter (resolveModelInfo), so a boolean-thinking model
  // shows exactly its two ends, a full-range one shows every advertised level,
  // and a partial one shows only what the provider exposes — never a blanket
  // none..max mapping.
  async function loadEffortSlider() {
    const version = ++effortLoadVersion
    const clear = () => {
      if (version !== effortLoadVersion) return
      effortPreference = undefined
      app.setEffortSlider(null)
    }
    const llm = ctx.get('llm')
    const defaultSelection = defaultModelSelection()
    const provider = modelPreference.provider ?? defaultSelection?.provider ?? app.provider
    const model = modelPreference.model ?? defaultSelection?.model ?? app.model
    if (!provider || !model || !llm?.resolveModelInfo) {
      clear()
      return
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      if (version !== effortLoadVersion) return
      const reasoning = info.reasoning
      if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) {
        clear()
        return
      }
      const levels = reasoning.efforts.map((effort) => ({ id: String(effort.id), name: effort.name ?? String(effort.id) }))
      const configuredEffort = defaultSelection?.reasoningEffort === undefined ? undefined : String(defaultSelection.reasoningEffort)
      // A stored value can belong to the model selected before this one. Only
      // apply it when the current adapter explicitly advertises that id.
      const settingsEffort = levels.some((level) => level.id === configuredEffort) ? configuredEffort : undefined
      effortPreference = settingsEffort
      app.setEffortSlider({
        levels,
        current: settingsEffort ?? (reasoning.defaultEffort === undefined ? undefined : String(reasoning.defaultEffort)),
      })
      // The stored level is the session's starting effort, not a per-request
      // override on 0.2.2+: record it once so the first step already uses it.
      if (settingsEffort) recordRoute({ withEffort: true, effort: settingsEffort })
    } catch {
      clear()
    }
  }

  function toggleEffortSlider() {
    if (app.effortSliderVisible) {
      app.effortSliderVisible = false
      paint()
      return
    }
    void loadEffortSlider().then(() => {
      if (!app.effortSlider) {
        app.showToast(t('session.noReasoningLevels'), 'warn')
        paint()
        return
      }
      app.effortSliderVisible = true
      paint()
    })
  }

  function moveEffort(delta) {
    const slider = app.effortSlider
    if (!slider || slider.levels.length === 0) return
    const index = Math.max(0, slider.levels.findIndex((level) => level.id === slider.current))
    const next = slider.levels[Math.min(Math.max(0, index + delta), slider.levels.length - 1)]
    if (!next || next.id === slider.current) return
    slider.current = next.id
    effortPreference = next.id
    paint()
    void commitEffort(next.id)
  }

  // Tab on the session page cycles the thinking intensity through the
  // model's levels, wrapping from the strongest back to the weakest.
  // Returns false when there is nothing to cycle.
  function cycleEffort(direction) {
    const slider = app.effortSlider
    if (!slider || slider.levels.length <= 1) return false
    const index = Math.max(0, slider.levels.findIndex((level) => level.id === slider.current))
    const next = slider.levels[((index + direction) % slider.levels.length + slider.levels.length) % slider.levels.length]
    if (!next || next.id === slider.current) return false
    slider.current = next.id
    effortPreference = next.id
    paint()
    void commitEffort(next.id)
    return true
  }

  async function commitEffort(id) {
    const settings = ctx.get('settings')
    if (!settings) {
      app.showToast(t('session.settingsUnavailable'), 'warn')
      paint()
      return
    }
    try {
      await settings.update('agent-default-model', { reasoningEffort: id })
      // Recorded here rather than per request: 0.2.2 rejects an effort change
      // proposed by the `agent/request` waterfall.
      recordRoute({ withEffort: true, effort: id })
      app.showToast(t('model.reasoning') + ': ' + id, 'info')
    } catch (error) {
      app.showToast(t('settings.error', { error: formatError(error) }), 'error')
      await loadEffortSlider()
    }
    paint()
  }

  // Route and effort overrides for hosts that own no selection of their own.
  //
  // dsh 0.2.2 fixed a step's route before prompt assembly and now rejects a
  // listener that proposes another one — the loop throws and the turn dies — so
  // there every choice goes through `agent.model.select()` before the step is
  // prepared (see recordRoute). The waterfall stays for the older line, where it
  // is still the only way to state them.
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    if (!currentAgent || agent.id !== currentAgent.id) return config
    if (recordsSelections(agent)) return config
    const overrides = legacyRouteOverrides(config, modelPreference, resolveAgentOptions(), effortPreference)
    return overrides ? { ...config, ...overrides } : config
  })

  // ---- approval -----------------------------------------------------------

  ctx.on('approval/request', (req, next) => {
    if (!currentAgent || req.agent.id !== currentAgent.id) return next()
    if (autoApprovalEnabled(req)) return 'allowed-once'
    return askApproval(req)
  })

  // Keep this live: settings can be changed while the TUI is running.
  function autoApprovalEnabled(req) {
    const settings = ctx.get('settings')
    const descriptor = settings?.describe?.({ redactSecrets: true })?.find((entry) => String(entry.ns) === 'permission')
    const permission = descriptor?.value ?? settings?.get?.('permission')
    const preset = permission?.defaultPreset ?? permission?.preset
    const mode = permission?.approvalMode ?? permission?.autoApproval ?? permission?.approval
    const autoField = permission && Object.entries(permission).some(([key, value]) =>
      /auto|approval/i.test(key) && (value === true || value === 'auto' || value === 'always' || value === 'enabled'))
    return preset === 'danger-full-access'
      || preset === 'auto'
      || preset === 'always'
      || mode === 'auto'
      || mode === 'always'
      || mode === 'enabled'
      || mode === true
      || autoField
      || req?.autoApprove === true
      || req?.approvalMode === 'auto'
  }

  // Wait on the approval modal. Shared by the harness waterfall and the
  // @dsh-std Presentation handler so both go through one piece of modal logic.
  // Resolves with the TUI's own vocabulary: 'allowed-once' | 'rejected' | 'cancelled'.
  //
  // The state carries everything the modal must display. The protocol requires
  // the provider to clearly show action, summary, origin and the
  // policy-permitted details, so the standard path maps all four through. The
  // harness path (`askApproval`) has no origin, details or risk of its own —
  // they stay undefined rather than being invented, and the modal simply draws
  // the fields it has.
  //
  // `deadline` is the consumer's upper bound on the wait. A request that
  // outlives it settles with 'expired' — distinct from 'cancelled', so a
  // consumer can never read a timeout as a human decision.
  function awaitApproval({ toolName, summary, origin, details, risk, signal, deadline }) {
    return new Promise((resolve) => {
      const delay = deadlineDelay(deadline)
      // Already past: expire at once. The modal never appears and no timer is
      // armed — `setTimeout(fn, 0)` would flash the prompt for a tick first.
      if (delay === 0) {
        resolve('expired')
        return
      }
      let settled = false
      let timer = null
      const settle = (outcome) => {
        if (settled) return
        settled = true
        detach()
        resolve(outcome)
      }
      const onAbort = () => settle('cancelled')
      const onExpire = () => settle('expired')
      // Every settle path goes through detach, and detach is where the deadline
      // timer dies: a modal the user answered must not leave a live timer
      // behind that would fire into an already-settled promise.
      const detach = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal) signal.removeEventListener('abort', onAbort)
        if (app.pendingApproval?.id === state.id) app.pendingApproval = null
        paint()
      }
      const state = {
        id: Math.random().toString(36).slice(2, 8),
        toolName,
        summary,
        origin,
        details,
        risk,
        settle,
      }
      if (signal) {
        if (signal.aborted) {
          resolve('cancelled')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (delay !== null) timer = setTimeout(onExpire, delay)
      app.pendingApproval = state
      paint()
    })
  }

  // The harness's `reason` is the same human explanation the standard calls a
  // summary; origin, details and risk have no harness counterpart.
  function askApproval(req) {
    return awaitApproval({ toolName: req.toolName, summary: req.reason, signal: req.signal })
  }

  // ---- user questions -----------------------------------------------------
  // The `ask_user_question` tool (mounted by this plugin's cordis.patch.yml)
  // pauses a tool call on the `user-questions/request` waterfall until a UI
  // supplies a human answer. This is the TUI's answerer; lib/ui.js draws the
  // modal and stages the questions one at a time, like the WebUI composer.
  // Requests addressed to another agent are delegated, so a future
  // multi-session host keeps working.

  ctx.on('user-questions/request', (req, next) => {
    const agent = req.agent
    if (!currentAgent || (agent && agent.id !== currentAgent.id)) return next()
    return askQuestions(req, next)
  })

  function normalizeQuestion(question) {
    return {
      id: String(question?.id ?? ''),
      question: String(question?.question ?? ''),
      detail: question?.detail === undefined ? undefined : String(question.detail),
      header: question?.header === undefined ? undefined : String(question.header),
      options: Array.isArray(question?.options)
        ? question.options.filter((option) => option && typeof option.label === 'string')
        : [],
      multiSelect: question?.multiSelect === true,
      intent: question?.intent,
    }
  }

  // Same encoding the WebUI composer produces: a custom answer replaces the
  // selection for a single-select question and accompanies it for a
  // multi-select one.
  function buildQuestionsAnswer(questions, drafts) {
    return {
      answers: questions.map((question, index) => {
        const draft = drafts[index]
        const custom = String(draft.custom ?? '').trim()
        return {
          id: question.id,
          selected: custom === '' || question.multiSelect ? draft.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
  }

  // Wait on the question modal for an already-normalized question list.
  // `onDefer` is what Esc means to the caller: the harness waterfall delegates
  // to the next answerer, while the @dsh-std path has no waterfall and treats
  // it as a cancel.
  //
  // `deadline` (standard path only) bounds the wait: on expiry it resolves with
  // the EXPIRED sentinel rather than rejecting, so the caller can report
  // `expired` and keep it distinct from an abort.
  function waitForQuestions(questions, { signal, onDefer, deadline }) {
    return new Promise((resolve, reject) => {
      if (questions.length === 0) {
        resolve({ answers: [] })
        return
      }
      const delay = deadlineDelay(deadline)
      if (delay === 0) {
        resolve(EXPIRED)
        return
      }
      let settled = false
      let timer = null
      const state = {
        id: Math.random().toString(36).slice(2, 8),
        questions,
        index: 0,
        drafts: questions.map(() => ({ selected: [], custom: '', skipped: false })),
        cursor: 0,
        customMode: false,
        customCursor: 0,
        scroll: 0,
        error: null,
        // Answering: hand the structured answer back to the pending tool call.
        settle: (answer) => {
          if (settled) return
          settled = true
          detach()
          resolve(answer)
        },
        // Esc: decline to answer here. The caller decides what that means.
        defer: () => {
          if (settled) return
          settled = true
          detach()
          resolve(onDefer())
        },
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        detach()
        // Rejecting with a plain error lets the service report its own
        // ASK_ABORTED ("aborted before the user answered").
        reject(new Error('user-questions request aborted'))
      }
      const onExpire = () => {
        if (settled) return
        settled = true
        detach()
        resolve(EXPIRED)
      }
      const detach = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal) signal.removeEventListener('abort', onAbort)
        if (app.pendingQuestions?.id === state.id) app.pendingQuestions = null
        paint()
      }
      if (signal) {
        if (signal.aborted) {
          reject(new Error('user-questions request aborted'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (delay !== null) timer = setTimeout(onExpire, delay)
      app.pendingQuestions = state
      paint()
    })
  }

  // Wait on the standalone secret prompt. `secret-input` is the one
  // Presentation operation with no existing modal: the Settings pages mask a
  // credential inline, but there was no way to ask for a secret on its own.
  // `minLength` / `maxLength` come from the request and MUST be enforced here:
  // the protocol's validateSecretInputValue rejects a submitted secret outside
  // them, and a throw inside the factory's handle is a capability failure rather
  // than a clean re-prompt.
  //
  // `deadline` bounds the wait; expiry resolves with the EXPIRED sentinel, which
  // the caller reports as `expired` — never as a submitted (or cancelled) value.
  function waitForSecret({ label, description, minLength, maxLength, signal, deadline }) {
    return new Promise((resolve, reject) => {
      const delay = deadlineDelay(deadline)
      if (delay === 0) {
        resolve(EXPIRED)
        return
      }
      let settled = false
      let timer = null
      const state = {
        label: String(label),
        description: description === undefined ? undefined : String(description),
        minLength,
        maxLength,
        draft: '',
        cursor: 0,
        error: null,
        settle: (value) => {
          if (settled) return
          settled = true
          detach()
          resolve(value)
        },
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        detach()
        reject(new Error('secret-input request aborted'))
      }
      const onExpire = () => {
        if (settled) return
        settled = true
        detach()
        resolve(EXPIRED)
      }
      const detach = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal) signal.removeEventListener('abort', onAbort)
        if (app.pendingSecret === state) app.pendingSecret = null
        paint()
      }
      if (signal) {
        if (signal.aborted) {
          reject(new Error('secret-input request aborted'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (delay !== null) timer = setTimeout(onExpire, delay)
      app.pendingSecret = state
      paint()
    })
  }

  // `next` is threaded in as a PARAMETER, never referenced as a free variable.
  // It is bound only as the parameter of the ctx.on arrow above, so a body that
  // merely mentions it throws ReferenceError on every request — strictly worse
  // than the original, where the free `next` sat inside `defer` and was
  // evaluated lazily, so only Esc broke.
  function askQuestions(req, next) {
    const questions = (Array.isArray(req.questions) ? req.questions : []).map(normalizeQuestion)
    return waitForQuestions(questions, { signal: req.signal, onDefer: next })
  }

  function activeQuestion() {
    const questions = app.pendingQuestions
    return questions ? questions.questions[questions.index] : null
  }

  function activeDraft() {
    return app.pendingQuestions.drafts[app.pendingQuestions.index]
  }

  // Returns an error message when the current question is not acceptably
  // answered, or null when it is. The length bounds come from the standard
  // request and MUST be enforced here: validateQuestionAnswers rejects an answer
  // outside them and that throw happens inside the factory's handle, so an
  // out-of-range answer would become a capability failure instead of a
  // re-prompt. Measured in UTF-16 units, which is what the validator compares —
  // the same trap the secret prompt hit.
  //
  // `emptyMessage` is the wording for an empty draft: the two call sites reach
  // this in different modes (typing free text vs. choosing among options) and
  // keep their own phrasing.
  function questionAnswerError(emptyMessage) {
    const question = activeQuestion()
    const draft = activeDraft()
    const custom = String(draft.custom ?? '').trim()
    if (draft.selected.length === 0 && custom === '') {
      return emptyMessage ?? t('session.answerRequired')
    }
    // Only a text field's answer is the custom string: a select field's free
    // text is dropped by the adapter, so bounds do not apply to it.
    if (question?.kind === 'text' && custom !== '') {
      if (question.minLength !== undefined && custom.length < question.minLength) {
        return t('session.minChars', { count: question.minLength })
      }
      if (question.maxLength !== undefined && custom.length > question.maxLength) {
        return t('session.maxChars', { count: question.maxLength })
      }
    }
    return null
  }

  function questionError(text) {
    app.pendingQuestions.error = text
    paint()
  }

  // Step to the next question, or answer the request on the last one.
  function advanceQuestion() {
    const pending = app.pendingQuestions
    if (pending.index < pending.questions.length - 1) {
      pending.index++
      pending.cursor = 0
      pending.customMode = false
      pending.customCursor = 0
      pending.scroll = 0
      pending.error = null
      paint()
      return
    }
    pending.settle(buildQuestionsAnswer(pending.questions, pending.drafts))
    paint()
  }

  function toggleQuestionOption(index) {
    const pending = app.pendingQuestions
    const question = activeQuestion()
    const option = question?.options?.[index]
    if (!option) return
    const draft = activeDraft()
    if (question.multiSelect) {
      draft.selected = draft.selected.includes(option.label)
        ? draft.selected.filter((label) => label !== option.label)
        : [...draft.selected, option.label]
    } else {
      // A single-select choice clears any typed "other" answer.
      draft.selected = [option.label]
      draft.custom = ''
    }
    draft.skipped = false
    pending.error = null
    paint()
  }

  function continueQuestion() {
    const pending = app.pendingQuestions
    const question = activeQuestion()
    const optionCount = question.options.length
    if (pending.customMode) {
      const error = questionAnswerError(t('session.typeAnswer'))
      if (error !== null) {
        questionError(error)
        return
      }
      pending.customMode = false
      advanceQuestion()
      return
    }
    if (pending.cursor >= optionCount) {
      // The free-text row.
      pending.customMode = true
      pending.customCursor = String(activeDraft().custom ?? '').length
      pending.error = null
      paint()
      return
    }
    if (question.multiSelect) {
      const error = questionAnswerError()
      if (error !== null) {
        questionError(error)
        return
      }
      advanceQuestion()
      return
    }
    const draft = activeDraft()
    const option = question.options[pending.cursor]
    if (!draft.selected.includes(option.label)) {
      draft.selected = [option.label]
      draft.custom = ''
    }
    advanceQuestion()
  }

  function moveQuestionCursor(delta) {
    const pending = app.pendingQuestions
    if (pending.customMode) return
    const rows = activeQuestion().options.length + 1
    pending.cursor = (pending.cursor + delta + rows) % rows
    pending.error = null
    paint()
  }

  function editQuestionCustom(edit) {
    const pending = app.pendingQuestions
    const draft = activeDraft()
    const current = String(draft.custom ?? '')
    const caret = Math.max(0, Math.min(pending.customCursor, current.length))
    const next = edit(current, caret)
    draft.custom = next.text
    // Typing a free-text answer replaces a single-select choice, exactly as the
    // WebUI composer does; a multi-select draft keeps its checked labels.
    if (!activeQuestion().multiSelect) draft.selected = []
    draft.skipped = false
    pending.customCursor = next.caret
    pending.error = null
    paint()
  }

  function handleQuestionKey(key) {
    const pending = app.pendingQuestions
    const question = activeQuestion()
    if (!pending || !question) return
    if (key.name === 'escape') {
      if (pending.customMode) {
        pending.customMode = false
        pending.error = null
        paint()
        return
      }
      pending.defer()
      return
    }
    if (pending.customMode) {
      switch (key.name) {
        case 'return': case 'enter': continueQuestion(); return
        case 'backspace':
          editQuestionCustom((text, caret) => caret <= 0
            ? { text, caret }
            : { text: text.slice(0, caret - 1) + text.slice(caret), caret: caret - 1 })
          return
        case 'delete':
          editQuestionCustom((text, caret) => caret >= text.length
            ? { text, caret }
            : { text: text.slice(0, caret) + text.slice(caret + 1), caret })
          return
        case 'left':
          pending.customCursor = Math.max(0, pending.customCursor - 1); paint(); return
        case 'right':
          pending.customCursor = Math.min(String(activeDraft().custom ?? '').length, pending.customCursor + 1); paint(); return
        case 'home': pending.customCursor = 0; paint(); return
        case 'end': pending.customCursor = String(activeDraft().custom ?? '').length; paint(); return
        default:
          if (key.text) editQuestionCustom((text, caret) => ({ text: text.slice(0, caret) + key.text + text.slice(caret), caret: caret + key.text.length }))
          return
      }
    }
    switch (key.name) {
      case 'up': moveQuestionCursor(-1); return
      case 'down': moveQuestionCursor(1); return
      case 'pageup': pending.scroll = Math.max(0, (pending.scroll ?? 0) - 5); paint(); return
      case 'pagedown': pending.scroll = (pending.scroll ?? 0) + 5; paint(); return
      case 'return': case 'enter': continueQuestion(); return
      default: break
    }
    if (key.text === ' ' || key.name === ' ') {
      if (pending.cursor >= question.options.length) continueQuestion()
      else toggleQuestionOption(pending.cursor)
      return
    }
    // Any other printable character goes straight into the free-text row.
    if (key.text && key.text.trim() !== '') {
      pending.cursor = question.options.length
      pending.customMode = true
      pending.customCursor = String(activeDraft().custom ?? '').length
      editQuestionCustom((text, caret) => ({ text: text.slice(0, caret) + key.text + text.slice(caret), caret: caret + key.text.length }))
    }
  }

  // ---- input handling -----------------------------------------------------

  function insert(ch) {
    const { inputText, inputCursor } = app
    app.inputText = inputText.slice(0, inputCursor) + ch + inputText.slice(inputCursor)
    app.inputCursor += ch.length
    paint()
  }
  function backspace() {
    const { inputText, inputCursor } = app
    if (inputCursor <= 0) return
    // Delete one code point.
    const before = inputText.slice(0, inputCursor)
    const removed = [...before].pop()
    app.inputText = before.slice(0, before.length - removed.length) + inputText.slice(inputCursor)
    app.inputCursor -= removed.length
    paint()
  }
  function del() {
    const { inputText, inputCursor } = app
    if (inputCursor >= inputText.length) return
    const after = inputText.slice(inputCursor)
    const removed = [...after].shift()
    app.inputText = inputText.slice(0, inputCursor) + after.slice(removed.length)
    paint()
  }

  // A bracketed paste arrived. Raw image bytes become a numbered attachment;
  // text is checked for a data URL / local image path / image URL before it
  // falls back to ordinary text. An empty paste asks the terminal for its
  // clipboard (OSC 52 read) so images that have no text form can still arrive.
  async function handlePaste(data) {
    if (data && data.length > 0) {
      const mediaType = detectImageMediaType(data)
      if (mediaType) {
        attachImage(data, mediaType)
        return
      }
      const text = data.toString('utf8')
      if (text.trim() === '') {
        requestClipboardImage()
        return
      }
      if (await attachFromText(text)) return
      insert(text)
      return
    }
    requestClipboardImage()
  }

  // A paste or clipboard reply that arrived while a dialog is open. The composer
  // is behind the dialog, so nothing here may reach it: the reply is either the
  // field being edited or nothing at all.
  function handleOverlayPaste(key) {
    if (key.name === 'clipboard') {
      // An OSC 52 reply answers a read the composer asked for before the dialog
      // opened. Nothing can use it now, and leaving the flag set would let a
      // later unsolicited reply be routed to the composer instead.
      clipboardRequested = false
      return
    }
    if (app.overlay === 'settings') pasteIntoSettingsField(key.data)
  }

  // The settings rows that hold one line of typed text, so a paste onto the
  // selected row can open its editor. A choice row is excluded: there is nothing
  // to paste into a list of options.
  const PASTEABLE_ROWS = new Set(['text', 'path', 'secret', 'provider-field', 'model-field', 'mcp-field', 'provider-model-add', 'provider-search'])

  function pasteableRow(item) {
    if (!item || item.disabled === true || item.selectable === false) return false
    if (Array.isArray(item.options) && item.options.length > 0) return false
    if (!PASTEABLE_ROWS.has(item.kind)) return false
    // The Models row on the create form opens a window; it is not a text field.
    return item.providerModels !== true
  }

  // Append a paste to the field the settings dialog is editing — or, when no
  // field is open, open the selected row's editor around the pasted text. That
  // is what pressing Ctrl+V on a highlighted "Provider API key" row means, and
  // it beats pasting into a composer the dialog is hiding.
  //
  // Everything the dialog edits is one line wide, so `fieldPasteText` folds the
  // newlines away; an image paste yields nothing, because a text field has no
  // place to put it and the composer that would have is not on screen.
  function pasteIntoSettingsField(data) {
    if (app.settingsEditing !== null) {
      const open = fieldPasteText(data, { secret: app.settingsSecret })
      if (open === null) return
      app.settingsDraft += open
      // The picker's filter row narrows the list as it is typed; a paste into it
      // has to land the same way a keystroke does.
      if (settingsView.kind === 'provider-picker' && app.settingsEditing === 0) rebuildPicker(app.settingsDraft)
      paint()
      return
    }
    const item = app.settingsItems[app.settingsSelection]
    if (!pasteableRow(item)) return
    const secret = item.secret === true || item.kind === 'secret'
    const text = fieldPasteText(data, { secret })
    if (text === null) return
    app.settingsEditing = app.settingsSelection
    app.settingsSecret = secret
    // A secret row masks what it shows, so the editor starts from the pasted
    // value; the row's previous value was never on screen to append to anyway.
    app.settingsDraft = text
    if (settingsView.kind === 'provider-picker' && app.settingsEditing === 0) rebuildPicker(app.settingsDraft)
    paint()
  }

  async function attachFromText(text) {    const trimmed = text.trim()
    const dataUrl = decodeDataUrl(trimmed)
    if (dataUrl) {
      const detected = detectImageMediaType(dataUrl.data)
      if (detected) {
        attachImage(dataUrl.data, dataUrl.mediaType || detected)
        return true
      }
    }
    const path = localImagePath(trimmed)
    if (path) {
      try {
        const bytes = await readFile(path)
        const detected = detectImageMediaType(bytes)
        if (detected) {
          attachImage(bytes, detected)
          return true
        }
      } catch { /* unreadable path; treat as plain text */ }
    }
    if (/^https?:\/\/\S+$/i.test(trimmed)) {
      return await attachFromUrl(trimmed)
    }
    return false
  }

  async function attachFromUrl(url) {
    if (typeof fetch !== 'function') return false
    try {
      const res = await fetch(url)
      if (!res.ok) return false
      const bytes = Buffer.from(await res.arrayBuffer())
      const detected = detectImageMediaType(bytes)
      if (!detected) return false
      attachImage(bytes, detected)
      return true
    } catch {
      return false
    }
  }

  // OSC 52 clipboard read, best-effort for terminals that support it.
  let clipboardRequested = false
  function requestClipboardImage() {
    clipboardRequested = true
    term.requestClipboard()
  }
  function handleClipboard(data) {
    if (!clipboardRequested) return
    clipboardRequested = false
    if (!data || data.length === 0) return
    const mediaType = detectImageMediaType(data)
    if (mediaType) {
      attachImage(data, mediaType)
      return
    }
    const text = data.toString('utf8').trim()
    if (text) insert(text)
  }

  function attachImage(data, mediaType) {
    const n = app.inputImages.length + 1
    // `data` stays on the entry so the optimistic transcript block can render
    // the image without a read-back; it lives only until submit clears the
    // composer.
    const entry = { status: 'pending', ref: null, mediaType, label: 'Image ' + n, promise: null, data }
    app.inputImages.push(entry)
    insert('[Image ' + n + ']')
    const attachments = ctx.get('attachments')
    if (!attachments || typeof attachments.saveImage !== 'function') {
      entry.status = 'error'
      app.showToast(t('session.attachmentsUnavailable'), 'warn')
      paint()
      return
    }
    entry.promise = (async () => {
      try {
        const ref = await attachments.saveImage({ data, mediaType, name: 'image-' + n })
        entry.ref = ref
        entry.status = 'ready'
      } catch (error) {
        entry.status = 'error'
        app.showToast(t('session.imageAttachFailed', { error: formatError(error) }), 'error')
      }
      paint()
      return entry.ref
    })()
  }

  function handleMouse(mouse) {
    if (mouse.action === 'move') {
      // Drag-select: while the left button is held, extend the selection.
      // A motion event without the left button means the release was lost
      // (e.g. the button came up outside the window) — drop the drag state.
      if (app.textSelectionDragging) {
        if (mouse.button === 'left') {
          if (app.updateTextSelection(mouse.x, mouse.y)) paint()
        } else {
          app.textSelectionDragging = false
        }
        return
      }
      // Focus follows the cursor: the row under the pointer owns the
      // selection. The App keeps the hover cache and re-applies the focus
      // when the selection moved away while the pointer rested on a row.
      if (app.hoverFocus(mouse.x, mouse.y)) paint()
      return
    }
    if (mouse.action === 'wheel-up' || mouse.action === 'wheel-down') {
      const direction = mouse.action === 'wheel-up' ? -1 : 1
      if (app.pendingQuestions) {
        // Scroll the plan/review window inside the question modal.
        app.pendingQuestions.scroll = Math.max(0, (app.pendingQuestions.scroll ?? 0) + direction * 3)
        paint()
        return
      }
      if (app.overlay === 'rewind') {
        app.moveRewind(direction)
      } else if (app.overlay === 'git-branches') {
        app.moveGitBranches(direction)
      } else if (app.overlay === 'settings') {
        // Scroll the settings content window instead of moving focus
        app.scrollSettingsWindow(direction * 3)
      } else if (app.hitTest(mouse.x, mouse.y, ['rail'])) {
        // The pointer rests over the status rail: scroll the rail, not the
        // transcript beneath it.
        app.scrollRail(direction * 3)
      } else {
        app.scrollTranscript(-direction * 3)
      }
      paint()
      return
    }
    if (mouse.action === 'up') {
      // Left button released: end the drag. A click without movement is not a
      // selection — drop it so no stale highlight lingers.
      if (app.textSelectionDragging) {
        app.textSelectionDragging = false
        const sel = app.textSelection
        if (sel && sel.startX === sel.endX && sel.startY === sel.endY) {
          app.textSelection = null
        }
        paint()
      }
      return
    }
    if (mouse.action === 'down' && mouse.button === 'right') {
      // Right click copies the current selection (OSC 52 / clip.exe fallback).
      const text = app.textSelection ? app.selectionText() : ''
      if (text) {
        app.textSelection.text = text
        term.copyToClipboard(text)
        app.showToast(tn('session.copied', text.split('\n').length, { count: text.split('\n').length }))
        paint()
      }
      return
    }
    if (mouse.action !== 'down' || mouse.button !== 'left') return
    if (app.pendingApproval) return
    if (app.overlay === 'rewind') {
      const region = app.hitTest(mouse.x, mouse.y, ['rewind-item', 'rewind-option'])
      if (!region || !app.rewind) {
        app.closeRewind()
        paint()
        return
      }
      if (region.kind === 'rewind-item') app.rewind.selected = region.rewindIndex
      if (region.kind === 'rewind-option') app.rewind.modeIndex = region.rewindIndex
      void confirmRewindPicker()
      return
    }
    if (app.overlay === 'git-branches') {
      const region = app.hitTest(mouse.x, mouse.y, ['git-branch-item'])
      const picker = app.gitBranches
      if (!region || !picker) {
        app.closeGitBranches()
        paint()
        return
      }
      // A click on an unselected row only moves the selection; switching a
      // branch is the second click on the row that already has it, so a
      // stray click cannot rewrite the working tree.
      if (picker.selected === region.branchIndex) {
        if (!picker.busy) void withGitBranchBusy(confirmGitBranch)
      } else {
        picker.selected = region.branchIndex
        app._clampGitBranchesScroll()
      }
      paint()
      return
    }
    if (app.pendingQuestions) {
      const option = app.hitTest(mouse.x, mouse.y, ['question-option'])
      if (option) {
        app.pendingQuestions.cursor = option.optionIndex
        toggleQuestionOption(option.optionIndex)
        return
      }
      if (app.hitTest(mouse.x, mouse.y, ['question-custom'])) {
        app.pendingQuestions.cursor = activeQuestion().options.length
        app.pendingQuestions.customMode = true
        app.pendingQuestions.customCursor = String(activeDraft().custom ?? '').length
        paint()
      }
      return
    }
    if (app.overlay === 'settings') {
      const menuRegion = app.hitTest(mouse.x, mouse.y, ['settings-menu'])
      if (menuRegion) {
        switchSettingsTab(menuRegion.menuIndex)
        return
      }
      const region = app.hitTest(mouse.x, mouse.y, ['settings-item'])
      if (!region) return
      app.settingsSelection = region.settingsIndex
      handleSettingsKey({ name: 'return' })
      return
    }
    if (app.overlay === 'help') {
      app.overlay = null
      paint()
      return
    }
    const region = app.hitTest(mouse.x, mouse.y)
    // The stats strip and the context meter both toggle the session stats
    // window; any other click while it is open closes it (outside-click close,
    // like the web ContextMeter).
    if (region?.kind === 'stats' || region?.kind === 'context-meter') {
      app.statsOpen = !app.statsOpen
      paint()
      return
    }
    if (app.statsOpen) {
      app.statsOpen = false
      paint()
      return
    }
    if (region?.kind === 'command') {
      app.completeCommand(region.commandIndex)
      paint()
      return
    }
    if (region?.kind === 'effort') {
      toggleEffortSlider()
      return
    }
    if (region?.kind === 'thinking') {
      app.toggleThinking(region.thinkingBlock)
      paint()
      return
    }
    if (region?.kind === 'note') {
      app.toggleNote(region.noteBlock)
      paint()
      return
    }
    // Tool activity cards expand to the full result on click.
    if (region?.kind === 'tool') {
      app.toggleTool(region.toolBlock)
      paint()
      return
    }
    // Left-drag inside the transcript selects text (right-click copies it).
    if (region?.kind === 'transcript') {
      app.startTextSelection(mouse.x, mouse.y)
      paint()
      return
    }
    // A click anywhere else in the main view drops a stale selection.
    const hadSelection = app.clearTextSelection()
    const placed = region?.kind === 'composer' && app.placeInputCursor(mouse.x, mouse.y)
    if (placed || hadSelection) paint()
  }

  term.on('key', (key) => {
    if (key.ctrl && key.name === 's') {
      void takeScreenshot()
      return
    }
     // The secret prompt owns pasted input: routing it through the composer
     // would put the plaintext in the screen buffer and leave it in the input
     // row after the prompt closes, where it could be submitted as a message.
     if (app.pendingSecret && key.name === 'paste') {
       // A secret is single-line, so collapse the newlines a multi-line paste
       // would otherwise introduce. Do not trim: leading or trailing spaces can
       // be part of a secret.
       const text = key.data ? key.data.toString('utf8').replace(/[\r\n]+/g, '') : ''
       if (text !== '') {
         app.pendingSecret.draft += text
         app.pendingSecret.error = null
         paint()
       }
       return
     }
     if (app.pendingSecret && key.name === 'clipboard') {
       // An OSC 52 clipboard reply answers a clipboard *read* (an image
       // request). While the prompt is open it must not reach the composer, and
       // it is not something the user typed, so it is dropped rather than
       // guessed at. Clearing the outstanding-read flag matters: handleClipboard
       // is what normally clears it, and we return before reaching it, so
       // leaving it set would let a later unsolicited reply be routed to the
       // composer — the same plaintext path this guard exists to close.
       clipboardRequested = false
       return
     }
    if (key.name === 'mouse') {
      handleMouse(key.mouse)
      return
    }
    // A paste belongs to whatever holds focus. Behind a dialog the composer is
    // not on screen, so routing there fills a row the user cannot see — one
    // Enter away from being sent as a message, which is exactly what an API key
    // must never become. Only the settings dialog has a field to give it to.
    if (app.overlay !== null && (key.name === 'paste' || key.name === 'clipboard')) {
      handleOverlayPaste(key)
      return
    }
    if (key.name === 'paste') {
      void handlePaste(key.data)
      return
    }
     if (key.name === 'clipboard') {
       handleClipboard(key.data)
       return
     }
     app.focusedRegion = 'keyboard'
     // Approval prompt has its own mini-mode.
     if (false) {
       if (key.name === 'y' || key.name === 'Y' || key.name === 'return' || key.name === 'enter') {

       } else if (key.name === 'n' || key.name === 'N' || key.name === 'escape') {

         app.showToast(t('session.deleteCancelled'))
         paint()
       }
       return
     }
     // Approval prompt has its own mini-mode.
    if (app.pendingApproval) {
      if (key.name === 'y' || key.name === 'Y' || key.name === 'return') {
        app.pendingApproval.settle('allowed-once')
      } else if (key.name === 'n' || key.name === 'N') {
        app.pendingApproval.settle('rejected')
      } else if (key.name === 'escape') {
        app.pendingApproval.settle('cancelled')
      }
      paint()
      return
    }
    if (app.pendingSecret) {
      if (key.name === 'escape') {
        app.pendingSecret.settle(null)
        return
      }
      if (key.name === 'return') {
        const state = app.pendingSecret
        // Measured the way the validator measures it: validateSecretInputValue
        // compares `result.secret.length`, which is UTF-16 units. Counting code
        // points here would diverge — maxLength 2 with a draft of two emoji
        // counts 2 here and 4 there, so the modal would submit a value the
        // validator rejects, which is the capability failure this branch exists
        // to prevent. (The bullet count below stays code-point based, because
        // that is what the user perceives as characters; only the bounds are
        // contractual.)
        const length = state.draft.length
        if (length === 0) {
          state.error = t('session.valueRequired')
          paint()
          return
        }
        if (state.minLength !== undefined && length < state.minLength) {
          state.error = t('session.minChars', { count: state.minLength })
          paint()
          return
        }
        if (state.maxLength !== undefined && length > state.maxLength) {
          state.error = t('session.maxChars', { count: state.maxLength })
          paint()
          return
        }
        state.settle(state.draft)
        return
      }
      if (key.name === 'backspace') {
        // Delete a whole code point, not a UTF-16 unit: backspacing over an
        // astral character (an emoji) with slice(0, -1) would leave a lone
        // surrogate, which masks as one bullet and counts as one code point
        // while being an invalid string.
        app.pendingSecret.draft = Array.from(app.pendingSecret.draft).slice(0, -1).join('')
        paint()
        return
      }
      if (typeof key.text === 'string' && key.text.length > 0 && !key.ctrl && !key.meta) {
        app.pendingSecret.draft += key.text
        paint()
      }
      return
    }
    // The question modal owns every key except Ctrl+C, which still cancels the
    // running turn — the request's abort signal then closes the modal.
    if (app.pendingQuestions && !(key.ctrl && key.name === 'c')) {
      handleQuestionKey(key)
      return
    }
    if (app.overlay === 'rewind') {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        handleCtrlKey(key.name)
        return
      }
      handleRewindKey(key)
      return
    }
    if (app.overlay === 'git-branches') {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        handleCtrlKey(key.name)
        return
      }
      handleGitBranchKey(key)
      return
    }
    if (app.overlay === 'settings') {
      handleSettingsKey(key)
      return
    }
    if (app.overlay === 'help') {
      if (key.name === 'escape' || key.name === 'return' || key.name === 'h') {
        app.overlay = null
        paint()
      }
      return
    }
    if (!key.ctrl && !key.meta && !key.shift && app.commandMatches().length > 0) {
      if (key.name === 'up' || key.name === 'down') {
        app.moveCommandSelection(key.name === 'up' ? -1 : 1)
        paint()
        return
      }
      if (key.name === 'tab' || ((key.name === 'return' || key.name === 'enter') && !app.commandMatches().some(([command]) => command === app.inputText))) {
        app.completeCommand()
        paint()
        return
      }
      if (key.name === 'escape') {
        app.dismissCommands()
        paint()
        return
      }
    }
    if (key.name === 'return' || key.name === 'enter') {
      // Every modifier combination of Enter means "newline": Ctrl+Enter is the
      // documented one, Shift/Alt are the alternatives, and a terminal that
      // reports alt-ness (ESC CR, CSI-u mod 3) lands here too.
      if (key.shift || key.ctrl || key.alt || key.meta) insert('\n')
      else void submit()
      return
    }
    if (key.ctrl) {
      handleCtrlKey(key.name)
      return
    }
    switch (key.name) {
      case 'backspace': backspace(); break
      case 'left':
        if (app.effortSliderVisible && app.effortSlider) moveEffort(-1)
        else if (app.inputCursor > 0) app.inputCursor--
        paint()
        break
      case 'right':
        if (app.effortSliderVisible && app.effortSlider) moveEffort(1)
        else if (app.inputCursor < app.inputText.length) app.inputCursor++
        paint()
        break
      case 'home': app.inputCursor = 0; paint(); break
      case 'end': app.inputCursor = app.inputText.length; paint(); break
      case 'up': {
        // Shift+Up scrolls the status rail when it is on screen; without the
        // rail (or without Shift) the arrow keeps its composer meanings.
        if (key.shift && app._layout().railW > 0) {
          app.scrollRail(-3)
          paint()
          break
        }
        // Multi-line input: Up moves the caret one visual row up (keeping the
        // column), and only the first row falls back to input history. The
        // width comes from the renderer's own layout so caret math matches
        // what is on screen.
        const layout = app._layout()
        if (layout.visual.cursorRow > 0) {
          app.inputCursor = cursorAtVisual(app.inputText, layout.composerWidth, layout.visual.cursorRow - 1, layout.visual.cursorCol)
          paint()
        } else {
          historyBack()
        }
        break
      }
      case 'down': {
        if (key.shift && app._layout().railW > 0) {
          app.scrollRail(3)
          paint()
          break
        }
        // Down moves the caret one visual row down; only the last row falls
        // back to input history.
        const layout = app._layout()
        if (layout.visual.cursorRow < layout.visual.rows.length - 1) {
          app.inputCursor = cursorAtVisual(app.inputText, layout.composerWidth, layout.visual.cursorRow + 1, layout.visual.cursorCol)
          paint()
        } else {
          historyForward()
        }
        break
      }
      case 'pageup': app.scroll = Math.min(app.scroll + 10, 100000); paint(); break
      case 'pagedown': app.scroll = Math.max(0, app.scroll - 10); paint(); break
      case 'tab': {
        // Tab changes the thinking intensity; a model with no selectable
        // levels keeps the old two-space insertion.
        if (!cycleEffort(1)) insert('  ')
        break
      }
      case 'shift-tab': cycleEffort(-1); break
      case 'escape':
        if (app.statsOpen) {
          app.statsOpen = false
          lastEscAt = 0
          paint()
        } else if (app.effortSliderVisible) {
          app.effortSliderVisible = false
          lastEscAt = 0
          paint()
        } else if (app.status === 'running') {
          lastEscAt = 0
          if (currentAgent) currentAgent.cancel({ kind: 'user' })
          app.showToast(t('session.interruptRequested'))
          paint()
        } else if (app.inputText.length > 0 || app.inputImages.length > 0) {
          lastEscAt = 0
          app.inputText = ''
          app.inputCursor = 0
          app.inputImages = []
          paint()
        } else {
          const now = Date.now()
          if (now - lastEscAt <= ESC_DOUBLE_MS) {
            lastEscAt = 0
            openRewindOverlay()
          } else {
            lastEscAt = now
          }
        }
        break
      case 'unknown': break
      default:
        if (key.text !== undefined && !key.alt) insert(key.text)
        break
    }
  })

  // Settings views: 'main', 'model', 'update' and 'mcp' are the left-menu tabs
  // of the settings dialog; 'choice', 'sessions', 'mcp-form' and
  // 'provider-models' are menu-less sub-views rendered in the same overlay.
  let settingsView = { kind: 'main' }
  // The last selection per menu tab, restored when Tab switches back.
  const menuSelections = { main: 0, model: 0, update: 0, mcp: 0 }
  let settingsLoadVersion = 0
  // The last-loaded update page snapshot (installed versions, registry results,
  // dsh entry, active profile) so version pickers and installs can reuse it.
  let updateState = null
  // The in-app download, while one is running: { pkg, version, label,
  // controller, progressRow }. Null otherwise; Esc aborts the controller.
  let updateDownload = null
  let sharedSettings = null

  function showSettings(loaded, selection = 0) {
    sharedSettings = loaded.settings
    app.openSettings(loaded.items, {
      title: loaded.title,
      subtitle: loaded.subtitle,
      menu: loaded.menu ?? [],
      menuIndex: loaded.menuIndex ?? 0,
    })
    app.setSettingsSelection(selection)
  }

  // Open one left-menu tab of the settings dialog. A version guard keeps a
  // slow loader from overwriting a tab the user already switched away from.
  async function openSettingsTab(tab, selection) {
    const version = ++settingsLoadVersion
    settingsView = { kind: tab }
    if (tab === 'update') {
      // The registry checks can take seconds; show the Update tab at once so
      // the check/switch entries are immediately visible while it fetches.
      app.settingsBusy = true
      app.openSettings([{ kind: 'update-loading', label: t('update.checking'), value: '', disabled: true }], {
        title: t('update.title'),
        subtitle: t('update.fetching'),
        menu: SETTINGS_MENU,
        menuIndex: 2,
      })
      app.setSettingsSelection(0)
      paint()
    }
    let loaded
    try {
      if (tab === 'update') loaded = await loadUpdateView(ctx)
      else if (tab === 'model') loaded = await loadModelSettings(ctx)
      else if (tab === 'mcp') loaded = await loadMcpSettings(ctx, mcpManager, { cwd: mcpCwd() })
      else loaded = await loadWebSettings(ctx)
    } catch (error) {
      if (tab === 'update') app.settingsBusy = false
      if (version !== settingsLoadVersion) return
      sharedSettings = null
      app.openSettings([{ label: t('settings.dshSettings'), value: formatError(error), disabled: true }])
      paint()
      return
    }
    if (tab === 'update') app.settingsBusy = false
    if (version !== settingsLoadVersion || settingsView.kind !== tab) return
    if (tab === 'update') updateState = loaded.state ?? null
    showSettings(loaded, selection ?? menuSelections[tab] ?? 0)
    // The MCP tab's change poll compares file mtimes against this baseline, so
    // opening the page has to record the state it just rendered — and the row
    // signature with it, or the first quiet poll would rebuild the same rows.
    if (tab === 'mcp') {
      mcpFiles = loaded.files ?? []
      mcpItemsSignature = mcpRowSignature(loaded.items)
      mcpFileSignature = await mcpFilesSignature(mcpFiles)
    }
    paint()
  }

  // Switch the settings dialog's left menu (Tab / click).
  function switchSettingsTab(index) {
    const menu = app.settingsMenu
    if (!Array.isArray(menu) || menu.length === 0) return
    const target = menu[((index % menu.length) + menu.length) % menu.length]
    if (!target || settingsView.kind === target.id) return
    if (settingsView.kind === 'main' || settingsView.kind === 'model' || settingsView.kind === 'update' || settingsView.kind === 'mcp') {
      menuSelections[settingsView.kind] = app.settingsSelection
    }
    void openSettingsTab(target.id)
  }

  async function openSettings(selection = 0) {
    app.statsOpen = false
    await openSettingsTab('main', selection)
  }

  function renderSessionManager(selection = 0) {
    const items = app.sidebarSessions.map((session) => ({
      kind: 'session',
      label: session.label,
      value: timeString(session.time),
      sessionId: session.id,
      disabled: false,
    }))
    app.openSettings(items.length > 0 ? items : [{ kind: 'session-empty', label: t('session.noSaved'), value: '', disabled: true }], {
      title: t('session.manageTitle'),
      subtitle: t('session.manageSubtitle'),
    })
    app.setSettingsSelection(selection)
    paint()
  }

  async function openSessionManager(selection = 0) {
    settingsView = { kind: 'sessions' }
    // Paint the rows already in hand first: they are one frame away, while a
    // fresh listing has to stat every session directory and read every title
    // snapshot. The revalidation below corrects the list once it lands, and
    // only when it actually differs from what is on screen.
    const shown = Array.isArray(app.sidebarSessions) ? app.sidebarSessions.slice() : []
    if (shown.length > 0) {
      renderSessionManager(selection)
    } else {
      app.openSettings([{ kind: 'session-loading', label: t('session.loading'), value: '', disabled: true }], {
        title: t('session.manageTitle'),
        subtitle: t('session.manageSubtitle'),
      })
      paint()
    }
    const before = sessionRowsSignature(shown)
    await refreshRecentSessions()
    if (settingsView.kind !== 'sessions') return
    if (shown.length > 0 && sessionRowsSignature(app.sidebarSessions) === before) return
    renderSessionManager(app.settingsSelection)
  }

  // Delete one persisted session.
  //
  // The harness exposes no session-deletion API — neither the lifecycle-owned
  // `SessionHandle` (read/append/flush/close) nor the `SessionPersistence`
  // service (create/open/flush/stat/list) has a delete — so the TUI removes the
  // session's own directory from the harness home. The store is one directory
  // per session holding its log plus any lock/metadata siblings, which makes
  // removing the directory the complete and only operation required.
  //
  // Deleting the session currently open in the TUI tears the live agent down to
  // quiescence first: `dispose()` releases the session's write ownership, so the
  // files are no longer held by a live handle before they are unlinked.
  async function deleteManagedSession(item) {
    const deletingCurrent = item.sessionId === app.sessionId
    try {
      if (deletingCurrent && handle) {
        const currentHandle = handle
        handle = null
        currentAgent = null
        await currentHandle.dispose()
      }
      if (!await deleteSessionDirectory(item.sessionId)) {
        throw new Error(t('session.deleteNotFound'))
      }
      app.settingsConfirm = null
      app.showToast(t('session.deleted', { label: item.label }))
      // The delete already succeeded, so the row can go without re-reading a
      // listing that would say exactly the same thing minus this session.
      // Retiring the cache (`sessionsLoadedAt = 0`) is what keeps the next
      // visit honest: it revalidates against the disk, so a delete that raced
      // another writer cannot leave a ghost row behind.
      app.sidebarSessions = app.sidebarSessions.filter((row) => row.id !== item.sessionId)
      sessionsLoadedAt = 0
      if (deletingCurrent) await showTitleScreen()
      else {
        settingsView = { kind: 'sessions' }
        renderSessionManager(Math.max(0, app.settingsSelection - 1))
      }
    } catch (error) {
      // The live agent was already torn down, so the session list is the only
      // surface left to show.
      if (deletingCurrent && !handle) await showTitleScreen()
      app.settingsConfirm = null
      app.showToast(t('session.deleteFailed', { error: formatError(error) }), 'error')
      paint()
    }
  }

  // The auto-fetched model selection window for one provider. Renders a
  // placeholder at once (the fetch can take a while) and swaps in the
  // checkbox list when it lands.
  async function openProviderModels(providerId, selection = 0) {
    const version = ++settingsLoadVersion
    const parentSelection = settingsView.kind === 'provider-models' && settingsView.provider === providerId
      ? settingsView.parentSelection
      : app.settingsSelection
    settingsView = { kind: 'provider-models', provider: providerId, parentSelection }
    app.openSettings([{ label: t('model.fetching'), value: '', disabled: true }], { title: t('model.models'), subtitle: t('model.autoFetching') })
    paint()
    let loaded
    try {
      loaded = await loadProviderModels(ctx, providerId)
    } catch (error) {
      if (version !== settingsLoadVersion) return
      app.showToast(t('settings.error', { error: formatError(error) }), 'error')
      await openSettingsTab('model', parentSelection)
      return
    }
    if (version !== settingsLoadVersion || settingsView.kind !== 'provider-models' || settingsView.provider !== providerId) return
    showSettings(loaded, selection)
    paint()
  }

  async function refreshSettings(selection = 0) {
    if (settingsView.kind === 'provider-models') {
      if (settingsView.draft === true) renderDraftModelWindow(settingsView.selection ?? 0)
      else await openProviderModels(settingsView.provider, selection)
    }
    else if (settingsView.kind === 'sessions') await openSessionManager(selection)
    else if (settingsView.kind === 'update') await openSettingsTab('update', selection)
    else if (settingsView.kind === 'model') await openSettingsTab('model', selection)
    else if (settingsView.kind === 'mcp') await openSettingsTab('mcp', selection)
    else if (settingsView.kind === 'mcp-form') renderMcpForm(mcpFormDraft, mcpFormIsEdit, selection)
    else if (settingsView.kind === 'provider-picker') openProviderPicker(selection, settingsView.query ?? '')
    else if (settingsView.kind === 'provider-form') renderProviderForm(providerDraft, providerFormMeta, selection)
    else if (settingsView.kind === 'model-form') renderModelForm(modelDraft, modelFormTarget, selection)
    else await openSettingsTab('main', selection)
  }

  // ---- add-provider flow ---------------------------------------------------
  // The WebUI's add card, split into the two views a terminal can render: a
  // picker over the routes still addable (the ones whose profile does not
  // resolve yet), then a form for the chosen one. The form is a draft — nothing
  // is written until Save — because a hand-declared route needs several fields
  // that are only valid together.
  let providerDraft = null
  let providerFormMeta = null
  // The endpoint's answer for the open draft, kept so toggling a model costs no
  // round trip and the list cannot shift under the cursor.
  let providerDiscovery = null
  // The directory the open picker was built from. Kept so typing a filter costs
  // no settings round trip per keystroke.
  let pickerDirectory = null

  function openProviderPicker(selection = 0, query = '') {
    const directory = providerDirectory(ctx)
    if (!directory) {
      app.showToast(t('settings.error', { error: t('common.unavailable') }), 'error')
      void openSettingsTab('model', 0)
      return
    }
    pickerDirectory = directory
    settingsView = { kind: 'provider-picker', query }
    app.openSettings(providerPickerItems(directory, { query }), {
      title: t('provider.add'),
      subtitle: t('provider.pickSubtitle'),
    })
    app.setSettingsSelection(selection)
    paint()
  }

  // Narrow the picker as the query is typed. The editor stays on the filter row
  // (index 0) and the list beneath it is what changes, so the cursor never
  // leaves the field being typed into. A commit passes `editing: false`: the
  // commit path has already closed the editor and must not reopen it.
  function rebuildPicker(query, { editing = true } = {}) {
    if (!pickerDirectory) return
    settingsView = { kind: 'provider-picker', query }
    app.settingsItems = providerPickerItems(pickerDirectory, { query })
    app.settingsSelection = 0
    app.settingsScrollOffset = 0
    if (editing) app.settingsEditing = 0
  }

  // The query the picker was filtering with, so backing out of a form returns to
  // the narrowed list rather than to 40 unfiltered routes.
  function pickerQuery() {
    return settingsView.kind === 'provider-picker' ? String(settingsView.query ?? '') : ''
  }

  // The routes already in use, so declaring one cannot shadow an existing
  // profile (the picker's own rows come from the addable half only).
  function takenRoutes(directory) {
    return directory.configured.map((row) => row.entry.provider)
  }

  function openProviderForm(draft, meta, selection) {
    const items = buildCreateFormItems(draft, { protocols: meta.protocols, title: meta.title })
    const start = items.findIndex((item) => item.kind === 'provider-field' && !item.disabled)
    renderProviderForm(draft, meta, selection ?? Math.max(0, start))
  }

  // Re-render the form around the same cursor position: a field commit rebuilds
  // the list (a picked protocol can change which rows exist), and the scroll
  // offset the view was at has to survive that.
  function renderProviderForm(draft, meta, selection = app.settingsSelection) {
    const scroll = app.settingsScrollOffset
    providerDraft = draft
    providerFormMeta = meta
    settingsView = { kind: 'provider-form' }
    app.openSettings(buildCreateFormItems(draft, { protocols: meta.protocols, title: meta.title }), {
      title: draft.mode === 'custom' ? t('provider.form.custom') : t('provider.add'),
      subtitle: t('provider.formSubtitle'),
    })
    app.setSettingsSelection(Math.min(selection, Math.max(0, app.settingsItems.length - 1)))
    app.settingsScrollOffset = scroll
    paint()
  }

  // Adopt a route the installed catalog already describes. Its profile inherits
  // the endpoint, protocol, and model catalog, so the form only offers the
  // fields a user actually overrides.
  function openCatalogProviderForm(providerId) {
    const directory = providerDirectory(ctx)
    const row = directory?.addable.find((candidate) => candidate.entry.provider === providerId)
    if (!directory || !row) {
      app.showToast(t('model.providerUnavailable'), 'error')
      openProviderPicker(0)
      return
    }
    // No protocol is preset: a catalog route keeps the one its own catalog
    // entry names, and forcing the adapter's first choice here would override
    // it (anthropic would be served over an OpenAI-shaped client).
    const draft = createDraft('catalog', providerId)
    openProviderForm(draft, {
      settingsNs: row.entry.settingsNs,
      revision: row.descriptor.revision,
      protocols: protocolChoices(row.descriptor),
      title: row.entry.displayName,
      taken: takenRoutes(directory),
      from: 'picker',
      query: pickerQuery(),
    })
  }

  // Declare a route the catalog does not ship: endpoint, protocol, and models
  // are the three fields nothing else can supply.
  function openCustomProviderForm() {
    const directory = providerDirectory(ctx)
    const target = directory ? declareNamespace(directory) : undefined
    if (!directory || !target) {
      app.showToast(t('model.namespaceUnavailable'), 'error')
      openProviderPicker(0)
      return
    }
    const draft = createDraft('custom')
    draft.api = target.protocols[0] ?? ''
    openProviderForm(draft, {
      settingsNs: target.settingsNs,
      revision: target.revision,
      protocols: target.protocols,
      from: 'picker',
      query: pickerQuery(),
      taken: takenRoutes(directory),
    })
  }

  function commitProviderField(item, value, selection) {
    const draft = { ...providerDraft }
    if (item.field === 'addModel') {
      const id = value.trim()
      if (id !== '' && !draft.models.some((model) => modelEntryId(model) === id)) draft.models = [...draft.models, { id }]
    } else if (item.field === 'key') {
      draft.key = value.trim()
    } else {
      draft[item.field] = value.trim()
      // The route id is a settings key the user has not thought about yet; the
      // display name is the one they have. Filling it from the name is visible
      // (the row repaints with it) and only ever happens while it is empty.
      if (item.field === 'displayName' && draft.mode === 'custom' && !draft.route) {
        const derived = deriveRoute(value)
        if (derived !== '') draft.route = derived
      }
    }
    renderProviderForm(draft, providerFormMeta, selection)
  }

  async function saveProviderForm() {
    const draft = providerDraft
    const meta = providerFormMeta
    if (!draft || !meta) return
    const failure = validateCreateDraft(draft, { taken: meta.taken })
    if (failure !== undefined) {
      app.showToast(t('settings.error', { error: failure }), 'error')
      paint()
      return
    }
    try {
      await saveCreateDraft(ctx, sharedSettings, draft, { settingsNs: meta.settingsNs, revision: meta.revision })
      providerDraft = null
      providerFormMeta = null
      providerDiscovery = null
      app.showToast(t('provider.added'), 'info')
      await openSettingsTab('model')
    } catch (error) {
      const conflict = error?.code === 'SETTINGS_CONFLICT'
      if (conflict) {
        // The revision this form opened at no longer matches, so a retry would
        // be refused forever. Take the revision the namespace stands at now:
        // the profile write is a single path op, which is safe to repeat.
        const fresh = providerDirectory(ctx)?.descriptors.get(meta.settingsNs)
        if (fresh) providerFormMeta = { ...meta, revision: fresh.revision }
      }
      app.showToast(t('settings.error', { error: conflict ? t('settings.conflict') : formatError(error) }), 'error')
      paint()
    }
  }

  // The model window for an unsaved draft: the same rows the saved-provider
  // window shows, but a toggle edits the draft instead of storing anything.
  async function openDraftModelWindow(selection = 0) {
    const draft = providerDraft
    const meta = providerFormMeta
    if (!draft || !meta) return
    const version = ++settingsLoadVersion
    settingsView = { kind: 'provider-models', draft: true, parentSelection: app.settingsSelection, selection }
    app.openSettings([{ label: t('model.fetching'), value: '', disabled: true }], {
      title: (meta.title ?? draft.route) + ' · ' + t('model.models').toLowerCase(),
      subtitle: t('model.autoFetching'),
    })
    paint()
    let answer
    try {
      answer = await discoverDraftModels(ctx, draft, { settingsNs: meta.settingsNs, providerId: draft.route })
    } catch (error) {
      answer = { models: [], failed: true, error: formatError(error) }
    }
    if (version !== settingsLoadVersion || settingsView.kind !== 'provider-models' || settingsView.draft !== true) return
    providerDiscovery = { models: answer.models, failed: answer.failed, error: answer.error }
    // A fetch that lands is a selection — for a hand-declared route, whose
    // profile has no catalog to inherit. A catalog route is deliberately left
    // unselected: an empty `models` means "serve the catalog", which keeps
    // working after the adapter updates it, while a copied list freezes today's.
    // Nothing is written until Save provider; the select-all row adds them all.
    if (providerDraft.mode === 'custom' && answer.models.length > 0 && providerDraft.models.length === 0) {
      providerDraft = { ...providerDraft, models: mergeModelSelection([], answer.models) }
    }
    renderDraftModelWindow(selection)
  }

  function renderDraftModelWindow(selection = app.settingsSelection) {
    const draft = providerDraft
    const meta = providerFormMeta
    if (!draft || !meta) return
    const discovered = providerDiscovery ?? { models: [], failed: true }
    settingsView = { kind: 'provider-models', draft: true, parentSelection: settingsView.parentSelection ?? 0, selection }
    app.openSettings(draftModelItems(draft, discovered.models, {
      failed: discovered.failed,
      error: discovered.error,
      providerId: draft.route,
    }), {
      title: (meta.title ?? draft.route) + ' · ' + t('model.models').toLowerCase(),
      subtitle: (discovered.failed ? t('model.fetchUnavailable') : t('model.fetchOk')) + ' · ' + t('model.editHint'),
    })
    app.setSettingsSelection(Math.min(selection, Math.max(0, app.settingsItems.length - 1)))
    paint()
  }

  function toggleDraftModel(item) {
    const draft = { ...providerDraft }
    if (item.checked) {
      draft.models = draft.models.filter((model) => modelEntryId(model) !== item.modelId)
    } else {
      const discovered = providerDiscovery?.models?.find((model) => modelEntryId(model) === item.modelId)
      const row = discovered ? adoptDiscovered(discovered) : undefined
      draft.models = [...draft.models, row ?? { id: item.modelId }]
    }
    providerDraft = draft
    const rows = draftModelItems(draft, providerDiscovery?.models ?? [], {
      failed: providerDiscovery?.failed === true,
      error: providerDiscovery?.error,
      providerId: draft.route,
    })
    // Keep the cursor on the row that was just toggled.
    const at = rows.findIndex((candidate) => candidate.modelId === item.modelId)
    renderDraftModelWindow(at >= 0 ? at : 0)
  }

  // ---- one model's entry ---------------------------------------------------
  // The WebUI's ModelListEditor edits a row's id, capacities and input
  // modalities in place; a terminal has one row of each, so the same fields live
  // in a form of their own. `target.kind` decides where a save lands: the
  // provider's saved list, or the create form's unsaved draft.
  let modelDraft = null
  let modelFormTarget = null

  function openModelForm(target, draft, selection = 0) {
    modelDraft = draft
    modelFormTarget = target
    renderModelForm(draft, target, selection)
  }

  function renderModelForm(draft, target, selection = app.settingsSelection) {
    const scroll = app.settingsScrollOffset
    modelDraft = draft
    modelFormTarget = target
    settingsView = { kind: 'model-form' }
    app.openSettings(buildModelFormItems(draft, { isNew: target.index < 0 }), {
      title: target.index < 0 ? t('model.form.add') : t('model.edit'),
      subtitle: t('provider.formSubtitle'),
    })
    app.setSettingsSelection(Math.min(selection, Math.max(0, app.settingsItems.length - 1)))
    app.settingsScrollOffset = scroll
    paint()
  }

  function commitModelField(item, value, selection) {
    const draft = { ...modelDraft }
    if (item.field === 'input') {
      draft.input = String(value).trim() === 'text + image' ? ['text', 'image'] : ['text']
    } else {
      draft[item.field] = value
    }
    renderModelForm(draft, modelFormTarget, selection)
  }

  // Open the editor for one row of the model window. A row that is not saved
  // yet opens in create mode, prefilled with what the endpoint advertised — so
  // "add this model, but with the capacities I know it has" is one pass.
  function editModelRow(item) {
    if (settingsView.kind === 'provider-models' && settingsView.draft === true) {
      const index = providerDraft.models.findIndex((model) => modelEntryId(model) === item.modelId)
      const discovered = providerDiscovery?.models?.find((model) => modelEntryId(model) === item.modelId)
      const seed = index >= 0 ? providerDraft.models[index] : adoptDiscovered(discovered) ?? { id: item.modelId }
      openModelForm({ kind: 'draft', index, providerId: providerDraft.route }, modelDraftFrom(seed), 0)
      return
    }
    const target = {
      kind: 'stored',
      settingsNs: item.settingsNs,
      providerPath: item.providerPath,
      storedModels: item.storedModels ?? [],
      revision: item.revision,
      index: typeof item.storedIndex === 'number' ? item.storedIndex : -1,
      providerId: item.providerId,
    }
    const seed = target.index >= 0 ? target.storedModels[target.index] : adoptDiscovered(item.candidate) ?? { id: item.modelId }
    openModelForm(target, modelDraftFrom(seed), 0)
  }

  // Back to the window the editor was opened from, re-reading the provider so
  // the rows reflect what was just written.
  async function returnToModelWindow(target) {
    if (!target) return
    if (target.kind === 'draft') {
      renderDraftModelWindow(0)
      return
    }
    await openProviderModels(target.providerId, 0)
  }

  async function saveModelForm() {
    const draft = modelDraft
    const target = modelFormTarget
    if (!draft || !target) return
    const existing = target.kind === 'draft'
      ? providerDraft.models.filter((_model, at) => at !== target.index)
      : target.storedModels.filter((_model, at) => at !== target.index)
    const failure = validateModelDraft(draft, { existing })
    if (failure !== undefined) {
      app.showToast(t('settings.error', { error: failure }), 'error')
      paint()
      return
    }
    try {
      if (target.kind === 'draft') {
        const entry = modelFromDraft(draft)
        const next = [...providerDraft.models]
        if (target.index >= 0) next[target.index] = entry
        else next.push(entry)
        providerDraft = { ...providerDraft, models: next }
        app.showToast(t('settings.saved'))
        await returnToModelWindow(target)
        return
      }
      await saveModelEntry(sharedSettings, target, draft)
      app.showToast(t('settings.saved'))
      await returnToModelWindow(target)
    } catch (error) {
      const conflict = error?.code === 'SETTINGS_CONFLICT'
      app.showToast(t('settings.error', { error: conflict ? t('settings.conflict') : formatError(error) }), 'error')
      paint()
    }
  }

  async function removeModelForm() {
    const target = modelFormTarget
    if (!target || target.index < 0) return
    try {
      if (target.kind === 'draft') {
        providerDraft = { ...providerDraft, models: providerDraft.models.filter((_model, at) => at !== target.index) }
      } else {
        await removeModelEntry(sharedSettings, target)
      }
      app.showToast(t('model.removed'), 'info')
      await returnToModelWindow(target)
    } catch (error) {
      app.showToast(t('settings.error', { error: formatError(error) }), 'error')
      paint()
    }
  }

  // Delete inside the model window: same writes as the editor's remove action,
  // without opening it first.
  async function removeModelInWindow({ item, draft }) {
    if (draft === true) {
      providerDraft = { ...providerDraft, models: providerDraft.models.filter((model) => modelEntryId(model) !== item.modelId) }
      app.showToast(t('model.removed'), 'info')
      renderDraftModelWindow(Math.max(0, app.settingsSelection - 1))
      return
    }
    try {
      await removeModelEntry(sharedSettings, {
        settingsNs: item.settingsNs,
        providerPath: item.providerPath,
        storedModels: item.storedModels ?? [],
        revision: item.revision,
        index: item.storedIndex,
      })
      app.showToast(t('model.removed'), 'info')
      await openProviderModels(item.providerId, Math.max(0, app.settingsSelection - 1))
    } catch (error) {
      app.showToast(t('settings.error', { error: formatError(error) }), 'error')
      paint()
    }
  }

  // ---- MCP settings tab ----------------------------------------------------
  // The config files are re-read for every render, so a server added, edited or
  // removed by another process — or by the model through the bundled skill
  // above — shows up without restarting anything.

  let mcpFormDraft = emptyDraft()
  let mcpFormIsEdit = false
  // The files the current page was read from and their mtime/size signature:
  // the poll above compares against it to notice an external write.
  let mcpFiles = []
  let mcpFileSignature = ''
  let mcpPollBusy = false
  // A signature of the rows the page last drew. The poll rebuilds the list twice
  // a second; without this every rebuild painted a frame identical to the one on
  // screen, which is most of what made the tab feel busy while a server was
  // still connecting.
  let mcpItemsSignature = ''
  // The tick count since the tool lists were last re-probed. Enumerating every
  // tool schema in the agent scope is the expensive half of a refresh, and a
  // connected server rarely changes its tools, so it runs on a slow beat
  // instead of on every poll.
  let mcpRefreshTicks = 0
  const MCP_REFRESH_TICKS = 10

  function mcpRowSignature(items) {
    return items.map((item) => [item.kind, item.label, item.value, item.tone ?? '', item.indent ?? 0].join('\u0000')).join('\u0001')
  }

  // The working directory this session's MCP servers are scoped to. On the
  // title screen (no live agent) the process directory is the honest stand-in.
  function mcpCwd() {
    return currentAgent?.session?.header?.cwd ?? process.cwd()
  }

  async function mcpFilesSignature(files) {
    const parts = []
    for (const file of files) {
      try {
        const info = await stat(file.path)
        parts.push(file.path + ':' + info.mtimeMs + ':' + info.size)
      } catch {
        // A missing file is a state of its own ("not created yet"), and it is
        // exactly the state that changes when a server is first written.
        parts.push(file.path + ':-')
      }
    }
    return parts.join('|')
  }

  // Re-render the MCP list. The selection and scroll offset are carried over:
  // the connection poll rebuilds these items while the page is open, and a
  // repaint must never move the row the user is on.
  //
  // `quiet` is the poll's mode: rebuild the rows only when they differ from what
  // is already drawn, and report whether they did through the return value.
  async function renderMcpList({ quiet = false } = {}) {
    const selection = app.settingsSelection
    const scroll = app.settingsScrollOffset
    let loaded
    try {
      loaded = await loadMcpSettings(ctx, mcpManager, { cwd: mcpCwd() })
    } catch (error) {
      app.showToast(t('session.mcpError', { error: formatError(error) }), 'error')
      paint()
      return false
    }
    // The user can leave the tab while the files are being read.
    if (settingsView.kind !== 'mcp') return false
    const signature = mcpRowSignature(loaded.items)
    if (quiet && signature === mcpItemsSignature) {
      mcpFiles = loaded.files ?? []
      return false
    }
    mcpItemsSignature = signature
    app.openSettings(loaded.items, {
      title: loaded.title,
      subtitle: loaded.subtitle,
      menu: loaded.menu,
      menuIndex: loaded.menuIndex,
    })
    app.setSettingsSelection(Math.min(selection, Math.max(0, app.settingsItems.length - 1)))
    app.settingsScrollOffset = scroll
    mcpFiles = loaded.files ?? []
    return true
  }

  // The file-change half of the poll: re-read, and when the on-disk content
  // changed, remount so a server added from outside this process (the model
  // writing the config, an editor saving it) actually connects.
  async function pollMcpList() {
    if (mcpPollBusy) return
    mcpPollBusy = true
    try {
      const filesBefore = mcpFileSignature
      const rowsBefore = mcpItemsSignature
      await renderMcpList({ quiet: true })
      if (settingsView.kind !== 'mcp') return
      mcpFileSignature = await mcpFilesSignature(mcpFiles)
      if (mcpFileSignature !== filesBefore) {
        await mcpManager.sync()
        await renderMcpList()
        paint()
        return
      }
      // A row that changed (a mount that settled, a server that dropped) is
      // worth a frame; an unchanged page is worth none.
      if (mcpItemsSignature !== rowsBefore) paint()
    } catch {
      // A failed poll is a stale page, never a broken session; the next tick
      // retries.
    } finally {
      mcpPollBusy = false
    }
  }

  function renderMcpForm(draft, isEdit, selection = app.settingsSelection) {
    const scroll = app.settingsScrollOffset
    mcpFormDraft = draft
    mcpFormIsEdit = isEdit
    settingsView = { kind: 'mcp-form' }
    app.openSettings(buildMcpFormItems(draft, { isEdit }), {
      title: isEdit ? t('mcp.titleEdit') : t('mcp.titleAdd'),
      subtitle: t('mcp.editSubtitle'),
    })
    app.setSettingsSelection(Math.min(selection, Math.max(0, app.settingsItems.length - 1)))
    app.settingsScrollOffset = scroll
    paint()
  }

  // Read the files again and remount, then redraw the page: the shared tail of
  // every write path (save, remove, scope move).
  async function reloadMcpAndSync() {
    const loaded = await loadMcpSettings(ctx, mcpManager, { cwd: mcpCwd() })
    mcpFiles = loaded.files ?? []
    // A write invalidates whatever the poll last compared against: the rows it
    // holds are the pre-write ones, and a matching signature would let the
    // quiet poll keep them.
    mcpItemsSignature = ''
    await mcpManager.sync()
    mcpFileSignature = await mcpFilesSignature(mcpFiles)
  }

  function openMcpForm(entry) {
    const isEdit = Boolean(entry?.name)
    // An add starts from the empty draft; `draftFromEntry` renders a stored
    // record's env/headers back as JSON text and is only meaningful with one.
    const draft = isEdit ? draftFromEntry(entry) : emptyDraft()
    // Where the record lives decides the scope rows: an entry read from a
    // project file opens as path-scoped on that directory (draftFromEntry
    // already resolved it from the source path).
    if (isEdit) draft.scope = entry.scope === 'path' ? 'path' : 'user'
    // Start on the first row that does something. The list's own selection is
    // meaningless here — the form is a different item list — so inheriting it
    // would drop the cursor on an arbitrary field.
    const items = buildMcpFormItems(draft, { isEdit })
    const start = items.findIndex((item) => item.kind === 'mcp-field' && !item.disabled)
    renderMcpForm(draft, isEdit, Math.max(0, start))
  }

  // The file a draft would be written to; '' when a path-scoped draft has no
  // usable path yet (validation reports that, not this helper).
  function mcpTargetPath(draft) {
    if (draft.scope !== 'path') return userConfigPath()
    const directory = String(draft.path ?? '').trim()
    return directory === '' ? '' : pathConfigPath(resolve(directory))
  }

  // Windows paths are case-insensitive, so a scope change has to be recognized
  // as a move even when only the path's case differs.
  function samePath(left, right) {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase()
  }

  // The inline text edit writes straight into the form draft and only "Save"
  // touches storage. Switching type or scope changes which rows exist, so the
  // form is rebuilt around the same cursor position.
  function commitMcpField(item, value, selection = app.settingsSelection) {
    const draft = { ...mcpFormDraft }
    if (item.field === 'enabled') draft.enabled = value !== 'off'
    else draft[item.field] = value
    mcpFormDraft = draft
    renderMcpForm(draft, mcpFormIsEdit, selection)
  }

  async function saveMcpForm() {
    const draft = mcpFormDraft
    const cwd = mcpCwd()
    // One read serves both the duplicate-name check and the move check; a read
    // failure only costs the duplicate warning.
    let collected = { servers: [] }
    try { collected = await collectServers(cwd) } catch { /* reported on save */ }
    const existing = collected.servers.filter((entry) => entry.name !== draft.originalName)
    const result = validateDraft(draft, { existing })
    if (!result.ok) {
      app.showToast(t('session.mcpError', { error: result.error }), 'error')
      paint()
      return
    }
    try {
      const original = draft.originalName
      const target = original ? mcpTargetPath(draft) : ''
      const current = original ? collected.servers.find((entry) => entry.name === original) : null
      await saveDraft({ cwd, draft })
      // Changing scope while editing moves the record: the new file has it now,
      // so the old one is dropped. Writing first means a failed write leaves the
      // original untouched — and the removal names the old document explicitly,
      // because resolving by name would now find the copy just written.
      if (original && current?.sourcePath && target && !samePath(current.sourcePath, target)) {
        await removeServer({ cwd, name: original, sourcePath: current.sourcePath })
      }
      await reloadMcpAndSync()
      app.showToast(original ? t('mcp.saved') : t('mcp.added'), 'info')
      await openSettingsTab('mcp', menuSelections.mcp ?? 0)
    } catch (error) {
      app.showToast(t('session.mcpError', { error: formatError(error) }), 'error')
      await openSettingsTab('mcp', menuSelections.mcp ?? 0)
    }
  }

  async function removeMcpServer(name) {
    const cwd = mcpCwd()
    try {
      await removeServer({ cwd, name })
      await reloadMcpAndSync()
      app.showToast(t('mcp.removed'), 'info')
    } catch (error) {
      app.showToast(t('session.mcpError', { error: formatError(error) }), 'error')
    }
    await openSettingsTab('mcp', menuSelections.mcp ?? 0)
  }

  function openSettingChoices(item, parentSelection) {
    if (!Array.isArray(item.options) || item.options.length === 0) {
      app.showToast(t('settings.noOptions', { label: item.label }), 'warn')
      paint()
      return
    }
    // A committed option, and Esc, both return to the view the list was opened
    // from. Deriving it from that view keeps a list opened inside the MCP form
    // (transport, enabled) coming back to the form instead of dumping the user
    // on the Main tab with the draft lost.
    const parent = settingsView.kind === 'choice' ? settingsView.parent : settingsView.kind
    settingsView = { kind: 'choice', parentSelection, parent }
    const settingItem = { ...item, returnSelection: parentSelection }
    // Options are either plain strings (label and value are the same id) or
    // { label, value } objects when the label carries capability markers that
    // must not leak into the committed value.
    const options = item.options.map((option) =>
      typeof option === 'object' && option !== null && 'value' in option
        ? { label: option.label, value: option.value }
        : { label: option, value: option })
    const items = options.map(({ label, value }) => ({
      kind: 'setting-option',
      label,
      value: value === item.value ? 'selected' : '',
      optionValue: value,
      settingItem,
      // Sensitive options (e.g. unrestricted access) confirm in place before
      // the choice is committed.
      confirm: item.confirmValue === value ? (item.confirmText ?? t('settings.confirmChange')) : undefined,
      disabled: false,
    }))
    app.openSettings(items, { title: item.label, subtitle: t('settings.optionList') })
    app.setSettingsSelection(Math.max(0, options.findIndex(({ value }) => value === item.value)))
    paint()
  }

  function requestSettingCommit(item, value) {
    if (item.confirmValue === value || item.kind === 'remove-provider') {
      app.settingsConfirm = { item, value, text: item.confirmText ?? t('settings.confirmChange') }
      paint()
      return
    }
    void commitSetting(value, item)
  }

  // Re-run the registry checks and rebuild the Update page in place. The page
  // keeps its selection; openSettingsTab shows the loading placeholder and
  // drives the busy spinner.
  async function checkUpdatesNow() {
    if (app.settingsBusy) return
    await openSettingsTab('update', app.settingsSelection)
  }

  // The version picker sub-view for one package (dsh / dsh-oc-tui): fetch the
  // registry versions and list them newest first with tag + installed markers.
  async function openUpdateVersions(pkg) {
    const version = ++settingsLoadVersion
    const parentSelection = app.settingsSelection
    settingsView = { kind: 'update-versions', pkg, parentSelection }
    const pkgLabel = pkg === 'dsh' ? DSH_PACKAGE : TUI_PACKAGE
    app.openSettings([{ kind: 'update-version-loading', label: t('update.fetchingVersions'), value: '', disabled: true }], {
      title: pkgLabel + ' · ' + t('update.versions').toLowerCase(),
      subtitle: t('update.fetching'),
    })
    paint()
    let registry
    try {
      const t0 = Date.now()
      registry = await registryInfo(pkg === 'dsh' ? DSH_PACKAGE : TUI_PACKAGE)
    } catch (error) {
      if (version !== settingsLoadVersion) return
      app.showToast(t('session.versionsError', { error: formatError(error) }), 'error')
      await openSettingsTab('update', parentSelection)
      return
    }
    if (version !== settingsLoadVersion || settingsView.kind !== 'update-versions' || settingsView.pkg !== pkg) return
    const installed = pkg === 'dsh' ? (updateState?.dsh?.installed ?? null) : (updateState?.tui?.installed ?? null)
    const staged = updateState?.staged
    app.openSettings(buildVersionItems(registry, installed, {
      // Tarballs already on disk make a rollback (or a retry) instant — the
      // rows say so, and stageInstall verifies a cache hit instead of trusting
      // it.
      cached: cachedTarballVersions(pkg === 'dsh' ? DSH_PACKAGE : TUI_PACKAGE),
      staged: staged && staged.pkg === pkg ? staged.version : null,
    }), {
      title: pkgLabel + ' · ' + t('update.versions').toLowerCase(),
      subtitle: t('update.versionsSubtitle'),
    })
    app.setSettingsSelection(0)
    paint()
  }

  // Inline y/n confirm before switching a version. For a locally-installed TUI
  // the copy warns that the local path install becomes a registry version; a
  // tarball already on disk (from this run or an earlier one) skips the
  // download and goes straight to the restart.
  function requestUpdateInstall(item) {
    const pkg = settingsView.pkg
    const target = item.version
    const label = pkg === 'dsh' ? DSH_PACKAGE : TUI_PACKAGE
    let text = item.cached === true
      ? t('update.restartApplyQ', { label, version: target })
      : t('update.downloadQ', { label, version: target })
    if (pkg === 'tui' && updateState?.profile && tuiInstallIsLocal(updateState.profile)) {
      text += t('update.localSwitch')
    }
    app.settingsConfirm = { item, value: target, text, updateInstall: { pkg, version: target } }
    paint()
  }

  // ---- download + restart to apply ---------------------------------------
  // The update path never installs inline. The tarball is downloaded here with
  // live progress and staged under $DSH_HOME/updates; applying it is a
  // restart. A detached applier waits for this process to exit, installs from
  // the staged tarball (so no npm/pnpm write ever races a live dsh), verifies
  // the on-disk version, writes the install marker, then relaunches dsh in this
  // terminal. Esc aborts an in-flight download.

  function updatePackageLabel(pkg) {
    return pkg === 'dsh' ? DSH_PACKAGE : TUI_PACKAGE
  }

  // Everything the applier needs, resolved while this process is still alive
  // and can see both trees (the global install and the profile).
  function buildApplyPlan(record) {
    const profile = record.profile ?? updateState?.profile ?? 'tui'
    const dshEntry = updateState?.dsh?.entry ?? null
    const args = dshProcessArgs()
    return restartPlan({
      pkg: record.pkg,
      packageName: record.packageName ?? updatePackageLabel(record.pkg),
      version: record.version,
      tarball: record.tarball,
      profile,
      cwd: record.cwd ?? process.cwd(),
      verifyPath: record.pkg === 'dsh' ? dshManifestPath() : tuiInstalledManifestPath(profile),
      marker: installMarkerPath(),
      dsh: dshEntry ? { command: process.execPath, args: [dshEntry] } : null,
      dshShim: dshShimPath(),
      dshArgs: args,
      relaunch: dshEntry ? { command: process.execPath, args: [dshEntry, ...args] } : null,
    })
  }

  async function startUpdateInstall(pkg, version) {
    if (app.settingsBusy || updateDownload) return
    const label = updatePackageLabel(pkg)
    const cachePath = tarballCachePath(label, version)
    const load = ++settingsLoadVersion
    settingsView = { kind: 'update-download', pkg, version, parentSelection: app.settingsSelection }
    app.settingsBusy = true
    app.openSettings([
      { kind: 'header', label: t('update.download'), value: '', disabled: true },
      { kind: 'update-progress', label, value: t('update.contacting'), percent: null, disabled: true },
      { kind: 'update-info', label: t('update.version'), value: version, disabled: true },
      { kind: 'update-info', label: t('update.savingTo'), value: cachePath, disabled: true },
    ], {
      title: label + ' · ' + t('update.download').toLowerCase(),
      subtitle: t('update.escCancels'),
    })
    app.setSettingsSelection(1)
    paint()
    const controller = new AbortController()
    const progressRow = app.settingsItems.find((item) => item.kind === 'update-progress')
    updateDownload = { pkg, version, label, controller, progressRow }
    const onProgress = ({ received, total }) => {
      const progress = formatDownloadProgress(received, total)
      if (progressRow) {
        progressRow.value = progress.text
        progressRow.percent = progress.percent
      }
      app.settingsSubtitle = version + ' · ' + progress.text
      paint()
    }
    try {
      const record = await stageInstall({
        pkg,
        version,
        profile: updateState?.profile ?? 'tui',
        cwd: process.cwd(),
        onProgress,
        signal: controller.signal,
      })
      updateDownload = null
      app.settingsBusy = false
      updateState = updateState ? { ...updateState, staged: record } : updateState
      if (load !== settingsLoadVersion) {
        // The user navigated away while the last chunk was landing.
        app.showToast(t('update.downloadedToast', { label, version }))
        paint()
        return
      }
      app.settingsSubtitle = t('update.downloaded')
      app.settingsConfirm = {
        item: progressRow ?? { kind: 'update-progress', label, disabled: true },
        value: '',
        text: t(record.cached ? 'update.alreadyDownloadedConfirm' : 'update.downloadedConfirm', { label, version }),
        updateRestart: record,
      }
      paint()
    } catch (error) {
      updateDownload = null
      app.settingsBusy = false
      if (controller.signal.aborted) app.showToast(t('update.downloadCancelled'))
      else app.showToast(t('update.downloadFailed', { error: formatError(error) }), 'error')
      if (load === settingsLoadVersion) await openSettingsTab('update', settingsView.parentSelection ?? 0)
      paint()
    }
  }

  // Apply a staged install by restarting. The applier is spawned *before* the
  // shutdown so a spawn failure can still be reported; it only polls this pid,
  // so nothing is installed until this process is really gone.
  async function restartToApply(record) {
    if (app.settingsBusy) return
    const label = record.packageName ?? updatePackageLabel(record.pkg)
    if (!record.tarball) {
      app.showToast(t('update.stagedGone'), 'error')
      paint()
      return
    }
    // A global install (or profile reinstall) over another live dsh is the
    // hybrid-tree hazard; refuse while any other dsh process is alive.
    const locks = await detectDshLocks(process.pid)
    if (locks.length > 0) {
      app.showToast(tn('update.locks', locks.length, { count: locks.length }), 'error')
      paint()
      return
    }
    const plan = buildApplyPlan(record)
    if (record.pkg === 'dsh' && !plan.npm) {
      app.showToast(t('update.noNpm'), 'error')
      paint()
      return
    }
    if (record.pkg === 'tui' && !plan.dsh) {
      app.showToast(t('update.noDshCli'), 'error')
      paint()
      return
    }
    if (!spawnApplyUpdater(plan)) {
      app.showToast(t('update.installerFailed', { label }), 'error')
      paint()
      return
    }
    app.settingsConfirm = null
    app.settingsBusy = true
    app.showToast(t('update.applying', { label }))
    paint()
    // Graceful shutdown: confirm-to-quit still applies, and the applier starts
    // installing the moment this pid disappears.
    setTimeout(() => quit(), 250)
  }

  // Drop the staged download (the cached tarball stays for a later retry).
  function discardStagedDownload() {
    clearStagedInstall()
    if (updateState) updateState = { ...updateState, staged: null }
    app.showToast(t('update.stagedDiscarded'))
    void openSettingsTab('update', app.settingsSelection)
  }

  function handleSettingsKey(key) {
    if (settingsView.kind === 'sessions' && key.ctrl && key.name === 'd') {
      const item = app.settingsItems[app.settingsSelection]
      if (item?.kind === 'session') {
        if (app.settingsConfirm?.item === item) {
          // Second Ctrl+D confirms deletion of the selected session.
          app.settingsConfirm = null
          void deleteManagedSession(item)
        } else {
          app.settingsConfirm = { item, value: '', text: t('settings.deleteTwice') + item.label }
        }
      } else {
        app.showToast(t('settings.noSession'), 'warn')
      }
      paint()
      return
    }
    // The model window is a list of entries, not of settings fields: `e` opens
    // the highlighted one's editor and Delete drops it from the provider. Both
    // act on the entry, which is why they are keys of their own rather than
    // extra rows in a list that is already rows of models.
    if (settingsView.kind === 'provider-models') {
      const item = app.settingsItems[app.settingsSelection]
      if (item?.kind === 'model-toggle' && (key.name === 'e' || key.text === 'e')) {
        editModelRow(item)
        return
      }
      if (item?.kind === 'model-toggle' && (key.name === 'delete' || key.name === 'backspace')) {
        if (settingsView.draft === true) {
          app.settingsConfirm = { item, value: '', text: t('model.form.removeConfirm'), removeModel: { item, draft: true } }
        } else if (typeof item.storedIndex === 'number' && item.storedIndex >= 0) {
          app.settingsConfirm = { item, value: '', text: t('model.form.removeConfirm'), removeModel: { item, draft: false } }
        } else {
          // Nothing stored to remove: the row is an offer, not a saved entry.
          app.showToast(t('model.notSaved'), 'warn')
        }
        paint()
        return
      }
    }
    // Delete on a server row uninstalls it without opening the form first.
    if (settingsView.kind === 'mcp' && (key.name === 'delete' || key.name === 'backspace')) {      const item = app.settingsItems[app.settingsSelection]
      if (item?.kind === 'mcp-server' && item.record?.name) {
        if (app.settingsConfirm?.item === item) {
          app.settingsConfirm = null
          void removeMcpServer(item.record.name)
        } else {
          app.settingsConfirm = { item, value: '', text: t('settings.deleteMcpTwice') + item.record.name }
          paint()
        }
      } else {
        app.showToast(t('settings.noMcp'), 'warn')
        paint()
      }
      return
    }
    const count = app.settingsItems.length
    if (count === 0) {
      app.showToast(t('settings.noSessions'), 'warn')
      paint()
      return
    }
    if (app.settingsConfirm) {
      const pending = app.settingsConfirm
      if (pending.item.kind === 'session') {
        // Session deletion is confirmed by a second Ctrl+D; only Esc cancels.
        if (key.name === 'escape') {
          app.settingsConfirm = null
          paint()
        }
      } else if (pending.item.kind === 'mcp-server') {
        // A second Delete removes the server; anything else cancels the prompt.
        if (key.name === 'delete' || key.name === 'backspace') {
          app.settingsConfirm = null
          void removeMcpServer(pending.item.record.name)
        } else {
          app.settingsConfirm = null
          paint()
        }
      } else if (key.name === 'y' || key.text?.toLowerCase() === 'y' || key.name === 'return' || key.name === 'enter') {
        app.settingsConfirm = null
        if (pending.removeModel?.form === true) void removeModelForm()
        else if (pending.removeModel) void removeModelInWindow(pending.removeModel)
        else if (pending.updateInstall) void startUpdateInstall(pending.updateInstall.pkg, pending.updateInstall.version)
        else if (pending.updateRestart) void restartToApply(pending.updateRestart)
        else void commitSetting(pending.value, pending.commitItem ?? pending.item)
      } else if (key.name === 'n' || key.text?.toLowerCase() === 'n' || key.name === 'escape') {
        app.settingsConfirm = null
        paint()
      }
      return
    }
    if (app.settingsEditing !== null) {
      if (key.name === 'escape') {
        app.settingsEditing = null
        app.settingsDraft = ''
        app.settingsSecret = false
      } else if (key.name === 'return' || key.name === 'enter') {
        const item = app.settingsItems[app.settingsEditing]
        requestSettingCommit(item, app.settingsDraft)
        return
      } else if (key.name === 'backspace') {
        app.settingsDraft = Array.from(app.settingsDraft).slice(0, -1).join('')
      } else if (key.text !== undefined && !key.ctrl && !key.alt) {
        app.settingsDraft += key.text
      }
      // Typing into the picker's filter narrows the list under it immediately —
      // a 40-route catalog is only scannable if the filter bites per keystroke.
      if (settingsView.kind === 'provider-picker' && app.settingsEditing === 0) rebuildPicker(app.settingsDraft)
      paint()
      return
    }

    if (key.name === 'escape') {
      if (settingsView.kind === 'choice' && settingsView.parent === 'mcp-form') {
        // Backing out of the transport/enabled list keeps the half-filled form.
        renderMcpForm(mcpFormDraft, mcpFormIsEdit, settingsView.parentSelection)
      } else       if (settingsView.kind === 'choice' && settingsView.parent === 'provider-form') {
        // Same for a protocol pick inside the add-provider form.
        renderProviderForm(providerDraft, providerFormMeta, settingsView.parentSelection)
      } else if (settingsView.kind === 'choice' && settingsView.parent === 'model-form') {
        // ...and for the input-modalities pick inside the model editor.
        renderModelForm(modelDraft, modelFormTarget, settingsView.parentSelection)
      } else if (settingsView.kind === 'choice') void openSettingsTab(settingsView.parent, settingsView.parentSelection)
      else if (settingsView.kind === 'mcp-form') void openSettingsTab('mcp', menuSelections.mcp ?? 0)
      else if (settingsView.kind === 'model-form') {
        // Esc drops the edit and returns to the row list, which is where the
        // user came from.
        modelDraft = null
        void returnToModelWindow(modelFormTarget)
      } else if (settingsView.kind === 'provider-models' && settingsView.draft === true) {
        // The unsaved draft's model window belongs to the form, not the tab.
        renderProviderForm(providerDraft, providerFormMeta, settingsView.parentSelection ?? 0)
      } else if (settingsView.kind === 'provider-models') void openSettingsTab('model', settingsView.parentSelection ?? 0)
      else if (settingsView.kind === 'provider-form') {
        // Esc drops the draft. A draft that came from the picker goes back
        // there (another route is one Enter away, and its filter is kept); one
        // opened from the Model tab goes back to the tab.
        const fromPicker = providerFormMeta?.from === 'picker'
        const query = providerFormMeta?.query ?? ''
        providerDraft = null
        providerFormMeta = null
        providerDiscovery = null
        if (fromPicker) openProviderPicker(0, query)
        else void openSettingsTab('model')
      } else if (settingsView.kind === 'provider-picker') void openSettingsTab('model')
      else if (settingsView.kind === 'sessions') void openSettingsTab('main')
      else if (settingsView.kind === 'update-versions') void openSettingsTab('update', settingsView.parentSelection ?? 0)
      else if (settingsView.kind === 'update-download') {
        // Esc aborts the fetch; the staged record (if any) stays for later.
        const download = updateDownload
        updateDownload = null
        app.settingsBusy = false
        if (download) download.controller.abort()
        void openSettingsTab('update', settingsView.parentSelection ?? 0)
      } else app.overlay = null
    } else if (key.name === 'up') {
      app.moveSettingsSelection(-1)
    } else if (key.name === 'down') {
      app.moveSettingsSelection(1)
    } else if (key.name === 'tab' || key.name === 'shift-tab') {
      // On the menu tabs, Tab switches the left menu; everywhere else it
      // keeps moving the item list like Down.
      if ((settingsView.kind === 'main' || settingsView.kind === 'model' || settingsView.kind === 'update' || settingsView.kind === 'mcp') && app.settingsMenu.length > 0) {
        switchSettingsTab(app.settingsMenuIndex + (key.name === 'shift-tab' ? -1 : 1))
        return
      }
      app.moveSettingsSelection(key.name === 'shift-tab' ? -1 : 1)
    } else if (key.name === 'return' || key.name === 'enter') {
      const item = app.settingsItems[app.settingsSelection]
      if (item.kind === 'new-session') {
        void showTitleScreen()
        return
      }
      if (item.kind === 'manage-sessions') {
        void openSessionManager()
        return
      }
      if (item.kind === 'session') {
        void openSession({ resume: item.sessionId })
        return
      }
      if (item.kind === 'open-update') {
        void openSettingsTab('update')
        return
      }
      if (item.kind === 'update-check') {
        void checkUpdatesNow()
        return
      }
      if (item.kind === 'update-versions') {
        void openUpdateVersions(item.pkg)
        return
      }
      if (item.kind === 'update-restart') {
        void restartToApply(item.staged)
        return
      }
      if (item.kind === 'update-discard') {
        discardStagedDownload()
        return
      }
      if (item.kind === 'update-version') {
        requestUpdateInstall(item)
        return
      }
      if (item.kind === 'mcp-add') {
        openMcpForm(null)
        return
      }
      if (item.kind === 'mcp-server') {
        openMcpForm(item.record)
        return
      }
      if (item.kind === 'mcp-save') {
        void saveMcpForm()
        return
      }
      if (item.kind === 'mcp-remove') {
        if (app.settingsConfirm?.item === item) {
          app.settingsConfirm = null
          void removeMcpServer(item.serverName)
        } else {
          app.settingsConfirm = { item, value: '', text: item.confirmText ?? t('mcp.removeConfirm') }
        }
        paint()
        return
      }
      if (item.kind === 'setting-option') {
        if (item.confirm) {
          // Sensitive option: confirm in place before committing the choice.
          app.settingsConfirm = { item, value: item.optionValue, text: item.confirm, commitItem: item.settingItem }
          paint()
          return
        }
        settingsView = { kind: settingsView.parent }
        void commitSetting(item.optionValue, item.settingItem)
        return
      }
      if (item.kind === 'provider-add') {
        openProviderPicker(0)
        return
      }
      if (item.kind === 'provider-pick') {
        openCatalogProviderForm(item.providerId)
        return
      }
      if (item.kind === 'provider-pick-custom') {
        openCustomProviderForm()
        return
      }
      if (item.kind === 'provider-save') {
        void saveProviderForm()
        return
      }
      if (item.kind === 'provider-search') {
        // The filter row is a normal text edit; `rebuildPicker` narrows the list
        // under it as each character lands.
        app.settingsEditing = app.settingsSelection
        app.settingsSecret = false
        app.settingsDraft = String(settingsView.query ?? '')
        paint()
        return
      }
      if (item.kind === 'model-select-all') {
        if (settingsView.kind === 'provider-models' && settingsView.draft === true) {
          // The draft holds no selection yet, so "all" is exactly the endpoint's
          // answer; "none" clears what the fetch pre-picked.
          const draft = { ...providerDraft }
          draft.models = item.allPicked ? [] : mergeModelSelection([], providerDiscovery?.models ?? [])
          providerDraft = draft
          renderDraftModelWindow(0)
        } else {
          // The saved window writes through: one mutate for the whole list.
          void commitSetting(item.allPicked ? 'off' : 'on', item)
        }
        return
      }
      if (item.kind === 'model-add') {
        openModelForm({
          kind: settingsView.draft === true ? 'draft' : 'stored',
          providerId: item.providerId,
          settingsNs: item.settingsNs,
          providerPath: item.providerPath,
          storedModels: settingsView.draft === true ? providerDraft.models : (item.storedModels ?? []),
          revision: item.revision,
          index: -1,
        }, modelDraftFrom({ id: '' }), 0)
        return
      }
      if (item.kind === 'model-refresh') {
        // Ask the endpoint again — the reason a catalog can be empty the first
        // time is usually that it was not reachable yet.
        if (settingsView.kind === 'provider-models' && settingsView.draft === true) void openDraftModelWindow(0)
        else void openProviderModels(item.providerId, 0)
        return
      }
      if (item.kind === 'model-save') {
        void saveModelForm()
        return
      }
      if (item.kind === 'model-remove') {
        if (app.settingsConfirm?.item === item) {
          app.settingsConfirm = null
          void removeModelForm()
        } else {
          app.settingsConfirm = { item, value: '', text: item.confirmText ?? t('model.form.removeConfirm'), removeModel: { form: true } }
        }
        paint()
        return
      }
      if (item.kind === 'provider-models') {
        // Auto-fetch the provider's model catalog and open the selection
        // window.
        void openProviderModels(item.providerId)
        return
      }
      if (item.kind === 'provider-model') {
        // A listed model becomes the default route for its provider.
        void commitSetting(item.modelId, item)
        return
      }
      if (item.kind === 'model-toggle') {
        // A toggle in the unsaved draft's window edits the draft; one in the
        // saved provider's window writes straight through.
        if (settingsView.kind === 'provider-models' && settingsView.draft === true) toggleDraftModel(item)
        else void commitSetting(item.checked ? 'off' : 'on', item)
        return
      }
      // The add-provider form is a draft like the MCP form: a field commit lands
      // in the draft and re-renders, and only Save writes.
      if (settingsView.kind === 'provider-form' && item.kind === 'provider-field') {
        if (item.providerModels === true) {
          void openDraftModelWindow(0)
          return
        }
        if (!item.disabled && item.options?.length > 0) openSettingChoices(item, app.settingsSelection)
        else if (!item.disabled) {
          app.settingsEditing = app.settingsSelection
          app.settingsSecret = item.secret === true
          app.settingsDraft = item.secret === true ? '' : String(item.value ?? '')
        }
        paint()
        return
      }
      // The model editor is the same shape of draft.
      if (settingsView.kind === 'model-form' && item.kind === 'model-field') {
        if (!item.disabled && item.options?.length > 0) openSettingChoices(item, app.settingsSelection)
        else if (!item.disabled) {
          app.settingsEditing = app.settingsSelection
          app.settingsSecret = false
          app.settingsDraft = String(item.value ?? '')
        }
        paint()
        return
      }
      // Every choice item opens its option list - there is no inline
      // left/right value cycling.
      if (!item.disabled && item.options?.length > 0) {
        openSettingChoices(item, app.settingsSelection)
        return
      }
      if (!item.disabled && (item.kind === 'enable-provider' || item.kind === 'remove-provider')) {
        requestSettingCommit(item, '')
        return
      }
      if (settingsView.kind === 'mcp-form' && item.kind === 'mcp-field') {
        // Choice rows go through the shared option list; text rows through the
        // inline editor. Both land in commitMcpField via commitSetting.
        if (!item.disabled && item.options?.length > 0) openSettingChoices(item, app.settingsSelection)
        else if (!item.disabled) {
          app.settingsEditing = app.settingsSelection
          app.settingsSecret = false
          app.settingsDraft = String(item.value ?? '')
        }
        paint()
        return
      }
      if (!item.disabled) {
        app.settingsEditing = app.settingsSelection
        app.settingsSecret = item.kind === 'secret'
        app.settingsDraft = item.kind === 'secret' || item.value === 'system' || item.value === 'default' ? '' : item.value
      }
    }
    paint()
  }

  async function commitSetting(value, item = app.settingsItems[app.settingsSelection]) {
    const selection = item?.returnSelection ?? app.settingsSelection
    app.settingsEditing = null
    app.settingsDraft = ''
    app.settingsSecret = false
    // The MCP form is a draft, not a settings field: its commit writes into the
    // draft and re-renders, and only "Save and connect" touches storage. The
    // row that was edited is `returnSelection`; `app.settingsSelection` still
    // points into the option list that just closed.
    if (settingsView.kind === 'mcp-form' && item?.kind === 'mcp-field') {
      commitMcpField(item, value, selection)
      paint()
      return
    }
    // The add-provider form holds a draft, so its fields commit there and only
    // "Save provider" reaches the settings service.
    if (settingsView.kind === 'provider-form' && item?.kind === 'provider-field') {
      commitProviderField(item, value, selection)
      return
    }
    // The picker's filter row writes nothing either: it narrows the list it sits
    // above, and the query is kept on the view.
    if (settingsView.kind === 'provider-picker' && item?.kind === 'provider-search') {
      rebuildPicker(value, { editing: false })
      paint()
      return
    }
    if (settingsView.kind === 'model-form' && item?.kind === 'model-field') {
      commitModelField(item, value, selection)
      return
    }
    if (!sharedSettings || !item || (value.trim() === '' && !['path', 'enable-provider', 'remove-provider'].includes(item.kind))) {
      paint()
      return
    }
    try {
      if (item.kind === 'locale') {
        // The host announces a committed Config field as it writes it, and the
        // volatile-update handler stands down for the duration so the two
        // rebuilds cannot race (see the note where it is declared).
        localeCommitInFlight = true
        try {
          await saveWebSetting(ctx, sharedSettings, item, value)
        } finally {
          localeCommitInFlight = false
        }
        // A language switch repaints the whole interface from the new catalog, so
        // it lands before the settings view is rebuilt (the rebuilt rows are then
        // already in the new language).
        setLocale(resolveLocale(value))
        app.showToast(t('settings.languageSaved', { language: describeLocale(value) }))
        await refreshSettings(selection)
        paint()
        return
      }
      if (item.settingGroup === 'tui-theme') {
        themeCommitInFlight = true
        try {
          await saveWebSetting(ctx, sharedSettings, item, value)
        } finally {
          themeCommitInFlight = false
        }
        app.setTheme(value)
        app.showToast(t('settings.saved'))
        await refreshSettings(selection)
        paint()
        return
      }
      await saveWebSetting(ctx, sharedSettings, item, value)
      if (item.kind === 'provider-model') {
        modelPreference.provider = item.providerId
        modelPreference.model = item.modelId
        selectModel({ provider: item.providerId, model: item.modelId })
      }
      if (item.ns === 'agent-default-model' && item.field === 'model') {
        modelPreference.model = value
        selectModel({ model: value })
      }
      if (item.ns === 'agent-default-model' && item.field === 'provider') {
        const selection = defaultModelSelection()
        modelPreference.provider = selection?.provider ?? value
        modelPreference.model = selection?.model
        selectModel({ provider: modelPreference.provider, model: modelPreference.model ?? '' })
      }
      if (item.ns === 'agent-default-model' || item.kind === 'provider-model') void loadEffortSlider()
      if (item.settingGroup === 'tui-graphics') applyGraphicsSettings()
      // Applied to what is already drawn, so the row has a visible effect the
      // moment it is committed rather than on the next session.
      if (item.settingGroup === 'tui-dev') app.setContextDetails(value)
      app.showToast(item.kind === 'remove-provider' ? t('settings.providerRemoved') : t('settings.saved'))
      if (item.kind === 'remove-provider') await openSettingsTab('model')
      else await refreshSettings(selection)
    } catch (error) {
      const conflict = error?.code === 'SETTINGS_CONFLICT' ? t('settings.conflict') : formatError(error)
      app.showToast(t('settings.error', { error: conflict }), 'error')
      await refreshSettings(selection)
    }
  }

  function handleCtrlKey(name) {
    switch (name) {
      case 'c': {
        const action = interrupt.interrupt({
          running: app.status === 'running',
          hasInput: app.inputText.length > 0,
        })
        if (action === 'clear') {
          app.inputText = ''
          app.inputCursor = 0
          app.inputImages = []
          app.showToast(t('session.promptCleared'))
        } else if (action === 'cancel') {
          if (currentAgent) currentAgent.cancel({ kind: 'user' })
          app.showToast(t('session.interruptRequested'))
        } else if (action === 'arm-exit') {
          app.showToast(t('session.exitAgain'))
        } else if (action === 'exit') {
          quit(true)
          return
        }
        paint()
        break
      }
      case 'p': openSettings(); break
      case 'g': void openGitBranchOverlay(); break
      case 'd': quit(); break
      case 'n': {
        void showTitleScreen()
        break
      }
      case 'l': app.resetView(); paint(); break
      case 'u': app.inputText = ''; app.inputCursor = 0; app.inputImages = []; paint(); break
      case 'a': app.inputCursor = 0; paint(); break
      case 'e': toggleEffortSlider(); break
      case 'j': insert('\n'); break
      default: break
    }
  }

  async function takeScreenshot() {
    try {
      const screen = app.render()
      const images = new Map(term._imagePayloads)
      const path = await saveScreenshot(screen, {
        directory: readTuiSetting(ctx, config, 'tui-screenshot', 'directory'),
        title: 'Deepseek Harness TUI',
        images,
      })
      app.showCornerNotice(t('screenshot.saved'), path, 'success')
    } catch (error) {
      app.showCornerNotice(t('screenshot.failed'), formatError(error), 'error')
    }
    if (term.started) paint()
  }

  function historyBack() {
    if (app.history.length === 0) return
    if (app.historyIndex < 0) {
      app.historyIndex = app.history.length - 1
      app.inputText = app.history[app.historyIndex]
    } else if (app.historyIndex > 0) {
      app.historyIndex--
      app.inputText = app.history[app.historyIndex]
    }
    app.inputImages = []
    app.inputCursor = app.inputText.length
    paint()
  }
  function historyForward() {
    if (app.historyIndex < 0) return
    app.historyIndex++
    if (app.historyIndex >= app.history.length) {
      app.historyIndex = -1
      app.inputText = ''
    } else {
      app.inputText = app.history[app.historyIndex]
    }
    app.inputImages = []
    app.inputCursor = app.inputText.length
    paint()
  }

  // ---- submit / commands --------------------------------------------------

  // The provider/model pair the next request actually routes to: an explicit
  // /model or /provider override wins, then the persisted agent-default-model
  // selection, then the session header shown in the status bar. This mirrors
  // the agent/request waterfall that applies the same preference below.
  function effectiveRoute() {
    const selection = defaultModelSelection()
    return {
      provider: modelPreference.provider ?? selection.provider ?? app.provider,
      model: modelPreference.model ?? selection.model ?? app.model,
    }
  }

  // The current route's model name when it explicitly refuses image input, or
  // null when the route is unknown, image-capable, or its capability cannot be
  // resolved — the adapter stays the authority for those cases.
  async function currentModelRejectsImages() {
    const llm = ctx.get('llm')
    const { provider, model } = effectiveRoute()
    if (!llm?.resolveModelInfo || !provider || !model) return null
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.inputModalities !== undefined && !info.inputModalities.includes('image') ? model : null
    } catch {
      return null
    }
  }

  // Reconstruct ordered user content from the submitted text. `[Image N]`
  // markers resolve to saved attachments; markers whose attachment failed to
  // save are preserved as literal text so no user input silently disappears.
  async function buildUserContent(text, images) {
    const resolved = await Promise.all(images.map((img) => {
      if (img.status === 'ready') return Promise.resolve(img.ref)
      if (img.status === 'pending' && img.promise) return img.promise.catch(() => null)
      return Promise.resolve(null)
    }))
    return userContentBlocks(text, resolved)
  }

  async function sendMessage(text, images = []) {
    if (!currentAgent) return
    const wasRunning = app.status === 'running'
    // The optimistic block renders images straight from the paste bytes — no
    // attachment read-back needed; the matching event attaches nothing but the
    // steering badge, which only it can know.
    rememberUserEcho(stripImageMarkers(text), images.some((img) => img.status === 'ready' || img.status === 'pending'))
    app.addUser(text, {
      images: images
        .filter((img) => img.data || usableRef(img))
        .map((img) => img.data
          ? { kind: 'bytes', key: sha16(img.data), bytes: img.data, mediaType: img.mediaType }
          : { kind: 'ref', key: 'ref:' + img.ref.attachmentId, ref: img.ref, mediaType: img.mediaType }),
    })
    app.setStatus('running')
    const content = await buildUserContent(text, images)
    const message = createUserMessage({
      content: content.length > 0 ? content : [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    // `settings.get(ns)` exists on the 0.1.x namespace provider; the 0.2.0 form
    // service dropped it and carries the same preference as a Config field
    // instead, so the read goes through the generation-aware resolver.
    const busyEnter = readTuiSetting(ctx, config, 'ui-conversation', 'busyEnter') ?? 'queue'
    if (wasRunning && busyEnter === 'steer') currentAgent.steer(message)
    else currentAgent.followup(message)
    paint()
  }

  function usableRef(img) {
    return img.ref && typeof img.ref.attachmentId === 'string'
  }

  async function createSessionAndSend(text, images = []) {
    app.setStatus('running')
    paint()
    let pending = openingSession
    let pendingVersion = openingVersion
    if (!pending) {
      pending = openSession()
      pendingVersion = lifecycleVersion
      openingSession = pending
      openingVersion = pendingVersion
      void pending.finally(() => {
        if (openingSession === pending) {
          openingSession = null
          openingVersion = 0
        }
      })
    }
    const intendedVersion = lifecycleVersion
    if (await pending) {
      if (intendedVersion === lifecycleVersion) await sendMessage(text, images)
      return
    }
    if (intendedVersion === lifecycleVersion && intendedVersion !== pendingVersion && !currentAgent) {
      if (openingSession === pending) {
        openingSession = null
        openingVersion = 0
      }
      await createSessionAndSend(text, images)
    }
  }

  async function submit() {
    const text = app.inputText
    const images = app.inputImages
    if (text.trim() === '' && images.length === 0) return
    // A message the current route cannot serve is discarded outright before it
    // is committed: it is dropped from the composer and never reaches the
    // durable session, so a failed image send cannot poison later resends or
    // model switches with the same replayable adapter error.
    if (!text.startsWith('/') && images.length > 0) {
      const content = await buildUserContent(text, images)
      if (contentHasImage(content)) {
        const refusing = await currentModelRejectsImages()
        if (refusing !== null) {
          app.inputText = ''
          app.inputCursor = 0
          app.inputImages = []
          app.showToast(t('session.modelNoImages', { model: refusing }), 'error')
          paint()
          return
        }
      }
    }
    app.history.push(text)
    if (app.history.length > 200) app.history.shift()
    app.historyIndex = -1
    app.inputText = ''
    app.inputCursor = 0
    app.inputImages = []
    if (text.startsWith('/')) {
      void runCommand(text)
      return
    }
    if (!currentAgent) {
      await createSessionAndSend(text, images)
      return
    }
    await sendMessage(text, images)
  }

  async function runCommand(line, onFeedback) {
    const parsed = parseCommand(line)
    if (!parsed) return
    // Command feedback is a transcript line inside a session and a toast on
    // the title screen, where a system block would hide the welcome view.
    // `onFeedback` lets the std runtime capture the same text it would show.
    const feedback = (text, level = 'info') => {
      if (currentAgent) app.addSystem(text, level)
      else app.showToast(text, level)
      if (onFeedback) onFeedback(text, level)
      paint()
    }
    // Let the harness own its human commands (/compact, /goal, /model…). On
    // the title screen there is no receiving agent for them, so a registered
    // harness command is reported instead of being dropped silently.
    if (!TUI_EXCLUSIVE_COMMANDS.has(parsed.name)
        && ctx.commands.find(currentAgent ?? undefined, parsed.name)) {
      if (!currentAgent) {
        app.showToast('/' + parsed.name + ': ' + t('session.startFirst'), 'warn')
        paint()
        return
      }
      try {
        const res = await ctx.commands.execute(currentAgent, line, [], new AbortController().signal)
        if (res?.result?.kind === 'error') {
          app.addSystem('/' + parsed.name + ': ' + res.result.text, 'error')
        } else if (res?.result?.text) {
          app.addSystem('/' + parsed.name + ': ' + res.result.text, 'info')
        }
      } catch (error) {
        app.addSystem('/' + parsed.name + ': ' + formatError(error), 'error')
      }
      paint()
      return
    }
    switch (parsed.name) {
      case 'settings':
        openSettings()
        break
      case 'help':
        app.overlay = 'help'
        app.statsOpen = false
        paint()
        break
      case 'stats': {
        // The details window needs a session: its figures describe a durable
        // log, and the title screen has none.
        if (!currentAgent) {
          feedback(t('session.startFirst'), 'warn')
          break
        }
        app.statsOpen = !app.statsOpen
        paint()
        break
      }
      case 'new': void showTitleScreen(); break
      case 'resume': {
        const id = parsed.rawInput.trim()
        if (!id) {
          feedback(t('session.usageResume'), 'warn')
          break
        }
        void openSession({ resume: id })
        break
      }
      case 'model': {
        const id = parsed.rawInput.trim()
        if (!id) {
          feedback(t('session.currentModel', { model: modelPreference.model || app.model }), 'info')
          break
        }
        modelPreference.model = id
        selectModel({ model: id })
        const message = t('session.modelSet', { model: id })
        app.showToast(message, 'info')
        if (onFeedback) onFeedback(message, 'info')
        paint()
        void loadEffortSlider()
        break
      }
      case 'provider': {
        const id = parsed.rawInput.trim()
        if (!id) {
          feedback(t('session.currentProvider', { provider: modelPreference.provider || app.provider }), 'info')
          break
        }
        modelPreference.provider = id
        selectModel({ provider: id })
        const message = t('session.providerSet', { provider: id })
        app.showToast(message, 'info')
        if (onFeedback) onFeedback(message, 'info')
        paint()
        void loadEffortSlider()
        break
      }
      case 'clear':
        app.resetView()
        paint()
        break
      case 'cancel': {
        if (currentAgent && app.status === 'running') {
          currentAgent.cancel({ kind: 'user' })
          app.showToast(t('session.interruptRequested'))
        } else {
          app.showToast(currentAgent ? t('session.nothingToInterrupt') : t('session.noSessionRunning'), 'warn')
        }
        paint()
        break
      }
      case 'quit':
      case 'exit': quit(); break
      case 'rewind': {
        void (async () => {
          if (!currentAgent) {
            feedback(t('session.startFirst'), 'warn')
            return
          }
          const parsedArgs = parseRewindArgs(parsed.rawInput)
          if (parsed.rawInput.trim() === '') {
            openRewindOverlay()
            return
          }
          try {
            const point = resolvePoint(listRewindPoints(sessionEvents(currentAgent.session)), parsedArgs.selector)
            await applyRewindChoice({ n: point.n, seq: point.seq }, parsedArgs.mode)
          } catch (error) {
            feedback('/rewind: ' + formatError(error), 'error')
          }
        })()
        break
      }
      case 'branch': {
        // The window is the title screen's; inside a session the call answers
        // with the same toast the Ctrl+G shortcut does, and opens nothing.
        void openGitBranchOverlay()
        break
      }
      default:
        feedback(t('session.unknownCommand', { name: parsed.name }), 'warn')
    }
  }

  async function listSessionsCommand() {
    const sq = ctx.get('sessionQuery')
    if (!sq) {
      app.addSystem(t('session.queryMissing'), 'warn')
      paint()
      return
    }
    try {
      const records = await sq.listSessions()
      const top = records.filter((r) => r.header.origin !== 'subagent').slice(0, 40)
      const results = await sq.readTitleSnapshots(top.map((r) => r.header.id))
      const lines = top.map((r, i) => {
        const res = results[i]
        const title = res?.status === 'fulfilled' && res.value.title
          ? res.value.title.title
          : String(r.header.id)
        return timeString(r.header.createdAt) + '  ' + String(r.header.id).slice(0, 20).padEnd(20, ' ')
          + '  ' + title
      })
      app.addSystem(lines.length > 0 ? t('session.listHeader') + '\n' + lines.join('\n') : t('session.noPersisted'), 'info')
    } catch (error) {
      app.addSystem(t('session.listFailed', { error: formatError(error) }), 'error')
    }
    paint()
  }

  function quit(alreadyRequested = false) {
    if (!alreadyRequested && !interrupt.requestExit()) return
    term.stop()
    const exit = ctx.get('appExit')
    // Disconnect the MCP servers first: each one may own a child process that
    // has to be closed before the harness home stops being writable.
    void mcpManager.detachAgent()
    const cleanup = handle ? handle.dispose().catch(() => undefined) : Promise.resolve()
    cleanup.finally(() => {
      if (exit) exit(0)
      else process.exit(0)
    })
  }

  // ---- startup -----------------------------------------------------------

  if (startup.resume) {
    void openSession({ resume: startup.resume }).then(() => refreshRecentSessions())
  } else {
    void showTitleScreen()
    void refreshRecentSessions()
  }
  void loadEffortSlider()

  // ---- startup update check ----------------------------------------------
  // Two seconds after boot (settings service settled): unless the user turned
  // it off, check dsh + dsh-oc-tui against the registry and toast stable
  // updates. Network failures are silently ignored — the Update page has a
  // manual "Check now".
  async function startupUpdateCheck() {
    if ((readTuiSetting(ctx, config, 'tui-updates', 'startupCheck') ?? 'on') !== 'on') return
    const dshInstall = detectDshInstall()
    const tuiInstalled = tuiInstalledVersion()
    const [dshReg, tuiReg] = await Promise.all([
      registryInfo(DSH_PACKAGE).catch(() => null),
      registryInfo(TUI_PACKAGE).catch(() => null),
    ])
    const available = []
    if (dshInstall.found && dshInstall.version && dshReg) {
      const status = updateStatus(dshInstall.version, dshReg)
      if (status.kind === 'available') available.push('dsh ' + status.target)
    }
    if (tuiInstalled && tuiReg) {
      const status = updateStatus(tuiInstalled, tuiReg)
      if (status.kind === 'available') available.push('dsh-oc-tui ' + status.target)
    }
    if (available.length > 0) {
      app.showToast(t('session.updatesAvailable', { list: available.join(' · ') }))
      paint()
    }
  }

  const startupCheckTimer = setTimeout(() => { void startupUpdateCheck() }, 2000)

  // ---- @dsh-std interop surface -------------------------------------------
  // The facet (lib/facet.js) forwards standard protocol calls here. This is the
  // only place the TUI advertises itself; the facet owns no lifecycle of its
  // own, which is what keeps the adapter from activating the TUI twice.

  // runCommand reports through the transcript/toast and returns nothing; the
  // std runtime needs the outcome. This wrapper captures the feedback that
  // runCommand would have shown and returns it as the standard's result shape,
  // without changing what the user sees.
  async function runCommandResult(line, parsed) {
    const captured = []
    const capture = (text, level = 'info') => { captured.push({ text, level }) }
    try {
      await runCommand(line, capture)
    } catch (error) {
      return { kind: 'error', text: formatError(error) }
    }
    const last = captured.at(-1)
    if (!last) return { kind: 'success' }
    return { kind: last.level === 'error' ? 'error' : 'success', text: last.text }
  }

  const releaseLiveTui = registerLiveTui({
    async interact(request, context) {
      // The abort signal comes from the protocol's handler context, not from the
      // request: PresentationRequestContext has no signal field.
      const signal = context?.signal
      if (request.kind === 'approval') {
        const outcome = await awaitApproval({
          toolName: request.action,
          summary: request.summary,
          origin: request.origin,
          details: request.details,
          risk: request.risk,
          signal,
          // The consumer's upper bound on the wait. It lives on the request
          // (PresentationRequestContext is flattened into ApprovalRequest).
          deadline: request.deadline,
        })
        return approvalOutcome(outcome)
      }
      if (request.kind === 'secret-input') {
        try {
          const value = await waitForSecret({
            label: request.label,
            description: request.description,
            minLength: request.minLength,
            maxLength: request.maxLength,
            signal,
            deadline: request.deadline,
          })
          if (value === EXPIRED) return { status: 'expired' }
          if (value === null) return { status: 'cancelled' }
          return { status: 'submitted', value: { secret: value } }
        } catch {
          return { status: 'cancelled' }
        }
      }
      if (request.kind === 'question') {
        const { questions, decoders } = toTuiQuestions(request.fields)
        try {
          const answer = await waitForQuestions(questions, {
            signal,
            onDefer: () => null,
            deadline: request.deadline,
          })
          if (answer === EXPIRED) return { status: 'expired' }
          if (answer === null) return { status: 'cancelled' }
          const value = fromTuiAnswers(decoders, answer)
          // A required field can end up unanswered in a way the standard cannot
          // carry — a select field the user answered with free text is dropped
          // by the adapter. Submitting a result that is missing a required field
          // makes the protocol validator throw, and a throw is not a clean
          // cancel, so cancel here instead.
          const missing = (request.fields ?? []).filter(
            (field) => field.required === true && !Object.hasOwn(value.answers, field.id)
          )
          if (missing.length > 0) return { status: 'cancelled' }
          return { status: 'submitted', value }
        } catch {
          // The modal rejects on abort; the standard distinguishes that from a
          // human decision.
          return { status: 'cancelled' }
        }
      }
      return { status: 'unavailable', reason: t('session.unsupportedInteraction', { kind: String(request.kind) }) }
    },

    async notify(request) {
      app.showToast(String(request.text), notificationLevel(request.level))
      paint()
      return { status: 'submitted', value: { accepted: true } }
    },

    async copyText(request) {
      // The sensitivity -> osc52Only mapping lives in lib/std/adapt.js so it can
      // be pinned without a terminal; its comment there explains why private
      // text must not reach the PowerShell fallback.
      const ok = term.copyToClipboard(String(request.text), copyTextOptions(request))
      if (!ok) return { status: 'unavailable', reason: t('session.noClipboard') }
      return { status: 'submitted', value: { accepted: true } }
    },

    async commandCatalog() {
      // The TUI's own command line is served from the local switch in
      // runCommand; this is the discoverable view of it. Descriptions mirror
      // the manifest contributions in dsh-plugin.json.
      return TUI_OWNED_COMMANDS.map((name) => {
        // `command-list.js` stays import-free (it must not pull a peer in), so
        // the catalog is resolved here; the map is the English fallback for a
        // name the catalogs do not cover yet.
        const key = 'command.' + name
        const message = t(key)
        return { name, description: message === key ? (COMMAND_DESCRIPTIONS[name] ?? '') : message }
      })
    },

    async executeCommand(line) {
      // The title screen has no session for a command to act on; the standard
      // allows execute to return undefined, which is the honest answer.
      if (!currentAgent) return undefined
      const parsed = parseCommand(line)
      if (!parsed) return undefined
      if (!TUI_OWNED_COMMANDS.includes(parsed.name)) return undefined
      const result = await runCommandResult(line, parsed)
      return result
    },
  })

  // Restore the terminal whenever this fiber unloads (exit, HMR, fail-loud).
  ctx.effect(() => {
    const restore = () => {
      term.stop()
      // After the alt screen is released: the process streams go back to the
      // host, and whatever was diverted is replayed where it can be read.
      diagnostics.restore()
      restoreMcpStderr()
    }
    const onExit = () => restore()
    const onSigint = () => handleCtrlKey('c')
    process.on('exit', onExit)
    process.on('SIGINT', onSigint)
    return () => {
      clearInterval(animationTimer)
      clearInterval(mcpPollTimer)
      clearTimeout(startupCheckTimer)
      app.clearCornerNotice()
      process.off('exit', onExit)
      process.off('SIGINT', onSigint)
      void mcpManager.detachAgent()
      releaseLiveTui()
      restore()
    }
  })
}
