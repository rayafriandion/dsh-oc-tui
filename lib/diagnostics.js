// Host diagnostics captured while the TUI owns the alternate screen.
//
// Plugins in this process report through `console.warn` / `console.error` when
// no logger exporter is mounted — the LLM adapters do exactly that for model
// listing problems. On an ordinary CLI that is fine; here every one of those
// writes lands on the alt screen the renderer believes it owns, leaving
// unpainted text behind that the diffing painter never corrects.
//
// So the process streams are diverted for as long as the alt screen is up. The
// text is appended to a log file the user can be pointed at, and replayed to the
// real stderr on restore, after the alt screen is gone and it can do no harm.
import fs from 'node:fs'
import path from 'node:path'

// Beyond this the in-memory copy stops growing: a plugin stuck in a warn loop
// must not be able to exhaust the heap. The file keeps the full text either way.
const MAX_KEPT_BYTES = 256 * 1024
// The log is truncated once it passes this. A plugin that warns on every frame
// would otherwise grow the file without bound across a long session.
const MAX_LOG_BYTES = 1024 * 1024

function streamText(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  return typeof chunk === 'string' ? chunk : String(chunk)
}

// Intercept both process streams. Returns a handle with the captured text, a
// live count, and `restore()`.
//
// `onFirst` fires exactly once, on the first diverted write: the caller uses it
// for a single toast rather than one per line. It is called after the write has
// been recorded, never from inside a console method, so a listener that itself
// logs cannot recurse into the capture.
export function captureDiagnostics({ logPath, onFirst } = {}) {
  const streams = [
    { stream: process.stdout, name: 'stdout' },
    { stream: process.stderr, name: 'stderr' },
  ]
  const undo = []
  const state = {
    count: 0,
    bytes: 0,
    kept: [],
    truncated: false,
    restored: false,
  }

  // Size is read once and then tracked, so a quiet session with no host output
  // never touches the filesystem at all.
  let logBytes = null

  const record = (name, text) => {
    if (!text) return
    state.count++
    // Stamping each write rather than each line keeps multi-line stack traces
    // attached to the moment they happened without parsing them here.
    const entry = `[${new Date().toISOString()}] [${name}] ${text}`
    if (logPath) {
      const line = entry.endsWith('\n') ? entry : entry + '\n'
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        if (logBytes === null) {
          try { logBytes = fs.statSync(logPath).size } catch { logBytes = 0 }
        }
        // Rotate by truncation: this file exists to answer "what did the host
        // complain about just now", so the newest lines are the ones worth
        // keeping.
        if (logBytes > MAX_LOG_BYTES) {
          fs.writeFileSync(logPath, '')
          logBytes = 0
        }
        fs.appendFileSync(logPath, line)
        logBytes += Buffer.byteLength(line)
      } catch {
        // A read-only home directory must not take the TUI down with it; the
        // in-memory copy below still carries the text to restore().
      }
    }
    if (state.bytes < MAX_KEPT_BYTES) {
      state.kept.push(text)
      state.bytes += Buffer.byteLength(text)
    } else {
      state.truncated = true
    }
    if (state.count === 1 && typeof onFirst === 'function') {
      try { onFirst() } catch { /* a listener must not break the capture */ }
    }
  }

  for (const { stream, name } of streams) {
    const original = stream.write
    if (typeof original !== 'function') continue
    stream.write = function (chunk, encoding, callback) {
      // Diverted writes report success and still fire the callback: a writer
      // that waits for it would otherwise hang the host mid-turn.
      record(name, streamText(chunk, encoding))
      if (typeof encoding === 'function') encoding()
      else if (typeof callback === 'function') callback()
      return true
    }
    undo.push(() => { stream.write = original })
  }

  return {
    get count() { return state.count },
    get truncated() { return state.truncated },
    // Everything captured, in write order, for the post-exit replay.
    text() { return state.kept.join('') },
    restore() {
      if (state.restored) return
      state.restored = true
      for (let i = undo.length - 1; i >= 0; i--) undo[i]()
      // Replay through the real streams, now that they no longer paint over the
      // alt screen. Nothing here goes through record().
      if (state.kept.length > 0) {
        try { process.stderr.write(state.kept.join('')) } catch { /* closed on shutdown */ }
      }
    },
  }
}
