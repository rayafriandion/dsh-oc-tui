// Presentation implementations for the TUI: the TUI is a *provider* of these
// operations, not a consumer. Consumers reach them through the connection layer
// and end up in the handlers below.
//
// Every handler resolves the live TUI at call time (late binding) and reports
// `unavailable` when there is none. That is the honest answer and the safe one:
// `unavailable` can never be mistaken for consent, which matters most for
// approvals.
//
// Support is declared for what actually exists. OpenExternal is not claimed
// (the TUI cannot open a browser, and spawning one is outside its remit), and
// ExternalRedirect is not claimed (it needs a loopback HTTP server plus a
// browser).

import { liveTui } from '../bridge.js'

export const PRESENTATION_API_VERSION = 'presentation.dsh/v1alpha1'

// The operations the TUI's modals genuinely implement. `secret-input` joins
// this list in Task 12, when its standalone prompt lands.
export function presentationOperations() {
  return ['question', 'approval']
}

const UNAVAILABLE = (reason) => ({ status: 'unavailable', reason })

async function withLiveTui(fn) {
  const handle = liveTui()
  if (!handle) return UNAVAILABLE('no live dsh-oc-tui instance')
  return fn(handle)
}

// Returns the { support, implementation } pairs the facet publishes. The shape
// matches ActivationContext.protocols.implement(support, implementation).
export function createPresentationImplementations() {
  const userInteraction = {
    async interact(request) {
      return withLiveTui((handle) => handle.interact(request))
    },
  }
  const notification = {
    async notify(request) {
      return withLiveTui((handle) => handle.notify(request))
    },
  }
  const copyText = {
    async copyText(request) {
      return withLiveTui((handle) => handle.copyText(request))
    },
  }

  return [
    {
      support: {
        apiVersion: PRESENTATION_API_VERSION,
        kind: 'UserInteraction',
        spec: { operations: presentationOperations() },
      },
      implementation: userInteraction,
    },
    {
      support: { apiVersion: PRESENTATION_API_VERSION, kind: 'Notification' },
      implementation: notification,
    },
    {
      support: { apiVersion: PRESENTATION_API_VERSION, kind: 'CopyText' },
      implementation: copyText,
    },
  ]
}
