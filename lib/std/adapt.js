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
  // A prompt that outlived its request deadline is not a decision either, and
  // the standard has a status for exactly this: `expired` says "no answer in
  // time", which a consumer must read as neither consent nor denial. Mapping it
  // to `cancelled` (the pre-deadline behaviour) would lose that distinction.
  if (tuiOutcome === 'expired') return { status: 'expired' }
  return { status: 'cancelled' }
}

// ---- presentation: request deadline --------------------------------------

// Milliseconds until a request's `deadline`, or null when the request carries
// none. A deadline already in the past yields 0 rather than a negative delay:
// the caller expires the wait at once instead of arming a timer that fires on
// the next tick anyway.
//
// An unparseable deadline is treated as absent. The protocol's own validator
// rejects a non-RFC-3339 deadline (`presentation/lib/index.js`, "must be an
// RFC 3339 date-time"), so such a value means the request never passed
// validation; waiting rather than inventing an immediate expiry is the less
// destructive reading of a prompt a human still has to answer.
export function deadlineDelay(deadline, now = Date.now()) {
  if (typeof deadline !== 'string' || deadline === '') return null
  const at = Date.parse(deadline)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
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
  // Null-prototype maps: field ids and option labels come from another
  // component, and a plain object would resolve inherited members — a field id
  // of `toString` would read Object.prototype.toString as a decoder, and an
  // option label of `__proto__` would not store a normal key.
  const decoders = Object.create(null)

  for (const field of fields ?? []) {
    const question = {
      id: String(field.id),
      question: String(field.label),
      header: field.label === undefined ? undefined : String(field.label),
      detail: field.description === undefined ? undefined : String(field.description),
      options: [],
      multiSelect: false,
      // The kind and the text bounds must reach the modal: an answer outside
      // minLength/maxLength is rejected by the protocol's
      // validateQuestionAnswers INSIDE the factory's handle, so without them an
      // ordinary out-of-range answer is a capability failure instead of a
      // re-prompt. Bounds are measured in UTF-16 units (String.prototype.length)
      // to match the validator, and are undefined when the field carries none.
      kind: field.kind,
      minLength: field.minLength,
      maxLength: field.maxLength,
    }

    if (field.kind === 'select') {
      const idByLabel = Object.create(null)
      // Allocate against the labels already used in THIS field rather than
      // counting occurrences of the base label. A literal label can already
      // equal a generated suffix — ["Same", "Same", "Same (2)"] is legal input
      // — and a collision would give two options the same display label and
      // overwrite each other's id mapping, so a selection would silently decode
      // to the wrong option. When the base itself ends in " (n)", continue that
      // counter from the root, so the literal "Same (2)" collides into
      // "Same (3)" rather than the unhelpful "Same (2) (2)".
      const used = new Set()
      for (const option of field.options ?? []) {
        const base = String(option.label)
        const suffixed = /^(.*) \((\d+)\)$/.exec(base)
        const root = suffixed ? suffixed[1] : base
        let label = base
        let n = suffixed ? Number(suffixed[2]) : 1
        while (used.has(label)) {
          n += 1
          label = root + ' (' + n + ')'
        }
        used.add(label)
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
      const idByLabel = Object.create(null)
      idByLabel[CONFIRM_YES] = true
      idByLabel[CONFIRM_NO] = false
      decoders[question.id] = { kind: 'confirm', idByLabel }
      question.options.push({ label: CONFIRM_YES }, { label: CONFIRM_NO })
    } else {
      // A text field has no options: the TUI answers it through the custom
      // draft, which the composer already supports.
      decoders[question.id] = { kind: 'text', idByLabel: Object.create(null) }
    }

    questions.push(question)
  }

  return { questions, decoders }
}

// ---- presentation: copy text -------------------------------------------

// The clipboard options a CopyText request implies.
//
// The Windows fallback in lib/term.js passes the text's base64 as a
// powershell.exe command-line argument, which any process of the same user can
// read back, so text marked private must stay on the in-band OSC 52 path.
export function copyTextOptions(request) {
  return { osc52Only: request?.sensitivity === 'private' }
}

// TUI answer ({ answers: [{ id, selected: [label], custom? }] }) -> the
// standard's { answers: { [fieldId]: string | boolean | string[] } }.
//
// Fields the user left empty are omitted rather than guessed at: an absent key
// is honest, a fabricated default is not.
export function fromTuiAnswers(decoders, tuiAnswer) {
  // Null-prototype for the same reason as the decoder maps: an id of
  // `__proto__` must be an ordinary key, not a prototype write.
  const answers = Object.create(null)
  // `?? []` only covers null/undefined; a non-array would make for...of throw.
  const entries = Array.isArray(tuiAnswer?.answers) ? tuiAnswer.answers : []
  for (const entry of entries) {
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

    // A select field can only carry option ids: the protocol's
    // validateQuestionAnswers rejects any answer that is not in the field's
    // option set. The TUI lets the user type a free-text answer to any question,
    // and that has no representation here, so it is dropped rather than emitted
    // as a non-id that would make the whole submitted result invalid. (A text
    // field's custom answer is the correct and only answer, and is handled
    // above.) The handle turns the resulting missing required field into a
    // cancel rather than a submitted result the validator would reject.
    if (decoder.multiple) {
      if (mapped.length > 0) answers[entry.id] = mapped
      continue
    }
    if (mapped.length > 0) answers[entry.id] = mapped[0]
  }
  return { answers }
}
