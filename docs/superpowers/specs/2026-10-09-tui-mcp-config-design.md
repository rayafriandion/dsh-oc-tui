# TUI 内建 MCP 服务器配置 — 设计（冻结接口）

日期：2026-10-09
分支：`feature/chafa+`
目标版本：`0.2.0-pre.11`（不新增 bump）
安装宿主：dsh `0.2.0-rc.2`

## 0. 为什么推翻 2026-10-06 的方案

旧方案把 server 列表写进 settings 命名空间 `tui-mcp`。在 dsh `0.2.0-rc.2` 上
`SettingsForms.mutate/describe` 只认 **profile entry id**（`tui-startup` / `tui-app`），
`write()` 对未知 ns 直接 `No configurable plugin entry "tui-mcp"`，`describe()` 也永远
返回不了该 ns —— 也就是说旧实现在当前宿主上既读不到也写不进（现有测试用假 settings
桩，掩盖了这一点）。同时需求里的「作用域（用户 / 指定路径）」本质上要求文件级存储。

因此：**配置文件由插件自管**，不再经过 settings 服务。

## 1. 存储契约

| 作用域 | 文件 | 生效范围 |
| --- | --- | --- |
| 用户 | `$DSH_HOME/mcp.json` | 所有会话 |
| 指定路径 | `<path>/.dsh/mcp.json` | cwd 位于 `<path>` 之下的会话 |

`collectServers(cwd)` 从 `cwd` 逐级向上到文件系统根，收集沿途每个 `.dsh/mcp.json`，
再加上用户文件。同名 server 由**最近的文件**胜出（路径作用域覆盖用户作用域）。

文档格式（写入固定 `servers`，读取额外接受 `mcpServers` 别名）：

```json
{
  "version": 1,
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "xxx" },
      "timeoutMs": 30000,
      "enabled": true
    },
    "web": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": {}, "timeoutMs": 30000, "enabled": true },
    "legacy": { "type": "sse", "url": "https://mcp.example.com/sse", "headers": {}, "timeoutMs": 30000, "enabled": true }
  }
}
```

- **name = `servers` 的 key**（记录里不重复写名字；旧记录里的 `name`/`serverName` 在读取时忽略）。
- 记录里**不含作用域字段**，作用域由所在文件决定。
- `timeoutMs` 默认 `30000`，映射到宿主 mcp-client 的 `toolCallTimeoutMs`。
- 文件缺失 = 合法空配置；JSON 坏 / `servers` 不是对象 = 该文件报错但不影响其他文件。

## 2. 类型与传输映射

界面类型：`本地命令` / `HTTP` / `SSE`，值 `stdio` / `http` / `sse`。

宿主 `@deepseek-ai/dsh-mcp-client`（0.2.0-rc.2）只有 `stdio` 与 `streamable-http`，
打包的 `@modelcontextprotocol/client` 里没有 legacy SSE transport。映射：

| 界面类型 | 挂载方式 |
| --- | --- |
| `stdio` | `transport: 'stdio'`，直接给 command/args/env/cwd |
| `http` | `transport: 'streamable-http'`，url/headers |
| `sse` | `transport: 'stdio'`，command=`process.execPath`，args=`[<bin/mcp-sse-bridge.mjs>]`，env 带 `MCP_SSE_URL` / `MCP_SSE_HEADERS` |

SSE 桥接脚本是零依赖的 stdio↔legacy-SSE 代理，宿主的工具桥接、重连、单次调用超时全部照常复用。

## 3. `lib/mcp.js` 冻结导出

```js
export const MCP_TYPES = ['stdio', 'http', 'sse']
export const DEFAULT_TIMEOUT_MS = 30000
export const MAX_TIMEOUT_MS = 3600000
export const MCP_ENTRY_PREFIX = 'mcp__'
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function dshHome()                                  // $DSH_HOME || ~/.dsh
export function userConfigPath(home = dshHome())           // <home>/mcp.json
export function pathConfigPath(directory)                  // <directory>/.dsh/mcp.json
export function configPathsForCwd(cwd, home)               // [{scope:'path',path,directory}... 由近及远, {scope:'user',path}]

export function parseArgs(text)                            // shell 式分词(双引号分组)；JSON 数组文本按数组解析；未闭合引号 throw
export function parseKeyValueJson(text, { header = false, label = 'environment' })
   // '' → {ok:true,value:{}}；JSON 对象；值 string|number|boolean → String()；其余 → {ok:false,error}
   // header=true 时再用 node:http 的 validateHeaderName/Value 校验
export function parseDocument(text)                        // {ok:true,servers:[record]} | {ok:false,error}
export async function readDocument(file)                   // {exists,servers,error}
export async function collectServers(cwd, { home } = {})   // {servers:[entry], files:[{scope,path,exists,error}]}
   // entry = record + { name, scope, sourcePath }

export function emptyDraft()                               // 见 §4
export function draftFromEntry(entry)                      // entry → draft（env/headers 序列化为 JSON 文本）
export function validateDraft(draft, { existing = [] } = {})
   // {ok:true, record} | {ok:false, error}；record 见 §5
export function upsertEntry(servers, record, originalName = '')  // 纯函数：替换或追加，按 name 排序
export function removeEntry(servers, name)                 // 纯函数
export function serializeDocument(servers)                 // JSON.stringify(doc, null, 2) + '\n'

export async function saveDraft({ cwd, draft, home })      // 按 draft.scope 选文件，read-modify-write
   // → { scope, path, servers }（servers = 该文件里的记录，按 name 排序）
export async function removeServer({ cwd, name, home })    // 从定义该生效条目的文件里删除 → { path, servers }

export class McpManager {
  constructor({ probe, loadClient } = {})
  setConfigured(servers)   // entry[]
  attachAgent(agentCtx, cwd = '')   // 不 await；内部 detach 后逐台 mount
  async detachAgent()
  async mount(entry); async unmount(name); async sync(); refresh()
  toolsOf(name); status()
}
export async function createToolProbe()                    // (agentCtx, serverName) => string[] | null
```

`status()` 行：`{ name, type, target, enabled, scope, sourcePath, state, error, tools, record }`，
`state ∈ 'pending' | 'connected' | 'unmounted' | 'disabled' | 'error'`，`tools` 为 `null` 表示探测不可用。
`target`：stdio 为 `command args...`，http/sse 为 url。

沿用旧文件的既有语义：挂载失败只记 `error` 不抛；`failOnStartupError: true` 让连接失败
以 fiber reject 的形式暴露；连接超时（内部 `CONNECT_TIMEOUT_MS = 20000`）单独报错。

## 4. draft 形状（表单）

```js
{
  name: '', type: 'stdio', timeoutMs: '30000',
  command: '', args: '', env: '',            // env 是 JSON 文本
  url: '', headers: '',                      // headers 是 JSON 文本
  scope: 'user', path: '',                   // path 仅当 scope==='path'
  enabled: true,
  originalName: '',                          // 编辑态；改名 = 先删再加
}
```

## 5. record 形状（落盘）

```js
// stdio
{ type:'stdio', command:'npx', args:['-y','pkg'], env:{K:'V'}, timeoutMs:30000, enabled:true }
// http / sse
{ type:'http', url:'https://...', headers:{A:'B'}, timeoutMs:30000, enabled:true }
```

`validateDraft` 规则：

- `name` 必须匹配 `SERVER_NAME_PATTERN`；与 `existing` 中已存在的名字重复 → 报错（编辑态由调用方把
  自己的 `originalName` 从 `existing` 里剔除后再传）。
- `timeoutMs`：空 → 30000；非整数 / <1 / >MAX → 报错。
- `stdio`：`command` 非空；`args` 走 `parseArgs`；`env` 走 `parseKeyValueJson`。
- `http`/`sse`：`url` 可被 `new URL` 解析且协议为 http/https；`headers` 走 `parseKeyValueJson({header:true})`。
- `scope === 'path'` 时 `path` 非空且为绝对路径（目录校验在 `saveDraft` 里做文件系统检查）。

## 6. `bin/mcp-sse-bridge.mjs` 契约

```
node mcp-sse-bridge.mjs --url <sse-url> [--header "Name: value"]... [--timeout-ms N]
env 回退：MCP_SSE_URL / MCP_SSE_HEADERS(JSON 对象) / MCP_SSE_TIMEOUT_MS
```

- `GET <url>`，`Accept: text/event-stream`（+ 额外 header）；解析 SSE 帧。
- `event: endpoint` 的 data 作为 POST 地址（相对地址按 `<url>` 解析）。
- stdin 的换行分隔 JSON-RPC → `POST` 到 endpoint（`Content-Type: application/json`）；endpoint 到达前的消息排队。
- `event: message` 的 data 原样写到 stdout，一行一条。
- 致命错误写 stderr 并非零退出；stdin EOF → 退出码 0；SSE 流意外关闭 → 非零退出（宿主据此重连）。
- 只用 `node:` 内置模块。

## 7. 内置 skill

- 源文件：`skills/mcp-import/SKILL.md`（带 YAML frontmatter：`name` / `description`）。
- 插件在 `apply()` 里通过 `ctx.get('skills')?.register({...})` 注册（宿主 `dsh-skill` 的 runtime 通道），
  frontmatter 由 `lib/mcp-skill.js` 自己解析，`source: 'bundled'`，`resourceBase` 指向随包目录。
- 服务缺失 / 注册报错只记日志，绝不影响 TUI 启动。

## 8. 写者分工（互不重叠，实际交付）

| 文件 | 归属 |
| --- | --- |
| `lib/mcp.js`、`tests/mcp.test.mjs` | mcp-core |
| `bin/mcp-sse-bridge.mjs`、`tests/mcp-sse-bridge.test.mjs`、`tests/fixtures/sse-server.mjs` | sse-bridge |
| `lib/mcp-skill.js`、`skills/mcp-import/SKILL.md`、`tests/mcp-skill.test.mjs` | skill-author |
| `lib/index.js`、`lib/web-settings.js`、`tests/mcp-form.test.mjs`、`tests/resume.test.mjs`、`tests/smoke.test.mjs`、`package.json`、`dsh-plugin.json`、`README.md`、`docs/用户手册.md`、`tests/fixtures/mcp-rpc.mjs`、`tests/fixtures/stdio-server.mjs`、`tests/fixtures/sse-mcp-server.mjs`、`tests/mcp-live.test.mjs` | Lead |

`package.json` 的 `files` 增加 `skills`；`check`/`test` 增加 `lib/mcp-skill.js`、`bin/mcp-sse-bridge.mjs`、`tests/mcp-{sse-bridge,skill,live}.test.mjs`。
`tests/resume.test.mjs` 原本把 MCP server 写在旧 settings 命名空间里，已改为写 `$DSH_HOME/mcp.json`。

## 9. 验收（实际执行）

1. `npm run check` 与 `npm test`：全绿，只有 AGENTS.md 记录在案的 8 个 `esc-questions` 既有失败。
2. `tests/mcp-live.test.mjs` —— 真机：**从 PATH 上的 dsh 安装**按绝对路径加载 `@deepseek-ai/dsh-tools` /
   `dsh-mcp-client` / `dsh-scope`（裸 specifier 在 profile 里会解析到 `profiles/node_modules` 的陈旧
   junction），挂真 `ToolRuntime`，用本地 stdio fixture 与 legacy-SSE fixture 各挂一台：
   连接成功、工具以 `mcp__fixture__echo` / `mcp__legacy__echo` 出现在注册表、fixture 记录了真实
   `initialize` + `tools/list`、卸载后工具消失。没有 dsh 安装时打印 `skip` 并退出 0。
3. `tests/mcp-form.test.mjs` —— 真 cordis + 假 TTY：用户作用域与路径作用域各写一台、编辑 Enabled、
   Delete 两次删除、作用域行、`$DSH_HOME/mcp.json` 与 `<dir>/.dsh/mcp.json` 的实际内容。
4. `lib/mcp-skill.js`：真 `SkillRegistry` 里 `ctx.skills.list()` 出现 `mcp-import`（`source: 'bundled'`），
   `get()` 返回正文。
5. repack（34 文件，含 `skills/mcp-import/SKILL.md` 与 `bin/mcp-sse-bridge.mjs`）→ 装进 `tui` profile →
   哈希对账 → `--dump-config` 有 `tui-startup`/`tui-app` 行。
6. `.e2e-dsh/pty-mcp-e2e.cjs` —— 真 `dsh --profile tui`（PATH 上的 0.2.0-rc.2）在 ConPTY 里启动：
   写 `mcp.json`（stdio + legacy SSE 各一台）→ 开会话 → `Ctrl+P` → `Shift+Tab` 到 MCP 页 →
   屏幕断言 10 项全过（MCP 页渲染、两台 server 行、`echo` 工具、无 `the host provides no MCP client`、
   无堆栈、无 TypeError、会话正常）。
