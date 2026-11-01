// The add-provider flow: the directory split that decides what the Model tab
// lists and what the add picker offers, the create form's validation, and the
// write it makes. These are the pieces that were missing entirely — the Model
// tab could edit a provider that already existed and could not create one — so
// each assertion here covers a way the flow used to be unusable rather than a
// detail of its presentation.
// Run: node tests/provider-form.test.mjs
process.env.DSH_TUI_LOCALE = "en"

import z from "@deepseek-ai/schemastery"
import {
  adoptDiscovered,
  buildCreateFormItems,
  buildModelFormItems,
  capacitySuffix,
  createDraft,
  declareNamespace,
  deriveRoute,
  discoverDraftModels,
  draftModelItems,
  fetchProviderModels,
  filterAddable,
  mergeModelSelection,
  formatCapacity,
  modelDraftFrom,
  modelFromDraft,
  normalizeModels,
  parseCapacity,
  protocolChoices,
  providerDirectory,
  providerPickerItems,
  removeModelEntry,
  routeKeyRef,
  saveCreateDraft,
  saveModelEntry,
  validateCreateDraft,
  validateModelDraft,
} from "../lib/providers.js"
import { loadModelSettings, loadProviderModels, saveWebSetting } from "../lib/web-settings.js"
import { fieldPasteText } from "../lib/util.js"

let failures = 0
const report = []
function ok(name, condition, extra = "") {
  if (condition) { report.push("ok   " + name); return }
  failures++
  report.push("FAIL " + name + (extra ? "  " + extra : ""))
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { report.push("ok   " + name); return }
  failures++
  report.push("FAIL " + name + "\n     actual:   " + a + "\n     expected: " + b)
}

// The schema a provider namespace declares, serialized the way the settings
// service hands it over. Protocol choices are READ from this, which is the
// whole point: a hardcoded list offered `google-generative-ai`, a protocol this
// adapter family has no implementation for.
const PI_AI_SCHEMA = z.object({
  providers: z.dict(z.object({
    api: z.union(["openai-completions", "openai-responses", "anthropic-messages"]),
    apiKeyEnv: z.string(),
    displayName: z.string(),
    baseURL: z.string(),
    models: z.array(z.object({ id: z.string().required() })),
  })).default({}).volatile(),
}).toJSON()
// A different family: no per-route profiles at all, so nothing to declare.
const DEEPSEEK_SCHEMA = z.object({
  baseURL: z.string().volatile(),
  apiKeyEnv: z.string().volatile(),
  models: z.array(z.object({ id: z.string().required() })).default([{ id: "deepseek-flash" }]).volatile(),
}).toJSON()

function setAt(root, path, value) {
  let node = root
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof node[path[i]] !== "object" || node[path[i]] === null) node[path[i]] = {}
    node = node[path[i]]
  }
  if (value === undefined) delete node[path[path.length - 1]]
  else node[path[path.length - 1]] = value
  return root
}

function makeSettings(sections) {
  const state = new Map(Object.entries(sections).map(([ns, entry]) => [ns, structuredClone(entry)]))
  return {
    writable: true,
    writes: [],
    describe() {
      return [...state].map(([ns, entry]) => ({
        ns,
        value: entry.value,
        user: entry.user ?? {},
        base: entry.base,
        schema: entry.schema,
        revision: 0,
        applies: "live",
      }))
    },
    async mutate(ns, ops, revision) {
      const entry = state.get(ns)
      this.writes.push({ ns, ops, revision })
      for (const op of ops) {
        entry.value = setAt(entry.value ?? {}, op.path, op.op === "set" ? op.value : undefined)
        entry.user = setAt(entry.user ?? {}, op.path, op.op === "set" ? op.value : undefined)
      }
    },
    section(ns) { return state.get(ns).value },
  }
}

const storedKeys = new Map()
const credentials = {
  configured: storedKeys,
  async describe(ref) { return { configured: storedKeys.has(ref), writable: true } },
  async set(ref, value) { storedKeys.set(ref, value) },
  async unset(ref) { storedKeys.delete(ref) },
}

// The directory a fresh install sees: the DeepSeek route is a whole-section
// plugin Config (nothing in the user layer), the catalog routes are unclaimed,
// and two hand-declared routes were added earlier.
const llm = {
  listProviders() { return [{ id: "deepseek-official", name: "DeepSeek" }, { id: "sophnet", name: "sophnet" }] },
  listConfigurableProviders() {
    return [
      { provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
      { provider: "deepseek-account", displayName: "DeepSeek Account", settingsNs: "llm-deepseek-account", settingsPath: [] },
      { provider: "anthropic", displayName: "anthropic", settingsNs: "llm-pi-ai", settingsPath: ["providers", "anthropic"] },
      { provider: "openai", displayName: "openai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openai"] },
      { provider: "sophnet", displayName: "SophNet", settingsNs: "llm-pi-ai", settingsPath: ["providers", "sophnet"], declared: true },
      { provider: "ghost", displayName: "Ghost", settingsNs: "llm-absent", settingsPath: [] },
    ]
  },
  async discoverModels(settingsNs, request) {
    if (request.provider === "anthropic") return [{ id: "claude-a" }, { id: "claude-b", inputModalities: ["text", "image"] }]
    if (request.baseURL === "https://gw.test/v1") return [{ id: "gw-large", contextWindow: 200000, maxTokens: 8192 }]
    return []
  },
}

const settings = makeSettings({
  "llm-deepseek": { value: { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{ id: "deepseek-flash" }] }, schema: DEEPSEEK_SCHEMA, user: {} },
  "llm-deepseek-account": { value: { models: [{ id: "deepseek-flash" }] }, schema: DEEPSEEK_SCHEMA, user: {} },
  "llm-pi-ai": {
    value: { providers: { sophnet: { api: "openai-completions", baseURL: "https://www.sophnet.com/api/open-apis/v1", models: [{ id: "DeepSeek-Flash-1017" }] } } },
    schema: PI_AI_SCHEMA,
    user: { providers: { sophnet: { api: "openai-completions" } } },
    base: {},
  },
  "agent-default-model": { value: { provider: "deepseek-official", model: "deepseek-flash" }, user: {} },
})
const ctx = {
  get(name) {
    if (name === "settings") return settings
    if (name === "credentials") return credentials
    if (name === "llm") return llm
  },
}

// ---- directory -------------------------------------------------------------

const directory = providerDirectory(ctx)
ok("the directory is available", directory !== undefined)
const configuredIds = directory.configured.map((row) => row.entry.provider).join(",")
// The whole-section routes are the regression this covers: their user layer is
// empty on a fresh install, and requiring a user override hid DeepSeek — the one
// provider a new user owns — from the very tab that configures it.
eq("whole-section routes count as configured even with no user layer",
  configuredIds, "deepseek-official,deepseek-account,sophnet")
eq("catalog routes without a profile are addable",
  directory.addable.map((row) => row.entry.provider).join(","), "anthropic,openai")
ok("a route whose settings namespace the host does not expose is dropped",
  ![...directory.configured, ...directory.addable].some((row) => row.entry.provider === "ghost"))

const picker = providerPickerItems(directory)
eq("the picker offers the addable routes plus the custom entry",
  picker.filter((item) => item.kind === "provider-pick").map((item) => item.label).join(","),
  "anthropic,openai")
ok("the custom entry is always offered", picker.some((item) => item.kind === "provider-pick-custom"))
ok("the first row is the filter", picker[0].kind === "provider-search")
ok("the custom entry sits above the catalog the filter narrows",
  picker.findIndex((item) => item.kind === "provider-pick-custom") < picker.findIndex((item) => item.kind === "header"))

// ---- the picker's filter ---------------------------------------------------

const narrowed = providerPickerItems(directory, { query: "anth" })
eq("the filter narrows by route id", narrowed.filter((item) => item.kind === "provider-pick").map((item) => item.label), ["anthropic"])
eq("the filter row shows what was typed", narrowed[0].value, "anth")
ok("the custom entry survives a filter that matches no route",
  narrowed.some((item) => item.kind === "provider-pick-custom"))
eq("the filter is case-insensitive", filterAddable(directory.addable, "ANTH").length, 1)
eq("no match says so instead of showing an empty catalog",
  providerPickerItems(directory, { query: "zzz" }).filter((item) => item.kind === "provider-empty").length, 1)
eq("everything configured reads differently from nothing matching",
  providerPickerItems({ addable: [] }, { query: "" }).filter((item) => item.kind === "provider-empty")[0].label,
  "every installed provider is already configured")

// ---- protocol choices ------------------------------------------------------

eq("protocols come from the namespace's own schema",
  protocolChoices(directory.descriptors.get("llm-pi-ai")),
  ["openai-completions", "openai-responses", "anthropic-messages"])
eq("a namespace with no per-route api declares no protocols",
  protocolChoices(directory.descriptors.get("llm-deepseek")), [])
eq("the declaring namespace is found by probe, not by name",
  declareNamespace(directory)?.settingsNs, "llm-pi-ai")
ok("the UNSUPPORTED protocol is not offered",
  !protocolChoices(directory.descriptors.get("llm-pi-ai")).includes("google-generative-ai"))

// ---- the Model tab ---------------------------------------------------------

const tab = await loadModelSettings(ctx)
const headers = tab.items.filter((item) => item.kind === "header").map((item) => item.label)
ok("every configured provider gets a block", ["DeepSeek", "DeepSeek Account", "SophNet"].every((name) => headers.includes(name)))
ok("an unconfigured catalog route does not", !headers.includes("anthropic"))
ok("the account route has no API-key row",
  !tab.items.some((item) => item.kind === "secret" && item.label === "Provider API key" && item.credentialRef === "DEEPSEEK_ACCOUNT_API_KEY"))
ok("the account route says how it authenticates",
  tab.items.some((item) => item.kind === "provider-note"))
ok("the whole-section route has no model editor",
  !tab.items.some((item) => item.kind === "provider-models" && item.providerId === "deepseek-official"))
ok("a path-scoped route keeps its model editor",
  tab.items.some((item) => item.kind === "provider-models" && item.providerId === "sophnet"))
ok("the declared route offers every protocol the adapter serves",
  (() => {
    const row = tab.items.find((item) => item.kind === "path-choice")
    return row && row.options.length === 3 && !row.options.includes("google-generative-ai")
  })())
const addRow = tab.items.find((item) => item.kind === "provider-add")
ok("the tab ends with the add flow", addRow !== undefined && addRow.label === "Add provider" && !addRow.disabled)
ok("the add row reports how many routes are addable", String(addRow.value).includes("2"))
ok("a hand-declared route can gain a model without discovery",
  tab.items.some((item) => item.kind === "provider-model-add" && item.path.join("/") === "providers/sophnet"))

// An empty install: the add row is the only way out, so it must be there and
// the tab must say why it is empty.
const emptySettings = makeSettings({
  "llm-pi-ai": { value: { providers: {} }, schema: PI_AI_SCHEMA, user: {} },
})
const emptyCtx = {
  get(name) {
    if (name === "settings") return emptySettings
    if (name === "credentials") return credentials
    if (name === "llm") return { listConfigurableProviders: () => llm.listConfigurableProviders() }
  },
}
const emptyTab = await loadModelSettings(emptyCtx)
ok("an empty install still reaches the add flow",
  emptyTab.items.some((item) => item.kind === "provider-add" && !item.disabled))
eq("and says so", emptyTab.items.filter((item) => item.kind === "provider-none").length, 1)

// ---- the create form ------------------------------------------------------

const customDraft = createDraft("custom")
customDraft.api = "openai-completions"
const customItems = buildCreateFormItems(customDraft, { protocols: protocolChoices(directory.descriptors.get("llm-pi-ai")) })
const fields = customItems.filter((item) => item.kind === "provider-field").map((item) => item.field)
eq("a declared route asks for its identity, endpoint, protocol, key and models",
  fields, ["route", "displayName", "baseURL", "api", "key", "models", "addModel"])
ok("the save row is the last real action",
  customItems.at(-1).kind === "provider-save" && customItems.at(-1).label === "Save provider")
ok("the route row explains where the key will be stored",
  customItems.some((item) => item.kind === "provider-hint" && item.label.includes("ACME_GATEWAY_API_KEY")))

const adopted = createDraft("catalog", "anthropic")
const adoptedItems = buildCreateFormItems(adopted, { protocols: [], title: "anthropic" })
ok("adopting a catalog route does not ask for a route id",
  !adoptedItems.some((item) => item.kind === "provider-field" && item.field === "route"))
ok("it names the route it is adopting", adoptedItems[0].label === "anthropic")

// ---- validation -----------------------------------------------------------

const goodCustom = { ...createDraft("custom"), route: "acme-gateway", baseURL: "https://gw.test/v1", api: "openai-completions", models: [{ id: "gw-large" }] }
eq("a complete declaration passes", validateCreateDraft(goodCustom, { taken: [] }), undefined)
ok("a route id must look like a route id",
  typeof validateCreateDraft({ ...goodCustom, route: "Acme_Gateway" }, { taken: [] }) === "string")
ok("a digit-leading route id is refused (a credential name cannot start with one)",
  typeof validateCreateDraft({ ...goodCustom, route: "1acme" }, { taken: [] }) === "string")
ok("an existing route id is refused",
  validateCreateDraft({ ...goodCustom, route: "sophnet" }, { taken: ["sophnet"] }) !== undefined)
ok("a declaration needs an endpoint",
  validateCreateDraft({ ...goodCustom, baseURL: "" }, { taken: [] }) !== undefined)
ok("a non-http endpoint is refused",
  validateCreateDraft({ ...goodCustom, baseURL: "gw.test/v1" }, { taken: [] }) !== undefined)
ok("a declaration needs a protocol",
  validateCreateDraft({ ...goodCustom, api: "" }, { taken: [] }) !== undefined)
// Nothing about a hand-declared route can default its models: the adapter has
// no catalog entry to fall back on, so zero models is a profile it refuses.
ok("a declaration needs at least one model",
  validateCreateDraft({ ...goodCustom, models: [] }, { taken: [] }) !== undefined)
ok("a model row needs an id",
  validateCreateDraft({ ...goodCustom, models: [{ id: "gw-large" }, { id: "" }] }, { taken: [] }) !== undefined)
ok("a model cannot be listed twice",
  validateCreateDraft({ ...goodCustom, models: [{ id: "m" }, { id: "m" }] }, { taken: [] }) !== undefined)
eq("an adopted catalog route needs nothing but its id",
  validateCreateDraft(createDraft("catalog", "anthropic"), { taken: [] }), undefined)
ok("but a bad endpoint is still refused there",
  validateCreateDraft({ ...createDraft("catalog", "anthropic"), baseURL: "nope" }, { taken: [] }) !== undefined)

// ---- the write ------------------------------------------------------------

const before = settings.section("llm-pi-ai")
await saveCreateDraft(ctx, settings, { ...goodCustom, key: "sk-test", displayName: "Acme Gateway" }, { settingsNs: "llm-pi-ai", revision: 0 })
const written = settings.section("llm-pi-ai").providers["acme-gateway"]
eq("the profile is written at providers.<route>",
  written, { apiKeyEnv: "ACME_GATEWAY_API_KEY", displayName: "Acme Gateway", api: "openai-completions", baseURL: "https://gw.test/v1", models: [{ id: "gw-large" }] })
eq("the key is stored under the reference the profile names", storedKeys.get("ACME_GATEWAY_API_KEY"), "sk-test")
ok("the sibling profiles are untouched", settings.section("llm-pi-ai").providers.sophnet !== undefined && before.providers.sophnet.baseURL === settings.section("llm-pi-ai").providers.sophnet.baseURL)

// A route added without a key keeps its provider-native authentication: naming
// a reference nothing stores would make it fail at request time instead.
await saveCreateDraft(ctx, settings, { ...createDraft("catalog", "anthropic") }, { settingsNs: "llm-pi-ai", revision: 0 })
eq("a keyless adoption stores an empty profile",
  settings.section("llm-pi-ai").providers.anthropic, {})
ok("and stores no credential",
  ![...storedKeys.keys()].some((ref) => ref === "ANTHROPIC_API_KEY"))

// ---- the draft's model window ---------------------------------------------

const draft = { ...createDraft("custom"), route: "acme-gateway", models: [{ id: "gw-large" }, { id: "hand-typed" }] }
const rows = draftModelItems(draft, [{ id: "gw-large" }, { id: "gw-small" }], { providerId: "acme-gateway" })
eq("the window lists the endpoint's answer and the stored rows, deduplicated",
  rows.filter((item) => item.kind === "model-toggle").map((item) => item.modelId).join(","),
  "gw-large,gw-small,hand-typed")
ok("saved rows are checked and the rest are not",
  rows.filter((item) => item.kind === "model-toggle").every((item) => item.checked === (item.modelId !== "gw-small")))
eq("an empty answer still lists the stored selection",
  draftModelItems({ ...draft, models: [{ id: "only" }] }, []).map((item) => item.modelId), ["only"])
const adoptedModel = adoptDiscovered({ id: "gw-large", contextWindow: 200000, maxTokens: 8192, inputModalities: ["text", "image"] })
eq("an adopted model keeps the capacities the endpoint reported",
  adoptedModel, { id: "gw-large", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] })
eq("a model the endpoint reported no capacities for is stored as an id alone",
  adoptDiscovered({ id: "bare" }), { id: "bare" })
eq("the credential reference derivation matches the WebUI's",
  routeKeyRef("minimax-cn"), "MINIMAX_CN_API_KEY")

// ---- one model's entry -----------------------------------------------------

eq("capacities are typed the way people say them",
  [parseCapacity("256K"), parseCapacity("1M"), parseCapacity("1000"), parseCapacity(""), Number.isNaN(parseCapacity("lots"))],
  [256000, 1000000, 1000, undefined, true])
eq("and read back the same way", [formatCapacity(256000), formatCapacity(1000000), formatCapacity(262144)], ["256K", "1M", "262144"])
eq("a model row carries its capacities beside the checkbox",
  capacitySuffix({ id: "m", contextWindow: 256000, maxTokens: 32000 }), "  256K · 32K")
eq("a model with no capacities says nothing", capacitySuffix({ id: "m" }), "")

const storedDraft = modelDraftFrom({ id: "gw-large", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] })
const editorItems = buildModelFormItems(storedDraft, { isNew: false })
eq("the editor names the entry it edits", editorItems[0].label, "Model · gw-large")
ok("the id is fixed while editing in place", !editorItems.some((item) => item.field === "id"))
eq("the capacities come back as they were typed", [
  editorItems.find((item) => item.field === "contextWindow").value,
  editorItems.find((item) => item.field === "maxTokens").value,
  // 8192 is not a round thousands count, so it stays exact rather than being
  // rounded into a `8K` that would read back as a different number.
], ["200K", "8192"])
eq("input modalities are a choice", [
  editorItems.find((item) => item.field === "input").value,
  editorItems.find((item) => item.field === "input").options.length,
], ["text + image", 2])
ok("an existing entry can be removed from the editor",
  editorItems.some((item) => item.kind === "model-remove"))
const newItems = buildModelFormItems(modelDraftFrom({ id: "" }), { isNew: true })
ok("a new entry asks for its id", newItems.some((item) => item.field === "id"))
ok("and offers no removal", !newItems.some((item) => item.kind === "model-remove"))

ok("an empty id is refused", typeof validateModelDraft({ id: "" }, { existing: [] }) === "string")
ok("a duplicate id is refused", validateModelDraft({ id: "m" }, { existing: [{ id: "m" }] }) !== undefined)
ok("a row being edited may keep its own id",
  validateModelDraft({ id: "m" }, { existing: [{ id: "other" }] }) === undefined)
ok("an unparseable capacity is refused", validateModelDraft({ id: "m", contextWindow: "lots" }) !== undefined)
eq("a complete entry passes", validateModelDraft({ id: "m", contextWindow: "256K" }, { existing: [] }), undefined)
eq("only the fields that are set are stored",
  modelFromDraft({ id: " m ", name: "  ", contextWindow: "256K", maxTokens: "", input: ["text", "image"] }),
  { id: "m", contextWindow: 256000, input: ["text", "image"] })

// ---- writing one entry -----------------------------------------------------

const entryTarget = (index, storedModels) => ({
  settingsNs: "llm-pi-ai",
  providerPath: ["providers", "anthropic"],
  storedModels,
  revision: 0,
  index,
})
await saveModelEntry(settings, entryTarget(-1, []), { id: "claude-a", contextWindow: "128K" })
eq("a new model is appended to the provider",
  settings.section("llm-pi-ai").providers.anthropic.models, [{ id: "claude-a", contextWindow: 128000 }])
await saveModelEntry(settings, entryTarget(0, settings.section("llm-pi-ai").providers.anthropic.models), { id: "claude-a", maxTokens: "8K" })
eq("an edit replaces the addressed row rather than adding a second",
  settings.section("llm-pi-ai").providers.anthropic.models, [{ id: "claude-a", maxTokens: 8000 }])
await removeModelEntry(settings, entryTarget(0, settings.section("llm-pi-ai").providers.anthropic.models))
eq("removing the last row unsets the field instead of storing an empty list",
  settings.section("llm-pi-ai").providers.anthropic, {})

// ---- the saved provider's model window -------------------------------------

const window = await loadProviderModels(ctx, "sophnet")
const windowRows = window.items.filter((item) => item.kind === "model-toggle")
eq("the window lists the saved model", windowRows.map((item) => item.modelId).join(","), "DeepSeek-Flash-1017")
ok("a saved row carries its position in the list",
  windowRows.find((item) => item.modelId === "DeepSeek-Flash-1017")?.storedIndex === 0)
ok("the window offers the two actions discovery cannot cover",
  window.items.some((item) => item.kind === "model-add") && window.items.some((item) => item.kind === "model-refresh"))
ok("its subtitle names the per-row keys",
  window.subtitle.includes("e edit") && window.subtitle.includes("Del remove"))

// A discovered model that the window echoes back must be adoptable as-is; the
// normalization step is what makes a string entry and an object entry agree.
eq("string and object entries normalize alike",
  normalizeModels(["a", { id: "b" }, { id: "" }, null]), [{ id: "a" }, { id: "b" }])

// ---- pasting into a field ---------------------------------------------------
// The routing is pinned end to end in `tests/settings-paste.test.mjs`; what a
// paste contributes to the field is decided here.

eq("a secret paste loses its newlines entirely — one key stays one key",
  fieldPasteText(Buffer.from("sk-a\r\nsk-b\n"), { secret: true }), "sk-ask-b")
eq("a plain field folds a newline run into one space",
  fieldPasteText(Buffer.from("a\n\nb"), {}), "a b")
eq("an image paste has no text form",
  fieldPasteText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {}), null)
eq("an empty paste contributes nothing", fieldPasteText(Buffer.alloc(0)), null)
eq("terminal padding (NUL) is stripped",
  fieldPasteText(Buffer.from("sk-key\u0000\u0000", "utf8"), { secret: true }), "sk-key")


// ---- a refused fetch says why ----------------------------------------------
// The reason is the whole point: "no models" with nothing else is what makes a
// fetch look broken when the answer was a 401 the user could fix.

const refusedCtx = {
  get(name) {
    if (name !== "llm") return undefined
    return {
      async discoverModels() {
        throw Object.assign(new Error("https://gw.test/v1/models answered 401; check the API key"), { code: "DISCOVERY_FAILED" })
      },
    }
  },
}
const refused = await fetchProviderModels(refusedCtx, { provider: "gw", settingsNs: "llm-pi-ai" }, { baseURL: "https://gw.test/v1" })
eq("a refused fetch reports the refusal", [refused.failed, refused.models.length, refused.error],
  [true, 0, "https://gw.test/v1/models answered 401; check the API key"])

// A namespace that registers no discovery answers from its adapter instead;
// when even that is missing the refusal is stated rather than invented.
const silentCtx = {
  get(name) {
    if (name !== "llm") return undefined
    return { async discoverModels() { throw Object.assign(new Error("none"), { code: "NO_DISCOVERY" }) } }
  },
}
const silent = await fetchProviderModels(silentCtx, { provider: "x", settingsNs: "llm-deepseek" }, {})
eq("a namespace with no discovery and no adapter is a refusal",
  [silent.failed, silent.error], [true, "the endpoint answered with no model list"])

// ---- the selection window ---------------------------------------------------

const candidates = [{ id: "c1" }, { id: "c2", maxTokens: 8000 }]
const allPicked = draftModelItems({ ...createDraft("custom"), models: [{ id: "c1" }, { id: "c2" }] }, candidates, { providerId: "gw" })
eq("the whole-selection row counts what is picked", [allPicked[0].kind, allPicked[0].value, allPicked[0].allPicked],
  ["model-select-all", "[x] 2/2", true])
const halfPicked = draftModelItems({ ...createDraft("custom"), models: [{ id: "c1" }] }, candidates, { providerId: "gw" })
eq("a partial selection reads as partial", [halfPicked[0].value, halfPicked[0].allPicked], ["[ ] 1/2", false])
// With nothing advertised there is no selection to toggle, so the row is absent.
ok("no candidates means no select-all row",
  !draftModelItems(createDraft("custom"), [], {}).some((item) => item.kind === "model-select-all"))
eq("the refusal is the first row when the fetch failed",
  draftModelItems({ ...createDraft("custom"), models: [{ id: "hand" }] }, [], { failed: true, error: "answered 401" })[0].kind,
  "model-error")
eq("a toggle row carries the candidate it would adopt",
  allPicked.find((item) => item.kind === "model-toggle").candidate, { id: "c1" })

eq("selecting all keeps a corrected row and adopts the rest",
  mergeModelSelection([{ id: "c1", maxTokens: 9 }], [{ id: "c1", maxTokens: 1 }, { id: "c2", contextWindow: 1000 }]),
  [{ id: "c1", maxTokens: 9 }, { id: "c2", contextWindow: 1000 }])

// ---- writing the whole selection -------------------------------------------

const selectAllItem = {
  kind: "model-select-all",
  settingsNs: "llm-pi-ai",
  providerPath: ["providers", "anthropic"],
  storedModels: [{ id: "mine" }],
  candidates,
  revision: 0,
  allPicked: false,
}
await saveWebSetting(ctx, settings, selectAllItem, "on")
eq("select-all writes the stored rows plus every candidate",
  settings.section("llm-pi-ai").providers.anthropic.models,
  [{ id: "mine" }, { id: "c1" }, { id: "c2", maxTokens: 8000 }])
await saveWebSetting(ctx, settings, { ...selectAllItem, allPicked: true }, "")
eq("deselect-all unsets the field",
  settings.section("llm-pi-ai").providers.anthropic, {})


// What a draft fetch actually asks: the form's own fields, including a key that
// has not been stored yet, and no empty route id (an empty one is not a route).
const asked = []
const captureCtx = {
  get(name) {
    if (name !== "llm") return undefined
    return { async discoverModels(ns, request) { asked.push({ ns, request }); return [{ id: "m1" }] } }
  },
}
await discoverDraftModels(captureCtx, { route: "", baseURL: "https://gw.test/v1", api: "openai-completions", key: "sk-1" },
  { settingsNs: "llm-pi-ai", providerId: "" })
eq("a draft fetch carries the endpoint, protocol and unsaved key",
  asked[0], { ns: "llm-pi-ai", request: { baseURL: "https://gw.test/v1", api: "openai-completions", apiKey: "sk-1" } })


// ---- the route id a name implies -------------------------------------------
// The route is the settings key and the credential stem; the display name is
// what the user has in front of them. The form fills one from the other.
eq("a plain name is already a route", deriveRoute("rinkogemini"), "rinkogemini")
eq("spaces and case fold into dashes", deriveRoute("Acme Gateway"), "acme-gateway")
eq("punctuation collapses rather than repeating", deriveRoute("acme__gateway!!v2"), "acme-gateway-v2")
eq("a leading digit is dropped, because a credential name cannot start with one", deriveRoute("1acme"), "acme")
eq("a name with nothing usable yields nothing, so validation still speaks",
  deriveRoute("内部网关"), "")

console.log(report.join("\n"))
console.log("")
if (failures > 0) {
  console.log(failures + " provider-form check(s) failed")
  process.exit(1)
}
console.log("provider-form tests passed")
