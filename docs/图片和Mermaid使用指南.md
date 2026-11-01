# 图片和 Mermaid 显示功能使用指南

## 功能状态
✅ **已验证：所有模块功能正常**

经过测试：
- 图片渲染（halfblock/sixel/iterm2/kitty）：**正常工作**
- Mermaid 渲染（通过 mermaid.ink）：**正常工作**
- 渲染管道：**已正确连接**

## 使用方法

### 1. 显示 Mermaid 图表

在对话中输入包含 mermaid 代码块的 markdown：

\`\`\`mermaid
graph TD
    A[开始] --> B[处理]
    B --> C[结束]
\`\`\`

**重要提示：**
- 必须使用 \`\`\`mermaid 标记（不是 \`\`\`diagram 或其他）
- 默认通过 mermaid.ink 网络服务渲染（需要网络连接）
- 本地 mmdc 未安装时会回退到网络模式

### 2. 显示图片

#### 方式 A：Markdown 图片语法
```markdown
![图片描述](https://example.com/image.png)
```

#### 方式 B：数据 URL
```markdown
![](data:image/png;base64,iVBORw0KG...)
```

#### 方式 C：粘贴图片（如果终端支持）
直接粘贴图片到输入框

## 图片显示协议

TUI 会自动探测终端能力并选择最佳协议：

1. **Kitty Graphics Protocol** - Kitty, Ghostty
2. **iTerm2 Inline Images** - iTerm2, WezTerm  
3. **Sixel** - Windows Terminal 1.22+, 支持 sixel 的终端
4. **ANSI Halfblock** - 所有终端的通用后备方案

## 设置

通过 `/settings` 命令可以配置：

### Graphics 设置
- `graphics`: `auto` (默认) / `off`
- `imageFallback`: `halfblock` (默认) / `chip` (纯文本标记)
- `imageMaxRows`: 图片最大高度（默认 20 行）

### Mermaid 设置
- `mermaid`: `auto` (默认) / `local` / `network` / `off`
  - `auto`: 优先本地 mmdc，回退到网络
  - `local`: 仅使用本地 mmdc（需安装）
  - `network`: 仅使用 mermaid.ink
  - `off`: 禁用渲染，显示源码

## 故障排查

### 问题 1: Mermaid 不显示

**可能原因：**
1. 语法错误 - 检查 mermaid 代码是否有效
2. 网络问题 - `auto` 或 `network` 模式需要访问 mermaid.ink
3. 设置为 `off` - 检查 `/settings` 中的 mermaid 选项

**解决方案：**
```bash
# 测试 mermaid 渲染
node tests/debug-mermaid.mjs

# 安装本地渲染器（可选）
npm install -g @mermaid-js/mermaid-cli

# 验证安装
mmdc --version
```

### 问题 2: 图片不显示

**可能原因：**
1. URL 不可访问
2. 图片格式不支持
3. Graphics 设置为 `off`
4. 终端不支持且 halfblock 被禁用

**解决方案：**
```bash
# 测试图片渲染
node tests/debug-image.mjs

# 在 TUI 中检查设置
/settings
# 导航到 Graphics 部分
# 确保 graphics = auto 且 imageFallback = halfblock
```

### 问题 3: 显示占位符而不是像素

这可能是**正常行为**：

- `imagePixels = false` 时显示 "🖼 image attachment"
- 加载中显示 "⏳ rendering image…"
- 失败显示 "⚠ image render failed"

**检查：**
1. 确认 `graphics` 设置不是 `off`
2. 如果终端不支持图形协议，确认 `imageFallback = halfblock`

### 问题 4: Halfblock 渲染模糊

这是**预期行为** - halfblock 是低分辨率的后备方案：

- 每个字符代表 2 个像素高度
- 使用 Unicode ▀ 字符和颜色组合
- 在不支持图形协议的终端上提供基本图片预览

**改进方法：**
- 使用支持 Kitty/iTerm2/Sixel 的终端
- Windows Terminal 用户：升级到 1.22+ 以支持 Sixel

## 验证功能正常工作

运行诊断脚本：

```bash
cd /d/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui

# 测试图片渲染
node tests/debug-image.mjs

# 测试 Mermaid 渲染  
node tests/debug-mermaid.mjs

# 运行完整测试套件
npm test
```

所有测试应该通过，表明功能正常。

## 开发者信息

### 关键模块
- `lib/image.js` - 图片解码、缩放、编码（halfblock/sixel/iterm2/kitty）
- `lib/mermaid.js` - Mermaid 提供者链（mmdc → mermaid.ink → fallback）
- `lib/markdown.js` - Markdown 解析器（识别 mermaid 块和图片）
- `lib/ui.js` - UI 层（触发渲染请求）
- `lib/index.js` - 主插件（连接管道）

### 渲染流程
```
输入 → markdown.js 解析 
     ↓
识别 mermaid/image
     ↓
ui.js 触发 onMermaidRequest/onImageRequest
     ↓
index.js 调用渲染器
     ↓
mermaid.js / image.js 渲染
     ↓
setImageResult / setMermaidResult 更新状态
     ↓
paintSoon() 触发重绘
     ↓
term.js paint() 输出到终端
```

### 添加调试日志

如需调试，在 `lib/index.js` 中添加：

```javascript
// 在 resolveImage 函数中
console.error('[DEBUG] Image request:', src.kind, src.key)

// 在 resolveMermaid 函数中  
console.error('[DEBUG] Mermaid request:', key, code.slice(0, 50))

// 在 app.setImageResult 调用后
console.error('[DEBUG] Image result:', src.key, render.protocol)
```

使用 `console.error` 因为 `console.log` 输出会被 TUI 捕获。

## 下一步

如果按照本指南操作后仍然无法显示：

1. 提供具体的重现步骤
2. 说明使用的终端（Windows Terminal/iTerm2/Kitty等）
3. 提供 `/settings` 截图
4. 运行 `node tests/debug-mermaid.mjs` 并提供输出
5. 说明期望看到什么 vs 实际看到什么
