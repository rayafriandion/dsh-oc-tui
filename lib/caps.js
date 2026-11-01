// Terminal capability probing. Every probe is an escape sequence the *client*
// terminal answers on stdin, so detection works unchanged over SSH where
// environment variables do not propagate. Env vars serve only as hints.
// A probe run that resolves with no graphics support at all is a valid
// outcome: the caller falls back to ANSI halfblock rendering, which needs no
// terminal support beyond truecolor.
export function parseDA1(body) {
  const params = body.replace(/^\?/, '').split(';').map(Number)
  return { sixel: params.includes(4) }
}

export function parseCellSize(body) {
  const m = /^8;(\d+);(\d+)$/.exec(body)
  if (!m) return null
  const h = Number(m[1])
  const w = Number(m[2])
  if (!h || !w) return null
  return { h, w }
}

// The XTVERSION reply names the terminal, optionally with a version. Used both
// for aliases (WezTerm also speaks OSC 1337) and for version-gated features
// (Windows Terminal grew sixel in 1.22).
export function parseTerminalVersion(name) {
  const m = /(\d+)\.(\d+)/.exec(name ?? '')
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

const DEFAULT_CELL = { w: 8, h: 16 }

// Probe the terminal and resolve once every answer had its chance to arrive
// (or the timeout expired — terminals that answer nothing stay text-only).
// Listening on the same decoded key stream as the app guarantees the replies
// can never be mistaken for user input, whatever arrives interleaved.
export async function probeCapabilities(term, { timeoutMs = 600 } = {}) {
  const caps = {
    kitty: false,
    iterm2: false,
    sixel: false,
    cellW: DEFAULT_CELL.w,
    cellH: DEFAULT_CELL.h,
    name: '',
    resolved: false,
  }
  const onKey = (key) => {
    if (key?.name !== 'terminal-reply') return
    const { kind, body } = key.reply
    if (kind === 'da1') caps.sixel = parseDA1(body).sixel
    else if (kind === 'apc' && body.startsWith('Gi=31')) {
      // Any graphics-protocol answer counts, but an explicit "not supported"
      // error code does not (some VTE forks echo the query with ENOSYS).
      caps.kitty = !body.includes('ENOSYS') && !body.includes('ENOTSUP')
    } else if (kind === 'dcs' && body.startsWith('>|')) caps.name = body.slice(2)
    else if (kind === 'windowops') {
      const c = parseCellSize(body)
      if (c) { caps.cellW = c.w; caps.cellH = c.h }
    }
  }
  term.on('key', onKey)
  term.write('\x1b[c')                                       // DA1: attribute list (sixel = "4")
  term.write('\x1b[>0q')                                     // XTVERSION: name + version
  term.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\')   // kitty graphics query
  term.write('\x1b[16t')                                     // cell size in pixels
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  term.off('key', onKey)
  if (caps.name) {
    if (/\bwezterm\b/i.test(caps.name)) caps.iterm2 = true   // WezTerm implements OSC 1337
    if (/\bghostty\b/i.test(caps.name)) caps.kitty = true
    if (/\bwindows terminal\b/i.test(caps.name)) {
      const v = parseTerminalVersion(caps.name)
      if (v && (v.major > 1 || (v.major === 1 && v.minor >= 22))) caps.sixel = true
    }
  }
  // Environment hints: honest only when local (they do not survive SSH), and
  // only able to confirm support the probes could not see, never to deny it.
  const env = process.env
  if (env.TERM_PROGRAM === 'iTerm.app') caps.iterm2 = true
  if (env.TERM_PROGRAM === 'WezTerm' || env.WEZTERM_EXECUTABLE) caps.iterm2 = true
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') caps.kitty = true
  if (env.GHOSTTY_RESOURCES_DIR) caps.kitty = true
  caps.resolved = true
  return caps
}
