// Pure adapters between @dsh-std shapes and the TUI's internal shapes.
//
// No IO, no side effects, no dependency on a running TUI — everything here is
// a plain function so it can be tested without a terminal.
//
// The important asymmetry: the standard keys question answers by option *id*,
// but the TUI keys selection by option *label* (lib/index.js:1212-1217). That
// encoding is shared with the WebUI composer and must not change, so the
// translation lives here instead.

// ---- presentation: notification ----------------------------------------

// The standard's levels are info/warning/error; the TUI's toast and system
// block levels are info/warn/error.
export function notificationLevel(level) {
  if (level === 'warning') return 'warn'
  if (level === 'error') return 'error'
  return 'info'
}

// ---- presentation: approval --------------------------------------------

// The TUI's approval modal settles with its own vocabulary; the standard's
// ApprovalValue is { decision: 'approved' | 'denied' }.
//
// A cancelled or aborted prompt is NOT a decision. Returning `cancelled`
// rather than a denial keeps the two distinguishable, so a consumer can never
// read a timeout as consent — and an unrecognised outcome is treated the same
// way, because guessing a decision is worse than reporting none.
export function approvalOutcome(tuiOutcome) {
  if (tuiOutcome === 'allowed-once') return { status: 'submitted', value: { decision: 'approved' } }
  if (tuiOutcome === 'rejected') return { status: 'submitted', value: { decision: 'denied' } }
  return { status: 'cancelled' }
}

// ---- presentation: questions -------------------------------------------

const CONFIRM_YES = 'Yes'
const CONFIRM_NO = 'No'

// Standard QuestionField[] -> TUI questions plus the decoders needed to turn
// the TUI's answer back into the standard's answers record.
//
// The TUI selects by label, and the standard does not promise unique labels,
// so duplicates get a display suffix. Without this, two options sharing a
// label would be indistinguishable on the way back and the answer would
// silently collapse onto the first.
export function toTuiQuestions(fields) {
  const questions = []
  const decoders = {}

  for (const field of fields ?? []) {
    const question = {
      id: String(field.id),
      question: String(field.label),
      header: field.label === undefined ? undefined : String(field.label),
      detail: field.description === undefined ? undefined : String(field.description),
      options: [],
      multiSelect: false,
    }

    if (field.kind === 'select') {
      const idByLabel = {}
      const seen = new Map()
      for (const option of field.options ?? []) {
        const base = String(option.label)
        const count = (seen.get(base) ?? 0) + 1
        seen.set(base, count)
        const label = count === 1 ? base : base + ' (' + count + ')'
        idByLabel[label] = String(option.id)
        question.options.push({ label })
      }
      question.multiSelect = field.multiple === true
      // `multiple` must live on the decoder too: fromTuiAnswers uses it to
      // decide between a single string and an array, and the TUI keeps
      // `selected` populated for a multi-select even when a custom answer is
      // also present.
      decoders[question.id] = { kind: 'select', multiple: field.multiple === true, idByLabel }
    } else if (field.kind === 'confirm') {
      decoders[question.id] = { kind: 'confirm', idByLabel: { [CONFIRM_YES]: true, [CONFIRM_NO]: false } }
      question.options.push({ label: CONFIRM_YES }, { label: CONFIRM_NO })
    } else {
      // A text field has no options: the TUI answers it through the custom
      // draft, which the composer already supports.
      decoders[question.id] = { kind: 'text', idByLabel: {} }
    }

    questions.push(question)
  }

  return { questions, decoders }
}

// TUI answer ({ answers: [{ id, selected: [label], custom? }] }) -> the
// standard's { answers: { [fieldId]: string | boolean | string[] } }.
//
// Fields the user left empty are omitted rather than guessed at: an absent key
// is honest, a fabricated default is not.
export function fromTuiAnswers(decoders, tuiAnswer) {
  const answers = {}
  for (const entry of tuiAnswer?.answers ?? []) {
    const decoder = decoders[entry?.id]
    if (!decoder) continue

    if (decoder.kind === 'text') {
      const text = String(entry.custom ?? '').trim()
      if (text !== '') answers[entry.id] = text
      continue
    }

    const selected = Array.isArray(entry.selected) ? entry.selected : []
    const mapped = selected.map((label) => decoder.idByLabel[label]).filter((v) => v !== undefined)

    if (decoder.kind === 'confirm') {
      if (mapped.length > 0) answers[entry.id] = mapped[0]
      continue
    }

    // A custom answer on a single-select question replaces the selection; the
    // TUI encodes that by clearing `selected`, so a non-empty custom is a
    // free-text answer the standard can carry as a plain string.
    const custom = String(entry.custom ?? '').trim()
    if (custom !== '' && !decoder.multiple) {
      answers[entry.id] = custom
      continue
    }
    if (decoder.multiple) {
      if (mapped.length > 0) answers[entry.id] = mapped
      continue
    }
    if (mapped.length > 0) answers[entry.id] = mapped[0]
  }
  return { answers }
}
