// Tests for the @dsh-std interop layer: the live-TUI registry, the pure
// adapters between standard and TUI shapes, and the protocol shims.
// Run: node tests/std.test.mjs  (no dsh environment required)
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { registerLiveTui, liveTui } from "../lib/bridge.js"
import { parseManifest, projectManifest } from "@dsh-std/manifest"
import { notificationLevel, approvalOutcome, toTuiQuestions, fromTuiAnswers } from "../lib/std/adapt.js"
import { createPresentationHandlers, createPresentationImplementations, presentationOperations } from "../lib/std/presentation.js"
import { COMMAND_PLACEMENT, TUI_OWNED_COMMANDS, createCommandRuntimeHandler, createCommandRuntimeImplementation } from "../lib/std/commands.js"
import { Terminal } from "../lib/term.js"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..")

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log("ok   " + name) }
  else { console.log("FAIL " + name + "  got " + a + "  want " + e); failed++ }
}
const ok = (name, cond) => cond ? console.log("ok   " + name) : (console.log("FAIL " + name), failed++)
// For assertions that a call does not throw: a bare call would abort the whole
// file on failure, so the throw becomes a counted FAIL and the run keeps
// reporting the remaining assertions.
const noThrow = (name, fn) => {
  try { fn(); console.log("ok   " + name) }
  catch (error) { console.log("FAIL " + name + "  threw " + error.message); failed++ }
}

// ---- bridge ----
eq("no live TUI initially", liveTui(), null)

{
  const h = { tag: "first" }
  const release = registerLiveTui(h)
  eq("liveTui returns the registered handle", liveTui(), h)
  release()
  eq("release clears the handle", liveTui(), null)
  release()
  eq("release is idempotent", liveTui(), null)
}

// The two assertions above cannot distinguish a guard-free release from a
// guarded one: a second release on an already-empty registry trivially yields
// null. This case is what actually pins the `released` flag — re-registering
// the same handle and then calling the spent release must not clear the new
// registration.
{
  const h = { tag: "re-registered" }
  const spent = registerLiveTui(h)
  spent()
  const release2 = registerLiveTui(h)
  spent()
  eq("a spent release does not clear a re-registration", liveTui(), h)
  release2()
  eq("the re-registration can still be released", liveTui(), null)
}

{
  const a = { tag: "a" }
  const b = { tag: "b" }
  const releaseA = registerLiveTui(a)
  const releaseB = registerLiveTui(b)
  releaseA()
  eq("stale release must not clear a newer registration", liveTui(), b)
  // Leave the registry empty: later sections of this file assert on the
  // no-live-TUI state, and a handle left registered here would break them.
  releaseB()
  eq("the registry is empty again for the sections that follow", liveTui(), null)
}

// ---- manifest ----
{
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  const raw = readFileSync(join(repoRoot, "dsh-plugin.json"), "utf8")
  const manifest = parseManifest(raw, { source: "dsh-plugin.json" })

  eq("manifest id", manifest.id, "io.github.rayafriandion.dsh-oc-tui")
  eq("manifest version tracks package.json", manifest.version, pkg.version)
  eq("manifest license tracks package.json", manifest.license, pkg.license)
  eq("facet entry", manifest.facets.host.entry, "lib/facet.js")
  eq("facet apiVersion", manifest.facets.host.apiVersion, "v1alpha1")

  // The TUI consumes Command resources (it reads other components' commands).
  // Presentation and ContributionHost are things the TUI *provides*, and
  // Community v0.15 has no `supports` field, so they must NOT appear here.
  eq("requires.contracts is exactly the Command resource",
    manifest.requires.contracts,
    [{ apiVersion: "commands.dsh/v1alpha1", kind: "Command" }])

  const projected = projectManifest(manifest)
  const facet = projected.spec.facets[0]
  eq("projects to one host facet", projected.spec.facets.length, 1)
  eq("activation coordinate", facet.activation.apiVersion, "lifecycle.dsh/v1alpha1")
  eq("activation kind", facet.activation.kind, "FacetModule")
  eq("activation module", facet.activation.spec.module, "lib/facet.js")

  // Commands must carry placements, which the simple contributes.commands route
  // drops (its projection keeps only { title }). Without placements a command is
  // publishable on every surface, so a web UI would list /settings too.
  const commands = facet.extensions.filter((e) => e.kind === "Command")
  eq("nine TUI-owned commands contributed", commands.length, 9)
  ok("every command is scoped to the TUI command line",
    commands.every((e) => JSON.stringify(e.spec.placements)
      === JSON.stringify([{ apiVersion: "tui.dsh/v1alpha1", kind: "CommandLine" }])))
  ok("every command carries a contribution id label",
    commands.every((e) => typeof e.metadata.labels["dsh.std/contribution-id"] === "string"))

  const names = commands.map((e) => e.metadata.name).sort()
  eq("contributed command names", names,
    ["cancel", "clear", "help", "new", "quit", "resume", "rewind", "settings", "stats"])
  // /model and /provider are deliberately absent: runCommand asks
  // ctx.commands.find() first, so the harness owns them when it registers them.
  ok("model and provider are not claimed", !names.includes("model") && !names.includes("provider"))

  const quit = commands.find((e) => e.metadata.name === "quit")
  eq("quit keeps the exit alias", quit.spec.aliases, ["exit"])

  const perms = facet.permissions.map((p) => p.action + " @ " + p.spec.scope).sort()
  eq("storage permissions are scoped to the component id", perms, [
    "storage.local.read @ io.github.rayafriandion.dsh-oc-tui",
    "storage.local.write @ io.github.rayafriandion.dsh-oc-tui",
  ])

  // The bundle patch is a real host patch and must be declared as one.
  eq("overrides records the cordis bundle patch",
    manifest.overrides.map((o) => o.target + ":" + o.kind),
    ["@deepseek-ai/dsh-base:patch"])
}

// ---- facet ----
{
  // The adapter takes `namespace.default ?? namespace.facet` and requires
  // `activate` to be a function; without @dsh-std/sdk installed the module must
  // still load and report degraded rather than throw, because a throw during
  // mountProfileComponents rolls back every other component in the profile.
  const mod = await import(pathToFileURL(join(repoRoot, "lib/facet.js")).href)
  const facet = mod.default
  ok("facet default export exists", facet !== undefined && facet !== null)
  eq("facet exports exactly activate/deactivate/snapshot",
    Object.keys(facet).sort(), ["activate", "deactivate", "snapshot"])
  eq("facet.activate is a function", typeof facet.activate, "function")
  eq("facet.deactivate is a function", typeof facet.deactivate, "function")
  eq("facet.snapshot is a function", typeof facet.snapshot, "function")

  const degraded = await facet.snapshot()
  eq("facet reports degraded with no live TUI", degraded.state, "degraded")
  ok("facet explains why it is degraded",
    typeof degraded.message === "string" && degraded.message.length > 0)

  const release = registerLiveTui({ tag: "facet-test" })
  eq("facet reports active with a live TUI", (await facet.snapshot()).state, "active")
  release()
  eq("facet returns to degraded after the TUI unloads", (await facet.snapshot()).state, "degraded")
}

// ---- adapt: notification level ----
// The standard says 'warning'; the TUI's toast/system levels say 'warn'.
eq("notification info", notificationLevel("info"), "info")
eq("notification warning maps to warn", notificationLevel("warning"), "warn")
eq("notification error", notificationLevel("error"), "error")
eq("notification undefined defaults to info", notificationLevel(undefined), "info")

// ---- adapt: approval ----
// Only the TUI -> standard direction exists: the modal already settles in the
// TUI's own vocabulary ('allowed-once' | 'rejected' | 'cancelled'), and nothing
// in this design drives the modal from a standard decision.
eq("submitted approval", approvalOutcome("allowed-once"),
  { status: "submitted", value: { decision: "approved" } })
eq("submitted denial", approvalOutcome("rejected"),
  { status: "submitted", value: { decision: "denied" } })
// A cancel must never be readable as consent. This is the highest-consequence
// property in the module, so every non-decision shape is pinned, not just the
// named one.
eq("cancelled is not an approval", approvalOutcome("cancelled"), { status: "cancelled" })
eq("an unknown outcome is not an approval either",
  approvalOutcome("something-else"), { status: "cancelled" })
eq("undefined is not an approval", approvalOutcome(undefined), { status: "cancelled" })
eq("null is not an approval", approvalOutcome(null), { status: "cancelled" })
eq("a truthy non-decision is not an approval", approvalOutcome(true), { status: "cancelled" })

// ---- adapt: select field ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "target", label: "Which target?", kind: "select",
      options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
  ])
  eq("select becomes one question", questions.length, 1)
  eq("question id", questions[0].id, "target")
  eq("question text is the field label", questions[0].question, "Which target?")
  eq("question offers the option labels", questions[0].options.map((o) => o.label), ["Alpha", "Beta"])
  eq("select is single by default", questions[0].multiSelect, false)
  // The TUI keys selection by label (lib/index.js:1212-1217); the decoder maps
  // back to the standard's option id.
  eq("answer decodes back to the option id",
    fromTuiAnswers(decoders, { answers: [{ id: "target", selected: ["Beta"] }] }),
    { answers: { target: "b" } })
}

// ---- adapt: multiple select ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "tags", label: "Tags", kind: "select", multiple: true,
      options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
  ])
  eq("multiple select sets multiSelect", questions[0].multiSelect, true)
  eq("multiple answers decode to an array",
    fromTuiAnswers(decoders, { answers: [{ id: "tags", selected: ["X", "Y"] }] }),
    { answers: { tags: ["x", "y"] } })
}

// ---- adapt: a select field drops a free-text answer ----
// The protocol validator only accepts option ids for a select field, so a
// free-text answer is unrepresentable rather than something to pass through.
{
  const { decoders } = toTuiQuestions([
    { id: "pick", label: "Pick", kind: "select", options: [{ id: "a", label: "Alpha" }] },
  ])
  eq("a free-text answer to a select field is omitted, not emitted as a non-id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: [], custom: "something else" }] }),
    { answers: {} })
}

// ---- adapt: multi-select keeps its array even with a custom answer ----
// The TUI keeps `selected` populated for a multi-select when a custom answer is
// also present (lib/index.js:1097-1103), and the standard's answer type has no
// slot for "selection plus free text". The array is the representable half, so
// the decoder must not fall through to the custom-text branch here.
{
  const { decoders } = toTuiQuestions([
    { id: "tags", label: "Tags", kind: "select", multiple: true,
      options: [{ id: "x", label: "X" }] },
  ])
  eq("a multi-select with a custom answer still answers with an array",
    fromTuiAnswers(decoders, { answers: [{ id: "tags", selected: ["X"], custom: "and more" }] }),
    { answers: { tags: ["x"] } })
}

// ---- adapt: duplicate labels must not collide ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "pick", label: "Pick", kind: "select",
      options: [{ id: "one", label: "Same" }, { id: "two", label: "Same" }] },
  ])
  eq("duplicate labels are disambiguated for display",
    questions[0].options.map((o) => o.label), ["Same", "Same (2)"])
  eq("the second duplicate decodes to its own id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["Same (2)"] }] }),
    { answers: { pick: "two" } })
}

// A literal label may already equal a generated suffix. Counting occurrences of
// the base label is not enough: it would emit "Same (2)" twice and let the last
// option overwrite the second one's id, so picking the second option would
// silently return the third option's id.
{
  const { questions, decoders } = toTuiQuestions([
    { id: "pick", label: "Pick", kind: "select",
      options: [{ id: "one", label: "Same" }, { id: "two", label: "Same" }, { id: "three", label: "Same (2)" }] },
  ])
  eq("a suffix-shaped literal label does not collide",
    questions[0].options.map((o) => o.label), ["Same", "Same (2)", "Same (3)"])
  eq("the second option keeps its own id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["Same (2)"] }] }),
    { answers: { pick: "two" } })
  eq("the third option keeps its own id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["Same (3)"] }] }),
    { answers: { pick: "three" } })
}

// Disambiguation is per field: a collision in one field must not shift the
// labels of another.
{
  const { questions } = toTuiQuestions([
    { id: "a", label: "A", kind: "select", options: [{ id: "a1", label: "Dup" }, { id: "a2", label: "Dup" }] },
    { id: "b", label: "B", kind: "select", options: [{ id: "b1", label: "Dup" }] },
  ])
  eq("the first field disambiguates", questions[0].options.map((o) => o.label), ["Dup", "Dup (2)"])
  eq("the second field is unaffected", questions[1].options.map((o) => o.label), ["Dup"])
}

// ---- adapt: ids and labels come from another component, so they must not be
// able to reach Object.prototype ----
{
  const { decoders } = toTuiQuestions([
    { id: "pick", label: "Pick", kind: "select",
      options: [{ id: "real", label: "__proto__" }] },
  ])
  eq("a __proto__ label round-trips to its id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["__proto__"] }] }),
    { answers: { pick: "real" } })

  const plain = toTuiQuestions([{ id: "x", label: "X", kind: "text" }])
  // An answer for a field we never issued must be ignored, not crash and not
  // fabricate: `decoders.toString` must be undefined, not Object.prototype's.
  eq("an inherited-looking field id is ignored",
    fromTuiAnswers(plain.decoders, { answers: [{ id: "toString", selected: ["A"], custom: "x" }] }),
    { answers: {} })
  eq("an inherited-looking id with a selection does not throw",
    fromTuiAnswers(plain.decoders, { answers: [{ id: "valueOf", selected: ["A"] }] }),
    { answers: {} })
}

// ---- adapt: malformed answers must not throw ----
{
  const { decoders } = toTuiQuestions([{ id: "a", label: "A", kind: "text" }])
  eq("a non-array answers value yields no answers",
    fromTuiAnswers(decoders, { answers: {} }), { answers: {} })
  eq("a missing answers value yields no answers",
    fromTuiAnswers(decoders, {}), { answers: {} })
  eq("a null answer yields no answers",
    fromTuiAnswers(decoders, null), { answers: {} })
}

// ---- adapt: confirm ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "ok", label: "Proceed?", kind: "confirm" },
  ])
  eq("confirm offers Yes/No", questions[0].options.map((o) => o.label), ["Yes", "No"])
  eq("confirm yes decodes to true",
    fromTuiAnswers(decoders, { answers: [{ id: "ok", selected: ["Yes"] }] }),
    { answers: { ok: true } })
  eq("confirm no decodes to false",
    fromTuiAnswers(decoders, { answers: [{ id: "ok", selected: ["No"] }] }),
    { answers: { ok: false } })
}

// ---- adapt: text ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "why", label: "Why?", kind: "text" },
  ])
  eq("text field has no options", questions[0].options, [])
  eq("text answers come from the custom draft",
    fromTuiAnswers(decoders, { answers: [{ id: "why", selected: [], custom: "because" }] }),
    { answers: { why: "because" } })
}

// ---- adapt: unanswered fields are omitted, not invented ----
{
  const { decoders } = toTuiQuestions([
    { id: "a", label: "A", kind: "select", options: [{ id: "a1", label: "A1" }] },
    { id: "b", label: "B", kind: "text" },
  ])
  eq("a skipped field is omitted from the record",
    fromTuiAnswers(decoders, { answers: [{ id: "a", selected: ["A1"] }, { id: "b", selected: [] }] }),
    { answers: { a: "a1" } })
}

// ---- term: private clipboard ----
{
  const writes = []
  const spawned = []
  const term = new Terminal()
  term.write = (chunk) => { writes.push(chunk); return true }
  // The fallback branch needs win32 AND a TTY to be reachable at all.
  term.output = { isTTY: true }
  const fakeSpawn = (cmd, args) => { spawned.push([cmd, args]); return { on() {} } }

  // The spoof is restored unconditionally: the harness's eq/ok do not throw
  // today, but a section added below this one, or a future assertion that does
  // throw, would otherwise run under a faked platform.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  try {
    writes.length = 0
    term.copyToClipboard("hello", { spawn: fakeSpawn })
    ok("copy writes OSC 52", writes.join("").includes("]52;c;"))
    ok("OSC 52 payload carries base64",
      writes.join("").includes(Buffer.from("hello", "utf8").toString("base64")))
    eq("the default path does spawn on win32", spawned.length, 1)
    // The fallback passes the text's base64 as a powershell.exe argument, where
    // any process of the same user can read it back.
    ok("the fallback receives the text as base64 in argv",
      spawned[0][1].join(" ").includes(Buffer.from("hello", "utf8").toString("base64")))

    spawned.length = 0
    writes.length = 0
    const privateWritten = term.copyToClipboard("secret", { osc52Only: true, spawn: fakeSpawn })
    eq("osc52Only never spawns the PowerShell fallback", spawned.length, 0)
    ok("osc52Only still writes OSC 52", writes.join("").includes("]52;c;"))
    // The payload must be this text, not a stale or empty one: an
    // implementation that wrote nothing would still satisfy the check above.
    ok("osc52Only writes the actual text",
      writes.join("").includes(Buffer.from("secret", "utf8").toString("base64")))
    eq("osc52Only still reports success", privateWritten, true)

    // This call must NOT reach the real fallback: the platform is spoofed to
    // win32 and this term reports a TTY, so leaving isTTY set would launch
    // powershell.exe for real and overwrite the host clipboard. Clearing output
    // keeps full discriminating power, because the option destructure runs
    // before the fallback guard.
    term.output = {}
    noThrow("a null options value does not throw", () => term.copyToClipboard("x", null))
    eq("a null options value still returns a boolean",
      typeof term.copyToClipboard("x", null), "boolean")
  } finally {
    Object.defineProperty(process, "platform", originalPlatform)
  }
}

// ---- presentation shim ----
const PARTICIPANT = "test/dsh-oc-tui"
{
  const impls = createPresentationImplementations(PARTICIPANT)
  const byKind = Object.fromEntries(impls.map((i) => [i.protocol.kind, i]))

  eq("publishes UserInteraction, Notification and CopyText",
    Object.keys(byKind).sort(), ["CopyText", "Notification", "UserInteraction"])
  // The adapter validates all three of these (packages/adapter-dsh/src/index.ts:1774):
  // a missing `handle`, a mismatched participantId, or a protocol differing from
  // the staged support each throws during mount and rolls back the whole
  // profile, so they are pinned here rather than left to integration.
  ok("every implementation carries the participant id",
    impls.every((i) => i.participantId === PARTICIPANT))
  ok("every implementation has a handle function",
    impls.every((i) => typeof i.handle === "function"))
  ok("every implementation is on presentation.dsh/v1alpha1",
    impls.every((i) => i.protocol.apiVersion === "presentation.dsh/v1alpha1"))

  // OpenExternal and ExternalRedirect are deliberately absent: the TUI cannot
  // open a browser, and a redirect needs a loopback HTTP server.
  ok("does not claim OpenExternal", byKind.OpenExternal === undefined)
  ok("does not claim ExternalRedirect", byKind.ExternalRedirect === undefined)

  eq("user interaction operations", byKind.UserInteraction.protocol.spec.operations,
    ["question", "approval", "secret-input"])
  eq("presentationOperations matches the published support",
    presentationOperations(), ["question", "approval", "secret-input"])

  // The declared operations and the handlers must not drift apart: a kind that
  // is declared but not served is only discovered when a consumer calls it.
  // The factory rejects a kind outside spec.operations, so this pins both sides.
  {
    const impls = createPresentationImplementations(PARTICIPANT)
    const ui = impls.find((i) => i.protocol.kind === "UserInteraction")
    const served = []
    const release = registerLiveTui({
      async interact(request) { served.push(request.kind); return { status: "cancelled" } },
    })
    for (const kind of presentationOperations()) {
      const request = kind === "approval"
        ? { kind, requestId: "r", invocationId: "i", origin: "t", action: "a", summary: "s" }
        : kind === "question"
          ? { kind, requestId: "r", invocationId: "i", origin: "t", fields: [{ id: "f", label: "F", kind: "text" }] }
          : { kind, requestId: "r", invocationId: "i", origin: "t", label: "L" }
      await ui.handle("interact", request, {})
    }
    eq("every declared operation reaches the handler", served, presentationOperations())

    let undeclaredThrew = false
    try {
      await ui.handle("interact", { kind: "open-external", requestId: "r", invocationId: "i", origin: "t" }, {})
    } catch { undeclaredThrew = true }
    ok("a kind outside the declared operations is rejected", undeclaredThrew)
    release()
  }

  // With no live TUI every call must report unavailable — never a decision.
  const approval = await byKind.UserInteraction.handle("interact", {
    kind: "approval", requestId: "r1", invocationId: "i1", origin: "test",
    action: "shell", summary: "rm -rf /",
  }, {})
  ok("approval with no live TUI is unavailable, not approved",
    approval.status === "unavailable")
  ok("approval never fabricates a decision", approval.value === undefined)
  ok("unavailable carries a non-empty reason",
    typeof approval.reason === "string" && approval.reason.length > 0)

  eq("question with no live TUI is unavailable",
    (await byKind.UserInteraction.handle("interact", {
      kind: "question", requestId: "r2", invocationId: "i1", origin: "test",
      fields: [{ id: "a", label: "A", kind: "text" }],
    }, {})).status, "unavailable")
  eq("notification with no live TUI is unavailable",
    (await byKind.Notification.handle("notify",
      { requestId: "r3", invocationId: "i1", origin: "test", text: "hi" }, {})).status,
    "unavailable")
  eq("copy with no live TUI is unavailable",
    (await byKind.CopyText.handle("copyText",
      { requestId: "r4", invocationId: "i1", origin: "test", text: "hi" }, {})).status,
    "unavailable")

  // An operation the support does not declare must be rejected by the factory,
  // not silently accepted.
  let threw = false
  try { await byKind.UserInteraction.handle("openExternal", {}, {}) } catch { threw = true }
  ok("an undeclared operation is rejected", threw)
}

// ---- presentation shim with a live TUI (late binding) ----
{
  const calls = []
  const handlers = createPresentationHandlers()

  // Register AFTER the handlers were created: they must look the handle up at
  // call time, because the adapter's mount order relative to the cordis bundle
  // rows is not guaranteed.
  const release = registerLiveTui({
    async interact(request) {
      calls.push(["interact", request])
      if (request.kind === "approval") return { status: "submitted", value: { decision: "denied" } }
      return { status: "submitted", value: { answers: { a: "x" } } }
    },
    async notify(request) { calls.push(["notify", request]); return { status: "submitted", value: { accepted: true } } },
    async copyText(request) { calls.push(["copyText", request]); return { status: "submitted", value: { accepted: true } } },
  })

  eq("approval forwards to the live TUI",
    await handlers.userInteraction.interact({ kind: "approval", action: "a", summary: "s" }),
    { status: "submitted", value: { decision: "denied" } })
  eq("question forwards to the live TUI",
    await handlers.userInteraction.interact({ kind: "question", fields: [] }),
    { status: "submitted", value: { answers: { a: "x" } } })
  eq("notification forwards to the live TUI",
    await handlers.notification.notify({ text: "hi" }),
    { status: "submitted", value: { accepted: true } })
  eq("copy forwards the sensitivity through",
    (await handlers.copyText.copyText({ text: "s", sensitivity: "private" }), calls.at(-1)[1]),
    { text: "s", sensitivity: "private" })

  release()
  eq("falls back to unavailable once the TUI unloads",
    (await handlers.notification.notify({ text: "hi" })).status, "unavailable")
}

// ---- index.js wiring contract ----
// lib/index.js needs a live cordis ctx, so it is not importable here. What is
// testable without one is the contract the handle must satisfy: the exact
// request/response shapes the facet's handlers will pass through.
{
  const seen = []
  const handle = {
    async interact(request, context) {
      seen.push(request, context?.signal)
      if (request.kind === "approval") {
        const { approvalOutcome } = await import("../lib/std/adapt.js")
        return approvalOutcome("rejected")
      }
      return { status: "cancelled" }
    },
  }
  // The bare handler is what the facet wires to the live TUI, and testing it
  // directly keeps this block about the handle contract rather than about the
  // factory's request validation.
  const ui = createPresentationHandlers().userInteraction
  const release = registerLiveTui(handle)

  const signal = new AbortController().signal
  const res = await ui.interact(
    { kind: "approval", action: "shell", summary: "run rm", risk: "high" }, { signal })
  eq("the handle receives the std request unchanged",
    seen[0], { kind: "approval", action: "shell", summary: "run rm", risk: "high" })
  eq("the handle receives the protocol context, so it can honour aborts",
    seen[1], signal)
  eq("a denial surfaces as a submitted denial", res,
    { status: "submitted", value: { decision: "denied" } })

  // This block drives the bare handler with a stub handle, so it pins the
  // pass-through, not lib/index.js. The stub answers anything that is not an
  // approval with `cancelled`, and that value must come back unchanged.
  eq("a non-approval result is passed through unchanged",
    await ui.interact({ kind: "question", fields: [] }), { status: "cancelled" })

  release()
}

// ---- facet activation registers the presentation implementations ----
{
  const mod = await import(pathToFileURL(join(repoRoot, "lib/facet.js")).href)
  const registered = []
  const context = {
    // The adapter rejects an implementation whose participantId differs from the
    // facet's activation participant id, so the fake must carry one.
    identity: {
      component: "io.github.rayafriandion.dsh-oc-tui",
      facet: "host",
      participantId: "test/facet-participant",
    },
    plan: {},
    scope: { signal: new AbortController().signal, add() {} },
    protocols: {
      agreement: () => undefined,
      client: () => undefined,
      implement(support, implementation) {
        registered.push({ support, implementation })
        return () => {}
      },
    },
    extensions: { publish: () => () => {} },
  }
  await mod.default.activate(context)
  // @dsh-std/presentation is a devDependency here, so the guarded import succeeds.
  const presentation = registered.filter((r) => r.support.kind !== "CommandRuntime")
  const kinds = presentation.map((r) => r.support.kind).sort()
  eq("activation publishes the three presentation kinds", kinds, ["CopyText", "Notification", "UserInteraction"])
  // Task 10 adds the command runtime; it is the only non-presentation support
  // staged here, and the facet-registration block below pins it in detail.
  eq("the command runtime is the only addition",
    registered.filter((r) => r.support.kind === "CommandRuntime").length, 1)
  ok("every published implementation is a CapabilityImplementation",
    registered.every((r) => typeof r.implementation?.handle === "function"))
  // The adapter rejects any implementation whose participantId differs from the
  // facet's activation participant id, so its source is pinned rather than
  // assumed: a hard-coded or undefined id would otherwise stay green.
  eq("staged participant ids come from context.identity",
    registered.map((r) => r.implementation.participantId),
    ["test/facet-participant", "test/facet-participant", "test/facet-participant", "test/facet-participant"])
  eq("each implementation is staged with its own protocol",
    registered.map((r) => r.implementation.protocol === r.support), [true, true, true, true])
}

// ---- command runtime ----
{
  eq("placement coordinate is the TUI command line", COMMAND_PLACEMENT,
    { apiVersion: "tui.dsh/v1alpha1", kind: "CommandLine" })
  // Derived from the manifest rather than restated, so the two cannot drift:
  // the manifest is the discovery surface and TUI_OWNED_COMMANDS is the
  // execution path, and a divergence would be invisible until a consumer
  // called a command the TUI does not own.
  {
    const raw = readFileSync(join(repoRoot, "dsh-plugin.json"), "utf8")
    const projected = projectManifest(parseManifest(raw, { source: "dsh-plugin.json" }))
    const fromManifest = projected.spec.facets[0].extensions
      .filter((e) => e.kind === "Command")
      .map((e) => e.metadata.name)
      .sort()
    eq("TUI_OWNED_COMMANDS matches the manifest's contributed commands",
      [...TUI_OWNED_COMMANDS].sort(), fromManifest)
  }
  ok("model and provider are not owned", !TUI_OWNED_COMMANDS.includes("model") && !TUI_OWNED_COMMANDS.includes("provider"))

  const runtime = createCommandRuntimeHandler()
  // The placement is required for these to reach the `!handle` branch: without
  // it `placementMatches` short-circuits and the assertions would pass even
  // with a live TUI registered.
  eq("catalog with no live TUI returns an empty catalog",
    await runtime.catalog({ contextId: "s1", placement: COMMAND_PLACEMENT }),
    { apiVersion: "commands.dsh/v1alpha1", commands: [] })
  eq("execute with no live TUI returns undefined",
    await runtime.execute({ contextId: "s1", line: "/help", placement: COMMAND_PLACEMENT }), undefined)
}

{
  const calls = []
  const runtime = createCommandRuntimeHandler()
  const release = registerLiveTui({
    async commandCatalog(input) {
      calls.push(["catalog", input])
      return [
        { name: "help", description: "Show help" },
        { name: "stats", description: "Show stats" },
      ]
    },
    async executeCommand(line, input) {
      calls.push(["execute", line, input])
      return { kind: "success", text: "ok" }
    },
  })

  // A request for the TUI's own command line must be answered.
  const catalog = await runtime.catalog({ contextId: "s1", placement: COMMAND_PLACEMENT })
  eq("catalog is published under the std coordinate", catalog.apiVersion, "commands.dsh/v1alpha1")
  eq("catalog carries the live commands", catalog.commands.map((c) => c.name), ["help", "stats"])

  // A request for a different surface must NOT be answered: the TUI owns only
  // its own command line, and returning commands here would make them appear on
  // surfaces that cannot run them.
  eq("a foreign placement gets an empty catalog",
    (await runtime.catalog({ contextId: "s1", placement: { apiVersion: "web.dsh/v1alpha1", kind: "CommandLine" } })).commands,
    [])
  eq("an unspecified placement gets an empty catalog",
    (await runtime.catalog({ contextId: "s1" })).commands, [])

  eq("execute forwards the raw line",
    await runtime.execute({ contextId: "s1", line: "/help now", placement: COMMAND_PLACEMENT }),
    { apiVersion: "commands.dsh/v1alpha1", commandId: "help",
      result: { kind: "success", text: "ok" } })
  eq("execute on a foreign placement is not run",
    await runtime.execute({ contextId: "s1", line: "/help", placement: { apiVersion: "web.dsh/v1alpha1", kind: "CommandLine" } }),
    undefined)
  eq("the live handle saw the raw line", calls.at(-1)[1], "/help now")

  release()
}

// A live handle that runs nothing (the title screen, an unparseable line, or a
// command the TUI does not own) reports "not run" as undefined; the runtime
// must pass that through rather than fabricate an empty success.
{
  const runtime = createCommandRuntimeHandler()
  const release = registerLiveTui({
    async commandCatalog() { return [] },
    async executeCommand() { return undefined },
  })
  eq("a handle that runs nothing yields undefined",
    await runtime.execute({ contextId: "s1", line: "/help", placement: COMMAND_PLACEMENT }), undefined)
  release()
}

// The factory result is what the adapter validates, so its shape is pinned:
// a missing `handle`, a mismatched participantId, or a protocol differing from
// the staged support each throws during mount and rolls back the whole profile.
{
  const impl = createCommandRuntimeImplementation("test/dsh-oc-tui")
  eq("the implementation carries the participant id", impl.participantId, "test/dsh-oc-tui")
  ok("the implementation has a handle function", typeof impl.handle === "function")
  eq("the implementation is on the commands coordinate",
    impl.protocol.apiVersion, "commands.dsh/v1alpha1")
  eq("the implementation declares the CommandRuntime kind", impl.protocol.kind, "CommandRuntime")

  // And the dispatch path works end to end through the factory.
  const release = registerLiveTui({
    async commandCatalog() { return [{ name: "help", description: "Show help" }] },
    async executeCommand() { return { kind: "success", text: "ok" } },
  })
  eq("catalog dispatches through the factory",
    (await impl.handle("catalog", { contextId: "s1", placement: COMMAND_PLACEMENT }, {})).commands.map((c) => c.name),
    ["help"])
  eq("execute dispatches through the factory",
    (await impl.handle("execute", { contextId: "s1", line: "/help", placement: COMMAND_PLACEMENT }, {})).commandId,
    "help")
  let threw = false
  try { await impl.handle("nonsense", {}, {}) } catch { threw = true }
  ok("an undeclared operation is rejected", threw)
  release()
}

// ---- facet registers the command runtime ----
{
  const mod = await import(pathToFileURL(join(repoRoot, "lib/facet.js")).href)
  const registered = []
  const context = {
    identity: { component: "io.github.rayafriandion.dsh-oc-tui", facet: "host", participantId: "test/facet-participant" },
    plan: {},
    scope: { signal: new AbortController().signal, add() {} },
    protocols: {
      agreement: () => undefined,
      client: () => undefined,
      implement(support, implementation) { registered.push({ support, implementation }); return () => {} },
    },
    extensions: { publish: () => () => {} },
  }
  await mod.default.activate(context)
  const kinds = registered.map((r) => r.support.kind).sort()
  eq("activation publishes presentation plus the command runtime", kinds,
    ["CommandRuntime", "CopyText", "Notification", "UserInteraction"])
  const runtime = registered.find((r) => r.support.kind === "CommandRuntime")
  eq("the runtime is on the commands coordinate", runtime.support.apiVersion, "commands.dsh/v1alpha1")
  ok("the runtime exposes a handle function",
    typeof runtime.implementation.handle === "function")
}

// ---- secret input ----
{
  const handle = {
    async interact(request) {
      if (request.kind !== "secret-input") return { status: "unavailable" }
      // Echoes what the modal would return, so the shim's mapping is what is
      // under test here rather than the terminal.
      return { status: "submitted", value: { secret: "s3cr3t" } }
    },
  }
  const ui = createPresentationHandlers().userInteraction
  const release = registerLiveTui(handle)
  eq("secret input is forwarded to the live TUI",
    await ui.interact({ kind: "secret-input", label: "API key" }),
    { status: "submitted", value: { secret: "s3cr3t" } })
  release()
  eq("secret input with no live TUI is unavailable",
    (await ui.interact({ kind: "secret-input", label: "API key" })).status, "unavailable")
}

console.log("")
if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all std tests passed")
