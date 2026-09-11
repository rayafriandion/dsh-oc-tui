// Whole-session statistics and token usage.
//
// `SessionMetrics` folds the durable session log into the figures the WebUI's
// stats strip and ContextMeter show. Its field names and fold rules mirror the
// host's two projection units exactly — `sessionStats`
// (`@deepseek-ai/dsh-session-stats`) and `tokenUsage` (`@deepseek-ai/dsh-token-meter`)
// — so the values a profile serves through `ctx.sessionProjections` and the
// values derived here are interchangeable; the TUI prefers the projection and
// falls back to this fold for whatever the profile does not mount
// (`mergeSessionStats`).

/**
 * A chunk that opens a step's first-token boundary: a non-empty text,
 * reasoning, or tool-call delta. Mirrors `isTokenDelta` in `@deepseek-ai/dsh-llm`
 * (empty deltas are heartbeats and never count).
 * @param chunk - stream chunk from an `assistant/chunk` event.
 * @returns true when the chunk carries model output.
 */
function isTokenDelta(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined
  return false
}

/**
 * A finite non-negative token count.
 * @param value - candidate count.
 * @returns the count, or null when the value is not one.
 */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * The four disjoint billing buckets of one provider usage report.
 * @param usage - `assistant/chunk` usage or `assistant/message` usage.
 * @returns the buckets, or null when the record is not a usage report.
 */
function usageBuckets(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  const uncachedInputTokens = tokenCount(usage.inputTokens)
  const outputTokens = tokenCount(usage.outputTokens)
  if (uncachedInputTokens === null || outputTokens === null) return null
  return {
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens: tokenCount(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens) ?? 0,
  }
}

/**
 * Integer cache-hit percentage, with positive ties rounded up (the web stats
 * strip's `roundedIntegerPercent`).
 * @param cacheReadTokens - prompt-side cache-read tokens.
 * @param denominator - billed prompt-side input tokens.
 * @returns the rounded integer percentage.
 */
function roundedIntegerPercent(cacheReadTokens, denominator) {
  const denominatorQuotient = Math.floor(denominator / 200)
  const denominatorRemainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / 200)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole log, ported
 * from the web stats strip so both surfaces print the same figure.
 *
 * An integer reading is used while it stays below 100; a near-total hit keeps
 * just enough decimal places to stay below 100 instead of reporting a rounded
 * 100%.
 * @param uncachedInputTokens - prompt-side cache-miss tokens.
 * @param cacheReadTokens - prompt-side cache-read tokens.
 * @param cacheWriteTokens - prompt-side cache-write tokens.
 * @returns the percentage text, or undefined when nothing was billed.
 */
export function cacheHitPercent(uncachedInputTokens, cacheReadTokens, cacheWriteTokens) {
  const denominator = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  if (denominator === 0) return undefined
  const missedInputTokens = uncachedInputTokens + cacheWriteTokens
  if (missedInputTokens === 0) return '100'

  const integerPercent = roundedIntegerPercent(cacheReadTokens, denominator)
  if (integerPercent < 100) return String(integerPercent)

  // At the first distinguishing precision, the rounded result is 100 minus one
  // to five units in the final decimal place. Scale only while the next
  // multiplication remains at or below the denominator, then derive that final
  // digit through exact small-factor comparisons.
  let decimalPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}

/**
 * Add the display-only readings the strip and the stats window print, so a
 * projection-backed figure and a locally folded one are formatted identically.
 * @param totals - whole-log counts, wall times, and billing buckets.
 * @returns the totals plus `billedInputTokens`, `ttftAverageMs`,
 * `tokensPerSecond`, and `cacheHitRate`.
 */
function withReadings(totals) {
  const billedInputTokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return {
    ...totals,
    billedInputTokens,
    ttftAverageMs: totals.ttftSteps > 0 ? totals.ttftMs / totals.ttftSteps : undefined,
    tokensPerSecond: totals.decodeMs > 0 ? totals.decodeTokens / (totals.decodeMs / 1000) : undefined,
    cacheHitRate: cacheHitPercent(totals.uncachedInputTokens, totals.cacheReadTokens, totals.cacheWriteTokens),
  }
}

/**
 * Overlay a profile's projection values on the locally folded figures.
 *
 * Every key the profile serves wins: `sessionStats` for the counts and wall
 * times, `tokenUsage` for the billing buckets. An absent key (a profile that
 * mounts neither row, or a host that serves no such unit) leaves the local
 * fold's own figure in place — the same `projected ?? deriveStats` split the
 * web stats strip uses.
 * @param local - the local fold's snapshot.
 * @param values - `ctx.sessionProjections.snapshot(session).values`, or null.
 * @returns the effective figures.
 */
export function mergeSessionStats(local, values) {
  const stats = values?.sessionStats
  const usage = values?.tokenUsage
  if (!stats && !usage) return local
  const merged = { ...local, ...(stats ?? {}) }
  if (usage) {
    merged.uncachedInputTokens = tokenCount(usage.uncachedInputTokens) ?? merged.uncachedInputTokens
    merged.outputTokens = tokenCount(usage.outputTokens) ?? merged.outputTokens
    merged.cacheReadTokens = tokenCount(usage.cacheReadTokens) ?? merged.cacheReadTokens
    merged.cacheWriteTokens = tokenCount(usage.cacheWriteTokens) ?? merged.cacheWriteTokens
  }
  return withReadings(merged)
}

/**
 * The TUI's whole-log fold of the durable session log.
 *
 * The fold is fed every `session/event` of the live session, and the whole log
 * on open/replay, so its totals describe the session rather than the visible
 * transcript — paging and compaction cannot change them. Usage reported by a
 * stream chunk and later restated by the step's assembled message replaces the
 * earlier sample instead of double counting it (the `tokenUsage` rule).
 */
export class SessionMetrics {
  constructor() {
    this.reset()
  }

  reset() {
    this.turns = 0
    this.steps = 0
    this.llmMs = 0
    this.toolMs = 0
    this.ttftMs = 0
    this.ttftSteps = 0
    this.decodeMs = 0
    this.decodeTokens = 0
    this.uncachedInputTokens = 0
    this.outputTokens = 0
    this.cacheReadTokens = 0
    this.cacheWriteTokens = 0
    // In-flight boundaries the totals accrue from.
    this.lastTurn = null
    this.openStep = null
    this.pendingCalls = new Map()
    this.lastUsage = null
  }

  /**
   * Record one durable session event.
   * @param event - a session-log event (`{ type, time, data }`).
   */
  consume(event) {
    const data = event.data
    switch (event.type) {
      case 'step/start':
        this.openStep = { turn: data.turn, step: data.step, startTime: event.time, firstTokenTime: null }
        return
      case 'assistant/chunk': {
        const chunk = data.chunk
        if (chunk.type === 'usage') {
          this._addUsage(data.turn, data.step, chunk.usage)
          return
        }
        const open = this.openStep
        if (open === null || open.turn !== data.turn || open.step !== data.step) return
        // The first attempt's boundary survives an in-step retry: later chunks
        // of the same step find the boundary already set.
        if (open.firstTokenTime !== null || !isTokenDelta(chunk)) return
        open.firstTokenTime = event.time
        return
      }
      case 'assistant/message': {
        const open = this.openStep
        if (open !== null && open.turn === data.turn && open.step === data.step) {
          this.llmMs += Math.max(0, event.time - open.startTime)
          if (open.firstTokenTime !== null) {
            this.ttftMs += Math.max(0, open.firstTokenTime - open.startTime)
            this.ttftSteps += 1
            const outputTokens = tokenCount(data.usage?.outputTokens)
            if (outputTokens !== null) {
              this.decodeMs += Math.max(0, event.time - open.firstTokenTime)
              this.decodeTokens += outputTokens
            }
          }
          // One assembled message per step: closing the boundary means a
          // duplicate cannot accrue twice.
          this.openStep = null
        }
        this._addUsage(data.turn, data.step, data.usage)
        return
      }
      case 'tool/call':
        this.pendingCalls.set(data.callId, event.time)
        return
      case 'tool/result': {
        const callId = data.message?.source?.callId
        if (callId === undefined || !this.pendingCalls.has(callId)) return
        this.toolMs += Math.max(0, event.time - this.pendingCalls.get(callId))
        this.pendingCalls.delete(callId)
        return
      }
      case 'step/end':
        // `step/end` — not `assistant/message` — counts the step: the loop
        // appends exactly one per entered step, so completed, failed,
        // cancelled, and max-tokens steps all land one.
        this.turns = this.lastTurn === data.turn ? this.turns : this.turns + 1
        this.steps += 1
        this.lastTurn = data.turn
        this.openStep = null
        return
      case 'turn/end':
        // A call whose result never landed belongs to a cancelled or failed
        // turn; results always land within their turn, so drop the leftovers.
        if (this.pendingCalls.size > 0) this.pendingCalls.clear()
        return
      default:
    }
  }

  /**
   * Fold one usage sample into the billing buckets, replacing the same step's
   * earlier sample rather than adding to it.
   * @param turn - the reporting turn.
   * @param step - the reporting step.
   * @param usage - the provider usage report.
   */
  _addUsage(turn, step, usage) {
    const buckets = usageBuckets(usage)
    if (buckets === null) return
    const previous = this.lastUsage !== null && this.lastUsage.turn === turn && this.lastUsage.step === step
      ? this.lastUsage.buckets
      : null
    if (previous !== null
      && previous.uncachedInputTokens === buckets.uncachedInputTokens
      && previous.outputTokens === buckets.outputTokens
      && previous.cacheReadTokens === buckets.cacheReadTokens
      && previous.cacheWriteTokens === buckets.cacheWriteTokens) {
      return
    }
    this.uncachedInputTokens += buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0)
    this.outputTokens += buckets.outputTokens - (previous?.outputTokens ?? 0)
    this.cacheReadTokens += buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0)
    this.cacheWriteTokens += buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0)
    this.lastUsage = { turn, step, buckets }
  }

  /**
   * The folded whole-log figures plus their display readings.
   * @returns totals (`turns`, `steps`, `llmMs`, `toolMs`, `ttftMs`, `ttftSteps`,
   * `decodeMs`, `decodeTokens`, the four billing buckets) and the derived
   * `billedInputTokens`, `ttftAverageMs`, `tokensPerSecond`, `cacheHitRate`.
   */
  snapshot() {
    return withReadings({
      turns: this.turns,
      steps: this.steps,
      llmMs: this.llmMs,
      toolMs: this.toolMs,
      ttftMs: this.ttftMs,
      ttftSteps: this.ttftSteps,
      decodeMs: this.decodeMs,
      decodeTokens: this.decodeTokens,
      uncachedInputTokens: this.uncachedInputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
    })
  }
}
