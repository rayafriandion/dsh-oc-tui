// Reasoning display: the transport's thinking signature must never reach the
// transcript, and a block that carries nothing but a signature must not draw a
// thinking row at all.
//
// The signature is a streaming problem, not just a string problem — a delta can
// stop inside the opening tag, so the cases below walk the prefix one rune at a
// time instead of only testing the finished text.
import { reasoningText } from "../lib/util.js"
import { App } from "../lib/ui.js"
import { t } from "../lib/i18n.js"

let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) console.log("ok   " + name)
  else { failed++; console.log("FAIL " + name + (extra ? "  " + extra : "")) }
}

// ---- the pure filter -------------------------------------------------------

ok("plain text passes through", reasoningText("let me think about this") === "let me think about this")
ok("empty text stays empty", reasoningText("") === "")
ok("missing text is empty", reasoningText(undefined) === "")
ok("a leading '<' that is not a signature is kept", reasoningText("<tag> is a tag") === "<tag> is a tag")
ok("a signature later in the text is not stripped", reasoningText("see <signature>abc</signature> here") === "see <signature>abc</signature> here")

const SIG = "<signature>deadbeefcafe</signature>"
ok("a bare signature yields nothing", reasoningText(SIG) === "")
ok("the signature is stripped and the body kept", reasoningText(SIG + "the real reasoning") === "the real reasoning")
ok("newlines after the signature are dropped", reasoningText(SIG + "\n\nbody") === "body")
ok("crlf after the signature is dropped", reasoningText(SIG + "\r\nbody") === "body")
ok("a blank line inside the body survives", reasoningText(SIG + "\nfirst\n\nsecond") === "first\n\nsecond")

// Streaming: no prefix of the opening tag may ever be shown, and an unclosed
// signature hides the whole block until the close arrives.
for (const prefix of ["<", "<s", "<sig", "<signatur", "<signature>"]) {
  ok("partial opening tag " + JSON.stringify(prefix) + " is hidden", reasoningText(prefix) === "")
}
ok("an unclosed signature hides its payload", reasoningText("<signature>deadbeef") === "")
ok("an unclosed signature hides a long payload", reasoningText("<signature>" + "x".repeat(4000)) === "")
ok("a closed signature with no body yet is empty", reasoningText("<signature>abc</signature>\n") === "")

// ---- the transcript --------------------------------------------------------

// Every painted row as text, so a row's presence can be asserted rather than
// its exact styling.
function screenText(app) {
  return app.render().cells.map((row) => row.map((cell) => cell.ch).join("")).join("\n")
}

function appWith(block) {
  const app = new App({ cols: 100, rows: 30, on() {} })
  app.setSession({ id: "s", title: "Session" })
  app.blocks.push(block)
  return app
}

const thinkingLabel = t("transcript.thinking")

{
  const app = appWith({ kind: "assistant", text: "", reasoning: SIG, streaming: false, rev: 1 })
  const text = screenText(app)
  ok("a signature-only block draws no thinking row", !text.includes(thinkingLabel))
  ok("the signature itself is never painted", !text.includes("deadbeef"))
}

{
  // A reasoning block that is still streaming must not flash the signature
  // while the opening tag is only half delivered.
  const app = appWith({ kind: "assistant", text: "", reasoning: "<signature>deadbeef", streaming: true, rev: 1 })
  const text = screenText(app)
  ok("an unclosed signature during streaming draws no thinking row", !text.includes(thinkingLabel))
  ok("no partial signature is painted while streaming", !text.includes("deadbeef"))
}

{
  const app = appWith({ kind: "assistant", text: "", reasoning: SIG + "\n\nactual chain of thought", streaming: false, rev: 1 })
  const text = screenText(app)
  ok("real reasoning still draws a thinking row", text.includes(thinkingLabel))
  ok("the signature is stripped from a block that has a body", !text.includes("deadbeef"))
}

{
  // The empty-bubble guard: a signature-only assistant message is as empty as
  // one that never reasoned, so it must not leave a bare `dsh` header behind.
  const app = appWith({ kind: "assistant", text: "", reasoning: SIG, streaming: false, showHeader: true, rev: 1 })
  ok("a signature-only block leaves no assistant header", !screenText(app).includes("dsh"))
}

{
  // Toggling is gated on displayable reasoning too, otherwise clicking the row
  // would expand an empty box.
  const block = { kind: "assistant", text: "answer", reasoning: SIG, streaming: false, rev: 1 }
  const app = appWith(block)
  app.toggleThinking(block)
  ok("a signature-only block cannot be expanded", block.thinkingCollapsed !== false)
  const real = { kind: "assistant", text: "answer", reasoning: SIG + "body", streaming: false, rev: 1 }
  // An expanded block collapses on the first toggle; what matters is that the
  // guard above let it through at all.
  app.toggleThinking(real)
  ok("a block with real reasoning still toggles", real.thinkingCollapsed === true)
}

{
  // A folded box names what it was about. Without this the row says only
  // "Thinking" and the reader has to expand it to find out whether it matters.
  const app = appWith({ kind: 'assistant', text: '', reasoning: '**First** thought, then a `code` token\nsecond line', streaming: false, thinkingCollapsed: true, rev: 1 })
  const text = screenText(app)
  ok("a folded box previews its reasoning", text.includes('First thought'))
  ok("the preview drops markdown markers", !text.includes('**') && !text.includes('`'))
  ok("the preview stops at the first line", !text.includes('second line'))

  const expanded = appWith({ kind: 'assistant', text: '', reasoning: 'First thought\nsecond line', streaming: false, thinkingCollapsed: false, rev: 1 })
  const expandedText = screenText(expanded)
  ok("an expanded box shows the body instead", expandedText.includes('second line'))
}

{
  // While streaming the text is still arriving; a preview of it would flicker.
  const app = appWith({ kind: 'assistant', text: '', reasoning: 'half an idea so far', streaming: true, reasoningLive: true, rev: 1 })
  ok('a streaming box shows no preview', !screenText(app).includes('half an idea so far'))
}

{
  // finalizeAssistant drops blocks that ended up empty; a signature-only one
  // must be dropped by the same rule.
  const app = appWith({ kind: "assistant", text: "", reasoning: SIG, streaming: true, rev: 1 })
  app.finalizeAssistant()
  ok("a signature-only streaming block is removed on finalize", app.blocks.length === 0)
  const kept = { kind: "assistant", text: "", reasoning: SIG + "body", streaming: true, rev: 1 }
  app.blocks.push(kept)
  app.finalizeAssistant()
  ok("a block with real reasoning survives finalize", app.blocks.length === 1)
}

console.log(failed === 0 ? "\nall reasoning tests passed" : `\n${failed} reasoning assertion(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
