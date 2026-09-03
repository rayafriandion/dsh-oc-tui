# 程序内更新系统（Update 设置页）设计

日期：2026-09-03
状态：已与用户确认设计方向，待评审

## 1. 背景与目标

dsh-oc-tui 目前没有任何版本/更新能力：用户需要手动 `npm view`、`npm install -g` 或
`dsh plugin add` 才能升级 dsh 或 TUI 自身。本设计在 Ctrl+P 设置页新增一个 **Update**
标签页，提供：

- 检测 **dsh**（`@deepseek-ai/dsh`）与 **dsh-oc-tui** 的当前安装版本；
- 通过 npm registry 查询可用版本与 dist-tags；
- 在版本列表中手动选择任意版本（含 pre-release）安装/切换；
- TUI 启动时后台静默检查一次，发现稳定版更新时 toast 提示。

已确认的决策：

- 检查/安装全部走 npm / pnpm CLI（尊重用户配置的 registry 与镜像，不直连
  registry.npmjs.org）；
- 启动时后台检查 + 设置页手动检查并存，启动检查可通过设置项关闭。

## 2. 非目标

- 不自动重启 dsh / TUI 进程：安装完成后 toast 提示 "restart to apply"；
- 不自动安装，只提示 + 手动确认后安装；
- 不引入 semver 依赖库：比较只用 major.minor.patch 数值 + 是否含 pre-release 段；
- 不显示 changelog（YAGNI，后续可加）。

## 3. 版本与"有更新"判定规则（用户已确认）

**版本列表（手动选择）**：列出 registry 全部版本（含 rc/alpha 等 pre-release），
新→旧排列；dist-tag（`latest` / `next` / `alpha`）用 `[tag]` 前缀标注，当前已装
版本标 `(installed)`。

**更新提示（设置页状态行 + 启动 toast）只以稳定版为目标**，pre-release 不提示：

- `latestStable(versions)`：过滤含 pre-release 段（`-` 之后非空）的版本，按
  major.minor.patch 数值取最大；无稳定版 → `null`。
- **提示条件**：`latestStable !== null` 且（`core(latestStable) > core(installed)`，
  或 core 相等且 installed 是 pre——即用户正在用的 rc 已发布正式版）。
- installed 的 core 更大（用户在用更新的 pre）→ 不提示，状态 `Up to date`。
- registry 无任何稳定版 → 永不提示。**注意当前 dsh 的真实情况：所有已发布版本
  都是 rc，dist-tags.latest = 0.1.1-rc.2 也是 pre**——因此在 @deepseek-ai 发布
  稳定版之前，dsh 永远不会触发更新提示；用户只能通过版本列表手动切换。这是
  用户明确选择的行为。

设置页同时显示一个事实行 `Latest (npm tag)` = `dist-tags.latest` 的值（即使是
pre），与状态行的"建议"分离：事实归事实，建议归建议。

判定案例（installed, registry → 状态）：

| installed | latestStable | dist-tags.latest | 状态 |
|---|---|---|---|
| 0.1.0 | 0.1.1 | 0.1.1 | Update available → 0.1.1 |
| 0.1.1 | 0.1.1 | 0.1.1 | Up to date |
| 0.2.0-rc.1 | 0.2.0 | 0.2.0 | Update available → 0.2.0 |
| 0.1.2-rc.1 | 0.1.1 | 0.1.2-rc.1 | Up to date（用的是更新的 pre） |
| 0.1.0-rc.6 | null（全是 rc） | 0.1.1-rc.2 | No stable release — pick from Versions |

## 4. 新模块 `lib/updates.js`

所有 npm/pnpm 交互集中在 `lib/updates.js`（风格对齐 `web-settings.js`），
`lib/index.js` 只做 UI 接线。导出：

| 函数 | 作用 |
|---|---|
| `DSH_PACKAGE`, `TUI_PACKAGE` | 常量 `@deepseek-ai/dsh` / `dsh-oc-tui` |
| `parseRegistryView(json)` | 解析 `npm view <pkg> versions dist-tags --json` 的输出 → `{ versions: string[], distTags: Record<string,string> }`；防御性解析（versions 退化成字符串等） |
| `isPrerelease(v)` / `coreSegments(v)` | 版本解析纯函数（剥 `+build`，`-` 后为 pre 段） |
| `latestStable(versions)` | 见第 3 节规则 |
| `updateStatus(installed, registry)` | → `{ kind: 'available' \| 'up-to-date' \| 'no-stable', target? }`，纯函数 |
| `detectDshInstall()` | 复用 launcher 的模式：`findOnPath('dsh')` → `createRequire(shim).resolve('@deepseek-ai/dsh/package.json')` 读 manifest → `{ version, entry, found: true }`；PATH 无 dsh → `{ found: false }`。不 spawn，毫秒级 |
| `tuiInstalledVersion()` | 读自己包根（`lib/../package.json`）的 version |
| `resolveActiveProfile(fs)` | ① env `DSH_TUI_BOOT_PROFILE`（launcher 注入）；② 扫描 `$DSH_HOME/profiles/*`，`realpath(profile/node_modules/dsh-oc-tui) === realpath(自身包根)`（pnpm symlink 也能对上）；③ 兜底 `'tui'` |
| `registryInfo(pkg)` | async spawn node 自带的 `npm-cli.js view pkg versions dist-tags --json`（30s 超时）→ 解析；失败抛错 |
| `installDsh(version)` | async spawn `node npm-cli.js install -g @deepseek-ai/dsh@<ver>`（300s 超时），返回 `{ code, stderr }` |
| `installTui(version, profile, dshEntry)` | async spawn `node <dshEntry> plugin --profile <p> add -E dsh-oc-tui@<ver>`（300s 超时；官方路径：自动走 pnpm 并同步 `dsh.profile.bundles`） |
| `loadUpdateView(ctx)` | async loader，返回与其他 tab 相同的 `{ settings, items, title, subtitle, menu, menuIndex }` 形状 |
| `buildUpdateItems(state)` / `buildVersionItems(registry, installed)` | 纯函数，构建 item 行（供测试） |

npm CLI 定位：`<dirname(process.execPath)>/node_modules/npm/bin/npm-cli.js`（与
launcher 的 `npxCommand()` 同模式），避免 Windows `.cmd` spawn 问题；找不到再退
PATH（`.cmd`/`.exe`/裸名探测，同 `findOnPath`）。所有 spawn 用**异步**
`child_process.spawn` 收集 stdout/stderr（不用 spawnSync——那会冻住整个 TUI 渲染
与按键）。

launcher（`bin/dsh-oc-tui.js`）小改一处：`spawnCommand` 增加 env 参数，启动 dsh
时注入 `DSH_TUI_BOOT_PROFILE=<profile>`，供插件侧 `resolveActiveProfile` 第一优先
级使用。

## 5. UI 设计

### 5.1 菜单与 loader 接线

- `SETTINGS_MENU`（`lib/web-settings.js`）追加 `{ id: 'update', label: 'Update' }`；
- `openSettingsTab`（`lib/index.js:1069`）加分支 `update` → `await loadUpdateView(ctx)`；
- `menuSelections` 增加 `update: 0`；`handleSettingsKey` 中 settingsView kind 检查
  （`'main' || 'model'` 处）加 `'update'`；Esc 返回目标分支同步。

### 5.2 Update 页布局

```
Update                                        [Main | Model | Update]
profile: tui
─ dsh (@deepseek-ai/dsh) ───────────────────────────────
  Installed         0.1.0-rc.6
  Latest (npm tag)  0.1.1-rc.2
  Status            No stable release — pick from Versions
  Versions          Select version…                ← Enter 打开列表
─ dsh-oc-tui ───────────────────────────────────────────
  Installed         0.1.1
  Latest (npm tag)  0.1.0
  Status            Up to date
  Versions          Select version…                ← Enter 打开列表
─ Actions ─────────────────────────────────────────────
  Check now         Refresh from npm registry
  Startup check     on / off                       ← 复用 'choice' item
```

新增 item kind（沿用 label/value 双列渲染）：

- `update-info`：静态信息行（Installed / Latest tag / Status），不可触发；Status
  为 `available` 时用主题高亮色（绿色/黄色，同 toast warn 级别）；
- `update-versions`：Enter → 打开版本列表子视图；
- `update-check`：Enter → 重新执行检查（期间行值显示 spinner，其余行 disabled）。

`Startup check` 复用现有 `choice` kind + `saveWebSetting` 的 `settings.mutate` 通道
（见第 6 节），零新代码。

### 5.3 版本列表子视图

复用 provider-models 窗口模式：`settingsView = { kind: 'update-versions', pkg }`，
异步 `registryInfo`（加载中显示 `'Fetching versions…'` 占位行，沿用
`settingsLoadVersion` 防错乱守卫）。行格式：

```
0.1.2-rc.1  [next]
0.1.1-rc.2  [latest]
0.1.0-rc.8
0.1.0-rc.7  (installed)
…
```

Enter 某版本 → 现有 `settingsConfirm` y/n 内联确认，文案包含目标版本号；若当前
profile 里 TUI 是 `file:`/本地路径安装（读 profile `package.json` 的
`dependencies.dsh-oc-tui` 判断），确认文案追加提示"将把本地安装切换为 registry
版本"。y → 执行安装。

### 5.4 安装过程

- 安装期间确认行显示 spinner（现有 `seg.anim === 'spinner'` 机制），页面其余操作
  可继续（Esc 离开不取消安装，安装作为后台 promise 继续）；
- 完成后：toast `dsh 0.1.1 installed — restart to apply`（或 TUI 同理），若 Update
  页仍开着则自动刷新数据；
- 失败：toast error + stderr 尾部摘要（最后 ~3 行，去掉 ANSI 后截断）；
- 并发守卫：同一时间只允许一个安装任务（busy 标志），进行中再次 Enter 无效。

## 6. 启动后台检查与开关

- `WEB_SETTING_SCHEMAS`（`lib/web-settings.js`）追加
  `['tui-updates', z.object({ startupCheck: z.union(['on','off']).default('on') })]`，
  由现有 `installWebSettingSchemas` 注册——dsh web 设置页也能看到同一开关；
- `apply()` 启动 2 秒后（等 settings 服务就绪）：读 `tui-updates.startupCheck`
  （读不到时默认 on），为 on 则 `void` 并行执行 dsh + tui 的检测与 registry 查询；
  两个包分别按第 3 节规则判定，有 `available` 则 toast 一次，例如
  `Updates: dsh 0.1.1 · dsh-oc-tui 0.2.0 — Ctrl+P → Update`；
- 网络失败静默忽略（不打扰启动）。

## 7. 错误与边界

| 情形 | 行为 |
|---|---|
| registry 查询失败/超时 | 对应包区显示 `Registry check failed` + 原因 + Check now 重试 |
| dsh 不在 PATH | dsh 区显示 `not found on PATH`；TUI 自身不受影响 |
| pnpm 缺失 | dsh plugin 命令自己会报 `pnpm not found`，toast 透传其 stderr |
| 安装失败 | toast error + stderr 摘要 |
| TUI 为 file:/git 本地安装 | 仍可切换到 registry 版本（确认文案警示） |
| 离线 | 仅页面显示错误，其他功能不受影响 |
| settings 服务不可用 | 开关行 disabled，启动检查默认 on |

## 8. 测试计划（`tests/smoke.test.mjs`，纯函数，不测 spawn 薄封装）

- `parseRegistryView`：标准 JSON、退化形状（versions 为字符串）、缺字段；
- `isPrerelease` / `coreSegments`：`0.1.0`、`0.1.1-rc.2`、`0.1.0+build`；
- `latestStable`：含/不含稳定版、多位数段（`0.10.0` > `0.9.0`）；
- `updateStatus`：第 3 节表格全部案例；
- `buildUpdateItems` / `buildVersionItems`：区块、tag 标注、`(installed)` 标注、
  loading/failed 状态行；
- `resolveActiveProfile`：注入 fake fs/env 验证三个优先级（env → realpath 匹配 →
  兜底）。

## 9. 文档更新

- `README.md`：新增 "Update manager (Ctrl+P → Update)" 小节（能力、判定规则、
  启动检查开关、restart to apply 说明）；
- `docs/用户手册.md`：对应中文小节。
