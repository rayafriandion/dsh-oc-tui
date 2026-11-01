---
name: mcp-import
description: "Use when the user asks to add, import, connect or configure an MCP server for the dsh-oc-tui TUI — a local command (stdio), a Streamable HTTP endpoint, or a legacy SSE endpoint — or to fix, disable, or remove an existing one; 用户要求添加、导入、连接或配置 MCP 服务器（本地命令 stdio / HTTP / SSE），或修改、停用、删除已有 MCP 服务器时使用。"
whenToUse: "The user names a concrete MCP server, package, command, or endpoint; importing one is a read-merge-write of one JSON config file, not a code change."
---

# Import and connect MCP servers

MCP servers for this TUI live in JSON config files that you edit directly. There
is no CLI command and no settings field for this: read the target file, merge in
one entry under `servers`, write the file back. The next session picks it up.

## 1. Which file to edit

| Scope | File | Applies to |
| --- | --- | --- |
| User | `$DSH_HOME/mcp.json` | every session |
| Project | `<dir>/.dsh/mcp.json` | sessions whose cwd is `<dir>` or below |

- `$DSH_HOME` defaults to `~/.dsh`; on Windows that is `%USERPROFILE%\.dsh`.
- At session start the TUI walks from the session cwd up to the filesystem root,
  collecting every `.dsh/mcp.json` along the way, then adds the user file. When
  the same server name is defined more than once, the file nearest the cwd wins.
- Default to the user file. Use the project file when the user wants the server
  for one project only ("only in this repo", "只在这个项目里"). Create the `.dsh`
  directory if it is missing.

## 2. Document shape

```json
{
  "version": 1,
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

- `version` is `1`; `servers` maps each server **name** to its record.
- The name is the object key, not a field. Do not write `name` or `serverName`
  inside the record.
- A name must match `[A-Za-z0-9_-]{1,32}` — 1 to 32 letters, digits, `_`, or `-`.
- A missing file is a valid empty configuration. A file with broken JSON, or with
  a `servers` value that is not an object, is reported as an error for that file
  alone and does not affect the other files.

## 3. Records

`timeoutMs` and `enabled` are accepted on every type:

| Field | Meaning |
| --- | --- |
| `timeoutMs` | Milliseconds allowed for one tool call or resource request. Integer 1–3600000, default `30000`. |
| `enabled` | `false` keeps the entry but never connects it. Default `true`. |

Write only the fields documented below.

### `stdio` — a local command

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_example" },
  "timeoutMs": 30000,
  "enabled": true
}
```

`command` is required: an executable resolved on `PATH`. `args` is an array of
strings. `env` is an object of string values that becomes the child environment.

### `http` — Streamable HTTP

```json
{
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": { "Authorization": "Bearer example-token" },
  "timeoutMs": 30000,
  "enabled": true
}
```

`url` is required and must parse as a URL with an `http` or `https` protocol.
`headers` is an object of string values.

### `sse` — legacy HTTP+SSE

```json
{
  "type": "sse",
  "url": "https://mcp.example.com/sse",
  "headers": { "Authorization": "Bearer example-token" },
  "timeoutMs": 30000,
  "enabled": true
}
```

Same fields as `http`. This is the legacy HTTP+SSE transport, which the TUI
bridges for the host, so the entry behaves like the others.

Choose by endpoint, not by preference: `http` is Streamable HTTP and fits a
modern `/mcp` endpoint; `sse` is only for a server whose endpoint really is a
legacy `/sse`. When unsure, use `http`.

## 4. Rules for editing

1. Read the target file first when it exists, then merge: change only the one key
   under `servers`. Keep every other server and every other document key exactly
   as it was — never regenerate the file from scratch.
2. Keep the JSON valid: double quotes, no comments, no trailing commas.
3. Write the whole file back (read-modify-write); do not append a second document.
4. If the requested name already exists, that is an edit, not an import. Replace
   that entry only when the user means to change that server; never silently
   repoint an existing name at a different server.
5. Secrets belong in `env` (stdio) or `headers` (`http` / `sse`). `mcp.json` is
   plain text on disk with no encryption, so say so before writing a token there.
6. Do not touch the TUI's `settings.yaml`, the TUI source, or anything else for
   this — server definitions live only in `mcp.json`.
7. If a required token is missing, ask for it. If you must write first, use a
   visible placeholder such as `"<token>"` and state that it still needs filling in.

## 5. Verify

1. The entry applies to the **next** session: tell the user to open a new session
   (or restart the TUI). A session already running keeps the servers it started
   with.
2. In the TUI, `Ctrl+P` opens Settings; `Tab` to the **MCP** tab
   (Main → Model → Update → MCP). The server is listed there with its scope, a
   live connection state, and a tool count.
3. Tools from a connected server are callable as `mcp__<name>__<tool>`: a server
   named `github` that exposes `create_issue` gives `mcp__github__create_issue`.
4. A bad entry is not fatal. It shows as an error row in the MCP tab while the
   rest of the TUI keeps working.
5. Sanity-check the file before handing it over, substituting the real path:

   ```sh
   node -e "JSON.parse(require('node:fs').readFileSync('PATH_TO_MCP_JSON','utf8'));console.log('valid')"
   ```

## 6. Worked examples

### stdio — "帮我加一个 github mcp"

Read `$DSH_HOME/mcp.json` (it may not exist yet), add `servers.github`, write it
back, and report the plain-text secret with the verification step:

```json
{
  "version": 1,
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_example" },
      "timeoutMs": 30000,
      "enabled": true
    }
  }
}
```

Then: open a new session, `Ctrl+P` → MCP, confirm `github` is connected and note
its tool count. Mention that the token sits unencrypted in `$DSH_HOME/mcp.json`.

### http — "把 https://mcp.example.com/mcp 接进来，用 Bearer token"

`$DSH_HOME/mcp.json`, preserving any other servers already in the file:

```json
{
  "version": 1,
  "servers": {
    "web": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer example-token" },
      "timeoutMs": 30000,
      "enabled": true
    }
  }
}
```

Then: new session, `Ctrl+P` → MCP, confirm `web` is connected, and check that its
tools appear as `mcp__web__<tool>`.

### sse — "这个服务器只提供 legacy /sse 端点"

Only because the endpoint is `/sse`; otherwise this would be `http`:

```json
{
  "version": 1,
  "servers": {
    "legacy": {
      "type": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer example-token" },
      "timeoutMs": 30000,
      "enabled": true
    }
  }
}
```

Then: new session, `Ctrl+P` → MCP, confirm `legacy` is connected and note its tool
count. If it reports an error, check that the endpoint is really SSE and not a
Streamable HTTP `/mcp` endpoint.
