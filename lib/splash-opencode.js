// OpenCode-style splash screen: the DeepSeek brand mark with input hints
import { t as tr } from './i18n.js'
import { displayWidth, shortenPath, truncateWidth } from './util.js'

// The DeepSeek mark as it has always been drawn on the title screen: the
// name in a blue→white gradient, set as one line rather than ASCII art.
const BRAND = 'DeepSeek Harness'
const BRAND_BLUE = '#4d6bfe'
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
 * - DeepSeek brand mark above the centered composer
 * - Keyboard shortcuts and workspace/git context below it
 *
 * @param {Screen} screen - The screen buffer to paint to
 * @param {number} cols - Terminal columns
 * @param {number} rows - Terminal rows
 * @param {object} theme - Color theme
 * @param {object} ctx - Context: { workingDirectory, gitBranch, model, provider }
 * @param {number} floor - Shortcut row for a standalone splash
 * @param {object} area - Composer band: { x0, width, composerTop, composerBottom }.
 */
export function paintSplashOpenCode(screen, cols, rows, theme, ctx = {}, floor = rows - 1, area = {}) {
  const chars = Array.from(BRAND)

  const brandRow = Math.max(1, (area.composerTop ?? Math.floor((rows - 1) / 2)) - 3)

  // The horizontal band: bounded by the caller, centered content within it.
  const x0 = Math.max(0, Math.min(area.x0 ?? 0, cols - 1))
  const bandW = Math.max(1, Math.min(area.width ?? cols, cols - x0))
  // Measured in cells, not code units: a translated hint or a CJK workspace
  // path is wide per rune, and centering by `length` would push it off-centre.
  const centerX = (text) => x0 + Math.max(0, Math.floor((bandW - displayWidth(text)) / 2))

  // Paint the brand centered horizontally, each rune one step along the
  // deep blue → white gradient the mark has always used.
  const brandX = centerX(BRAND)
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0
    screen.text(brandX + i, brandRow, chars[i], { fg: mixColor(BRAND_BLUE, BRAND_TAIL, t), bold: true, bg: theme.background })
  }

  // Keep shortcuts close to the input while reserving the last status row.
  const shortcutsY = Math.min(rows - 2, area.composerBottom != null ? area.composerBottom + 2 : floor)

  // Workspace/git/model info below the mark
  let infoY = area.composerBottom != null ? shortcutsY + 2 : brandRow + 2
  const { workingDirectory = '', gitBranch = '', model = '', provider = '' } = ctx

  if (workingDirectory && infoY < rows - 2) {
    const branch = gitBranch ? '  git: ' + truncateWidth(gitBranch, Math.max(4, Math.floor(bandW / 3))) : ''
    const info = shortenPath(workingDirectory, Math.max(4, bandW - displayWidth(branch))) + branch
    screen.text(centerX(info), infoY, truncateWidth(info, bandW), { fg: theme.textMuted, bg: theme.background })
    infoY++
  }

  if (area.composerTop == null && model && infoY < shortcutsY - 1) {
    const modelInfo = provider ? `${provider}/${model}` : model
    screen.text(centerX(modelInfo), infoY, truncateWidth(modelInfo, bandW), { fg: theme.secondary, bg: theme.background })
    infoY++
  }

  // Input hint below info
  const hintY = infoY + 1
  if (area.composerTop == null && hintY < shortcutsY) {
    const hint = tr('splash.hint')
    screen.text(centerX(hint), hintY, truncateWidth(hint, bandW), { fg: theme.textMuted, bg: theme.background })
  }

  // Keyboard shortcuts at bottom: only affordances that actually exist on the
  // title screen. A narrow terminal drops whole groups rather than cutting any
  // group in half; settings and thinking take priority over branches. Each
  // group paints its key in the accent color and bold so the key reads apart
  // from the muted description that follows it.
  if (shortcutsY > brandRow + 2) {
    const sep = '    '
    const pairs = [
      ['Ctrl+P', tr('splash.shortcutSettings')],
      ['Tab', tr('splash.shortcutThinking')],
      ['Ctrl+G', tr('splash.shortcutBranches')],
      ['Ctrl+S', tr('screenshot.shortcut')],
    ]
    const essentialWidth = pairs.slice(0, 2).reduce((n, [key, desc]) => n + displayWidth(key) + 2 + displayWidth(desc), displayWidth(sep))
    if (essentialWidth > bandW - 2) {
      const descBudget = Math.max(0, bandW - 2 - displayWidth('Ctrl+P  Tab') - displayWidth(sep) - 2)
      const firstRoom = Math.min(displayWidth(pairs[0][1]), Math.floor(descBudget / 2))
      pairs[0][1] = truncateWidth(pairs[0][1], firstRoom)
      pairs[1][1] = truncateWidth(pairs[1][1], descBudget - firstRoom)
    }
    const kept = []
    let width = 0
    for (const [key, desc] of pairs) {
      const groupW = displayWidth(key) + 2 + displayWidth(desc)
      const next = kept.length === 0 ? groupW : width + displayWidth(sep) + groupW
      if (next > bandW - 2) break
      kept.push([key, desc])
      width = next
    }
    if (kept.length > 0) {
      const line = kept.map(([key, desc]) => key + '  ' + desc).join(sep)
      let sx = centerX(line)
      for (let i = 0; i < kept.length; i++) {
        if (i > 0) sx = screen.text(sx, shortcutsY, sep, { fg: theme.textMuted, bg: theme.background })
        const [key, desc] = kept[i]
        sx = screen.text(sx, shortcutsY, key, { fg: theme.accent, bold: true, bg: theme.background })
        sx = screen.text(sx, shortcutsY, '  ' + desc, { fg: theme.textMuted, bg: theme.background })
      }
    }
  }
}
