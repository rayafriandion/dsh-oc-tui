# dsh-oc-tui 现代化实施计划(真实图像 / 完整 Markdown / Mermaid / 现代视觉)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息中的图片以真实像素渲染(kitty/iTerm2/sixel/半块自动选优,穿透 SSH),Markdown 升级为 markdown-it + highlight.js 完整渲染,```mermaid 围栏渲染为真实图表,全 UI 圆角气泡化。

**Architecture:** 新增 `lib/caps.js`(终端能力探测)、`lib/image.js`(图像管线与四种编码器)、`lib/mermaid.js`(provider 链);重写 `lib/markdown.js`(markdown-it 驱动,对外 API 不变);`term.js` 增加终端应答解码、cell `link`、图像槽位发射;`ui.js` 气泡/圆角/主题/图像行;`index.js` 探测接线、事件图片提取、重复块修复、设置。

**Tech Stack:** Node ≥22 ESM、sharp、markdown-it、highlight.js;零外部二进制。

**Spec:** `docs/superpowers/specs/2026-09-27-graphics-modern-ui-design.md`

## Global Constraints

- 每个渲染行必须恰好 `cols` 列、无残留(tests/render.test.mjs 强制);图像占位行也必须满足。
- 转写行对象契约:`{ segs: [{ text, style, anim?, link? }], thinking?, note?, image? }`;特殊行 `{ mermaid }` / `{ image }` 只允许出现在 `renderMarkdown` 返回值,由 ui.js 消化,不得漏到 `_blockLines` 输出。
- cell 内字符禁止控制字符(term.js:70 sanitizer 不变);OSC 8 只在 `paint()` 发射,URL 白名单 `^(https?|file):`。
- 现有导出 API 不破坏:`renderMarkdown(text, theme, width)`、`decodeKey(input)`、`Screen`、`Terminal.paint(screen)` 签名不变,只扩展。
- 新依赖仅:`sharp`、`markdown-it`、`highlight.js`(dependencies)。engines 不变 Node ^22.19 || >=24。
- 提交信息用英文,遵循仓库现有 conventional 风格(`feat(tui): ...`)。

---

### Task 1: 依赖安装

**Files:** Modify: `package.json`

- [x] `npm install sharp markdown-it highlight.js`(Windows 本机安装验证预编译包落地)
- [x] `npm ls sharp markdown-it highlight.js` 确认;`node -e "import('sharp').then(m=>console.log('sharp ok', !!m.default))"` 确认可导入
- [x] Commit: `chore(pkg): add sharp, markdown-it, highlight.js for graphics rendering`

### Task 2: 终端应答解码(term.js)+ 能力探测(caps.js)

**Files:**
- Modify: `lib/term.js`(`decodeKey`)
- Create: `lib/caps.js`
- Test: `tests/graphics.test.mjs`(新建,与 Task 3 共用)

**Interfaces:**
- Produces: `decodeKey` 新事件 `{ name: 'terminal-reply', reply: { kind: 'da1'|'apc'|'dcs'|'windowops'|'unknown', body: string } }`
- Produces: `caps.js` → `probeCapabilities(term, { timeoutMs=600 }) → Promise<{ kitty, iterm2, sixel, cellW, cellH, name, resolved }>`;`parseDA1(body)→{sixel}`、`parseCellSize(body)→{w,h}|null` 供单测。

- [x] **Step 1: 写失败测试**(tests/graphics.test.mjs)

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeKey } from '../lib/term.js'
import { parseDA1, parseCellSize } from '../lib/caps.js'

test('decodeKey: DA1 reply with sixel becomes terminal-reply', () => {
  const r = decodeKey(Buffer.from('\x1b[?62;4;6;9;15;22c', 'latin1'))
  assert.equal(r.key.name, 'terminal-reply')
  assert.equal(r.key.reply.kind, 'da1')
  assert.equal(r.key.reply.body, '?62;4;6;9;15;22')
})
test('decodeKey: kitty APC reply', () => {
  const r = decodeKey(Buffer.from('\x1b_Gi=31;OK\x1b\\', 'latin1'))
  assert.equal(r.key.name, 'terminal-reply')
  assert.equal(r.key.reply.kind, 'apc')
  assert.equal(r.key.reply.body, 'i=31;OK')
})
test('decodeKey: XTVERSION DCS reply', () => {
  const r = decodeKey(Buffer.from('\x1bP>|iTerm2 3.5.11\x1b\\', 'latin1'))
  assert.equal(r.key.reply.kind, 'dcs')
  assert.equal(r.key.reply.body, '>|iTerm2 3.5.11')
})
test('decodeKey: cell-size windowops reply', () => {
  const r = decodeKey(Buffer.from('\x1b[8;16;8t', 'latin1'))
  assert.equal(r.key.reply.kind, 'windowops')
  assert.equal(r.key.reply.body, '8;16;8')
})
test('decodeKey: partial CSI waits for more bytes', () => {
  assert.equal(decodeKey(Buffer.from('\x1b[?62;', 'latin1')), null)
})
test('decodeKey: CPR reply swallowed, never a printable key', () => {
  const r = decodeKey(Buffer.from('\x1b[24;80R', 'latin1'))
  assert.equal(r.key.name, 'terminal-reply')
  assert.equal(r.key.reply.kind, 'unknown')
})
test('parseDA1: sixel flag detection', () => {
  assert.equal(parseDA1('?62;4;6').sixel, true)
  assert.equal(parseDA1('?62;1;2').sixel, false)
})
test('parseCellSize: CSI 8;h;w t', () => {
  assert.deepEqual(parseCellSize('8;16;8'), { h: 16, w: 8 })
  assert.equal(parseCellSize('22;0'), null)
})
```

- [x] **Step 2: 运行确认失败** — `node --test tests/graphics.test.mjs` → FAIL(caps.js 不存在)
- [x] **Step 3: 实现 decodeKey 分支**(term.js)

关键插入点与顺序:
1. 在 bracketed-paste 分支**之前**、mouse 分支之后,加 DCS/APC 完整匹配(带 ST/BEL 终止才算完整,否则 return null):
```js
// Terminal replies: DCS (XTVERSION), APC (kitty graphics), OSC (generic),
// and CSI report forms (DA1, XTWINOPS). All must be consumed as reply events
// or they leak into the composer as garbage keys.
const dcs = /^\x1b(P|\|)([^]*?)(?:\x1b\\|\x07)/.exec(s) // \x1bP ... ST/BEL
if (dcs) return { key: { name: 'terminal-reply', reply: { kind: 'dcs', body: dcs[2] } }, consumed: dcs[0].length }
```
注意:`\x1bP` 后面 `>` 与 `|` 已被 `(P|\|)` 错开——正确写法:`/^\x1bP([^]*?)(?:\x1b\\|\x07)/`,body 含 `>|iTerm2 3.5.11`。
2. APC:`/^\x1b_([^]*?)(?:\x1b\\|\x07)/` → kind `'apc'`。
3. OSC 通用:在现有 `]52;` 分支之后,`/^\x1b\](\d+);([^]*?)(?:\x1b\\|\x07)/` → kind `'osc'`(现仅吞掉;后备剪贴板走 52 专支)。
4. CSI 应答:把现有通用 CSI 正则 `/^\x1b\[([0-9;]*)([A-Za-z~])/` 之前加应答形:`/^\x1b\[([0-9;?]*)([crt])/` — `c` → kind `'da1'`;`t` 且参数以 `8;` 开头 → `'windowops'`,其他 `t` → `'unknown'`;`r` → `'unknown'`。**并在 CSI 通用正则前加部分序列守卫**:`if (/^\x1b\[[0-9;?<>=]*$/.test(s)) return null`(无 final 字节,等更多输入)。
5. `c`/`t` 应答正则必须放在按键 CSI 正则**之前**,且参数含 `?`(如 `?62;4…c`)只能被应答正则吃掉。

- [x] **Step 4: 实现 lib/caps.js**

```js
// Terminal capability probing. All probes are escape sequences the *client*
// terminal answers, so detection works unchanged over SSH where environment
// variables do not propagate. Zero protocol is a valid outcome: the caller
// falls back to ANSI halfblock rendering, which needs no terminal support.
export function parseDA1(body) {
  const params = body.replace(/^\?/, '').split(';').map(Number)
  return { sixel: params.includes(4) }
}
export function parseCellSize(body) {
  const m = /^8;(\d+);(\d+)$/.exec(body)
  if (!m) return null
  const h = Number(m[1]); const w = Number(m[2])
  if (!h || !w) return null
  return { h, w }
}
const DEFAULT_CELL = { w: 8, h: 16 }
export async function probeCapabilities(term, { timeoutMs = 600 } = {}) {
  const caps = { kitty: false, iterm2: false, sixel: false, cellW: DEFAULT_CELL.w, cellH: DEFAULT_CELL.h, name: '', resolved: false }
  const onKey = (key) => {
    if (key?.name !== 'terminal-reply') return
    const { kind, body } = key.reply
    if (kind === 'da1') caps.sixel = parseDA1(body).sixel
    else if (kind === 'apc' && body.startsWith('i=31')) caps.kitty = true
    else if (kind === 'dcs' && body.startsWith('>|')) caps.name = body.slice(2)
    else if (kind === 'windowops') { const c = parseCellSize(body); if (c) { caps.cellW = c.w; caps.cellH = c.h } }
  }
  term.on('key', onKey)
  term.write('\x1b[c')                                  // DA1: attributes (sixel = "4")
  term.write('\x1b[>0q')                                // XTVERSION: name/version
  term.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\') // kitty graphics query
  term.write('\x1b[16t')                                // cell size in pixels
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  term.off('key', onKey)
  if (caps.name.includes('kitty') || /ghostty|wezterm/i.test(caps.name)) caps.kitty = true
  if (/wezterm/i.test(caps.name)) caps.iterm2 = true    // WezTerm implements OSC 1337
  caps.resolved = true
  return caps
}
```

- [x] **Step 5: 测试通过** — `node --test tests/graphics.test.mjs` 全绿;`npm run check` 通过
- [x] **Step 6: Commit** `feat(tui): terminal capability probing with reply-safe key decoding`

### Task 3: 图像管线与四种编码器(lib/image.js)

**Files:** Create: `lib/image.js`; Test: `tests/graphics.test.mjs`(追加)

**Interfaces:**
- Produces:
  - `scaleToCells(pxW, pxH, maxCellsW, maxCellsH, cellW, cellH) → { cellsW, cellsH }`(只缩不放;maxCells 封顶)
  - `renderHalfblock(rgba, pxW, pxH, cellsW, cellsH) → segLines`(数组,每行 = `{ text, style: { fg, bg } }[]`,保证每段宽度恰为 cellsW 列,宽字符问题不存在:▀/空格均为宽 1)
  - `encodeSixel(rgba, pxW, pxH) → string`(DCS 到 ST 的完整序列;median-cut 256 色)
  - `encodeKittyTransmission(hash, pngBase64) → string`(分块 4096,`m=1/0`)
  - `kittyPlacement(id, x, y)` / `kittyDelete(id | 'all')` / `encodeITerm2(pngBase64, pxW, pxH)` 字符串函数
  - `renderImage({ bytes, mediaType }, { protocol, maxCellsW, maxCellsH, cellW, cellH, bgHex, sharp }) → Promise<{ protocol, cellsW, cellsH, payload? , segLines?, hash }>`(sharp 不可用或解码失败 → `{ protocol: 'error', error }`)
  - `LRU` 简单实现 `class PayloadCache { get(k) set(k,v) }`(上限 32 条)

- [x] **Step 1: 失败测试**(追加)

```js
import { scaleToCells, renderHalfblock, encodeSixel, encodeKittyTransmission, encodeITerm2 } from '../lib/image.js'
test('scaleToCells: downscale only, capped', () => {
  assert.deepEqual(scaleToCells(800, 600, 60, 20, 8, 16), { cellsW: 60, cellsH: 19 })
  assert.deepEqual(scaleToCells(80, 40, 60, 20, 8, 16), { cellsW: 10, cellsH: 5 })
  assert.deepEqual(scaleToCells(2000, 50, 60, 20, 8, 16), { cellsW: 60, cellsH: 3 })
})
test('renderHalfblock: 2x2 px cell, uniform pixel -> space, split -> half block', () => {
  // 1 cell = 2x2 px: top-left white, top-right black, bottom both black
  const rgba = Buffer.from([
    255,255,255,255,   0,0,0,255,
    0,0,0,255,         0,0,0,255,
  ])
  const lines = renderHalfblock(rgba, 2, 2, 1, 1, () => null)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].length, 1)
  assert.equal(lines[0][0].text, '\u2580') // ▀
  assert.deepEqual(lines[0][0].style.fg, 'ffffff')
  assert.deepEqual(lines[0][0].style.bg, '000000')
})
test('renderHalfblock: uniform color collapses to a plain space', () => {
  const rgba = Buffer.alloc(2*2*4, 255) // all white
  const lines = renderHalfblock(rgba, 2, 2, 1, 1, () => null)
  assert.equal(lines[0][0].text, ' ')
})
test('encodeSixel: header and terminator', () => {
  const s = encodeSixel(Buffer.from([255,0,0,255, 0,0,255,255]), 2, 1, { paletteSize: 256 })
  assert.ok(s.startsWith('\x1bP0;1;0q'))
  assert.ok(s.endsWith('\x1b\\'))
  assert.ok(s.includes('#0'))   // palette entry
})
test('kitty chunked transmission', () => {
  const b64 = 'A'.repeat(5000)
  const s = encodeKittyTransmission(7, b64)
  assert.ok(s.startsWith('\x1b_Ga=T,f=100,q=2,i=7,m=1;'))
  assert.ok(s.includes('\x1b_Gm=0;'))
  assert.ok(s.endsWith('\x1b\\'))
})
test('encodeITerm2 shape', () => {
  const s = encodeITerm2('QUJD', 64, 32)
  assert.equal(s, '\x1b]1337;File=inline=1;size=4;width=64px;height=32px:name=x.png:QUJD\x07')
})
```

- [x] **Step 2: 确认失败** `node --test tests/graphics.test.mjs`
- [x] **Step 3: 实现 lib/image.js** — 算法要点(完整实现写入文件):
  - `scaleToCells`: `cells = ceil` 保比缩放 `min(pxW/cellW, maxCellsW)` 与高度同取小者;均不放大(px<1 cell → 至少 1 格)。
  - `renderHalfblock(rgba, pxW, pxH, cellsW, cellsH, themeBg)`:先把 RGB 转 hex(无 alpha 合成:与 bgHex 按 alpha 混合);每 cell 取像素 (2x,2y) 与 (2x,2y+1);相同→`{ text:' ', style:{bg} }`,不同→`{ text:'▀', style:{fg:上,bg:下} }`。**每行段合并相邻同 style**。rgba 行 stride = pxW*4。奇数像素宽取 floor,右侧溢出像素按 bg。
  - `encodeSixel`:median-cut(实现 ≤80 行:RGB 桶递归按最大通道中位切分至 256 桶,桶均值成调色板)→ sixel:调色板 `#i;2;r;g;b`(0-100 标度),按 6 行带(`?`(二进制或)编码,列游程);头 `\x1bP0;1;0q`,尾 `\x1b\\`;`-` 换行带。dithering: v1 不做(YAGNI,半块真彩已覆盖观感)。
  - `encodeKittyTransmission(id, b64)`:每 4096 字符一块,除最后一块外 `m=1`:`\x1b_Ga=T,f=100,q=2,i=<id>,m=1;<chunk>\x1b\\` … 最后 `\x1b_Ga=T,m=0;<last>\x1b\\`(注:kitty 协议 m 标志在继续块中,最后块 m=0 可省略载荷重复——按规范用同 a/f 参数组)。
  - `kittyPlacement(id, x, y) → '\x1b_Ga=p,i=<id>,H=<x+1>,Y=<y+1>,q=2\x1b\\'`;`kittyDelete(id) → '\x1b_Ga=d,d=i,i=<id>,q=2\x1b\\'`;all → `d=a`。
  - `encodeITerm2(b64, pxW, pxH) → '\x1b]1337;File=inline=1;size=<len>;width=<pxW>px;height=<pxH>px:name=x.png:<b64>\x07'`。
  - `renderImage`:sharp pipeline — `sharp(bytes, { animated:false }).metadata()` → scaleToCells → `.resize(pxW, pxH, { fit:'fill' })` 其中 pxW=cellsW*cellW, pxH=cellsH*cellH → `.ensureAlpha()` → `.raw().toBuffer({ resolveWithObject: true })` 得 rgba;protocol 分支:
    - `halfblock` → renderHalfblock
    - `sixel` → 先 `.png()` 拿 PNG base64(供缓存共享)再 rgba → encodeSixel
    - `kitty` → `.png().toBuffer()` → base64 → payload 传字符串(放置由 term.js 做)
    - `iterm2` → PNG base64 + 原始像素宽高(用 pxW/pxH 即目标格像素,保持清晰度用 metadata 原始宽高比限宽)
  - `hash = sha1(bytes).slice(0,16)`;PayloadCache LRU 32。
- [x] **Step 4: 测试通过 + `npm run check`**
- [x] **Step 5: Commit** `feat(tui): image pipeline with halfblock, sixel, kitty, iTerm2 encoders`

### Task 4: term.js 图像槽位与发射

**Files:** Modify: `lib/term.js`(`Screen.setImageRow`、`Terminal.paint`、start/stop);Test: `tests/graphics.test.mjs`(追加,不发真实终端,只断言字符串)

**Interfaces:**
- `screen.setImageRow(y, { key, x, cellsW, cellsH, top })` — top 行标注完整信息,其余行仅 `{ key }`(占位识别)。
- `paint(screen)` 新逻辑(文本 diff 之后、光标停靠之前):
  - 收集 screen 中 top 行标注 → `want` 列表;`this._prevImages` 为上一帧列表。
  - `caps.kitty`(paint 时以 `this.caps` 注入,默认 null → 跳过协议发射):
    - 新 key → 发 `encodeKittyTransmission`(payload 从 `this._imagePayloads` 取,由 App 侧预填;无 payload 则跳过该图)
    - 位置变化 → 发 `kittyPlacement`;消失 → `kittyDelete`(id 表 `Map<key,id>` 计数器分配)
  - `sixel`/`iterm2`:top 行位置或 key 变化 → `\x1b[<y+1>;<x+1>H` + payload(缓存于 `this._imagePayloads`)
  - resize/start/stop → kitty `d=a` + 清空注册表(payload 缓存保留)
- `sameStyle` 增加 `link` 字段比较;paint 行发射时对连续相同 `cell.style.link` run 包 OSC 8(`\x1b]8;;URL\x07` … `\x1b]8;;\x07`),URL 过 `safeLink()`(白名单 + 去控制字符)。

- [x] **Step 1: 失败测试**(追加)

```js
import { Screen, Terminal } from '../lib/term.js'
import { kittyPlacement, kittyDelete } from '../lib/image.js'
test('Screen.setImageRow annotates top rows', () => {
  const s = new Screen(10, 6)
  s.setImageRow(2, { key: 'abc', x: 1, cellsW: 4, cellsH: 3, top: true })
  assert.equal(s.images.length, 1)
  assert.equal(s.images[0].y, 2)
})
test('Terminal.paint kitty mode emits placement once and moves it', () => {
  const t = new Terminal({ output: { write() {}, columns: 80, rows: 24 } })
  t.caps = { kitty: true, sixel: false, iterm2: false, cellW: 8, cellH: 16 }
  t._imagePayloads.set('abc', { kind: 'kitty', id: 7 })
  const s = new Screen(80, 24)
  s.setImageRow(3, { key: 'abc', x: 2, cellsW: 10, cellsH: 5, top: true })
  let out = ''
  t.output = { write(s2) { out += s2 } }
  t.paint(s)
  assert.ok(out.includes(kittyPlacement(7, 2, 3)))
  out = ''
  s.setImageRow(5, { key: 'abc', x: 2, cellsW: 10, cellsH: 5, top: true })
  t.paint(s)
  assert.ok(out.includes(kittyPlacement(7, 2, 5)))
  assert.ok(!out.includes('a=T,'))  // 不重传
})
test('safeLink rejects javascript: URLs', () => {
  // safeLink exported from term.js
  assert.equal(safeLink('javascript:alert(1)'), null)
  assert.equal(safeLink('https://x.example/a(b)'), 'https://x.example/a%28b%29')
})
```

- [x] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过 + `npm run check` + `npm test`(既有 render.test.mjs 行宽/无残留不变量必须仍全绿)**
- [x] **Step 5: Commit** `feat(tui): image slab emission in the paint pipeline + OSC 8 links`

### Task 5: 转写集成图片(ui.js + index.js,半块先行)

**Files:**
- Modify: `lib/ui.js`(App:imageCache、`addUser` images 字段、`_blockLines` user/assistant/tool 图像行)
- Modify: `lib/index.js`(事件/replay 提取 images、resolve 管线、重复块修复)
- Modify: `lib/util.js`(`contentImages(content) → [{ kind:'ref', ref } | { kind:'bytes', data, mediaType }]`)
- Test: `tests/smoke.test.mjs`(contentImages)、`tests/graphics.test.mjs`(App 图像行)、`tests/render.test.mjs`(图像占位行行宽不变量)

**Interfaces:**
- `App.addUser(text, { steering, images })`;user/assistant/tool block 可带 `images: ImageSource[]`(ImageSource = `{ key?, kind:'ref'|'bytes'|'url', ref?|data?|url? }`)。
- `app.setImageResolver(fn)` — fn(source) → Promise<{ bytes, mediaType }> 由 index.js 提供。
- `app._imageResults: Map<key, { state:'loading'|'done'|'error', render? }>`;`_blockLines` 对每图:loading → 2 行占位(`⏳ rendering image…`);done → 按 `render.segLines`(半块)输出 N 行 `{ segs }`,或按 cellsH 输出 `{ image: { key, x:2, cellsW, cellsH, top:i===0 } }` 行(协议模式);error → 1 行 `⚠ image render failed`。
- App 构造新参 `{ onImageResult?: () => void }` 或复用现有 paintSoon 注入点(index.js 已持有 app,直接在 resolve 后 `app.bumpBlockImages(block)` + paintSoon)。
- 重复块修复(index.js:537-553):live 路径 `lastUserText` 保存**标记剥离后**文本(`text.replace(/\[Image \d+\]/g,'').trim()`),事件路径同样剥离后比较;匹配且 8s 内 → 跳过 add,不重复注入 images。

- [x] **Step 1: 失败测试**

```js
// smoke: contentImages
import { contentImages } from '../lib/util.js'
test('contentImages extracts image content blocks', () => {
  const content = [
    { type: 'text', text: '看这张图' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
  ]
  const imgs = contentImages(content)
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].kind, 'ref')
  assert.equal(imgs[0].ref.attachmentId, 'sha256:abc')
  assert.equal(contentImages([{ type: 'text', text: 'x' }]).length, 0)
})
```

```js
// graphics.test.mjs: App image lines (halfblock path, no terminal)
import { App, THEME } from '../lib/ui.js'
test('user block renders halfblock image lines when result cached', async () => {
  const app = new App({ cols: 80, rows: 24 })
  const fakeLines = [[{ text: '▀', style: { fg: 'ffffff', bg: '000000' } }]]
  app.addUser('看图', { images: [{ key: 'k1', kind: 'bytes' }] })
  app._imageResults.set('k1', { state: 'done', render: { protocol: 'halfblock', segLines: fakeLines, cellsW: 1, cellsH: 1 } })
  const block = app.blocks[0]
  const lines = app._blockLines(block, 76)
  assert.ok(lines.some((l) => l.segs?.[0]?.text === '▀'))
})
```

render.test.mjs 追加:带 loading 图像占位的帧也满足「每行恰 cols 列、无残留」(复用现有 emulate 循环,加一个含 images 的 addUser 用例)。

- [x] **Step 2: 确认失败 → Step 3: 实现**
  - ui.js `case 'user'` / `'assistant'`:文本行后追加图像行(图在前文后?定:文后图前 → 图紧随文本);`case 'tool'`:结果行后追加(不受 6 行文本上限约束)。
  - index.js:`handleSessionEvent` user/message 与 replay user/message、assistant/message、tool/result 都提取 `contentImages`;submit() 把 `app.inputImages` 中已有 bytes 传给 `addUser`(optimistic);`setImageResolver` 用 `attachments.readImage(ref)`;管线 caps 未就绪时 protocol 强制 'halfblock'。
- [x] **Step 4: 全测试通过(`npm test`)**
- [x] **Step 5: Commit** `feat(tui): render transcript images (halfblock path) + paste dedup fix`

### Task 6: markdown.js 重写

**Files:** Rewrite: `lib/markdown.js`;Test: `tests/graphics.test.mjs`(追加)

**Interfaces:**
- `renderMarkdown(text, theme, width) → Line[]`,Line = segs 数组 或 `{ mermaid: code }` 或 `{ image: { url, alt } }`;segs 可带 `link: url`。
- 保留导出:`wrapSegments`、`inlineSegments`(内部仍用;签名不变)。
- THEME 新增 key(在 ui.js THEME 同步):`syntaxKeyword/syntaxString/syntaxNumber/syntaxComment/syntaxFunction/syntaxType`、`bubbleUser/bubbleUserBorder/bubbleAssistant/bubbleAssistantBorder`、`tableBorder`。

- [x] **Step 1: 失败测试**

```js
import { renderMarkdown } from '../lib/markdown.js'
const T = { text:'fff', textMuted:'888', primary:'4d6bfe', codeBg:'1b2740', markdownCode:'7fd88f',
  markdownHeading:'7c9cff', markdownLinkText:'6c9cff', markdownListItem:'4d6bfe',
  markdownBlockQuote:'9fb0d8', markdownHorizontalRule:'46547a', markdownCodeBlock:'f0f4ff',
  syntaxKeyword:'c678dd', syntaxString:'98c379', syntaxNumber:'d19a66', syntaxComment:'7f848e',
  syntaxFunction:'61afef', syntaxType:'e5c07b', tableBorder:'3d4d73', background:'0a0e18' }
test('markdown: GFM table renders bordered rows', () => {
  const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  const lines = renderMarkdown(md, T, 40)
  const text = lines.map((l) => l.map?.((s) => s.text).join('') ?? '').join('\n')
  assert.ok(text.includes('│'), 'vertical border')
  assert.ok(text.includes('a'), 'header cell')
  assert.ok(text.includes('2'), 'body cell')
})
test('markdown: nested list indents', () => {
  const md = '- one\n  - one.a\n- two'
  const lines = renderMarkdown(md, T, 40)
  const text = lines.map((l) => l.map((s) => s.text).join(''))
  assert.ok(text.some((t) => t.startsWith('    ') && t.includes('one.a')))
})
test('markdown: task list glyphs', () => {
  const md = '- [x] done\n- [ ] todo'
  const text = renderMarkdown(md, T, 40).map((l) => l.map((s) => s.text).join('')).join('\n')
  assert.ok(text.includes('☑ done'))
  assert.ok(text.includes('□ todo'))
})
test('markdown: mermaid fence becomes special line', () => {
  const lines = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```', T, 40)
  assert.ok(lines.some((l) => l && l.mermaid === 'graph TD\nA-->B'))
})
test('markdown: image syntax becomes image line', () => {
  const lines = renderMarkdown('![logo](https://x/y.png)', T, 40)
  assert.deepEqual(lines[0], { image: { url: 'https://x/y.png', alt: 'logo' } })
})
test('markdown: link keeps url on seg', () => {
  const lines = renderMarkdown('[site](https://x.example)', T, 40)
  const seg = lines[0].find((s) => s.text === 'site')
  assert.equal(seg.link, 'https://x.example')
})
test('markdown: js code gets keyword color segments', () => {
  const lines = renderMarkdown('```js\nconst a = 1\n```', T, 40)
  const flat = lines.flat().filter(Boolean)
  assert.ok(flat.some((s) => s.style?.fg === T.syntaxKeyword && s.text.includes('const')))
})
```

- [x] **Step 2: 确认失败 → Step 3: 重写实现**
  - 结构:`import MarkdownIt from 'markdown-it'`,`const md = new MarkdownIt({ html: false, linkify: true })`;`highlight.js` → `hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }) : null`;token class→theme 映射表(属性选择器如 `hljs-keyword` → syntaxKeyword)。
  - 遍历 `md.parse(text, {})` token 流,维护 `listDepth` 栈与 `quoteDepth`,生成行;fence:lang==='mermaid' → `{ mermaid: content }`(trim 尾换行);image token(`token.type==='image'`)→ `{ image: { url: token.attrs.get('src'), alt: token.children?.[0]?.content ?? '' } }`(url 仅 http/https/data:image 放行,本地 file:// 不进管线 → 落为 alt 文本)。
  - 表格:`thead/tbody` token 收集单元格 → 列宽 = min(max 内容宽, floor((width-边)/n)) → 渲染 `╭─┬─╮ / │ a │ b │ / ├─┼─┤ / ╰─┴─╯`;单元格内容过 inline 渲染;超宽省略 `…`。
  - 任务列表:list_item 内 paragraph 以 `[ ] `/`[x] ` 开头 → 前缀 `□ `/`☑ `。
  - 行内:复用 inlineSegments 增强 link 捕获(markdown-it `inline` token 的 children 里 link_open → 其 child 文本段带 `link`)。
  - 段落合并语义保留(现状:软换行并段)。
- [x] **Step 4: 全测试通过(既有 smoke markdown 断言 "Hello world"/"- one"/"▍ quote" 必须仍过 — quote 前缀保持 `▍ `)**
- [x] **Step 5: Commit** `feat(tui): markdown-it renderer with tables, nested/task lists, hljs, links`

### Task 7: mermaid provider 链

**Files:** Create: `lib/mermaid.js`;Test: `tests/graphics.test.mjs`(追加)

**Interfaces:**
- `createMermaidRenderer({ fetch: impl = globalThis.fetch, sharp, tmpDir = os.tmpdir()+'/dsh-oc-tui', clock } ) → render(code, { pxWidth }) → Promise<{ bytes, mediaType } | null>`(null = 全部 provider 失败 → 调用方回退高亮代码块)。
- provider 顺序由 `mode`:'auto' = local→network;'local' 仅 local;'off' 不渲染。
- local:`mmdc --version`(spawn 5s 超时,结果缓存)→ 临时 `.mdd`/`.svg` → sharp(density 按 pxWidth)→ PNG bytes;失败清临时文件。
- network:`https://mermaid.ink/img/<base64url(code)>?type=png` → 10s 超时 → 缓存文件 `<sha1(code)>.png` 命中直接读。

- [x] **Step 1: 失败测试**(注入 fetch,不真联网)

```js
import { createMermaidRenderer } from '../lib/mermaid.js'
test('mermaid: network provider fetches and caches', async () => {
  const calls = []
  const fakeFetch = async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNGDATA').buffer } }
  const r = createMermaidRenderer({ fetch: fakeFetch, sharp: null, mode: 'network', tmpDir: undefined })
  const a = await r('graph TD; A-->B', {})
  assert.ok(a && Buffer.from(a.bytes).toString().startsWith('PNG'))
  const b = await r('graph TD; A-->B', {})
  assert.equal(calls.length, 1, 'second call hits cache')  // tmpDir=undefined → 内存缓存
})
test('mermaid: mode off returns null without network', async () => {
  const r = createMermaidRenderer({ fetch: async () => { throw new Error('no') }, mode: 'off' })
  assert.equal(await r('graph TD', {}), null)
})
```

- [x] **Step 2-4: 实现/通过**(`mmdc 检测`用 `spawn('mmdc', ['--version'])` error 事件判定;测试不依赖 mmdc)
- [x] **Step 5: Commit** `feat(tui): mermaid provider chain (mmdc → mermaid.ink → fallback)`

### Task 8: UI 美化(圆角 / 气泡 / 主题 / 图像+mermaid 行消费)

**Files:** Modify: `lib/ui.js`(主要:THEME、`_blockLines` user/assistant 气泡、所有盒线角、`_ensureBlockLines` mermaid/image 行消费);Modify: `lib/index.js`(mermaid 调用点)

**Interfaces:**
- 气泡渲染 helper:`bubbleLines(headerSegs, bodyLines, width, colors, { openBottom }) → Line[]`(圆角框、标题嵌上边框、body 行左右各 1 空格 pad;openBottom=true 时底边换成 `╰…` 之前的开放态:最后一行后画 `╰` 仅左角+空右——实现:底边行画 `╰` + 流式光标行不封右)。
- user 气泡:border = `bubbleUserBorder`(primary 调暗),头部 ` you · time`;assistant 气泡:border = `bubbleAssistantBorder`,头部 ` dsh · time`;thinking box 与 note/todo 卡片仅圆角化(结构性不动)。
- `{ mermaid }` 行:`app._imageResults` 旁路 `_mermaidResults: Map<codeHash, render>`;render 成功 → 走图像行(协议渲染);失败/`off` → 高亮代码块(`hljs` lang=mermaid)。
- `{ image }` 行:转 ImageSource(kind:'url')走 `_imageResults`。

- [x] **Step 1: 失败测试**(render.test.mjs 追加:user/assistant 气泡在窄宽(20 列)与宽字符(CJK)下帧不变量:每行恰 cols 列、无残留;气泡边框完整)
- [x] **Step 2: 实现** — 圆角字符映射表 `ROUNDED = { '┌':'╭', '┐':'╮', '└':'╰', '┘':'╯' }` 应用到所有边框绘制点(composer frame、help/settings/rewind/questions/stats 覆盖层、thinking/note/todo 盒若有角、气泡)。
- [x] **Step 3: 全测试通过(`npm test`)+ `npm run check`**
- [x] **Step 4: Commit** `feat(tui): rounded chat-bubble layout, refreshed theme, mermaid/image line consumption`

### Task 9: 设置 + 文档 + 全量验证

**Files:** Modify: `lib/web-settings.js`(或 tui-graphics 注册点)、`lib/index.js`(Graphics 分组菜单项)、`README.md`、`docs/用户手册.md`;`package.json`(check 脚本追加 graphics.test.mjs?— 测试统一 `npm test` 串接)

- [x] `settings.register('tui-graphics', schema)`(graphics choice auto/off;imageFallback choice halfblock/chip;imageMaxRows number 4..40 默认 20;mermaid choice auto/local/off);Settings → Main 增加分组行(graphics、imageFallback、mermaid、imageMaxRows 四项,choice 走现有 choice 机制)。注册位置:沿用 `tui-updates` 的注册处(实施时 grep `register\(` 定位)。
- [x] README:Features 表加 4 行(Real image rendering / Mermaid / Full markdown / Modern UI);Requirements 提示图形协议矩阵与 SSH 说明;Known limitations 更新(IME 不变,GIF 首帧、sextant 未做);Layout 加 caps.js/image.js/mermaid.js。
- [x] 用户手册:第 9 节已知限制更新 + 新「图形渲染」小节(协议矩阵、设置项、mermaid 隐私说明)。
- [x] `npm test && npm run check` 全绿;`npm pack` → `dsh plugin --profile tui remove -w dsh-oc-tui` → 删旧 tgz → 重 pack → add(README Development 流程);启动真机冒烟:粘贴一张本地图片路径看半块渲染;Windows Terminal 下确认 DA1 探测(sixel 路径在 WT 1.22+ 自动启用);发一条含 ```mermaid 的消息看渲染。
- [x] Commit: `docs(tui): graphics rendering matrix, settings, and manual` + `chore(pkg): release 0.2.0`(版本号按 feature 体量定为 0.2.0,可再议)

## Self-Review 结论

- 覆盖检查:spec 每节均有对应 Task(探测→T2、管线→T3、槽位→T4、集成→T5、markdown→T6、mermaid→T7、UI→T8、设置文档→T9)。
- 类型一致性:`renderImage` 返回 `{ protocol, payload?, segLines?, cellsW, cellsH, hash }` 在 T3 定义、T4/T5/T8 消费一致;`ImageSource` 形状在 T5 定义,`{ mermaid }`/`{ image }` 特殊行在 T6 产出、T8 消费一致。
- 无占位符;算法(半块/sixel/kitty 分块/探测)均给出可执行代码或精确规范。
