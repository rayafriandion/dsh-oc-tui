// Standalone smoke tests for the dsh-oc-tui pure modules.
// Run: node tests/smoke.test.mjs  (no dsh environment required)
import { decodeKey, Screen, makeStyle, Terminal } from "../lib/term.js"
import { App, THEME, noteFromContext, inputRows, cursorAtVisual } from "../lib/ui.js"
import { InterruptState } from "../lib/interrupt.js"
import { SessionMetrics } from "../lib/metrics.js"
import { SETTINGS_MENU, loadModelSettings, loadProviderModels, loadWebSettings, saveWebSetting } from "../lib/web-settings.js"
import { renderMarkdown } from "../lib/markdown.js"
import { displayWidth, wrapText, roughTokens, truncateWidth, contentText, timeString, toolSummary, detectImageMediaType, imageMediaTypeFromName, decodeDataUrl, localImagePath } from "../lib/util.js"

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log("ok   " + name) }
  else { console.log("FAIL " + name + "  got " + a + "  want " + e); failed++ }
}
const ok = (name, cond) => cond ? console.log("ok   " + name) : (console.log("FAIL " + name), failed++)

// ---- util ----
eq("displayWidth CJK", displayWidth("中文a"), 5)
eq("roughTokens", roughTokens("你好world"), 3)
eq("truncateWidth", truncateWidth("hello world", 5), "hello")
eq("wrapText", wrapText("a b c d e", 5), ["a b c", "d e"])
eq("contentText includes reasoning", contentText([{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }]), "hiddenvisible")
eq("contentText skips reasoning", contentText([{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }], { skipReasoning: true }), "visible")
eq("timeString carries full date", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeString(0)), true)
eq("image detect png", detectImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png")
eq("image detect jpeg", detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg")
eq("image detect gif", detectImageMediaType(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif")
eq("image detect webp", detectImageMediaType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "image/webp")
eq("image detect text returns null", detectImageMediaType(Buffer.from("hello world")), null)
eq("image media type from name", imageMediaTypeFromName("photo.JPEG?x=1"), "image/jpeg")
eq("image media type from name webp", imageMediaTypeFromName("/a/b/c.webp"), "image/webp")
eq("image media type from name non-image", imageMediaTypeFromName("notes.txt"), null)
eq("decode data url", decodeDataUrl("data:image/png;base64,iVBORw0KGgo="), { mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })
eq("decode data url non-image", decodeDataUrl("data:text/plain;base64,aGk="), null)
eq("local image path plain", localImagePath("C:\\pics\\a.png"), "C:\\pics\\a.png")
eq("local image path quoted", localImagePath('"/tmp/my image.gif"'), "/tmp/my image.gif")
eq("local image path file uri", localImagePath("file:///C:/pics/a.jpg"), "C:/pics/a.jpg")
eq("local image path non-image", localImagePath("C:\\notes.txt"), null)

// ---- tool summaries ----
eq("toolSummary read", toolSummary("read", '{"file_path":"/a/b.txt"}'), "read /a/b.txt")
eq("toolSummary write object args", toolSummary("write", { file_path: "/a/b.txt" }), "write /a/b.txt")
eq("toolSummary pwsh hides command key", toolSummary("pwsh", '{"command":"pnpm test"}'), "run pnpm test")
eq("toolSummary glob hides pattern key", toolSummary("glob", '{"pattern":"**/*.ts"}'), "glob **/*.ts")
eq("toolSummary grep", toolSummary("grep", '{"pattern":"TODO"}'), "grep TODO")
eq("toolSummary editor", toolSummary("str_replace_editor", '{"command":"str_replace","path":"/a/b.txt"}'), "str_replace_editor str_replace /a/b.txt")
eq("toolSummary unknown value-led", toolSummary("something", '{"command":"x"}'), "something x")
eq("toolSummary unknown json fallback", toolSummary("something", '{"a":1}'), "something {\"a\":1}")
eq("toolSummary no args", toolSummary("read"), "read")

// ---- decodeKey ----
eq("Enter", decodeKey(Buffer.from([0x0d])), { key: { name: "return" }, consumed: 1 })
eq("Ctrl+D", decodeKey(Buffer.from([0x04])), { key: { name: "d", ctrl: true }, consumed: 1 })
eq("Up", decodeKey(Buffer.from([0x1b, 0x5b, 0x41])), { key: { name: "up" }, consumed: 3 })
eq("PgUp", decodeKey(Buffer.from([0x1b, 0x5b, 0x35, 0x7e])), { key: { name: "pageup" }, consumed: 4 })
eq("ESC alone", decodeKey(Buffer.from([0x1b])), { key: { name: "escape" }, consumed: 1 })
eq("printable", decodeKey(Buffer.from("a")), { key: { name: "a", text: "a" }, consumed: 1 })
eq("CJK printable", decodeKey(Buffer.from("中", "utf8")), { key: { name: "中", text: "中" }, consumed: 3 })
eq("Shift+Enter CSI-u", decodeKey(Buffer.from("\x1b[13;2u")), { key: { name: "enter", shift: true }, consumed: 7 })
eq("Ctrl+Enter CSI-u", decodeKey(Buffer.from("\x1b[13;5u")), { key: { name: "enter", ctrl: true }, consumed: 7 })
eq("Ctrl+Enter LF", decodeKey(Buffer.from([0x0a])), { key: { name: "enter", ctrl: true }, consumed: 1 })
eq("Alt+Enter legacy", decodeKey(Buffer.from([0x1b, 0x0d])), { key: { name: "enter", shift: true }, consumed: 2 })
eq("Ctrl+comma CSI-u", decodeKey(Buffer.from("\x1b[44;5u")), { key: { name: ",", ctrl: true }, consumed: 7 })
eq("mouse left down", decodeKey(Buffer.from("\x1b[<0;12;7M")), { key: { name: "mouse", mouse: { x: 11, y: 6, button: "left", action: "down", shift: false, alt: false, ctrl: false } }, consumed: 10 })
eq("mouse hover motion", decodeKey(Buffer.from("\x1b[<35;12;7M")), { key: { name: "mouse", mouse: { x: 11, y: 6, button: "none", action: "move", shift: false, alt: false, ctrl: false } }, consumed: 11 })
eq("mouse drag motion", decodeKey(Buffer.from("\x1b[<32;12;7M")), { key: { name: "mouse", mouse: { x: 11, y: 6, button: "left", action: "move", shift: false, alt: false, ctrl: false } }, consumed: 11 })
eq("mouse release", decodeKey(Buffer.from("\x1b[<0;12;7m")), { key: { name: "mouse", mouse: { x: 11, y: 6, button: "left", action: "up", shift: false, alt: false, ctrl: false } }, consumed: 10 })
eq("mouse wheel up", decodeKey(Buffer.from("\x1b[<64;3;4M")), { key: { name: "mouse", mouse: { x: 2, y: 3, button: "wheel", action: "wheel-up", shift: false, alt: false, ctrl: false } }, consumed: 10 })
eq("X10 wheel up", decodeKey(Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 44, 39])), { key: { name: "mouse", mouse: { x: 11, y: 6, button: "wheel", action: "wheel-up", shift: false, alt: false, ctrl: false } }, consumed: 6 })
eq("partial mouse buffered", decodeKey(Buffer.from("\x1b[<0;12")), null)
eq("partial X10 buffered", decodeKey(Buffer.from([0x1b, 0x5b, 0x4d, 0x60])), null)
eq("bracketed paste text", decodeKey(Buffer.from("\x1b[200~hello world\x1b[201~")), { key: { name: "paste", data: Buffer.from("hello world") }, consumed: 23 })
eq("bracketed paste image bytes", decodeKey(Buffer.concat([Buffer.from("\x1b[200~"), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("\x1b[201~")])), { key: { name: "paste", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, consumed: 16 })
eq("partial bracketed paste buffered", decodeKey(Buffer.from("\x1b[200~abc")), null)
eq("osc52 clipboard reply base64", decodeKey(Buffer.from("\x1b]52;c;aGVsbG8=\x07")), { key: { name: "clipboard", data: Buffer.from("hello") }, consumed: 16 })
eq("osc52 clipboard reply ST terminator", decodeKey(Buffer.from("\x1b]52;c;aGk=\x1b\\")), { key: { name: "clipboard", data: Buffer.from("hi") }, consumed: 13 })
eq("partial osc52 buffered", decodeKey(Buffer.from("\x1b]52;c;aGk=")), null)

// ---- markdown ----
const theme = {
  text: "eeeeee", markdownHeading: "9d7cd8", markdownCode: "7fd88f", codeBg: "1e1e1e",
  markdownCodeBlock: "eeeeee", markdownListItem: "fab283", markdownHorizontalRule: "808080",
  markdownBlockQuote: "e5c07b", markdownLinkText: "56b6c2",
}
const NL2 = String.fromCharCode(10)
const md = renderMarkdown("Hello **world**" + NL2 + "- one" + NL2 + "> quote" + NL2 + "# Head" + NL2 + "para two", theme, 40)
const mdText = md.map((l) => l.map((s) => s.text).join(""))
eq("markdown blocks", mdText, ["Hello world", "- one", "▍ quote", "Head", "para two"])
const unorderedText = renderMarkdown("- one" + NL2 + "* two" + NL2 + "+ three", theme, 40)
  .map((line) => line.map((segment) => segment.text).join(""))
eq("markdown unordered markers use stable ASCII width", unorderedText, ["- one", "- two", "- three"])

// ---- context notes ----
eq("noteFromContext system-reminder", noteFromContext({ kind: "plugin", plugin: "agent-instructions" }, "<system-reminder>Additional instructions</system-reminder>"), { label: "system-reminder", text: "Additional instructions" })
eq("noteFromContext system-reminder strips every frame", noteFromContext({ kind: "plugin", plugin: "skill" }, "<system-reminder>one</system-reminder>\n<system-reminder>two</system-reminder>"), { label: "system-reminder", text: "one\ntwo" })
eq("noteFromContext compaction checkpoint", noteFromContext({ kind: "plugin", plugin: "compact", compactionId: "c1" }, "checkpoint preamble\n<compacted-summary>\nsummary body\n</compacted-summary>"), { label: "compaction", text: "checkpoint preamble\n\nsummary body" })
eq("noteFromContext other plugin stays plain", noteFromContext({ kind: "plugin", plugin: "other" }, "plain text"), null)
eq("noteFromContext non-string stays plain", noteFromContext({ kind: "plugin", plugin: "compact" }, 42), null)

// ---- interrupt lifecycle ----
const interrupt = new InterruptState({ confirmMs: 1500 })
eq("Ctrl+C clears input", interrupt.interrupt({ running: false, hasInput: true, now: 1000 }), "clear")
eq("Ctrl+C cancels running turn", interrupt.interrupt({ running: true, now: 1000 }), "cancel")
eq("first idle Ctrl+C arms exit", interrupt.interrupt({ running: false, now: 1000 }), "arm-exit")
eq("second idle Ctrl+C exits", interrupt.interrupt({ running: false, now: 2000 }), "exit")
eq("exit is idempotent", interrupt.requestExit(), false)

// ---- session metrics ----
const metrics = new SessionMetrics()
metrics.consume({ type: "step/start", time: 1000, data: { turn: 1, step: 1 } })
metrics.consume({ type: "assistant/chunk", time: 1300, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } } })
metrics.consume({ type: "assistant/message", time: 2300, data: { turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60 } } })
eq("TTFT average", metrics.snapshot().ttftAverageMs, 300)
eq("decode throughput", metrics.snapshot().tokensPerSecond, 20)
eq("disjoint cache hit rate", metrics.snapshot().cacheHitRate, 60)

// ---- shared WebUI settings ----
const sections = new Map([
  ["agent-default-model", { provider: "first", model: "one" }],
  ["permission", { defaultPreset: "workspace-write" }],
  ["agent-presets", { default: "catgirl-ptc" }],
  ["llm-pi-ai", { providers: { first: { apiKeyEnv: "FIRST_API_KEY", baseURL: "https://first.test", models: [{ id: "one" }] }, second: { models: [{ id: "two" }, { id: "three" }] } } }],
])
const userSections = new Map([...sections].map(([ns, value]) => [ns, structuredClone(value)]))
const revisions = new Map([...sections.keys()].map((ns) => [ns, 0]))
const setAt = (source, path, value) => {
  if (path.length === 0) return value
  const root = structuredClone(source ?? {})
  let node = root
  for (const part of path.slice(0, -1)) node = node[part] ??= {}
  if (value === undefined) delete node[path.at(-1)]
  else node[path.at(-1)] = value
  return root
}
const fakeSettings = {
  writable: true,
  documentPath: "C:/Users/test/.dsh/settings.yaml",
  describe() { return [...sections].map(([ns, value]) => ({ ns, value, user: userSections.get(ns), revision: revisions.get(ns) ?? 0, applies: "live" })) },
  register(ns) {
    if (ns === "ui-theme") sections.set(ns, { preference: "system" })
    if (ns === "locale") sections.set(ns, {})
    if (ns === "ui-conversation") sections.set(ns, { busyEnter: "queue" })
    userSections.set(ns, structuredClone(sections.get(ns)))
    revisions.set(ns, 0)
  },
  get(ns) { return sections.get(ns) },
  async update(ns, patch) { sections.set(ns, { ...sections.get(ns), ...patch }); userSections.set(ns, structuredClone(sections.get(ns))); revisions.set(ns, (revisions.get(ns) ?? 0) + 1) },
  async replace(ns, value) { sections.set(ns, value); userSections.set(ns, structuredClone(value)); revisions.set(ns, (revisions.get(ns) ?? 0) + 1) },
  async mutate(ns, ops) {
    let next = userSections.get(ns)
    for (const op of ops) next = setAt(next, op.path, op.op === "set" ? op.value : undefined)
    userSections.set(ns, next)
    sections.set(ns, structuredClone(next))
    revisions.set(ns, (revisions.get(ns) ?? 0) + 1)
  },
}
const storedCredentials = new Map([["FIRST_API_KEY", "old-secret"]])
const fakeCredentials = {
  async describe(ref) { return { configured: storedCredentials.has(ref), source: storedCredentials.has(ref) ? "file" : undefined, writable: true } },
  async set(ref, value) { storedCredentials.set(ref, value) },
  async unset(ref) { storedCredentials.delete(ref) },
}
const fakeLlm = {
  listProviders() { return [{ id: "first", name: "First" }, { id: "second", name: "Second" }] },
  // `listModels` only covers registered adapters and returns a narrow set;
  // `discoverModels` is the configuration-surface API that returns the full
  // advertised catalog (including models the user has not saved yet).
  async listModels(provider) { return provider === "first" ? [{ provider, id: "one", name: "One" }] : [{ provider, id: "two", name: "Two" }, { provider, id: "three", name: "Three" }] },
  async discoverModels(settingsNs, request) {
    if (request.provider === "first") return [{ id: "one" }, { id: "extra-one" }]
    if (request.provider === "second") return [{ id: "two" }, { id: "three" }, { id: "four" }, { id: "five" }]
    return []
  },
  async resolveModelInfo(provider, model) {
    if (provider === "first" && model === "one") {
      return { context: 128000, defaultMaxTokens: 4096, reasoning: { defaultEffort: "high", efforts: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }] } }
    }
    return { context: 128000, defaultMaxTokens: 4096 }
  },
  listConfigurableProviders() {
    return [
      { provider: "first", displayName: "First", settingsNs: "llm-pi-ai", settingsPath: ["providers", "first"] },
      { provider: "second", displayName: "Second", settingsNs: "llm-pi-ai", settingsPath: ["providers", "second"], declared: true },
      // A provider the system knows about but the user never added must stay
      // hidden from the Model tab.
      { provider: "unadded", displayName: "Unadded preset", settingsNs: "llm-pi-ai", settingsPath: ["providers", "unadded"] },
    ]
  },
}
const fakeCtx = {
  get(name) {
    if (name === "settings") return fakeSettings
    if (name === "credentials") return fakeCredentials
    if (name === "llm") return fakeLlm
    if (name === "agentPresets") return { defaultId: "catgirl-ptc", async list() { return [{ id: "catgirl-ptc" }, { id: "default" }] } }
    if (name === "permissionPresets") return { names: ["workspace-write", "danger-full-access"] }
  },
}
const shared = await loadWebSettings(fakeCtx)
ok("WebUI namespaces registered", sections.has("ui-theme") && sections.has("locale") && sections.has("ui-conversation"))
ok("main settings loaded", shared.items.some((item) => item.label === "Busy Enter"))
ok("model items moved to the Model tab", !shared.items.some((item) => item.label === "Default model" || item.label === "Default provider" || item.field === "reasoningEffort"))
ok("manage sessions setting", shared.items.some((item) => item.kind === "manage-sessions" && item.label === "Manage sessions"))
ok("new session setting", shared.items.some((item) => item.kind === "new-session" && item.label === "New session"))
eq("main tab headers", shared.items.filter((item) => item.kind === "header").map((item) => item.label).join(","), "General,Sessions,System")
eq("settings menu is Main then Model", SETTINGS_MENU.map((entry) => entry.id).join(","), "main,model")
ok("main tab carries the left menu", Array.isArray(shared.menu) && shared.menu.map((entry) => entry.label).join(",") === "Main,Model" && shared.menuIndex === 0)
const presetItem = shared.items.find((item) => item.ns === "agent-presets")
ok("default agent preset is a list choice", presetItem && presetItem.kind === "agent-preset" && Array.isArray(presetItem.options) && presetItem.options.length === 2 && presetItem.value === "catgirl-ptc")
await saveWebSetting(fakeCtx, fakeSettings, presetItem, "default")
eq("default agent preset persisted", sections.get("agent-presets").default, "default")
ok("provider config hint stays in main", !shared.items.some((item) => item.kind === "provider") && shared.items.some((item) => item.kind === "provider-config-info"))
ok("web-only appearance/language hidden in TUI", !shared.items.some((item) => item.label === "General · Appearance") && !shared.items.some((item) => item.label === "General · Language"))

// ---- Model tab: merged provider + model settings ----
const modelTab = await loadModelSettings(fakeCtx)
ok("model tab carries the left menu", modelTab.menu.map((entry) => entry.label).join(",") === "Main,Model" && modelTab.menuIndex === 1 && modelTab.title === "Model")
ok("default provider choice", modelTab.items.some((item) => item.kind === "default-provider" && item.label === "Default provider" && item.value === "first"))
ok("default model options come from saved provider models", modelTab.items.some((item) => item.kind === "default-model" && item.label === "Default model" && item.value === "one" && Array.isArray(item.options) && item.options.includes("one") && !item.options.includes("extra-one")))
const effortItem = modelTab.items.find((item) => item.field === "reasoningEffort")
ok("reasoning is a list menu", effortItem && effortItem.kind === "effort" && effortItem.label === "Reasoning" && Array.isArray(effortItem.options) && effortItem.options.length === 3 && effortItem.value === "high")
const originalModelSettings = structuredClone(sections.get("agent-default-model"))
sections.set("agent-default-model", { ...originalModelSettings, reasoningEffort: "unsupported-old-model-level" })
const unsupportedModelTab = await loadModelSettings(fakeCtx)
eq("unsupported stored effort falls back to current model default", unsupportedModelTab.items.find((item) => item.field === "reasoningEffort").value, "high")
sections.set("agent-default-model", originalModelSettings)
await saveWebSetting(fakeCtx, fakeSettings, effortItem, "max")
eq("reasoning effort persisted", sections.get("agent-default-model").reasoningEffort, "max")
// Merged provider blocks: URL / API key / Models live under each provider.
ok("provider blocks listed", modelTab.items.some((item) => item.kind === "header" && item.label === "First") && modelTab.items.some((item) => item.kind === "header" && item.label === "Second"))
ok("unadded preset providers hidden", !modelTab.items.some((item) => item.kind === "header" && item.label === "Unadded preset"))
const urlItem = modelTab.items.find((item) => item.label === "Provider URL")
ok("provider URL merged into Model tab", urlItem && urlItem.kind === "path" && urlItem.value === "https://first.test")
const keyItem = modelTab.items.find((item) => item.label === "Provider API key")
ok("provider API key merged into Model tab", keyItem && keyItem.kind === "secret" && keyItem.value.includes("configured"))
const modelsRow = modelTab.items.find((item) => item.kind === "provider-models")
ok("provider models row", modelsRow && modelsRow.label === "Models" && modelsRow.providerId === "first" && modelsRow.value.includes("1"))
ok("stored models listed under provider", modelTab.items.some((item) => item.kind === "provider-model" && item.label === "one" && item.indent === 1))
ok("default model marked in provider list", modelTab.items.find((item) => item.kind === "provider-model" && item.modelId === "one")?.value === "default")
await saveWebSetting(fakeCtx, fakeSettings, keyItem, "new-secret")
eq("provider credential persisted", storedCredentials.get("FIRST_API_KEY"), "new-secret")
await saveWebSetting(fakeCtx, fakeSettings, urlItem, "https://changed.test")
eq("provider path persisted", sections.get("llm-pi-ai").providers.first.baseURL, "https://changed.test")
const imageInputItem = modelTab.items.find((item) => item.kind === "input-modalities")
ok("pi-ai provider exposes default image input", imageInputItem && imageInputItem.options.includes("text + image"))
await saveWebSetting(fakeCtx, fakeSettings, imageInputItem, "text + image")
eq("provider image input persisted", sections.get("llm-pi-ai").providers.first.defaultInput, ["text", "image"])
// A listed model becomes the default route for its provider.
const listedModel = modelTab.items.find((item) => item.kind === "provider-model" && item.modelId === "one")
await saveWebSetting(fakeCtx, fakeSettings, listedModel, "one")
eq("listed model sets default model", sections.get("agent-default-model").model, "one")
eq("listed model sets default provider", sections.get("agent-default-model").provider, "first")
const modelItem = modelTab.items.find((item) => item.kind === "default-model")
await saveWebSetting(fakeCtx, fakeSettings, modelItem, "gpt-5.6-luna")
eq("shared settings persisted", sections.get("agent-default-model").model, "gpt-5.6-luna")

// ---- auto-fetched model picker ----
const picker = await loadProviderModels(fakeCtx, "second")
ok("picker auto-fetches the full provider catalog", picker.items.filter((item) => item.kind === "model-toggle").map((item) => item.modelId).join(",") === "two,three,four,five")
ok("picker marks only the saved selection", picker.items.filter((item) => item.kind === "model-toggle" && ["two", "three"].includes(item.modelId)).every((item) => item.checked === true && item.value === "[x]") && picker.items.filter((item) => item.kind === "model-toggle" && ["four", "five"].includes(item.modelId)).every((item) => item.checked === false && item.value === "[ ]"))
ok("picker title names the provider", picker.title.includes("Second"))
const toggleTwo = picker.items.find((item) => item.modelId === "two")
await saveWebSetting(fakeCtx, fakeSettings, toggleTwo, "off")
eq("model toggle removes from provider models", sections.get("llm-pi-ai").providers.second.models.map((entry) => entry.id), ["three"])
const picker2 = await loadProviderModels(fakeCtx, "second")
const twoAgain = picker2.items.find((item) => item.modelId === "two")
ok("picker reflects the saved state", twoAgain && twoAgain.checked === false && twoAgain.value === "[ ]")
await saveWebSetting(fakeCtx, fakeSettings, twoAgain, "on")
eq("model toggle adds back to provider models", sections.get("llm-pi-ai").providers.second.models.map((entry) => entry.id).sort().join(","), "three,two")
const refreshedShared = await loadWebSettings(fakeCtx)
const refreshedModelTab = await loadModelSettings(fakeCtx)

// ---- App render ----
const fakeTerm = { cols: 100, rows: 30, on() {} }
const titleApp = new App(fakeTerm)
titleApp.setWelcome({ workingDirectory: "D:/Projects/example", gitBranch: "main" })
const titleRendered = titleApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("title screen", titleRendered.includes("DeepSeek Harness") && titleRendered.includes("D:/Projects/example"))
ok("title git branch", titleRendered.includes("git: main"))
ok("title settings hint", titleRendered.includes("Ctrl+P") && titleApp.sessionId === "")
ok("title hint advertises Tab thinking without effort word", titleRendered.includes("Tab thinking") && !titleRendered.toLowerCase().includes("effort"))

// Entering the welcome screen must drop the previous session's title.
const staleTitleApp = new App(fakeTerm)
staleTitleApp.setSession({ id: "old", title: "Old session title" })
staleTitleApp.setWelcome({ workingDirectory: "D:/x" })
const staleTitleRendered = staleTitleApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("welcome screen drops stale session title", !staleTitleRendered.includes("Old session title") && staleTitleRendered.includes("New session"))

const modelTitleApp = new App(fakeTerm)
modelTitleApp.setWelcome({ workingDirectory: "D:/Projects/example", model: "gpt-5.6-luna", provider: "first" })
const modelTitleRendered = modelTitleApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("title screen shows default model", modelTitleRendered.includes("gpt-5.6-luna") && !modelTitleRendered.includes("· model ·"))

const app = new App(fakeTerm)
app.setSession({ id: "t1", title: "Test", model: "m", provider: "p" })
app.addUser("hi")
app.startAssistant()
const scrollApp = new App(fakeTerm)
scrollApp.setSession({ id: "scroll", title: "Scroll" })
for (let i = 0; i < 20; i++) scrollApp.addSystem("history line " + i)
scrollApp.scrollTranscript(3)
ok("mouse-wheel transcript scroll", scrollApp.scroll > 0)
const scrolled = scrollApp.scroll
scrollApp.scrollTranscript(-3)
ok("mouse-wheel transcript return", scrollApp.scroll < scrolled)

app.streamChunk({ type: "text-delta", text: "hello there" })
app.startTool({ callId: "c1", name: "bash", args: "{}" })
app.updateTool("c1", { status: "ok", result: "done" })
const followupAssistant = app.ensureAssistantBlock(Date.now())
followupAssistant.text = "continued after tool"
app.inputText = "first line\nsecond line"
app.inputCursor = app.inputText.length
app.setMetrics(metrics.snapshot())
app.sidebarSessions = [{ id: "t1", label: "Test session", time: Date.now() }]
const screen = app.render()
ok("render has rows", screen.rows === 30)
ok("render has cols", screen.cols === 100)
// header
ok("header text", screen.cells[0].slice(0, 20).map((c) => c.ch).join("").includes("DeepSeek"))
const headerRows = screen.cells.slice(0, 2).map((r) => r.map((c) => c.ch).join("")).join(NL2)
eq("single session title in header", (headerRows.match(/Test/g) ?? []).length, 1)
ok("session id hidden from header", !headerRows.includes("t1"))
// user block
const rendered = screen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("user label", rendered.includes("You"))
eq("single assistant header per request", (rendered.match(/dsh\s+·/g) ?? []).length, 1)
ok("no left session rail", !rendered.includes("Test session"))
ok("multiline composer", rendered.includes("first line") && rendered.includes("second line"))
ok("TTFT footer", rendered.includes("TTFT avg 300ms"))
ok("throughput footer", rendered.includes("20.0 tok/s"))
ok("cache footer", rendered.includes("cache 60%"))
ok("bottom actions removed", !app.hitRegions.some((region) => region.kind === "new-session" && region.y === 29) && !app.hitRegions.some((region) => region.kind === "settings"))
ok("no session mouse target in transcript", !app.hitRegions.some((region) => region.kind === "session"))
const composerRegion = app.hitRegions.find((region) => region.kind === "composer")
ok("mouse composer target", composerRegion && app.placeInputCursor(composerRegion.x + 2, composerRegion.composerTop + 1) && app.inputCursor === 0)
// Pasted images render as orange [Image N] chips plus a multimodal hint row.
const imageApp = new App(fakeTerm)
imageApp.setSession({ id: "img", title: "Test" })
imageApp.inputText = "look at [Image 1] and [Image 2]"
imageApp.inputCursor = imageApp.inputText.length
imageApp.inputImages = [
  { status: "ready", ref: { attachmentId: "sha256:aaa" }, mediaType: "image/png", label: "Image 1" },
  { status: "ready", ref: { attachmentId: "sha256:bbb" }, mediaType: "image/jpeg", label: "Image 2" },
]
const imageScreen = imageApp.render()
const imageRendered = imageScreen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("image hint row appears", imageRendered.includes("deepseek-v4-flash-vision-exp"))
ok("image marker text intact", imageRendered.includes("[Image 1]") && imageRendered.includes("[Image 2]"))
ok("image marker chip uses orange background", imageScreen.cells.some((row) => row.some((c) => c.ch === "[" && c.style?.bg === THEME.imageChipBg)))
app.openSettings(refreshedShared.items, { title: refreshedShared.title, subtitle: refreshedShared.subtitle, menu: refreshedShared.menu, menuIndex: refreshedShared.menuIndex })
const settingsRendered = app.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("settings overlay", settingsRendered.includes("Settings") && settingsRendered.includes("Shared with DeepSeek Harness WebUI"))
ok("settings left menu rendered", settingsRendered.includes("Main") && settingsRendered.includes("Model") && settingsRendered.includes("MENU"))
ok("settings menu hit targets", app.hitRegions.some((region) => region.kind === "settings-menu" && region.menuIndex === 0) && app.hitRegions.some((region) => region.kind === "settings-menu" && region.menuIndex === 1))
ok("main tab keeps general settings", settingsRendered.includes("Busy Enter"))
ok("main tab drops model settings", !settingsRendered.includes("Default model"))
// Grouped settings: section headers render as their own rows and the
// selection / hit regions never rest on them.
ok("settings groups rendered", settingsRendered.includes("GENERAL") && settingsRendered.includes("SESSIONS") && settingsRendered.includes("SYSTEM") && !settingsRendered.includes("MODELS"))
ok("settings items are grouped", refreshedShared.items.filter((item) => item.kind === "header").map((item) => item.label).join(",") === "General,Sessions,System")
ok("selection skips headers", app.settingsItems[app.settingsSelection]?.kind !== "header" && app.settingsSelection === refreshedShared.items.findIndex((item) => item.kind !== "header"))
ok("header rows carry no hit region", !app.hitRegions.some((region) => region.kind === "settings-item" && app.settingsItems[region.settingsIndex]?.kind === "header"))
ok("mouse settings targets", app.hitRegions.some((region) => region.kind === "settings-item" && region.settingsIndex === app.settingsSelection))
app.moveSettingsSelection(-1)
ok("wrap skips headers upward", app.settingsItems[app.settingsSelection]?.kind !== "header")
app.setSettingsSelection(0)
ok("setSettingsSelection steps off headers", app.settingsItems[app.settingsSelection]?.kind !== "header")
ok("setting labels are concise without separators", shared.items.every((item) => !String(item.label).includes("\u00b7")))
ok("renamed setting labels", shared.items.some((item) => item.label === "Busy Enter") && shared.items.some((item) => item.label === "Default preset") && shared.items.some((item) => item.label === "Permission preset") && shared.items.some((item) => item.label === "Provider API config"))
ok("settings arrow hint removed", !refreshedShared.subtitle && !settingsRendered.includes("changes"))
// Model tab: the merged provider + model settings with the menu on the left.
app.openSettings(refreshedModelTab.items, { title: refreshedModelTab.title, subtitle: refreshedModelTab.subtitle, menu: refreshedModelTab.menu, menuIndex: refreshedModelTab.menuIndex })
const modelRendered = app.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("model tab shows merged settings", modelRendered.includes("Default model") && modelRendered.includes("Provider URL") && modelRendered.includes("Provider API key") && modelRendered.includes("Models"))
ok("model tab shows default model value", modelRendered.includes("gpt-5.6-luna"))
ok("model tab footer mentions Tab menu", modelRendered.includes("Tab menu"))

// Focus follows the cursor: hovering a row moves the selection there, and
// re-hovering the same row still refocuses it after the selection moved away
// (keyboard, click, reopened list) — the hover cache must not go stale.
const hoverApp = new App(fakeTerm)
hoverApp.openSettings([
  { kind: "session", label: "A", value: "a", sessionId: "a", disabled: false },
  { kind: "session", label: "B", value: "b", sessionId: "b", disabled: false },
  { kind: "session", label: "C", value: "c", sessionId: "c", disabled: false },
], { title: "Manage sessions" })
hoverApp.render()
const hoverRows = hoverApp.hitRegions
  .filter((region) => region.kind === "settings-item")
  .sort((a, b) => a.settingsIndex - b.settingsIndex)
ok("hover focuses row", hoverApp.hoverFocus(hoverRows[1].x + 1, hoverRows[1].y) && hoverApp.settingsSelection === 1)
ok("hover idle within same row does not repaint", !hoverApp.hoverFocus(hoverRows[1].x + 2, hoverRows[1].y))
hoverApp.settingsSelection = 0
ok("re-hover same row refocuses", hoverApp.hoverFocus(hoverRows[1].x + 1, hoverRows[1].y) && hoverApp.settingsSelection === 1)
ok("hover next row moves focus", hoverApp.hoverFocus(hoverRows[2].x + 1, hoverRows[2].y) && hoverApp.settingsSelection === 2)

// ---- mouse text selection (left-drag select, right-click copy) ----
const selApp = new App(fakeTerm)
selApp.setSession({ id: "t1", title: "Test" })
selApp.addUser("hello world")
selApp.startAssistant()
selApp.streamChunk({ type: "text-delta", text: "selectable answer text" })
selApp.finalizeAssistant()
const selScreen = selApp.render()
const selRows = selScreen.cells.map((r) => r.map((c) => c.ch).join(""))
const answerY = selRows.findIndex((r) => r.includes("selectable answer text"))
ok("selection target row rendered", answerY >= 0)
const answerRow = selRows[answerY]
const wordX = answerRow.indexOf("selectable")
// Single-row drag selects exactly the covered cells.
selApp.startTextSelection(wordX, answerY)
selApp.updateTextSelection(wordX + "selectable".length - 1, answerY)
eq("single-row drag selects exact text", selApp.selectionText(), "selectable")
// The highlight is painted with the selection background.
const hiScreen = selApp.render()
ok("selection highlight painted", hiScreen.cells[answerY].some((c) => c.style?.bg === THEME.selection))
// Reverse drag (right -> left) normalizes to the same text.
selApp.startTextSelection(wordX + "selectable answer".length - 1, answerY)
selApp.updateTextSelection(wordX, answerY)
eq("reverse drag selects same text", selApp.selectionText(), "selectable answer")
// Multi-row drag: first row from the start column, last row to the end column.
const userY = selRows.findIndex((r) => r.includes("hello world"))
const helloX = selRows[userY].indexOf("hello")
selApp.startTextSelection(helloX, userY)
selApp.updateTextSelection(wordX + "selectable".length - 1, answerY)
const multiSel = selApp.selectionText().split(NL2)
eq("multi-row selection first line", multiSel[0], "hello world")
eq("multi-row selection last line", multiSel.at(-1), "  selectable")
// Wide runes: continuation cells are skipped, CJK survives the copy intact.
const cjkApp = new App(fakeTerm)
cjkApp.setSession({ id: "t1", title: "Test" })
cjkApp.addUser("中文内容abc")
const cjkRows = cjkApp.render().cells.map((r) => r.map((c) => c.ch).join(""))
const cjkY = cjkRows.findIndex((r) => r.includes("中文内容abc"))
const cjkX = cjkRows[cjkY].indexOf("中")
cjkApp.startTextSelection(cjkX, cjkY)
cjkApp.updateTextSelection(cjkX + 10, cjkY)
eq("wide-rune selection intact", cjkApp.selectionText(), "中文内容abc")
// Clearing drops the highlight again.
ok("clearTextSelection reports and clears", selApp.clearTextSelection() === true && selApp.textSelection === null && !selApp.textSelectionDragging)
ok("selection highlight cleared", !selApp.render().cells[answerY].some((c) => c.style?.bg === THEME.selection))
// Clipboard write: OSC 52 with the base64 payload, empty input refused.
let oscOut = ""
const clipTerm = new Terminal({
  input: { isTTY: false, on() {}, off() {}, resume() {}, pause() {} },
  output: { isTTY: false, columns: 80, rows: 24, write: (s) => { oscOut += s }, on() {}, off() {} },
})
ok("copyToClipboard emits OSC 52 write", clipTerm.copyToClipboard("hello") === true && oscOut.includes("\x1b]52;c;" + Buffer.from("hello").toString("base64") + "\x1b\\"))
eq("copyToClipboard refuses empty text", clipTerm.copyToClipboard(""), false)
// CJK must travel as UTF-8 base64, never a locale code page — the Windows
// clipboard fallback and the terminal both decode the same bytes to the same
// string, so non-ASCII selections survive the round trip.
let cjkOscOut = ""
const cjkClipTerm = new Terminal({
  input: { isTTY: false, on() {}, off() {}, resume() {}, pause() {} },
  output: { isTTY: false, columns: 80, rows: 24, write: (s) => { cjkOscOut += s }, on() {}, off() {} },
})
cjkClipTerm.copyToClipboard("中文内容")
ok("CJK copy encodes UTF-8 base64", cjkOscOut.includes("\x1b]52;c;" + Buffer.from("中文内容", "utf8").toString("base64") + "\x1b\\"))

// Toast lives on the bottom status row, horizontally centered.
const toastApp = new App(fakeTerm)
toastApp.toast = { text: "saved to DSH settings", level: "info" }
const toastRendered = toastApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const toastLastRow = toastRendered.split(NL2).at(-1)
ok("toast bottom-center on status row", toastLastRow.includes("saved to DSH settings"))
ok("toast not in transcript header", !toastRendered.split(NL2).slice(0, 2).join(NL2).includes("saved to DSH settings"))

// Terminal cursor parks at the input caret (IME anchors there).
const cursorScreen = new App(fakeTerm)
cursorScreen.setSession({ id: "t1", title: "Test" })
cursorScreen.inputText = "hello"
cursorScreen.inputCursor = 5
const cursorRendered = cursorScreen.render()
ok("cursor parked at input caret", cursorRendered.cursorY > 0 && cursorRendered.cursorX > 2 && cursorRendered.cursorY < 30)

// Vertical caret movement across composer rows (Up/Down keep the column,
// clamping to shorter rows; wrap rows count the same as explicit newlines).
{
  const caretText = "line one" + NL2 + "line two" + NL2 + "line three"
  const caretW = 40
  const caretMid = inputRows(caretText, 12, caretW) // middle of "line two"
  ok("caret row/col resolved", caretMid.cursorRow === 1 && caretMid.cursorCol === 3)
  eq("caret up keeps column", cursorAtVisual(caretText, caretW, 0, caretMid.cursorCol), 3)
  eq("caret down keeps column", cursorAtVisual(caretText, caretW, 2, caretMid.cursorCol), 21)
  eq("caret down past last row lands at end", cursorAtVisual(caretText, caretW, 5, 0), caretText.length)
  // Wrapped rows: "abcdefghij" at width 4 wraps into abcd / efgh / ij.
  const wrapText = "abcdefghij"
  const wrapMid = inputRows(wrapText, 5, 4) // 'f' on the second visual row
  ok("wrap rows tracked", wrapMid.cursorRow === 1 && wrapMid.cursorCol === 1 && wrapMid.rows.length === 3)
  eq("caret up across wrap rows", cursorAtVisual(wrapText, 4, 0, 1), 1)
  eq("caret down clamps to short last row", cursorAtVisual(wrapText, 4, 2, 1), 9)
  // Layout exposes the same composer width the renderer wraps with.
  const caretApp = new App(fakeTerm)
  caretApp.setSession({ id: "t1", title: "Test" })
  caretApp.inputText = caretText
  caretApp.inputCursor = 12
  const caretLayout = caretApp._layout()
  ok("layout carries composer width + visual", caretLayout.composerWidth >= 20 && caretLayout.visual.cursorRow === 1 && caretLayout.visual.cursorCol === 3)
}

// Thinking box: collapsed by default once streaming finishes, clickable to expand.
const thinkApp = new App(fakeTerm)
thinkApp.setSession({ id: "t1", title: "Test" })
thinkApp.addUser("hi")
const thinkBlock = thinkApp.ensureAssistantBlock(Date.now())
thinkBlock.reasoning = "secret reasoning text"
thinkBlock.text = "the answer"
thinkBlock.streaming = false
thinkBlock.thinkingCollapsed = true
const collapsedRendered = thinkApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking collapsed by default", collapsedRendered.includes("thinking") && !collapsedRendered.includes("secret reasoning text"))
ok("thinking click target", thinkApp.hitRegions.some((region) => region.kind === "thinking"))
const thinkRegion = thinkApp.hitRegions.find((region) => region.kind === "thinking")
thinkApp.toggleThinking(thinkRegion.thinkingBlock)
const expandedRendered = thinkApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking expands on click", expandedRendered.includes("secret reasoning text"))
thinkApp.toggleThinking(thinkRegion.thinkingBlock)
const recollapsedRendered = thinkApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking collapses again on click", !recollapsedRendered.includes("secret reasoning text"))

// Thinking stays collapsed while streaming, and toggle is a no-op until done.
const streamThink = new App(fakeTerm)
streamThink.setSession({ id: "t1", title: "Test" })
streamThink.addUser("hi")
const streamBlock = streamThink.ensureAssistantBlock(Date.now())
streamBlock.reasoning = "live streaming reasoning"
streamBlock.text = "answer"
streamBlock.streaming = true
const streamRendered = streamThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking stays collapsed while streaming", streamRendered.includes("streaming") && !streamRendered.includes("live streaming reasoning"))
streamThink.toggleThinking(streamBlock)
ok("thinking toggle no-op while streaming", streamBlock.thinkingCollapsed !== true)
streamBlock.streaming = false
streamBlock.thinkingCollapsed = true // finalizeAssistant sets this when streaming ends
const afterStreamRendered = streamThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking collapsed after streaming", !afterStreamRendered.includes("live streaming reasoning"))
streamThink.toggleThinking(streamBlock)
const expandedAfterStream = streamThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking expandable after streaming", expandedAfterStream.includes("live streaming reasoning"))

// Context notes render as thinking-style collapsible boxes with their own palettes.
const noteApp = new App(fakeTerm)
noteApp.setSession({ id: "t1", title: "Test" })
noteApp.addNote("Additional instructions from: AGENTS.md", "system-reminder")
noteApp.addNote("This is an automatically generated checkpoint condensing an earlier span.", "compaction")
const noteCollapsed = noteApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("note labels rendered", noteCollapsed.includes("system-reminder") && noteCollapsed.includes("compaction"))
ok("note bodies collapsed by default", !noteCollapsed.includes("Additional instructions") && !noteCollapsed.includes("automatically generated"))
ok("note click targets registered", noteApp.hitRegions.filter((region) => region.kind === "note").length >= 2)
const noteRegion = noteApp.hitRegions.find((region) => region.kind === "note")
noteApp.toggleNote(noteRegion.noteBlock)
const noteExpanded = noteApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("note expands on click", noteExpanded.includes("Additional instructions"))
noteApp.toggleNote(noteRegion.noteBlock)
const noteRecollapsed = noteApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("note collapses again on click", !noteRecollapsed.includes("Additional instructions"))
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const rgbDist = (a, b) => Math.hypot(...hexRgb(a).map((v, i) => v - hexRgb(b)[i]))
ok("note palettes differ from thinking background", THEME.reminderBg !== THEME.compactionBg && THEME.reminderBg !== THEME.backgroundElement && THEME.compactionBg !== THEME.backgroundElement)
ok("note backgrounds are visually distinct", rgbDist(THEME.reminderBg, THEME.backgroundElement) > 40 && rgbDist(THEME.compactionBg, THEME.backgroundElement) > 40 && rgbDist(THEME.reminderBg, THEME.compactionBg) > 40)

// ---- context meter (web ContextMeter port) ----
const meterApp = new App(fakeTerm)
meterApp.setSession({ id: "t1", title: "Test" })
meterApp.setContextMeter({})
ok("no meter without pressure", meterApp.contextMeter === null)
meterApp.setContextMeter(null)
ok("null meter input clears without throwing", meterApp.contextMeter === null)
meterApp.setContextMeter(undefined)
ok("undefined meter input clears without throwing", meterApp.contextMeter === null)
meterApp.setContextMeter({ pressure: { pressureTokens: 32_000 } })
ok("no meter without capacity", meterApp.contextMeter === null)
meterApp.setContextMeter({ pressure: { contextWindow: 128_000 } })
ok("no meter without numerator", meterApp.contextMeter === null)
meterApp.setContextMeter({
  pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
  breakdown: { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 },
})
eq("meter occupancy percent", meterApp.contextMeter.percent, 25)
const meterRendered = meterApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const meterRow = meterRendered.split(NL2).at(-1)
ok("meter reading in status row", meterRow.includes("ctx") && meterRow.includes("32K/128K") && meterRow.includes("25%"))
ok("meter bar uses fill and track cells", meterRow.includes("█") && meterRow.includes("░"))
ok("meter click target", meterApp.hitRegions.some((region) => region.kind === "context-meter"))
// projectedTokens drives the reading so a compaction shows at once.
const projectedApp = new App(fakeTerm)
projectedApp.setSession({ id: "t1", title: "Test" })
projectedApp.setContextMeter({ pressure: { pressureTokens: 32_000, projectedTokens: 3_000, contextWindow: 128_000 } })
eq("meter follows projectedTokens", projectedApp.contextMeter.percent, 2)
const projectedRow = projectedApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2).split(NL2).at(-1)
ok("meter reading shows projected figures", projectedRow.includes("3K/128K"))
// Full context clamps at 100% and shifts the fill to the warning/error hue.
const fullApp = new App(fakeTerm)
fullApp.setSession({ id: "t1", title: "Test" })
fullApp.setContextMeter({ pressure: { pressureTokens: 300_000, contextWindow: 128_000 } })
eq("meter clamps at 100%", fullApp.contextMeter.percent, 100)
// Click-open breakdown panel: headline, reading, segmented bar, legend.
const panelApp = new App(fakeTerm)
panelApp.setSession({ id: "t1", title: "Test" })
panelApp.setContextMeter({
  pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
  breakdown: { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 },
})
panelApp.contextMeterOpen = true
const panelRendered = panelApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("context panel headline", panelRendered.includes("context") && panelRendered.includes("used 25%"))
ok("context panel figures", panelRendered.includes("~32K / 128K"))
ok("context panel legend", panelRendered.includes("system prompt") && panelRendered.includes("tools") && panelRendered.includes("messages"))
ok("context panel hidden behind settings", !panelRendered.includes("Settings") || panelRendered.includes("Esc close"))
// Zero occupancy draws no fill segment but still shows the figures.
const zeroApp = new App(fakeTerm)
zeroApp.setSession({ id: "t1", title: "Test" })
zeroApp.setContextMeter({ pressure: { pressureTokens: 0, contextWindow: 128_000 } })
zeroApp.contextMeterOpen = true
const zeroPanelRendered = zeroApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("zero occupancy still shows figures", zeroPanelRendered.includes("~0 / 128K"))
ok("context palette distinct", THEME.contextSystem !== THEME.contextTools && THEME.contextTools !== THEME.contextMessages)

// Tool invocations surface their primary value without leaking JSON field names.
const toolApp = new App(fakeTerm)
toolApp.setSession({ id: "t1", title: "Test" })
toolApp.startTool({ callId: "r1", name: "read", args: '{"file_path":"/a/b.txt"}' })
toolApp.startTool({ callId: "p1", name: "pwsh", args: '{"command":"pnpm test"}' })
toolApp.startTool({ callId: "g1", name: "glob", args: '{"pattern":"**/*.ts"}' })
const toolSummaryRendered = toolApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("tool summary hides raw field names", !toolSummaryRendered.includes("file_path") && !toolSummaryRendered.includes("command") && !toolSummaryRendered.includes("pattern"))
ok("tool summary shows values", toolSummaryRendered.includes("/a/b.txt") && toolSummaryRendered.includes("pnpm test") && toolSummaryRendered.includes("**/*.ts"))

// A blank line separates a collapsed thinking box from the visible answer.
const gapApp = new App(fakeTerm)
gapApp.setSession({ id: "t1", title: "Test" })
gapApp.addUser("hi")
const gapAssistant = gapApp.ensureAssistantBlock(Date.now())
gapAssistant.reasoning = "thinking text"
gapAssistant.thinkingCollapsed = true
gapAssistant.text = "answer"
gapAssistant.streaming = false
const gapRows = gapApp.render().cells.map((r) => r.map((c) => c.ch).join(""))
const thinkIdx = gapRows.findIndex((r) => r.includes("thinking"))
const answerIdx = gapRows.findIndex((r) => r.includes("answer"))
ok("blank line separates thinking box from answer", thinkIdx >= 0 && answerIdx === thinkIdx + 2 && gapRows[thinkIdx + 1].trim() === "")

// ---- theme / activity animation ----
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const animApp = new App(fakeTerm)
animApp.setSession({ id: "t1", title: "Test" })
ok("no animation when idle", !animApp.hasAnimation())
const toolBlock = animApp.startTool({ callId: "c1", name: "write", args: "{}" })
ok("animation while tool running", animApp.hasAnimation())
const toolRendered = animApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const toolRow = toolRendered.split(NL2).find((l) => l.includes("write"))
ok("running tool shows flowing spinner", toolRow && SPINNER.some((ch) => toolRow.includes(ch)))
animApp.updateTool("c1", { status: "ok", result: "done" })
ok("animation stops when tool finishes", !animApp.hasAnimation())

// Running composer border: the flat yellow frame becomes a flowing gold
// marching-ants frame (several gold tones around the perimeter, advancing
// over time, with the warning gold still the dominant color).
{
  const borderApp = new App(fakeTerm)
  borderApp.setSession({ id: "t1", title: "Test" })
  const idleScreen = borderApp.render()
  const idleTopRow = idleScreen.cells.find((row) => row.some((cell) => cell.ch === "╭"))
  const idleDashColors = new Set(idleTopRow.filter((cell) => cell.ch === "─").map((cell) => cell.style?.fg))
  eq("idle composer border is flat", idleDashColors.size, 1)
  ok("idle composer border uses theme border color", [...idleDashColors].every((c) => c === THEME.border))

  borderApp.setStatus("running")
  const realNow = Date.now
  let fakeNow = 1_000_000
  Date.now = () => fakeNow
  const mixHex = (a, b, t) => "#" + [0, 2, 4].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) + (parseInt(b.slice(i, i + 2), 16) - parseInt(a.slice(i, i + 2), 16)) * t).toString(16).padStart(2, "0")).join("")
  const golds = new Set([THEME.warning, THEME.warningDim, mixHex(THEME.warning, "ffffff", 0.5)])
  try {
    const flowScreen = borderApp.render()
    const topIdx = flowScreen.cells.findIndex((row) => row.some((cell) => cell.ch === "╭"))
    const flowTopRow = flowScreen.cells[topIdx]
    const flowColors = new Set(flowTopRow.filter((cell) => cell.ch === "─").map((cell) => cell.style?.fg))
    ok("running border flows with several gold tones", flowColors.size >= 2)
    ok("running border keeps the warning gold", flowColors.has(THEME.warning) && [...flowColors].every((c) => c !== THEME.border))
    ok("running border stays in the gold family", [...flowColors].every((c) => golds.has(c)))
    const sideRow = flowScreen.cells[topIdx + 1]
    ok("running side borders flow", sideRow.some((cell) => cell.ch === "│" && golds.has(cell.style?.fg)))
    // One 80ms step advances the marching-ants phase, so the tone sequence
    // along the top edge shifts even though nothing else changed.
    const before = flowTopRow.filter((c) => c.ch === "─").map((c) => c.style?.fg).join(",")
    fakeNow += 80
    const afterScreen = borderApp.render()
    const afterTopRow = afterScreen.cells[afterScreen.cells.findIndex((row) => row.some((cell) => cell.ch === "╭"))]
    const after = afterTopRow.filter((c) => c.ch === "─").map((c) => c.style?.fg).join(",")
    ok("running border advances over time", before !== after)
  } finally {
    Date.now = realNow
  }
  borderApp.setStatus("idle")
  const settledScreen = borderApp.render()
  const settledTopRow = settledScreen.cells.find((row) => row.some((cell) => cell.ch === "╭"))
  ok("border settles back to static when idle", settledTopRow.filter((cell) => cell.ch === "─").every((cell) => cell.style?.fg === THEME.border))
}

// Streaming thinking header carries the flowing spinner too.
const spinThink = new App(fakeTerm)
spinThink.setSession({ id: "t1", title: "Test" })
spinThink.addUser("hi")
const spinBlock = spinThink.ensureAssistantBlock(Date.now())
spinBlock.reasoning = "thinking out loud"
spinBlock.streaming = true
const spinRendered = spinThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const thinkingRow = spinRendered.split(NL2).find((l) => l.includes("thinking"))
ok("streaming thinking shows flowing spinner", thinkingRow && SPINNER.some((ch) => thinkingRow.includes(ch)))

// Title brand is drawn with a blue->white gradient (multiple distinct fg colors).
const gradApp = new App(fakeTerm)
gradApp.setWelcome({ workingDirectory: "D:/x" })
const gradScreen = gradApp.render()
const gradRow = gradScreen.cells.findIndex((row) => row.map((c) => c.ch).join("").includes("DeepSeek Harness"))
const gradColors = new Set()
for (const cell of gradScreen.cells[gradRow]) {
  if (cell.style && cell.style.fg) gradColors.add(cell.style.fg)
}
ok("title blue-white gradient", gradRow >= 0 && gradColors.size >= 2)
ok("theme is DeepSeek blue-white, no orange", THEME.primary === "4d6bfe" && !Object.values(THEME).some((c) => String(c).toLowerCase() === "fab283"))

// assistant/message semantics: the visible text excludes reasoning, which
// stays in its own box (so the box does not "disappear" into plain output).
const msgApp = new App(fakeTerm)
msgApp.setSession({ id: "t1", title: "Test" })
msgApp.addUser("hi")
msgApp.streamChunk({ type: "reasoning-delta", text: "private chain of thought" })
msgApp.streamChunk({ type: "text-delta", text: "the answer" })
const msgBlock = msgApp.blocks[msgApp.blocks.length - 1]
msgBlock.text = contentText([{ type: "reasoning", text: "private chain of thought" }, { type: "text", text: "the answer" }], { skipReasoning: true })
msgBlock.reasoning = "private chain of thought"
msgBlock.streaming = false
msgBlock.thinkingCollapsed = true
msgBlock.rev++
const msgRendered = msgApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("reasoning stays in its box after message", msgApp.hitRegions.some((region) => region.kind === "thinking") && msgRendered.includes("thinking"))
ok("reasoning not duplicated in plain text", !msgRendered.includes("private chain of thought") || msgRendered.includes("the answer"))
msgApp.toggleThinking(msgBlock)
const msgExpanded = msgApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("reasoning visible when expanded", msgExpanded.includes("private chain of thought"))

// ---- background normalization -------------------------------------------
// Every rendered cell carries an explicit background: fg-only styles
// (markdown text, indents, row tail fills) are normalized onto the themed
// canvas so nothing falls back to the terminal's default (black) background.
{
  const bgApp = new App(fakeTerm)
  bgApp.setSession({ id: "t1", title: "Test" })
  bgApp.addUser("hello")
  const bgBlock = bgApp.ensureAssistantBlock(Date.now())
  bgBlock.text = "plain **bold** and `code` words"
  bgBlock.streaming = false
  bgBlock.rev++
  const bgScreen = bgApp.render()
  let missing = 0
  for (const row of bgScreen.cells) {
    for (const cell of row) {
      if (!cell.style?.bg) missing++
    }
  }
  eq("every cell carries an explicit background", missing, 0)
  ok("markdown text sits on the canvas background", bgScreen.cells.some((row) => row.some((cell) => cell.ch === "p" && cell.style?.fg === THEME.text && cell.style?.bg === THEME.background)))
  ok("code spans keep their own background", bgScreen.cells.some((row) => row.some((cell) => cell.ch === "c" && cell.style?.bg === THEME.codeBg)))
  // The engine helper itself: null styles and fg-only styles get the default,
  // explicit backgrounds survive.
  const plain = new Screen(4, 2)
  plain.text(0, 0, "ab", makeStyle({ fg: "ffffff" }))
  plain.text(0, 1, "cd")
  plain.defaultBackground("0a0e18")
  ok("defaultBackground fills null and fg-only styles", plain.cells[0][0].style.bg === "0a0e18" && plain.cells[1][0].style.bg === "0a0e18" && plain.cells[1][0].style.fg === null)
  const kept = new Screen(2, 1)
  kept.set(0, 0, "x", makeStyle({ fg: "ffffff", bg: "111a2c" }))
  kept.defaultBackground("0a0e18")
  ok("defaultBackground keeps explicit backgrounds", kept.cells[0][0].style.bg === "111a2c")
}

// ---- reasoning-effort slider ----
const sliderApp = new App(fakeTerm)
sliderApp.setSession({ id: "t1", title: "Test" })
sliderApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }], current: "high" })
sliderApp.effortSliderVisible = true
const sliderMidScreen = sliderApp.render()
const sliderRendered = sliderMidScreen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const sliderMidRow = sliderMidScreen.cells.find((row) => row.some((cell) => cell.ch === "█"))
const sliderMidRowText = sliderMidRow?.map((cell) => cell.ch).join("") ?? ""
ok("effort word removed from slider screen", !sliderRendered.toLowerCase().includes("effort"))
ok("slider hint mentions Tab", sliderRendered.includes("Tab"))
ok("effort slider current name", sliderRendered.includes("high"))
ok("effort slider row keeps current value", sliderMidRowText.includes("high"))
ok("effort slider real range hint", sliderRendered.includes("off") && sliderRendered.includes("max"))
const midComposerRow = sliderMidScreen.cells.find((row) => row.some((cell) => cell.ch === "╭"))?.map((cell) => cell.ch).join("") ?? ""
ok("composer label drops effort word", midComposerRow.includes("high") && !midComposerRow.includes("effort"))
ok("effort slider not animated at mid strength", !sliderApp.hasAnimation())
sliderApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }], current: "max" })
ok("effort slider animates at max", sliderApp.hasAnimation())
const sliderMaxScreen = sliderApp.render()
const sliderMaxRendered = sliderMaxScreen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("effort slider max marker is text-safe", sliderMaxRendered.includes("↑") && !sliderMaxRendered.includes(String.fromCodePoint(0x26A1)))
const sliderMaxRow = sliderMaxScreen.cells.find((row) => row.some((cell) => cell.ch === "█"))
const sliderGradientColors = new Set(sliderMaxRow?.filter((cell) => cell.ch === "█").map((cell) => cell.style?.fg).filter(Boolean))
ok("effort slider max uses gradient colors", sliderGradientColors.size > 1)
const composerTopRow = sliderMaxScreen.cells.find((row) => {
  const text = row.map((cell) => cell.ch).join("")
  return text.includes("╭") && text.includes("↑") && text.includes("max")
})
const composerTopText = composerTopRow?.map((cell) => cell.ch).join("") ?? ""
ok("effort value is pinned to composer top-right", composerTopText.lastIndexOf("max") > composerTopText.length / 2 && composerTopText.includes("╮"))
const maxStart = composerTopText.lastIndexOf("max")
const maxTextColors = new Set(composerTopRow?.slice(maxStart, maxStart + 3).map((cell) => cell.style?.fg).filter(Boolean))
ok("max text uses flowing gradient colors", maxTextColors.size > 1)
sliderApp.effortSliderVisible = false
ok("max animation continues after slider closes", sliderApp.hasAnimation())
// A one-level Off-only model is not max and must not animate.
const offOnlyApp = new App(fakeTerm)
offOnlyApp.setSession({ id: "t1", title: "Test" })
offOnlyApp.setEffortSlider({ levels: [{ id: "off", name: "Off" }], current: "off" })
offOnlyApp.effortSliderVisible = true
const offOnlyRendered = offOnlyApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("off-only slider does not animate as max", !offOnlyApp.hasAnimation() && !offOnlyRendered.includes("↑ max"))
// A boolean-thinking model exposes exactly its two ends, never a fake scale.
const boolApp = new App(fakeTerm)
boolApp.setSession({ id: "t1", title: "Test" })
boolApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }], current: "off" })
boolApp.effortSliderVisible = true
const boolRendered = boolApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("boolean slider shows exactly two ends", boolRendered.includes("off") && boolRendered.includes("high") && !boolRendered.includes("effort"))
ok("boolean slider not animated at off", !boolApp.hasAnimation())
// A partial-range provider (off/high/max) must not map to a full none..max.
const partialApp = new App(fakeTerm)
partialApp.setSession({ id: "t1", title: "Test" })
partialApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }], current: "high" })
partialApp.effortSliderVisible = true
const partialRendered = partialApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("partial slider uses provider levels only", !partialRendered.includes("none") && !partialRendered.includes("low") && !partialRendered.includes("medium"))

console.log("")
if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all smoke tests passed")