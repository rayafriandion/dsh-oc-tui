// The page a boot refuses on.
//
// It is painted *instead of* the interface, never on top of it, because the
// whole point is that nothing else may happen: no session, no settings, no
// startup update check. The only input it accepts is quit.
//
// A card, not a toast: the failure is not something to dismiss and continue
// past, and the information it carries (what is running, what was verified, what
// to install) has to stay on screen while the reader copies a command out of it.
import { Screen, makeStyle } from './term.js'
import { displayWidth, truncateWidth, wrapText } from './util.js'
import { t as tr } from './i18n.js'

const PAD = 2
const MAX_WIDTH = 78

// Build the frame for the gate page. The caller owns the terminal, so this stays
// a pure (cols, rows) -> Screen function with no knowledge of it.
export function renderBootBlock(cols, rows, theme, info) {
  return paintBootBlock(new Screen(cols, rows), theme, info)
}

/**
 * Paint the version-gate page.
 * @param {Screen} screen - the frame to paint into
 * @param {object} theme - active colour theme
 * @param {object} info - gate result: { verdict, version, range, recommended, tested, source }
 */
export function paintBootBlock(screen, theme, info) {
  const background = makeStyle({ bg: theme.background })
  screen.clear(background)

  const width = Math.max(24, Math.min(screen.cols - PAD * 2, MAX_WIDTH))
  const x0 = Math.max(1, Math.floor((screen.cols - width) / 2))
  const inner = Math.max(12, width - PAD)

  const title = tr(info.verdict === 'unsupported' ? 'boot.unsupportedTitle' : 'boot.unverifiedTitle')
  const headline = { fg: theme.error, bold: true }
  const label = { fg: theme.textMuted }
  const value = { fg: theme.text }
  const body = { fg: theme.textMuted }
  const command = { fg: theme.primary, bold: true }
  const hint = { fg: theme.textMuted, dim: true }

  // The card is assembled from parts so a short terminal can drop the narration
  // and keep the thing the page exists for: the command that fixes it. What is
  // running and how to install the recommended version are essential; the
  // alternatives go first, and each one only comes back if it still fits.
  const rows = []
  const blank = () => rows.push(null)
  // A field wraps at the value column rather than truncating: the verified list is
  // the one row that routinely outgrows the card, and cutting it with `…` hides
  // versions the reader is being asked to choose between.
  const field = (name, text, style = value) => {
    const pad = displayWidth(name) < 12 ? ' '.repeat(12 - displayWidth(name)) : ' '
    const width = Math.max(4, inner - 12)
    const lines = wrapText(text, width)
    rows.push([{ text: name + pad, style: label }, { text: lines[0] ?? '', style }])
    for (const line of lines.slice(1)) rows.push([{ text: ' '.repeat(12), style: null }, { text: line, style }])
  }
  const wrap = (text, style = body) => {
    for (const line of wrapText(text, inner)) rows.push([{ text: line, style }])
  }
  // Everything below pushes into `rows`; each splice cuts the block back out so
  // the parts can be ordered and dropped independently of how they were written.
  const cut = () => rows.splice(0)

  rows.push([{ text: '⚠ ', style: headline }, { text: title, style: headline }])
  blank()
  field(tr('boot.runningLabel'), info.version ?? '—')
  field(tr('boot.supportedLabel'), info.range === '' ? '—' : info.range)
  if (info.recommended) field(tr('boot.recommendedLabel'), info.recommended, { fg: theme.success, bold: true })
  if (info.tested?.length) field(tr('boot.verifiedLabel'), info.tested.join(' · '))
  blank()
  const head = cut()

  wrap(tr(info.verdict === 'unsupported' ? 'boot.unsupportedBody' : 'boot.unverifiedBody', {
    version: info.version ?? '?',
    range: info.range,
    recommended: info.recommended ?? '',
    verified: (info.tested ?? []).join(' · '),
  }))
  blank()
  const explanation = cut()

  wrap(tr('boot.installHint'))
  const installHint = cut()

  rows.push([{ text: '    npm i -g @deepseek-ai/dsh@' + (info.recommended ?? ''), style: command }])
  blank()
  const installCommand = cut()

  wrap(tr('boot.updatePluginHint'))
  rows.push([{ text: '    npm i -g dsh-oc-tui@latest', style: command }])
  const alternative = cut()

  // The bottom row is the footer, so the card is centred in the rows above it.
  // Reading order is fixed by this list; membership is what the budget decides.
  const footerRow = Math.max(0, screen.rows - 1)
  const budget = footerRow
  const kept = new Set([head, installCommand])
  const card = () => [head, explanation, installHint, installCommand, alternative]
    .flatMap((part) => (kept.has(part) ? part : []))
  // Added by importance, so a window that only fits one of them keeps the
  // sentence that introduces the command rather than the alternative route.
  for (const part of [installHint, explanation, alternative]) {
    if (card().length + part.length > budget) continue
    kept.add(part)
  }

  const lines = card()
  const top = Math.max(0, Math.floor((budget - lines.length) / 2))
  const limit = Math.max(0, Math.min(lines.length, budget - top))
  for (let i = 0; i < limit; i++) {
    const row = lines[i]
    if (!row) continue
    let x = x0
    for (const segment of row) {
      x = screen.text(x, top + i, segment.text, makeStyle({ ...segment.style, bg: theme.background }))
    }
  }
  // The one line that must survive any window height: how to get out. It is a
  // footer, not a card row, so a tall card being truncated cannot swallow it —
  // and it clears its row first, because a card that ran into it would otherwise
  // leave its own text trailing after the hint.
  screen.fill(0, footerRow, screen.cols, ' ', background)
  screen.text(x0, footerRow, truncateWidth(tr('boot.exitHint'), inner), makeStyle({ ...hint, bg: theme.background }))
  return screen
}
