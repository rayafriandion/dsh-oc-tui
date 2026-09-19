// Tests for the @dsh-std interop layer: the live-TUI registry, the pure
// adapters between standard and TUI shapes, and the protocol shims.
// Run: node tests/std.test.mjs  (no dsh environment required)
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { registerLiveTui, liveTui } from "../lib/bridge.js"
import { parseManifest, projectManifest } from "@dsh-std/manifest"
import { notificationLevel, approvalOutcome, toTuiQuestions, fromTuiAnswers } from "../lib/std/adapt.js"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..")

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log("ok   " + name) }
  else { console.log("FAIL " + name + "  got " + a + "  want " + e); failed++ }
}
const ok = (name, cond) => cond ? console.log("ok   " + name) : (console.log("FAIL " + name), failed++)

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
// A cancel must never be readable as consent.
eq("cancelled is not an approval", approvalOutcome("cancelled"), { status: "cancelled" })
eq("an unknown outcome is not an approval either",
  approvalOutcome("something-else"), { status: "cancelled" })

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

console.log("")
if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all std tests passed")
