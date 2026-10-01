// OpenCode-style splash screen: the DeepSeek brand mark with input hints

// The DeepSeek mark as it has always been drawn on the title screen: the
// name in a blue→white gradient, set as one line rather than ASCII art.
const BRAND = 'DeepSeek Harness'
const BRAND_TAIL = '#ffffff'

// Color mixing helper (linear interpolation in RGB space)
function mixColor(a, b, t) {
  const parseHex = (hex) => {
    const h = hex.replace('#', '')
    return {
      r: parseInt(h.substring(0, 2), 16),
      g: parseInt(h.substring(2, 4), 16),
      b: parseInt(h.substring(4, 6), 16),
    }
  }
  const ca = parseHex(a)
  const cb = parseHex(b)
  const r = Math.round(ca.r + (cb.r - ca.r) * t)
  const g = Math.round(ca.g + (cb.g - ca.g) * t)
  const bl = Math.round(ca.b + (cb.b - ca.b) * t)
  return '#' + [r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Paint the OpenCode-style splash screen:
 * - DeepSeek brand mark centered vertically and horizontally
 * - Workspace/git info and model below the mark
 * - Input prompt below
 * - Keyboard shortcuts at bottom
 *
 * @param {Screen} screen - The screen buffer to paint to
 * @param {number} cols - Terminal columns
 * @param {number} rows - Terminal rows
 * @param {object} theme - Color theme
 * @param {object} ctx - Context: { workingDirectory, gitBranch, model, provider }
 * @param {number} floor - Last row the splash may use (the composer claims the rest)
 */
export function paintSplashOpenCode(screen, cols, rows, theme, ctx = {}, floor = rows - 1) {
  const chars = Array.from(BRAND)
  const brandWidth = chars.length

  // Center the brand vertically (slightly above center for better balance)
  const brandRow = Math.max(0, Math.floor((rows - 1) / 2) - 3)

  // Paint the brand centered horizontally, each rune one step along the
  // deep blue → white gradient the mark has always used.
  const brandX = Math.max(0, Math.floor((cols - brandWidth) / 2))
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0
    screen.text(brandX + i, brandRow, chars[i], { fg: mixColor(theme.primary, BRAND_TAIL, t), bold: true, bg: theme.background })
  }

  // The shortcut row anchors to the bottom of the usable area; everything
  // above it stacks out of the brand and has to stop short of that row.
  const shortcutsY = Math.min(rows - 2, floor)

  // Workspace/git/model info below the mark
  let infoY = brandRow + 2
  const { workingDirectory = '', gitBranch = '', model = '', provider = '' } = ctx

  if (workingDirectory && infoY < shortcutsY - 2) {
    const info = `${workingDirectory}${gitBranch ? `  git: ${gitBranch}` : ''}`
    const infoX = Math.max(0, Math.floor((cols - info.length) / 2))
    screen.text(infoX, infoY, info, { fg: theme.textMuted, bg: theme.background })
    infoY++
  }

  if (model && infoY < shortcutsY - 1) {
    const modelInfo = provider ? `${provider}/${model}` : model
    const modelX = Math.max(0, Math.floor((cols - modelInfo.length) / 2))
    screen.text(modelX, infoY, modelInfo, { fg: theme.secondary, bg: theme.background })
    infoY++
  }

  // Input hint below info
  const hintY = infoY + 1
  if (hintY < shortcutsY) {
    const hint = 'Ask anything... "Fix broken tests"'
    const hintX = Math.max(0, Math.floor((cols - hint.length) / 2))
    screen.text(hintX, hintY, hint, { fg: theme.textMuted, bg: theme.background })
  }

  // Keyboard shortcuts at bottom. The two DSH affordances come first so a
  // narrow terminal drops the agent hint rather than losing settings or
  // thinking intensity; each group is dropped whole, never cut in half.
  if (shortcutsY > hintY + 2) {
    const sep = '    '
    let line = ''
    for (const group of ['Ctrl+P  settings', 'Tab thinking', 'tab agents']) {
      const next = line === '' ? group : line + sep + group
      if (next.length > cols - 2) break
      line = next
    }
    if (line) {
      const shortcutsX = Math.max(0, Math.floor((cols - line.length) / 2))
      screen.text(shortcutsX, shortcutsY, line, { fg: theme.textMuted, bg: theme.background })
    }
  }
}
