// Bundled-skill tests: the frontmatter parser the runtime registration path uses,
// the shipped SKILL.md that actually ships in the tarball, and the verdict
// `registerMcpSkill` returns for every shape of host. Nothing here boots dsh —
// the skill service is faked, which is what makes the unavailable-service path
// testable at all.
//
// Run: node tests/mcp-skill.test.mjs
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MCP_SKILL_NAME,
  loadBundledMcpSkill,
  parseSkillFile,
  registerMcpSkill,
} from "../lib/mcp-skill.js"

let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) console.log("ok   " + name)
  else { failed++; console.log("FAIL " + name + (extra ? "  " + extra : "")) }
}
const eq = (name, actual, expected, extra = "") => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(name, same, same ? "" : "actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected) + (extra ? "  " + extra : ""))
}
const attempt = (fn) => {
  try { return { threw: false, value: fn() } }
  catch (error) { return { threw: true, value: error } }
}

const SKILL_DIR = fileURLToPath(new URL("../skills/mcp-import/", import.meta.url))
const SKILL_TEXT = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")

// ---- parseSkillFile -------------------------------------------------------

const valid = "---\nname: mcp-import\ndescription: add an MCP server\nwhenToUse: when the user names one\n---\n\n# Body\n\ntext\n"
const parsed = parseSkillFile(valid)
eq("a valid file parses its name", parsed?.name, "mcp-import")
eq("a valid file parses its description", parsed?.description, "add an MCP server")
eq("a valid file parses whenToUse", parsed?.whenToUse, "when the user names one")
eq("the body is trimmed and kept verbatim", parsed?.content, "# Body\n\ntext")
eq("a file without whenToUse omits the key", "whenToUse" in parseSkillFile("---\nname: x\ndescription: y\n---\nbody"), false)

eq("no frontmatter returns null", parseSkillFile("# just a body\n"), null)
eq("an opening fence without a closing one returns null", parseSkillFile("---\nname: x\ndescription: y\nbody\n"), null)
eq("a missing description returns null", parseSkillFile("---\nname: x\n---\nbody\n"), null)
eq("a missing name returns null", parseSkillFile("---\ndescription: y\n---\nbody\n"), null)
eq("an empty name returns null", parseSkillFile('---\nname: ""\ndescription: y\n---\nbody\n'), null)
eq("a non-string returns null", parseSkillFile(null), null)
eq("a BOM before the fence is tolerated", parseSkillFile("\uFEFF---\nname: x\ndescription: y\n---\nb")?.name, "x")
eq("quoted scalars are unquoted", parseSkillFile('---\nname: "a-b"\ndescription: \'c: d\'\n---\nb')?.description, "c: d")
eq("escaped quotes survive inside a double-quoted scalar", parseSkillFile('---\nname: x\ndescription: "a \\"b\\" c"\n---\nb')?.description, 'a "b" c')

// CRLF is what a Windows checkout hands the parser; the body must not carry the
// carriage returns into the model's instructions.
const crlf = parseSkillFile(valid.replace(/\n/g, "\r\n"))
eq("CRLF parses identically", crlf, parsed)
ok("CRLF leaves no carriage return in the body", !crlf.content.includes("\r"))

// ---- the shipped SKILL.md -------------------------------------------------

const shipped = loadBundledMcpSkill()
ok("the shipped SKILL.md loads", shipped !== null)
ok("the shipped skill is named mcp-import", shipped?.name === MCP_SKILL_NAME && MCP_SKILL_NAME === "mcp-import", "name=" + shipped?.name)
ok("the name satisfies the host kebab-case grammar", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shipped?.name ?? ""))
ok("the description is non-empty", typeof shipped?.description === "string" && shipped.description.trim().length > 0)
ok("the whenToUse is non-empty", typeof shipped?.whenToUse === "string" && shipped.whenToUse.trim().length > 0)
ok("the body is non-empty", typeof shipped?.content === "string" && shipped.content.trim().length > 0)

// The description is all the model sees before loading, so it has to carry both
// languages' trigger words.
for (const trigger of ["MCP", "stdio", "HTTP", "SSE", "添加", "导入", "配置"]) {
  ok("the description carries the trigger " + JSON.stringify(trigger), shipped?.description.includes(trigger))
}

const skillLines = SKILL_TEXT.replace(/^\uFEFF/, "").split(/\r?\n/)
const fenceEnd = skillLines.indexOf("---", 1)
ok("the shipped file opens with a frontmatter fence", skillLines[0] === "---" && fenceEnd > 1)
const fenceKeys = skillLines.slice(1, fenceEnd).filter((line) => line.trim() !== "").map((line) => line.split(":")[0].trim())
eq("the frontmatter carries exactly name, description and whenToUse", [...fenceKeys].sort(), ["description", "name", "whenToUse"])

// What the body has to teach: both files, the name grammar, the tool prefix and
// the tab path to verify through.
for (const fact of ["$DSH_HOME/mcp.json", ".dsh/mcp.json", "%USERPROFILE%\\.dsh", "[A-Za-z0-9_-]{1,32}", "mcp__", "timeoutMs", "enabled", "Ctrl+P", "MCP"]) {
  ok("the body documents " + JSON.stringify(fact), shipped?.content.includes(fact))
}

// Every JSON block in the shipped body must be valid and copy-pasteable. A block
// is either a whole document (`version` + `servers`) or one standalone record,
// and the three transports must each appear as a complete record.
const blocks = [...SKILL_TEXT.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1])
ok("the body carries JSON examples", blocks.length >= 4, "blocks=" + blocks.length)
const documents = []
const records = []
for (let index = 0; index < blocks.length; index++) {
  const result = attempt(() => JSON.parse(blocks[index]))
  ok("JSON example " + (index + 1) + " parses", !result.threw, String(result.value))
  if (result.threw) continue
  const parsedBlock = result.value
  if (parsedBlock !== null && typeof parsedBlock === "object" && parsedBlock.servers !== undefined) {
    eq("JSON example " + (index + 1) + " is a version 1 document", parsedBlock.version, 1)
    ok("JSON example " + (index + 1) + " carries a servers object",
      parsedBlock.servers !== null && typeof parsedBlock.servers === "object" && !Array.isArray(parsedBlock.servers))
    documents.push(parsedBlock)
    records.push(...Object.values(parsedBlock.servers ?? {}))
  } else {
    ok("JSON example " + (index + 1) + " is a bare record", ["stdio", "http", "sse"].includes(parsedBlock?.type))
    records.push(parsedBlock)
  }
}
ok("the body carries whole documents", documents.length >= 4, "documents=" + documents.length)
for (const document of documents) {
  for (const name of Object.keys(document.servers ?? {})) {
    ok("the server key " + JSON.stringify(name) + " satisfies the name grammar", /^[A-Za-z0-9_-]{1,32}$/.test(name))
  }
}
const types = records.map((record) => record?.type)
for (const type of ["stdio", "http", "sse"]) {
  ok("the body shows a " + type + " record", types.includes(type))
  ok("the body shows a complete " + type + " record",
    records.some((record) => record?.type === type && typeof record.timeoutMs === "number" && typeof record.enabled === "boolean"))
}
for (const record of records) {
  ok("a " + record.type + " record repeats no name", !("name" in record) && !("serverName" in record))
  ok("a " + record.type + " record uses only documented keys",
    Object.keys(record).every((key) => ["type", "command", "args", "env", "url", "headers", "timeoutMs", "enabled"].includes(key)),
    "keys=" + Object.keys(record).join(","))
  if (record.timeoutMs !== undefined) ok("a " + record.type + " record has an integer timeoutMs", Number.isInteger(record.timeoutMs) && record.timeoutMs >= 1)
  if (record.enabled !== undefined) ok("a " + record.type + " record has a boolean enabled", typeof record.enabled === "boolean")
  if (record.type === "stdio") {
    ok("a stdio record has a command and an args array", typeof record.command === "string" && Array.isArray(record.args))
    if (record.env !== undefined) ok("a stdio record has a string-valued env", Object.values(record.env).every((value) => typeof value === "string"))
  } else {
    let url = null
    try { url = new URL(record.url) } catch { /* asserted below */ }
    ok("a " + record.type + " record has an http(s) url", url !== null && (url.protocol === "http:" || url.protocol === "https:"))
  }
}

// ---- registerMcpSkill -----------------------------------------------------

const noCtx = attempt(() => registerMcpSkill(undefined))
ok("no ctx does not throw", !noCtx.threw)
eq("no ctx reports failure", noCtx.value, { ok: false, reason: "the host skill service is unavailable" })

const bareCtx = attempt(() => registerMcpSkill({}))
ok("a ctx without get does not throw", !bareCtx.threw)
eq("a ctx without get reports failure", bareCtx.value.ok, false)

const throwingLookup = attempt(() => registerMcpSkill({ get() { throw new Error("boom") } }))
ok("a throwing lookup does not throw", !throwingLookup.threw)
eq("a throwing lookup reports failure", throwingLookup.value.ok, false)
ok("a throwing lookup reports its reason", throwingLookup.value.reason.includes("boom"), "reason=" + throwingLookup.value.reason)

const noService = attempt(() => registerMcpSkill({ get: () => undefined }))
ok("an absent service does not throw", !noService.threw)
eq("an absent service reports failure", noService.value.ok, false)

const noRegister = attempt(() => registerMcpSkill({ get: () => ({}) }))
ok("a service without register does not throw", !noRegister.threw)
eq("a service without register reports failure", noRegister.value.ok, false)

const throwingRegister = attempt(() => registerMcpSkill({ get: () => ({ register() { throw new Error("nope") } }) }))
ok("a throwing register does not throw", !throwingRegister.threw)
eq("a throwing register reports failure", throwingRegister.value.ok, false)
ok("a throwing register reports its reason", throwingRegister.value.reason.includes("nope"), "reason=" + throwingRegister.value.reason)

let called = 0
let registration = null
const recordingCtx = { get: (name) => (name === "skills" ? { register(skill) { called++; registration = skill; return () => {} } } : undefined) }
const okResult = attempt(() => registerMcpSkill(recordingCtx))
ok("a live service does not throw", !okResult.threw)
eq("a live service reports success", okResult.value, { ok: true, name: "mcp-import" })
eq("the service was called once", called, 1)
ok("a registration object was passed", registration !== null && typeof registration === "object")
eq("the registration keeps the parsed description", registration?.description, shipped?.description)
eq("the registration keeps the parsed whenToUse", registration?.whenToUse, shipped?.whenToUse)
eq("the registration keeps the parsed content", registration?.content, shipped?.content)
eq("the registration is labelled bundled", registration?.source, "bundled")
eq("the registration resolves resources from the shipped skill directory", registration?.resourceBase, { kind: "directory", path: SKILL_DIR })
eq("the registration permits both invocation surfaces", registration?.invocation, { modelInvocable: true, userInvocable: true })
eq("the registration passes exactly the documented fields",
  Object.keys(registration ?? {}).sort(),
  ["content", "description", "invocation", "name", "resourceBase", "source", "whenToUse"])
ok("the resource base is a real directory holding the skill",
  (() => { try { return statSync(join(registration.resourceBase.path, "SKILL.md")).isFile() } catch { return false } })())
ok("the registered name is the shipped name", registration?.name === shipped?.name)

// A session that never registered must still be able to read the body it would
// have registered: loadBundledMcpSkill is what the module exports for that, and
// it answers null rather than throwing when the file is gone.
const loaderSource = readFileSync(new URL("../lib/mcp-skill.js", import.meta.url), "utf8")
ok("the module has no top-level @deepseek-ai import", !/^import[^\n]*@deepseek-ai/m.test(loaderSource))
ok("registerMcpSkill reads the service through ctx.get", loaderSource.includes("ctx?.get?.('skills')"))

// ---- teardown -------------------------------------------------------------

console.log("")
console.log(failed === 0 ? "all mcp-skill tests passed" : failed + " mcp-skill test(s) failed")
process.exit(failed === 0 ? 0 : 1)
