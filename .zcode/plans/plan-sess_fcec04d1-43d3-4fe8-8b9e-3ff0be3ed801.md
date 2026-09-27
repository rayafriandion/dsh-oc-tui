# dsh-oc-tui 现代化:真实图像 / 完整 Markdown / Mermaid / 现代视觉

## 已确认的决策
1. **纯 npm 依赖**:新增 `sharp`(图像解码/缩放/SVG 光栅化,全平台预编译)、`markdown-it`、`highlight.js`;协议编码器(kitty / iTerm2 OSC1337 / sixel / ANSI 半块)自研纯 JS,**不需要用户安装任何外部二进制**(chafa/mdcat 不用)。
2. **Mermaid 多级 provider**:本地 mmdc(检测 PATH,若用户自装)→ mermaid.ink 网络 API(设置可关)→ 语法高亮代码块回退。
3. **无图形协议终端**(GNOME Terminal、旧 xterm):高质量半块(▀▄█ + 真彩 + Floyd-Steinberg 抖动)预览,设置可关回 `[Image N]` chip。v1 只用半块(所有字体都有字形),六分块留作后续。
4. **UI 美化全做**:圆角边框+统一间距、代码语法高亮、OSC 8 可点击链接+表格美化、聊天气泡式布局。

## 关键现状(探索结论)
- 渲染管线:事件 → `App.blocks` → `_blockLines()`(ui.js:1127)产生 styled-segment 行 → 缓存(`rev:width`)→ `render()`(ui.js:1370)窗口化写入 `Screen` cell 网格 → `term.paint()`(term.js:475)行级差分输出。硬不变量:**每行恰好 cols 列、无残留**(tests/render.test.mjs 强制)。
- 图片现状:粘贴字节已到 `attachImage`(index.js:1646)→ 存为附件 → 只显示 `[Image N]` 文本。**不存在任何字符画/像素渲染**;term.js 无任何能力探测与图形协议代码。
- 已知 bug(将顺带修复):粘贴图片时乐观块(带 `[Image N]` 标记)与事件回放文本(标记已剥离)不一致,去重失败 → 出现重复用户块(index.js:547)。
- markdown.js:296 行自研渲染器;```mermaid 围栏的 info string 在 markdown.js:229 被解析后丢弃——这是 mermaid 的天然钩子点。
- 设置系统支持 `settings.register(ns, schema)`(web-settings.js:118),已有 `tui-updates` TUI 自有命名空间先例。

## 架构设计

### 新模块
| 模块 | 职责 |
| --- | --- |
| `lib/caps.js`(新) | 终端能力探测:并行发 DA1(`\x1b[c`,应答含 "4" → sixel)、kitty 图形查询(`\x1b_Gi=31,...;AAAA` 应答 → kitty graphics)、XTVERSION(`\x1b[>0q` → 识别 iTerm2/WezTerm/mintty/ghostty)、XTWINOPS 单元格像素尺寸(`\x1b[16t`,算缩放比例,缺省 8×16)。环境变量(WT_SESSION/KITTY_WINDOW_ID/TERM_PROGRAM…)只作提示不作权威。转义序列由客户端终端应答,天然穿透 SSH。优先级:kitty > iTerm2 > sixel > 半块(永远可用)。探测与首帧并行,能力就绪后重绘。 |
| `lib/image.js`(新) | 图像管线:来源 = 粘贴字节(已在手)/ 附件 ref(replay 路径 `attachments.readImage(ref)`)/ data URL / 本地路径 / http(s) URL(助手消息里的 `![alt](url)`)。sharp 解码 → 按格数缩放(默认 max 20 行 × 转写宽-4)→ 编码器:kitty(按内容哈希传输一次 PNG + `a=p` 引用放置,零重传)/ iTerm2 / sixel(行移动时用缓存负载重发)/ 半块(纯文本 cell,零 term.js 改动)。负载按 `sha1(bytes)+尺寸+协议` LRU 缓存;异步解码队列(并发 2),未就绪显示"渲染中…"占位,就绪后 `rev++` 重绘。GIF 取首帧。 |
| `lib/mermaid.js`(新) | provider 链:`auto`(默认)→ local(mmdc 在 PATH → SVG → sharp 按主题背景色光栅化)→ mermaid.ink(10s 超时,结果缓存 `os.tmpdir()/dsh-oc-tui/`)→ 高亮代码块回退。 |

### 修改模块
- **lib/term.js**:`decodeKey` 增加通用 DCS/OSC 终端应答分支(→ `terminal-reply` 事件,未知应答安全吞掉,绝不漏进 composer——现有 OSC 52 分支是先例);`Screen` 行级图像槽位标注(图像行画背景占位 cell,列数不变量不破坏);`paint()` 在文本 diff 后发射图形(kitty 引用放置 / sixel+iTerm2 缓存重发 / 清理,start/stop/resize 时 kitty delete-all);cell style 增加 `link` 字段,对连续 run 发射 OSC 8(URL 白名单 scheme http/https/file + 转义)。
- **lib/markdown.js**(重写,对外 API `renderMarkdown(text, theme, width)` 不变):markdown-it token 流驱动 → 表格(圆角框线+列宽省略)、嵌套列表、任务列表、h1–h6 层级、嵌套引用;highlight.js 按语言着色(token→主题色映射,配 `codeBg`);`[text](url)` 产出 link segs;返回值允许特殊行对象 `{ mermaid: code }` 与 `{ image: { url, alt } }`,由 ui.js 转成图像/mermaid 行。
- **lib/ui.js**:THEME 刷新(保留 DeepSeek 蓝基调,补 token 色/气泡色/边框层次);全部盒子与覆盖层圆角化(┌┐└┘→╭╮╰╯);**聊天气泡**:user = primary 边框圆角气泡、assistant = borderSubtle 圆角气泡,头部嵌进边框(`╭─ you · 14:32 ─╮`),流式时 assistant 气泡不闭合底边;user/assistant/tool 块新增图像行渲染(tool 文本仍 6 行上限,图片不计入);统一块间距节奏。
- **lib/index.js**:启动时并行探测接线;`user/message` 与 replay 提取 content 中的 image block 传入 `app.addUser(text, { images })`(顺带修复重复块 bug);粘贴图片的字节直接随提交进入乐观块(零读取),replay 用 `readImage`;mermaid/图像解码队列与设置接线。
- **设置**:`settings.register('tui-graphics', …)`:`graphics: auto|off`、`imageFallback: halfblock|chip`、`imageMaxRows`、`mermaid: auto|local|off`;Settings UI 增加 Graphics 分组。

### 数据流(图像)
```
粘贴字节/附件ref/URL ──▶ lib/image.js(sharp 解码+缩放)
   ├─ caps: kitty    → 传输一次 + 引用放置( term.paint 发射)
   ├─ caps: iTerm2   → OSC 1337 行移动重发(缓存负载)
   ├─ caps: sixel    → DCS 负载行移动重发(缓存)
   └─ 无协议         → 半块文本行(普通 segs,所有既有不变量自动成立)
```

## 实施步骤(每步可独立验证)
1. **spec + 计划文档**:写 `docs/superpowers/specs/2026-09-27-graphics-modern-ui-design.md` 并提交(按 superpowers 流程用 writing-plans 细化任务)。
2. **caps.js + decodeKey 应答分支**(+罐头应答单测)。
3. **image.js 管线核心 + 半块编码器**(纯函数 + 黄金用例,小 PNG fixture)。
4. **转写集成图片**(半块先行,所有终端立即可见;含重复块修复;index/render 测试)。
5. **term.js 图形槽位 + kitty/iTerm2/sixel 发射**(caps 门控;单测负载格式与槽位差分)。
6. **markdown.js 重写**(markdown-it + highlight.js + 表格/嵌套/任务列表/链接)(+ smoke 用例)。
7. **mermaid.js provider 链**(注入 fetch 单测 + 缓存测试)。
8. **UI 美化**:圆角、气泡布局、主题刷新、间距。
9. **设置 + 文档**(README 功能矩阵/SSH 说明、用户手册、Layout)+ 全量 `npm test`/`npm check` + `npm pack` 装入 tui profile 真机冒烟(Windows Terminal sixel 本机验证;其余终端矩阵写入文档)。

## 风险与对策
- SSH 慢链路 sixel 行移动重发 → 负载缓存 + 滚动已 40ms 合并;kitty 引用放置无此成本。
- 老版 Windows Terminal(<1.22)DA1 不报 sixel → 自动落半块。
- sharp 原生包经 pnpm 进 profile → 0.34+ 平台预编译 optionalDependencies 三平台即装即用,第 9 步真机验证。
- 探测窗口(~400ms)内用户按键 → 应答与按键按序列形态独立解码,互不干扰。
- 包体积 +约 40MB(sharp)→ 用户已确认接受。

## 交付后效果
- Windows Terminal / iTerm2 / WezTerm / kitty / Ghostty / mintty / foot:消息里的图片与 mermaid 图**以真实像素渲染**(协议自动选优),SSH 下同样工作。
- GNOME Terminal / 旧 xterm:半块真彩预览(可关)。
- Markdown:表格、嵌套/任务列表、语法高亮代码、可点击链接。
- 全 UI 圆角气泡风、DeepSeek 蓝主题精修。