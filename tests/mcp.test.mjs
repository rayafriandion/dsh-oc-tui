// MCP configuration tests: the file storage contract (user scope plus the
// ancestors of the session's cwd), the validation the form applies, and the
// live mounts. Nothing here boots dsh and nothing needs a @deepseek-ai package —
// the host seams are faked, which is what makes every path testable, including
// the ones a real host never takes. Every write goes to a temp tree.
//   node tests/mcp.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MCP_ENTRY_PREFIX,
  MCP_TYPES,
  McpManager,
  SERVER_NAME_PATTERN,
  collectServers,
  configPathsForCwd,
  createToolProbe,
  draftFromEntry,
  dshHome,
  emptyDraft,
  parseArgs,
  parseDocument,
  parseKeyValueJson,
  pathConfigPath,
  readDocument,
  removeEntry,
  removeServer,
  saveDraft,
  serializeDocument,
  upsertEntry,
  userConfigPath,
  validateDraft,
} from "../lib/mcp.js"

const root = mkdtempSync(join(tmpdir(), "dsh-oc-tui-mcp-"))
process.on("exit", () => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
})

let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) console.log("ok   " + name)
  else { failed++; console.log("FAIL " + name + (extra ? "  " + extra : "")) }
}
const bad = async (promise) => {
  try { await promise; return null } catch (error) { return error }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (predicate, { timeout = 3000 } = {}) => {
  const deadline = Date.now() + timeout
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(10)
  }
}
// A document in the shape the plugin writes: `servers` keyed by name.
const write = (file, servers) => writeFileSync(file, JSON.stringify({ version: 1, servers }, null, 2) + "\n", "utf8")

const home = join(root, "home")
const project = join(root, "project")
const nested = join(project, "packages", "app")
mkdirSync(home, { recursive: true })
mkdirSync(join(project, ".dsh"), { recursive: true })
mkdirSync(join(nested, ".dsh"), { recursive: true })

// ---- paths and constants ----------------------------------------------------
{
  ok("the interface types are the three the form offers", MCP_TYPES.join(",") === "stdio,http,sse")
  ok("the default and maximum timeouts are the frozen values", DEFAULT_TIMEOUT_MS === 30000 && MAX_TIMEOUT_MS === 3600000)
  ok("server names follow the host's own pattern", SERVER_NAME_PATTERN.test("a-b_C9") && !SERVER_NAME_PATTERN.test("a.b") && !SERVER_NAME_PATTERN.test(""))
  ok("the tool prefix matches the host's tool naming", MCP_ENTRY_PREFIX === "mcp__")

  ok("dshHome follows DSH_HOME", (() => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const got = dshHome()
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    return got === home
  })())
  ok("dshHome falls back to ~/.dsh", (() => {
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    const got = dshHome()
    if (saved !== undefined) process.env.DSH_HOME = saved
    return got === join(homedir(), ".dsh")
  })())
  ok("the user document is <home>/mcp.json", userConfigPath(home) === join(home, "mcp.json"))
  ok("a path document is <dir>/.dsh/mcp.json", pathConfigPath(project) === join(project, ".dsh", "mcp.json"))

  const paths = configPathsForCwd(nested, home)
  ok("the path scopes run from cwd upward, nearest first",
    paths[0].path === pathConfigPath(nested)
    && paths[0].directory === nested
    && paths[1].path === pathConfigPath(join(project, "packages"))
    && paths[2].path === pathConfigPath(project),
    JSON.stringify(paths.slice(0, 4)))
  ok("the user document comes last", paths.at(-1).scope === "user" && paths.at(-1).path === userConfigPath(home))
  ok("the walk reaches the filesystem root", paths.some((entry) => entry.scope === "path" && dirname(entry.directory) === entry.directory))
  ok("a session without a cwd sees only the user document", (() => {
    const only = configPathsForCwd("", home)
    return only.length === 1 && only[0].scope === "user"
  })())
}

// ---- command-line and pair parsing ------------------------------------------
{
  ok("parseArgs splits on whitespace", JSON.stringify(parseArgs("  node   server.js ")) === JSON.stringify(["node", "server.js"]))
  ok("parseArgs keeps quoted groups", JSON.stringify(parseArgs('npx -y pkg --flag "a b"')) === JSON.stringify(["npx", "-y", "pkg", "--flag", "a b"]))
  ok("parseArgs keeps a quoted empty argument", JSON.stringify(parseArgs('a "" b')) === JSON.stringify(["a", "", "b"]))
  ok("parseArgs accepts an empty argument list", parseArgs("").length === 0)
  ok("parseArgs reads a JSON array as an array", JSON.stringify(parseArgs('["a b","c"]')) === JSON.stringify(["a b", "c"]))
  ok("parseArgs rejects an unclosed quote", (() => { try { parseArgs('pkg "unclosed'); return false } catch { return true } })())
  ok("parseArgs rejects a malformed JSON array", (() => { try { parseArgs("[oops"); return false } catch { return true } })())
  ok("parseArgs rejects a JSON array holding objects", (() => { try { parseArgs('[{"a":1}]'); return false } catch { return true } })())

  const kv = parseKeyValueJson('{"TOKEN":"abc","PORT":8080,"DEBUG":true}')
  ok("parseKeyValueJson coerces scalars to strings",
    kv.ok && kv.value.TOKEN === "abc" && kv.value.PORT === "8080" && kv.value.DEBUG === "true")
  ok("empty text is a legal empty map", parseKeyValueJson("").ok && Object.keys(parseKeyValueJson("").value).length === 0)
  ok("a nested object value is rejected", parseKeyValueJson('{"A":{"B":"c"}}').ok === false)
  ok("an array value is rejected", parseKeyValueJson('{"A":["b"]}').ok === false)
  ok("a null value is rejected", parseKeyValueJson('{"A":null}').ok === false)
  ok("non-object text is rejected", parseKeyValueJson("TOKEN=abc").ok === false)
  ok("a control character in an environment name is rejected", parseKeyValueJson('{"A\\u0001B":"v"}').ok === false)
  ok("the error names the field it came from", parseKeyValueJson("nope", { label: "headers" }).error.includes("headers"))
  ok("a bad header name is rejected", parseKeyValueJson('{"X Key":"1"}', { header: true }).ok === false)
  ok("a header value with a newline is rejected", parseKeyValueJson('{"X-Key":"a\\nb"}', { header: true }).ok === false)
  ok("a valid header passes", parseKeyValueJson('{"Authorization":"Bearer t"}', { header: true }).value.Authorization === "Bearer t")
}

// ---- documents --------------------------------------------------------------
{
  const parsed = parseDocument('{"servers":{"b":{"type":"http","url":"https://x/mcp"},"a":{"type":"stdio","command":"node","args":["s.js"],"env":{"K":1},"timeoutMs":1000,"enabled":false}}}')
  ok("records are keyed by their document name", parsed.ok && parsed.servers.map((s) => s.name).join(",") === "a,b")
  ok("a stdio record is normalized", parsed.servers[0].command === "node"
    && JSON.stringify(parsed.servers[0].args) === JSON.stringify(["s.js"])
    && parsed.servers[0].env.K === "1"
    && parsed.servers[0].timeoutMs === 1000
    && parsed.servers[0].enabled === false)
  ok("mcpServers is read as an alias for servers", parseDocument('{"mcpServers":{"x":{"command":"node"}}}').servers[0].name === "x")
  ok("a document without a server list is legal and empty", parseDocument("{}").ok && parseDocument("{}").servers.length === 0)
  ok("bad JSON is an error result, not a throw", parseDocument("{oops").ok === false)
  ok("a non-object document is an error result", parseDocument("[]").ok === false && parseDocument('"x"').ok === false)
  ok("a server list that is not an object is an error result", parseDocument('{"servers":[]}').ok === false)
  ok("a record that is not an object is skipped, its siblings survive",
    parseDocument('{"servers":{"ok":{"command":"node"},"junk":"nope"}}').servers.map((s) => s.name).join(",") === "ok")
  ok("the legacy streamable-http type reads as http",
    parseDocument('{"servers":{"x":{"type":"streamable-http","url":"https://x/mcp"}}}').servers[0].type === "http")
  ok("an unknown type falls back to stdio",
    parseDocument('{"servers":{"x":{"type":"carrier-pigeon","command":"node"}}}').servers[0].type === "stdio")
  ok("an in-record name is ignored in favour of the document key",
    parseDocument('{"servers":{"key":{"name":"other","serverName":"third","command":"node"}}}').servers[0].name === "key")
  ok("an out-of-range timeout returns to the default",
    parseDocument('{"servers":{"x":{"command":"node","timeoutMs":0}}}').servers[0].timeoutMs === DEFAULT_TIMEOUT_MS)
  ok("a non-scalar env value is dropped rather than stringified",
    Object.keys(parseDocument('{"servers":{"x":{"command":"n","env":{"A":{"b":1}}}}}').servers[0].env).length === 0)

  const missing = await readDocument(join(root, "absent", "mcp.json"))
  ok("a missing document is a legal empty one", missing.exists === false && missing.error === "" && missing.servers.length === 0)
  const brokenFile = join(root, "broken.json")
  writeFileSync(brokenFile, "{oops")
  const broken = await readDocument(brokenFile)
  ok("a malformed document reports its error", broken.exists === true && broken.error !== "" && broken.servers.length === 0)
}

// ---- scope collection -------------------------------------------------------
const nestedFile = pathConfigPath(nested)
const projectFile = pathConfigPath(project)
{
  write(nestedFile, {
    "cwd-a": { type: "stdio", command: "cwd" },
    shared: { type: "stdio", command: "cwd" },
  })
  write(projectFile, {
    "project-a": { type: "http", url: "https://p/mcp" },
    shared: { type: "stdio", command: "project" },
  })
  write(userConfigPath(home), {
    "user-a": { type: "sse", url: "https://u/sse" },
    shared: { type: "stdio", command: "user" },
  })

  const collected = await collectServers(nested, { home })
  const byName = Object.fromEntries(collected.servers.map((server) => [server.name, server]))
  ok("the user document and every ancestor document are read",
    Boolean(byName["user-a"] && byName["project-a"] && byName["cwd-a"]))
  ok("the nearest document wins a duplicate",
    byName.shared.command === "cwd" && byName.shared.scope === "path" && byName.shared.sourcePath === nestedFile)
  ok("an entry names the document it came from",
    byName["user-a"].scope === "user" && byName["user-a"].sourcePath === userConfigPath(home)
    && byName["project-a"].scope === "path" && byName["project-a"].sourcePath === projectFile)
  ok("entries come back sorted by name", (() => {
    const names = collected.servers.map((server) => server.name)
    return names.join(",") === [...names].sort((a, b) => a.localeCompare(b)).join(",")
  })())
  const missingLocation = collected.files.find((file) => file.path === pathConfigPath(root))
  ok("a document that is not there is reported as absent", missingLocation?.exists === false && missingLocation.error === "")
  ok("the file list ends with the user document",
    collected.files.at(-1).scope === "user" && collected.files.at(-1).path === userConfigPath(home))
  ok("a path document reports the directory it scopes, a user document none",
    collected.files.find((file) => file.path === nestedFile).directory === nested
    && collected.files.find((file) => file.path === projectFile).directory === project
    && collected.files.at(-1).directory === "")
  ok("the file list reports the documents that do exist",
    collected.files.find((file) => file.path === nestedFile).exists === true
    && collected.files.find((file) => file.path === projectFile).exists === true)

  // A broken document costs its own servers only.
  const badCwd = join(root, "bad-tree", "a")
  const badFile = pathConfigPath(badCwd)
  const goodFile = pathConfigPath(join(root, "bad-tree"))
  mkdirSync(dirname(badFile), { recursive: true })
  mkdirSync(dirname(goodFile), { recursive: true })
  writeFileSync(badFile, "{ not json at all")
  write(goodFile, { survivor: { type: "stdio", command: "node" } })
  const mixed = await collectServers(badCwd, { home: join(root, "empty-home") })
  ok("a broken document does not break the others", mixed.servers.some((server) => server.name === "survivor"))
  ok("the broken document is reported", mixed.files.find((file) => file.path === badFile).error !== "")
}

// ---- drafts and validation --------------------------------------------------
{
  const base = emptyDraft()
  ok("an empty draft is a stdio user-scope form",
    base.type === "stdio" && base.scope === "user" && base.timeoutMs === "30000" && base.enabled === true && base.originalName === "")

  const stdio = validateDraft({ ...emptyDraft(), name: "demo", command: " npx ", args: '-y "a b"', env: '{"TOKEN":"t"}', timeoutMs: "45000" })
  ok("a stdio draft validates", stdio.ok === true && stdio.record.name === "demo" && stdio.record.command === "npx")
  ok("a stdio record carries its parsed args, env and timeout",
    JSON.stringify(stdio.record.args) === JSON.stringify(["-y", "a b"])
    && stdio.record.env.TOKEN === "t"
    && stdio.record.timeoutMs === 45000
    && stdio.record.type === "stdio"
    && stdio.record.enabled === true)
  ok("a record never carries the scope or where it came from",
    stdio.record.scope === undefined && stdio.record.sourcePath === undefined)

  const http = validateDraft({ ...emptyDraft(), name: "web", type: "http", url: "https://mcp.example.com/mcp", headers: '{"Authorization":"Bearer t"}', timeoutMs: "60000" })
  ok("an http draft validates", http.ok === true && http.record.url === "https://mcp.example.com/mcp"
    && http.record.headers.Authorization === "Bearer t" && http.record.timeoutMs === 60000 && http.record.enabled === true)
  const sse = validateDraft({ ...emptyDraft(), name: "legacy", type: "sse", url: "http://127.0.0.1:9000/sse" })
  ok("an sse draft validates with its url only",
    sse.ok === true && sse.record.type === "sse" && sse.record.url === "http://127.0.0.1:9000/sse"
    && JSON.stringify(sse.record.headers) === "{}" && sse.record.timeoutMs === DEFAULT_TIMEOUT_MS)
  ok("an empty timeout takes the default", validateDraft({ ...emptyDraft(), name: "t", command: "x", timeoutMs: "" }).record.timeoutMs === DEFAULT_TIMEOUT_MS)

  const rejects = (draft, extra) => validateDraft(draft, extra).ok === false
  ok("an empty name is rejected", rejects({ ...emptyDraft(), name: "", command: "x" }))
  ok("a name with a slash is rejected", rejects({ ...emptyDraft(), name: "a/b", command: "x" }))
  ok("a name longer than 32 characters is rejected", rejects({ ...emptyDraft(), name: "a".repeat(33), command: "x" }))
  ok("a name another server already uses is rejected",
    rejects({ ...emptyDraft(), name: "demo", command: "x" }, { existing: [{ name: "demo" }] }))
  ok("a non-numeric timeout is rejected", rejects({ ...emptyDraft(), name: "t", command: "x", timeoutMs: "soon" }))
  ok("a fractional timeout is rejected", rejects({ ...emptyDraft(), name: "t", command: "x", timeoutMs: "30000.5" }))
  ok("a timeout of zero is rejected", rejects({ ...emptyDraft(), name: "t", command: "x", timeoutMs: "0" }))
  ok("a timeout above the maximum is rejected", rejects({ ...emptyDraft(), name: "t", command: "x", timeoutMs: String(MAX_TIMEOUT_MS + 1) }))
  ok("a stdio server without a command is rejected", rejects({ ...emptyDraft(), name: "t", type: "stdio", command: "  " }))
  ok("a stdio server with bad env JSON is rejected", rejects({ ...emptyDraft(), name: "t", type: "stdio", command: "x", env: "{oops" }))
  ok("an unparsable URL is rejected", rejects({ ...emptyDraft(), name: "t", type: "http", url: "not a url" }))
  ok("a non-http URL is rejected", rejects({ ...emptyDraft(), name: "t", type: "http", url: "ftp://x/y" }))
  ok("a bad header is rejected", rejects({ ...emptyDraft(), name: "t", type: "sse", url: "https://x/sse", headers: '{"X Key":"1"}' }))
  ok("a path scope without a directory is rejected", rejects({ ...emptyDraft(), name: "t", command: "x", scope: "path", path: "" }))
  ok("a relative path scope is rejected", rejects({ ...emptyDraft(), name: "t", command: "x", scope: "path", path: "relative/dir" }))
  ok("an absolute path scope validates", validateDraft({ ...emptyDraft(), name: "t", command: "x", scope: "path", path: project }).ok === true)
  ok("an unknown type is treated as stdio", validateDraft({ ...emptyDraft(), name: "t", type: "carrier-pigeon", command: "x" }).record.type === "stdio")
}

// ---- records, lists and documents ------------------------------------------
{
  const one = upsertEntry([], { name: "b", type: "stdio", command: "b" })
  ok("upsert appends into an empty list", one.length === 1 && one[0].name === "b")
  const two = upsertEntry(one, { name: "a", type: "http", url: "https://a/mcp" })
  ok("upsert keeps the list sorted by name", two.map((entry) => entry.name).join(",") === "a,b")
  const replaced = upsertEntry(two, { name: "b", type: "stdio", command: "b2" })
  ok("upsert replaces an entry by name", replaced.length === 2 && replaced.find((entry) => entry.name === "b").command === "b2")
  const renamed = upsertEntry(two, { name: "c", type: "stdio", command: "c" }, "b")
  ok("upsert with an original name renames in place", renamed.map((entry) => entry.name).join(",") === "a,c")
  const decorated = upsertEntry([{ name: "a", type: "stdio", command: "x", scope: "path", sourcePath: "S" }], { name: "a", type: "stdio", command: "y" })
  ok("upsert drops the stale scope decoration", decorated[0].sourcePath === undefined && decorated[0].scope === undefined)
  ok("upsert does not mutate the list it was given", two.length === 2)
  ok("removeEntry drops one name", removeEntry(two, "a").map((entry) => entry.name).join(",") === "b" && two.length === 2)
  ok("removeEntry of an absent name changes nothing", removeEntry(two, "absent").length === 2)

  const text = serializeDocument([
    { name: "z", type: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "V" }, timeoutMs: 30000, enabled: true, scope: "path", sourcePath: "S" },
    { name: "a", type: "http", url: "https://a/mcp", headers: { A: "B" } },
  ])
  ok("the document is pretty-printed with a trailing newline", text.endsWith("\n") && text.includes('\n  "servers"'))
  const document = JSON.parse(text)
  ok("the document is versioned and keyed by name",
    document.version === 1 && Object.keys(document.servers).join(",") === "a,z")
  ok("a stored record does not duplicate its name or its scope",
    !("name" in document.servers.z) && !("scope" in document.servers.z) && !("sourcePath" in document.servers.z))
  ok("the stored stdio record keeps the contract keys",
    Object.keys(document.servers.z).join(",") === "type,command,args,env,timeoutMs,enabled")
  ok("the stored http record keeps the contract keys",
    Object.keys(document.servers.a).join(",") === "type,url,headers,timeoutMs,enabled")
  const round = parseDocument(text)
  ok("the document round-trips through a read",
    round.ok
    && round.servers.find((server) => server.name === "z").command === "npx"
    && JSON.stringify(round.servers.find((server) => server.name === "z").args) === JSON.stringify(["-y", "pkg"])
    && round.servers.find((server) => server.name === "a").url === "https://a/mcp"
    && round.servers.find((server) => server.name === "a").timeoutMs === DEFAULT_TIMEOUT_MS)

  const readBack = draftFromEntry({ name: "demo", type: "stdio", command: "node", args: ["s.js"], env: { TOKEN: "t" }, enabled: false, scope: "path", sourcePath: nestedFile })
  ok("draftFromEntry restores the text fields",
    readBack.name === "demo" && readBack.args === "s.js" && readBack.env === '{"TOKEN":"t"}' && readBack.enabled === false)
  ok("draftFromEntry restores a path entry's directory and original name",
    readBack.scope === "path" && readBack.path === nested && readBack.originalName === "demo")
  ok("draftFromEntry leaves a user-scope entry without a path",
    draftFromEntry({ name: "u", scope: "user", sourcePath: userConfigPath(home) }).path === "")
  ok("draftFromEntry quotes arguments the shell form cannot hold",
    draftFromEntry({ name: "q", type: "stdio", command: "n", args: ["a b", ""] }).args === '["a b",""]')
  ok("args that need quoting round-trip through the draft", (() => {
    const args = ["a b", '""', "c"]
    const back = validateDraft(draftFromEntry({ name: "quoted", type: "stdio", command: "node", args, env: {}, timeoutMs: 30000, enabled: true }), { existing: [] })
    return back.ok && JSON.stringify(back.record.args) === JSON.stringify(args)
  })())
}

// ---- saving against real files ---------------------------------------------
{
  const saveHome = join(root, "save-home")
  const saved = await saveDraft({
    cwd: project,
    draft: { ...emptyDraft(), name: "alpha", command: "npx", args: "-y pkg", env: '{"TOKEN":"t"}' },
    home: saveHome,
  })
  ok("a user-scope draft writes <home>/mcp.json",
    saved.scope === "user" && saved.path === userConfigPath(saveHome) && existsSync(saved.path))
  ok("the parent directory is created", existsSync(saveHome))
  ok("the returned records are the document's", saved.servers.length === 1 && saved.servers[0].name === "alpha")
  ok("the written document is the contract shape", (() => {
    const raw = JSON.parse(readFileSync(saved.path, "utf8"))
    return raw.version === 1
      && raw.servers.alpha.command === "npx"
      && JSON.stringify(raw.servers.alpha.args) === JSON.stringify(["-y", "pkg"])
      && raw.servers.alpha.env.TOKEN === "t"
      && raw.servers.alpha.timeoutMs === DEFAULT_TIMEOUT_MS
  })())
  ok("no temporary file is left behind", readdirSync(dirname(saved.path)).join(",") === "mcp.json")

  const edited = await saveDraft({ draft: { ...emptyDraft(), name: "alpha", command: "node", originalName: "alpha" }, home: saveHome })
  ok("an edit rewrites its own entry", edited.servers.length === 1 && edited.servers[0].command === "node")
  const added = await saveDraft({ draft: { ...emptyDraft(), name: "beta", command: "x" }, home: saveHome })
  ok("a second save appends and sorts", added.servers.map((server) => server.name).join(",") === "alpha,beta")

  const writeProject = join(root, "write-project")
  mkdirSync(writeProject, { recursive: true })
  const pathSaved = await saveDraft({ cwd: nested, draft: { ...emptyDraft(), name: "gamma", command: "node", scope: "path", path: writeProject }, home: saveHome })
  ok("a path-scope draft writes <path>/.dsh/mcp.json",
    pathSaved.scope === "path" && pathSaved.path === pathConfigPath(writeProject) && existsSync(pathSaved.path))
  await saveDraft({ draft: { ...emptyDraft(), name: "delta", command: "node", scope: "path", path: writeProject }, home: saveHome })
  const removed = await removeServer({ cwd: writeProject, name: "gamma", home: saveHome })
  ok("removeServer edits the document that defines the entry",
    removed.path === pathConfigPath(writeProject) && removed.servers.map((server) => server.name).join(",") === "delta")
  ok("the removal reached the disk", JSON.parse(readFileSync(removed.path, "utf8")).servers.gamma === undefined)

  ok("a name already in the target document is refused",
    await bad(saveDraft({ draft: { ...emptyDraft(), name: "alpha", command: "x" }, home: saveHome })) !== null)
  const notADir = join(root, "not-a-dir")
  writeFileSync(notADir, "x")
  ok("a path scope that is not a directory is refused",
    await bad(saveDraft({ draft: { ...emptyDraft(), name: "z", command: "x", scope: "path", path: notADir }, home: saveHome })) !== null)
  ok("a relative path scope is refused at the write too",
    await bad(saveDraft({ draft: { ...emptyDraft(), name: "z", command: "x", scope: "path", path: "relative/dir" }, home: saveHome })) !== null)
  const dirHome = join(root, "dir-home")
  mkdirSync(join(dirHome, "mcp.json"), { recursive: true })
  ok("a directory where the document belongs is refused",
    await bad(saveDraft({ draft: { ...emptyDraft(), name: "x", command: "n" }, home: dirHome })) !== null)
  const brokenHome = join(root, "broken-home")
  mkdirSync(brokenHome, { recursive: true })
  const brokenTarget = userConfigPath(brokenHome)
  writeFileSync(brokenTarget, "{ nope")
  ok("a document that cannot be parsed is never overwritten",
    await bad(saveDraft({ draft: { ...emptyDraft(), name: "x", command: "n" }, home: brokenHome })) !== null
    && readFileSync(brokenTarget, "utf8") === "{ nope")
  ok("removing an unknown server is refused",
    await bad(removeServer({ cwd: writeProject, name: "absent", home: saveHome })) !== null)

  // The scope contract: removing a shadowed name edits the nearest document.
  const scopeTree = join(root, "scope-tree")
  const scopeInner = join(scopeTree, "inner")
  const outerFile = pathConfigPath(scopeTree)
  const innerFile = pathConfigPath(scopeInner)
  mkdirSync(dirname(outerFile), { recursive: true })
  mkdirSync(dirname(innerFile), { recursive: true })
  write(outerFile, { shadow: { type: "stdio", command: "outer" } })
  write(innerFile, { shadow: { type: "stdio", command: "inner" } })
  const scopeHome = join(root, "scope-home")
  const shadowed = await collectServers(scopeInner, { home: scopeHome })
  ok("the nearest document shadows the farther one", shadowed.servers.find((server) => server.name === "shadow").command === "inner")
  const shadowRemoved = await removeServer({ cwd: scopeInner, name: "shadow", home: scopeHome })
  ok("removeServer edits the nearest document", shadowRemoved.path === innerFile && shadowRemoved.servers.length === 0)
  ok("the shadowed document is untouched", JSON.parse(readFileSync(outerFile, "utf8")).servers.shadow.command === "outer")
  const afterRemoval = await collectServers(scopeInner, { home: scopeHome })
  ok("the farther definition becomes effective again", afterRemoval.servers.find((server) => server.name === "shadow").command === "outer")

  // A scope move: the caller knows which document the old definition is in, and
  // a nearer file would otherwise hide it from the by-name lookup.
  const moveTree = join(root, "move-tree")
  const moveInner = join(moveTree, "inner")
  const moveOuter = pathConfigPath(moveTree)
  const moveInnerFile = pathConfigPath(moveInner)
  mkdirSync(dirname(moveOuter), { recursive: true })
  mkdirSync(dirname(moveInnerFile), { recursive: true })
  write(moveOuter, { moved: { type: "stdio", command: "outer" } })
  write(moveInnerFile, { moved: { type: "stdio", command: "inner" } })
  const moved = await removeServer({ cwd: moveInner, name: "moved", home: scopeHome, sourcePath: moveOuter })
  ok("removeServer can name the document instead of the effective entry",
    moved.path === moveOuter && moved.servers.length === 0
    && JSON.parse(readFileSync(moveInnerFile, "utf8")).servers.moved.command === "inner")
  ok("naming a document that does not define the name is refused",
    await bad(removeServer({ cwd: moveInner, name: "moved", home: scopeHome, sourcePath: moveOuter })) !== null)
}

// ---- live mounts -----------------------------------------------------------
const fakeClient = {
  name: "mcp-client",
  inject: ["tools"],
  Config: (config) => ({ args: [], env: {}, headers: {}, ...config }),
  async apply() {},
}

// One live plugin instance. A config naming a server in `failFor` is the server
// that refuses to connect; like cordis's own wrapper, `then` returns a fresh
// promise so awaiting the fiber never re-enters itself.
class FakeFiber {
  constructor(config, { fail = false } = {}) {
    this.config = config
    this.disposed = false
    this._ready = fail ? Promise.reject(new Error("connect ECONNREFUSED")) : Promise.resolve()
  }
  then(onFulfilled, onRejected) { return this._ready.then(onFulfilled, onRejected) }
  async dispose() { this.disposed = true }
}

function createFakeAgent({ toolNames = [], failFor = [] } = {}) {
  const fibers = []
  return {
    fibers,
    get(name) {
      if (name !== "tools") return undefined
      return { schemas: () => toolNames.map((name) => ({ name, description: "", parameters: {} })) }
    },
    plugin(client, config) {
      const fiber = new FakeFiber(config, { fail: failFor.includes(config.serverName) })
      fibers.push(fiber)
      return fiber
    },
  }
}

const stdioEntry = { name: "demo", type: "stdio", command: "node", args: ["s.js"], env: { TOKEN: "t" }, timeoutMs: 45000, enabled: true, scope: "path", sourcePath: nestedFile }
{
  const manager = new McpManager({ loadClient: async () => fakeClient, probe: () => ["read", "write"] })
  manager.setConfigured([stdioEntry])
  const agent = createFakeAgent()
  manager.attachAgent(agent, nested)
  ok("a mount settles once the fiber is up", await settle(() => manager.status()[0].state === "connected"))
  ok("the mounted config is the host's strict-startup shape",
    agent.fibers.length === 1
    && agent.fibers[0].config.failOnStartupError === true
    && agent.fibers[0].config.serverName === "demo"
    && agent.fibers[0].config.transport === "stdio"
    && agent.fibers[0].config.command === "node"
    && JSON.stringify(agent.fibers[0].config.args) === JSON.stringify(["s.js"])
    && agent.fibers[0].config.env.TOKEN === "t")
  ok("timeoutMs maps to the host's tool-call timeout", agent.fibers[0].config.toolCallTimeoutMs === 45000)
  ok("the session cwd reaches a stdio mount", agent.fibers[0].config.cwd === nested)
  const row = manager.status()[0]
  ok("status reports the tools the probe found", JSON.stringify(row.tools) === JSON.stringify(["read", "write"]))
  ok("a status row carries the frozen shape",
    row.name === "demo" && row.type === "stdio" && row.target === "node s.js" && row.enabled === true
    && row.scope === "path" && row.sourcePath === nestedFile && row.error === "" && row.record === stdioEntry)

  const httpManager = new McpManager({ loadClient: async () => fakeClient })
  httpManager.setConfigured([{ name: "web", type: "http", url: "https://x/mcp", headers: { A: "B" }, timeoutMs: 30000, enabled: true }])
  httpManager.attachAgent(createFakeAgent())
  ok("an http entry mounts as the host's streamable-http", await settle(() => httpManager.status()[0].state === "connected")
    && httpManager.entries.get("web") !== undefined)
  ok("an http row targets its url", httpManager.status()[0].target === "https://x/mcp")

  const sseManager = new McpManager({ loadClient: async () => fakeClient })
  sseManager.setConfigured([{ name: "legacy", type: "sse", url: "https://x/sse", headers: { Authorization: "Bearer t" }, timeoutMs: 30000, enabled: true }])
  const sseAgent = createFakeAgent()
  sseManager.attachAgent(sseAgent)
  await settle(() => sseManager.status()[0].state === "connected")
  const sseConfig = sseAgent.fibers[0].config
  ok("an sse entry mounts as the bundled bridge over stdio",
    sseConfig.transport === "stdio" && sseConfig.command === process.execPath
    && sseConfig.args.length === 1 && sseConfig.args[0].endsWith("mcp-sse-bridge.mjs"))
  ok("the sse bridge keeps the tool-call timeout",
    sseConfig.toolCallTimeoutMs === 30000 && sseConfig.env.MCP_SSE_TIMEOUT_MS === "30000")
  ok("the sse url and headers travel in the environment, never in argv",
    sseConfig.env.MCP_SSE_URL === "https://x/sse"
    && JSON.parse(sseConfig.env.MCP_SSE_HEADERS).Authorization === "Bearer t"
    && !sseConfig.args.join(" ").includes("https://"))
  ok("an sse row targets its url", sseManager.status()[0].target === "https://x/sse")

  const failing = new McpManager({ loadClient: async () => fakeClient })
  failing.setConfigured([{ ...stdioEntry, name: "ghost" }])
  const failingAgent = createFakeAgent({ failFor: ["ghost"] })
  failing.attachAgent(failingAgent)
  ok("a refused connection is recorded, never thrown", await settle(() => failing.status()[0].state === "error"))
  ok("the failure carries the reason", failing.status()[0].error.includes("connect ECONNREFUSED"))
  ok("the failed fiber is disposed", await settle(() => failingAgent.fibers.every((fiber) => fiber.disposed)))

  const noClient = new McpManager({ loadClient: async () => null })
  noClient.setConfigured([stdioEntry])
  noClient.attachAgent(createFakeAgent())
  ok("a host without an MCP client still reports a row", await settle(() => noClient.status()[0].state === "error"))
  ok("the missing client is named in the error", noClient.status()[0].error.includes("no MCP client"))

  const disabled = new McpManager({ loadClient: async () => fakeClient })
  disabled.setConfigured([{ ...stdioEntry, enabled: false }])
  disabled.attachAgent(createFakeAgent())
  await sleep(20)
  ok("a disabled server mounts nothing", disabled.status()[0].state === "disabled" && disabled.entries.size === 0)
}

// ---- reconciliation ---------------------------------------------------------
{
  const agent = createFakeAgent()
  const manager = new McpManager({ loadClient: async () => fakeClient })
  manager.setConfigured([stdioEntry])
  manager.attachAgent(agent, nested)
  await settle(() => manager.status()[0].state === "connected")
  await manager.sync()
  ok("sync keeps a matching mount", agent.fibers.length === 1 && manager.entries.has("demo"))

  manager.setConfigured([{ ...stdioEntry, name: "fresh" }])
  await manager.sync()
  ok("sync mounts what joined and unmounts what left",
    manager.entries.has("fresh") && !manager.entries.has("demo")
    && agent.fibers.filter((fiber) => !fiber.disposed).length === 1)
  ok("a server that left the list reads as unmounted", !manager.status().some((row) => row.name === "demo"))

  manager.setConfigured([{ ...stdioEntry, name: "fresh", command: "other" }])
  await manager.sync()
  ok("sync remounts a server whose config changed",
    agent.fibers.filter((fiber) => !fiber.disposed).length === 1
    && agent.fibers.at(-1).config.command === "other")

  await manager.removeAll()
  ok("removeAll drops the mounts but keeps the configuration",
    manager.entries.size === 0 && manager.configured.length === 1 && agent.fibers.every((fiber) => fiber.disposed))
  ok("a dropped mount reads as unmounted", manager.status()[0].state === "unmounted")

  await manager.dispose()
  ok("dispose forgets the configuration too", manager.configured.length === 0 && manager.status().length === 0)
}

// ---- attach and dispose race ------------------------------------------------
{
  const agent = createFakeAgent()
  const manager = new McpManager({ loadClient: async () => fakeClient })
  manager.setConfigured([stdioEntry])
  manager.attachAgent(agent, nested)
  await manager.dispose()
  await sleep(30)
  ok("dispose supersedes an attach still in flight", manager.entries.size === 0 && agent.fibers.length === 0)

  const detached = new McpManager({ loadClient: async () => fakeClient })
  detached.setConfigured([stdioEntry])
  const detachedAgent = createFakeAgent()
  detached.attachAgent(detachedAgent, nested)
  await settle(() => detached.entries.size === 1)
  await detached.detachAgent()
  ok("detach closes every fiber and clears the scope",
    detached.entries.size === 0 && detached.agentCtx === null && detachedAgent.fibers.every((fiber) => fiber.disposed))
}

// ---- the tool probe ---------------------------------------------------------
{
  const probe = await createToolProbe()
  const agent = createFakeAgent({ toolNames: ["mcp__demo__read", "mcp__demo__write", "read"] })
  const probed = probe(agent, "demo")
  ok("the probe reads one server's tools, or degrades to null",
    probed === null || JSON.stringify(probed) === JSON.stringify(["read", "write"]))
  ok("the probe survives a missing tools service", probe({ get: () => undefined }, "demo") === null)
  ok("the probe survives a tools service without schemas", probe({ get: () => ({}) }, "demo") === null)
  ok("the probe survives a throwing tools service", probe({ get: () => ({ schemas() { throw new Error("boom") } }) }, "demo") === null)
}

console.log(failed === 0 ? "\nall mcp tests passed" : "\n" + failed + " mcp test(s) failed")
process.exit(failed === 0 ? 0 : 1)
