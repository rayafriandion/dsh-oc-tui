import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
let picturesDirectory

export function defaultPicturesDirectory() {
  if (!picturesDirectory) picturesDirectory = findPicturesDirectory()
  return picturesDirectory
}

async function findPicturesDirectory() {
  const home = homedir()
  if (platform() === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Environment]::GetFolderPath("MyPictures")',
      ], { timeout: 4000, windowsHide: true })
      const directory = stdout.trim()
      if (directory && isAbsolute(directory)) return directory
    } catch { /* Windows can still use the conventional folder. */ }
  } else if (platform() !== 'darwin') {
    try {
      const config = await readFile(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs'), 'utf8')
      const match = /^XDG_PICTURES_DIR="([^"\r\n]*)"/m.exec(config)
      const directory = match?.[1]?.replace(/^\$HOME(?=\/|$)/, home)
      if (directory && isAbsolute(directory)) return directory
    } catch { /* XDG user directories are optional. */ }
  }
  return join(home, 'Pictures')
}

function escapeXml(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '\ufffd')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function color(value, fallback) {
  if (typeof value !== 'string') return fallback
  const hex = value.replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(hex)) return '#' + hex
  if (/^[0-9a-f]{3}$/i.test(hex)) return '#' + [...hex].map((ch) => ch + ch).join('')
  return fallback
}

// The export is reconstructed from the same cells the terminal receives, so it
// works over SSH and does not require access to the user's desktop or clipboard.
export async function renderScreenshot(screen, { title = '', images = new Map() } = {}) {
  const sharp = (await import('sharp')).default
  const cellW = 10
  const cellH = 20
  const margin = 24
  const titleH = 40
  const width = screen.cols * cellW + margin * 2
  const height = screen.rows * cellH + margin * 2 + titleH
  if (width * height > 50_000_000) throw new Error('screen is too large to export')
  const x0 = margin
  const y0 = margin + titleH
  const windowW = screen.cols * cellW
  const windowH = titleH + screen.rows * cellH
  const pieces = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect x="${x0}" y="${margin}" width="${windowW}" height="${windowH}" rx="7" fill="#151620" stroke="#373b53"/>`,
    `<path d="M${x0} ${margin + titleH}H${x0 + windowW}" stroke="#303347"/>`,
    `<circle cx="${x0 + 18}" cy="${margin + 20}" r="5" fill="#ff5f57"/>`,
    `<circle cx="${x0 + 35}" cy="${margin + 20}" r="5" fill="#febc2e"/>`,
    `<circle cx="${x0 + 52}" cy="${margin + 20}" r="5" fill="#28c840"/>`,
    `<clipPath id="title"><rect x="${x0 + 69}" y="${margin}" width="${Math.max(0, windowW - 80)}" height="${titleH}"/></clipPath>`,
    `<text x="${x0 + 70}" y="${margin + 25}" clip-path="url(#title)" fill="#a8b4d2" font-family="Cascadia Mono,Consolas,Microsoft YaHei UI,monospace" font-size="13">${escapeXml(title)}</text>`,
  ]
  for (let y = 0; y < screen.rows; y++) {
    const row = screen.cells[y]
    for (let x = 0; x < screen.cols;) {
      const bg = color(row[x].style?.bg, '#101114')
      let end = x + 1
      while (end < screen.cols && color(row[end].style?.bg, '#101114') === bg) end++
      pieces.push(`<rect x="${x0 + x * cellW}" y="${y0 + y * cellH}" width="${(end - x) * cellW}" height="${cellH}" fill="${bg}"/>`)
      x = end
    }
    for (let x = 0; x < screen.cols; x++) {
      const cell = row[x]
      const ch = cell.ch
      if (!ch || ch === ' ') continue
      const style = cell.style ?? {}
      const fg = color(style.fg, '#e4e5eb')
      const px = x0 + x * cellW
      const py = y0 + y * cellH
      if (ch === '▀' || ch === '▄' || ch === '█') {
        const top = ch === '▄' ? cellH / 2 : 0
        const h = ch === '█' ? cellH : cellH / 2
        pieces.push(`<rect x="${px}" y="${py + top}" width="${cellW}" height="${h}" fill="${fg}"/>`)
      } else {
        const weight = style.bold ? 'bold' : 'normal'
        const italic = style.italic ? 'italic' : 'normal'
        const opacity = style.dim ? '0.65' : '1'
        const underline = style.underline ? ' text-decoration="underline"' : ''
        pieces.push(`<text x="${px}" y="${py + 16}" fill="${fg}" opacity="${opacity}" font-family="Cascadia Mono,Consolas,Microsoft YaHei UI,Noto Sans Mono CJK SC,monospace" font-size="16" font-weight="${weight}" font-style="${italic}"${underline}>${escapeXml(ch)}</text>`)
      }
    }
  }
  pieces.push('</svg>')
  const imageLayers = []
  for (const image of screen.images ?? []) {
    const payload = images.get(image.key)
    const bytes = payload?.png ?? (payload?.b64 ? Buffer.from(payload.b64, 'base64') : null)
    if (!bytes) continue
    const imageW = Math.max(1, image.cellsW * cellW)
    const imageH = Math.max(1, image.cellsH * cellH)
    const visibleW = Math.min(imageW, (screen.cols - image.x) * cellW)
    const visibleH = Math.min(imageH, (screen.rows - image.y) * cellH)
    if (image.x < 0 || image.y < 0 || visibleW <= 0 || visibleH <= 0) continue
    const input = await sharp(bytes).resize(imageW, imageH, { fit: 'fill' })
      .extract({ left: 0, top: 0, width: visibleW, height: visibleH }).png().toBuffer()
    imageLayers.push({ input, left: x0 + image.x * cellW, top: y0 + image.y * cellH })
  }
  return sharp(Buffer.from(pieces.join(''))).composite(imageLayers).png().toBuffer()
}

export async function saveScreenshot(screen, { directory, title, images, now = new Date() } = {}) {
  const choice = typeof directory === 'string' ? directory.trim() : ''
  const expanded = choice === '~' ? homedir() : choice.replace(/^~[\\/]/, homedir() + '/')
  const target = expanded ? resolve(expanded) : await defaultPicturesDirectory()
  const png = await renderScreenshot(screen, { title, images })
  await mkdir(target, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  for (let suffix = 0; suffix < 1000; suffix++) {
    const path = join(target, `dsh-screenshot-${stamp}${suffix ? '-' + suffix : ''}.png`)
    try {
      await writeFile(path, png, { flag: 'wx' })
      return path
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not choose a unique screenshot filename')
}
