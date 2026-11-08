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
  let directoryReady = false
  // The log is written in batches, not once per diverted write. `record` runs
  // inside the host's own write path, and an MCP server started through `npx`
  // prints its download progress there in hundreds of small chunks: a
  // synchronous append, a stat and a mkdir per chunk blocked the frame loop long
  // enough to read as a stutter — worst of all while MCP servers were loading,
  // which is exactly when that output arrives. The in-memory copy stays exact
  // and immediate; only the file lags by one flush interval.
  const FLUSH_MS = 250
  const FLUSH_BYTES = 64 * 1024
  let pending = ''
  let flushTimer = null

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!logPath || pending === '') return
    const text = pending
    pending = ''
    try {
      if (!directoryReady) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        directoryReady = true
      }
      if (logBytes === null) {
        try { logBytes = fs.statSync(logPath).size } catch { logBytes = 0 }
      }
      // Rotate by truncation: this file exists to answer "what did the host
      // complain about just now", so the newest lines are the ones worth
      // keeping.
      if (logBytes + Buffer.byteLength(text) > MAX_LOG_BYTES) {
        fs.writeFileSync(logPath, '')
        logBytes = 0
      }
      fs.appendFileSync(logPath, text)
      logBytes += Buffer.byteLength(text)
    } catch {
      // A read-only home directory must not take the TUI down with it; the
      // in-memory copy below still carries the text to restore().
    }
  }

  const queueForLog = (line) => {
    pending += line
    if (Buffer.byteLength(pending) >= FLUSH_BYTES) {
      flush()
      return
    }
    if (flushTimer) return
    flushTimer = setTimeout(flush, FLUSH_MS)
    // The timer must never be the reason the process stays alive.
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  const record = (name, text) => {
    if (!text) return
    state.count++
    // Stamping each write rather than each line keeps multi-line stack traces
    // attached to the moment they happened without parsing them here.
    const entry = `[${new Date().toISOString()}] [${name}] ${text}`
    if (logPath) queueForLog(entry.endsWith('\n') ? entry : entry + '\n')
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
    // Write the log out now instead of on the next flush tick. A caller that
    // is about to read the file — the tests, a user asked to look at it —
    // needs the tail to be on disk already.
    flush,
    restore() {
      if (state.restored) return
      state.restored = true
      // Pending log text would otherwise be lost on the way out, which is
      // exactly the tail a user is asked to look at when something failed.
      flush()
      for (let i = undo.length - 1; i >= 0; i--) undo[i]()
      // Replay through the real streams, now that they no longer paint over the
      // alt screen. Nothing here goes through record().
      if (state.kept.length > 0) {
        try { process.stderr.write(state.kept.join('')) } catch { /* closed on shutdown */ }
      }
    },
  }
}
