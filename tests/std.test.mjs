// Tests for the @dsh-std interop layer: the live-TUI registry, the pure
// adapters between standard and TUI shapes, and the protocol shims.
// Run: node tests/std.test.mjs  (no dsh environment required)
import { registerLiveTui, liveTui } from "../lib/bridge.js"

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

{
  const a = { tag: "a" }
  const b = { tag: "b" }
  const releaseA = registerLiveTui(a)
  registerLiveTui(b)
  releaseA()
  eq("stale release must not clear a newer registration", liveTui(), b)
}

console.log("")
if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all std tests passed")
