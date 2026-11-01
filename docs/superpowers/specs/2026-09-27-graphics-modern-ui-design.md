# dsh-oc-tui 现代化:真实图像 / 完整 Markdown / Mermaid / 现代视觉 — 设计文档

日期:2026-09-27 · 状态:已批准(用户确认四个关键决策)· 分支:feature/chafa+

## 目标

1. 消息中的图片以**真实像素**渲染(不再只显示 `[Image N]` 文本),支持 Windows / macOS / Linux 及 SSH 下的终端。
2. Markdown 升级为完整渲染:表格、嵌套列表、任务列表、语法高亮、可点击链接。
3. ```mermaid 围栏渲染为真实图表(不再退化为纯色代码块)。
4. 现代视觉:圆角边框、聊天气泡、统一间距、主题精修。

## 用户确认的决策

1. **纯 npm 依赖**:`sharp`(解码/缩放/SVG 光栅化,全平台预编译)、`markdown-it`、`highlight.js`。协议编码器(kitty / iTerm2 OSC 1337 / sixel / ANSI 半块)自研纯 JS。不引入 chafa / mdcat 等外部二进制。
2. **Mermaid 多级 provider**:本地 mmdc(检测 PATH)→ mermaid.ink 网络 API(设置可关)→ 语法高亮代码块回退。
3. **无图形协议终端**(GNOME Terminal、旧 xterm):高质量半块预览(▀▄█ 真彩,每格 2×2 像素),设置可关回 `[Image N]` chip。v1 只用半块(所有终端字体都有字形);六分块留作后续。
4. **UI 美化全做**:圆角边框+间距、语法高亮、OSC 8 链接+表格、聊天气泡。

## 架构

### 数据流(图像)

```
粘贴字节 / 附件 ref / data URL / 本地路径 / http(s) URL
  └─▶ lib/image.js:sharp 解码 → 按格数缩放(默认 max 20 行 × 转写宽−4)
       ├─ caps: kitty   → 传输一次 PNG + a=p 引用放置(term.paint 发射,零重传)
       ├─ caps: iTerm2  → OSC 1337,行移动时按缓存负载重发
       ├─ caps: sixel   → DCS 负载,行移动时重发(median-cut 量化到 256 色)
       └─ 无协议        → 半块文本行(普通 styled segs,既有行宽不变量自动成立)
```

### 能力探测(lib/caps.js)

- 并行探测:DA1(`\x1b[c`,应答参数含 `4` → sixel)、kitty 图形查询(`\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`,任何 `\x1b_G…` 应答 → kitty graphics)、XTVERSION(`\x1b[>0q`,DCS `>|name` → 识别 iTerm2/WezTerm/mintty/ghostty)、单元格像素尺寸(`\x1b[16t`,应答 `CSI 8;h;w t`,缺省 8×16)。
- 转义序列由**客户端终端**应答,天然穿透 SSH(环境变量不跨 SSH,只作提示不作权威)。
- 优先级:kitty > iTerm2 > sixel > 半块(永远可用)。探测与首帧并行,能力就绪后重绘。
- `term.js` 的 `decodeKey` 增加通用 DCS/APC/OSC/CSI 应答分支(→ `terminal-reply` 事件),未知应答安全吞掉,绝不漏进 composer。

### 图像管线(lib/image.js)

- `renderImage(bytes, opts) → { protocol, payload? | segLines?, cellsW, cellsH }`;负载按内容哈希 LRU 缓存;异步解码队列(并发 2),未就绪显示占位,就绪后 `rev++` 重绘;GIF 取首帧。
- 半块:每格取 2×2 像素,上像素→前景色、下像素→背景色,相同则空格,不同则 `▀`;真彩直出无需抖动(空间损失在降采样处,sixel 量化才需要调色板)。
- sixel:median-cut 量化 256 色 + 可选抖动,自研 sixel 编码器。
- kitty:`a=T,f=100`(PNG 直传)按 hash 传输一次,`a=p,H,Y` 按格坐标放置,滚出/清理时 `a=d`。

### 渲染集成(lib/term.js + lib/ui.js + lib/index.js)

- `Screen` 行级图像槽位标注(图像行画背景占位 cell,行宽不变量不破坏);`paint()` 在文本 diff 后发射图形;start/stop/resize 时清理(kitty delete-all)。
- cell style 增加 `link` 字段,`paint()` 对连续 run 发射 OSC 8(scheme 白名单 http/https/file + 转义)。
- user/assistant/tool 块新增图像行;user/message 与 replay 提取 content 中的 image block;顺带修复粘贴图片重复块 bug(乐观块标记文本 vs 事件剥离文本不一致)。
- 流式/滚动重绘只重发射位置变化的图像;SSH 慢链路由缓存 + 40ms 合并兜底。

### Markdown 重写(lib/markdown.js)

- 对外 API `renderMarkdown(text, theme, width)` 不变;返回行允许特殊条目 `{ mermaid: code }` 与 `{ image: { url, alt } }`,由 ui.js 转成图像/mermaid 行。
- markdown-it token 流驱动:表格(圆角框线+列宽省略)、嵌套列表、任务列表(`[ ]`/`[x]`)、h1–h6 层级、嵌套引用;highlight.js 按语言着色(token→主题色);`[text](url)` → link segs;`![alt](url)` → `{ image }` 行(受尺寸上限约束)。

### Mermaid(lib/mermaid.js)

- provider 链由设置 `mermaid: auto|local|off` 控制:local(mmdc → SVG → sharp 按主题背景色光栅化)→ mermaid.ink(10s 超时,结果缓存 `os.tmpdir()/dsh-oc-tui/`)→ 高亮代码块回退。

### 设置与文档

- `settings.register('tui-graphics', …)`:`graphics: auto|off`、`imageFallback: halfblock|chip`、`imageMaxRows`、`mermaid: auto|local|off`;Settings UI 增加 Graphics 分组。
- README 功能矩阵 / SSH 说明 / 已知限制、用户手册、Layout 更新。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| SSH 慢链路 sixel 行移动重发 | 负载缓存 + 滚动 40ms 合并;kitty 引用放置无此成本 |
| 老 WT(<1.22)无 sixel | DA1 不报 4 → 自动落半块 |
| sharp 原生包经 pnpm 进 profile | 0.34+ 平台预编译 optionalDependencies,三平台即装即用,真机验证 |
| 探测窗口(~600ms)内用户按键 | 应答与按键按序列形态独立解码,互不干扰 |
| 包体积 +约 40MB(sharp) | 用户已确认接受 |
| GNOME Terminal 无任何协议 | 半块回退(用户已确认) |

## 实施顺序(每步可独立验证)

1. spec + 计划文档(本文 + plans/2026-09-27-graphics-modern-ui.md)
2. 依赖安装 + caps.js + decodeKey 应答分支(+单测)
3. image.js 管线核心 + 半块/sixel/kitty/iTerm2 编码器(+黄金用例)
4. 转写集成图片(半块先行,所有终端立即可见;含重复块修复)
5. term.js 图形槽位 + 协议发射(caps 门控)
6. markdown.js 重写(markdown-it + highlight.js)
7. mermaid.js provider 链
8. UI 美化:圆角、气泡布局、主题、间距
9. 设置 + 文档 + 全量测试 + npm pack 真机冒烟
