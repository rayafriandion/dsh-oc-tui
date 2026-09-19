// Presentation implementations for the TUI: the TUI is a *provider* of these
// operations, not a consumer. Consumers reach them through the connection layer
// and end up in the handlers below.
//
// The implementations come from @dsh-std/presentation's factories rather than
// being hand-built objects, because the adapter validates what a facet stages:
//
//   capabilityImplementation(participantId, support, value)
//     requires typeof value.handle === 'function'
//     requires value.participantId === the facet's activation participantId
//     requires sameProtocol(value.protocol, support)
//
// (packages/adapter-dsh/src/index.ts:1774). A plain handler object throws there,
// and a throw during mount rolls back every component in the profile — so the
// factories are not a convenience, they are the contract.
//
// Every handler resolves the live TUI at call time (late binding) and reports
// `unavailable` when there is none. That is the honest answer and the safe one:
// `unavailable` can never be mistaken for consent, which matters most for
// approvals.
//
// Support is declared for what actually exists. OpenExternal is not claimed
// (the TUI cannot open a browser), and ExternalRedirect is not claimed (it needs
// a loopback HTTP server plus a browser).

import { liveTui } from '../bridge.js'
import {
  copyTextImplementation,
  notificationImplementation,
  userInteractionImplementation,
} from '@dsh-std/presentation'

// The operations the TUI's modals genuinely implement. Everything listed here
// must have a working prompt behind it: the standard's `support` means an
// available implementation, not an intention. `secret-input` joins this list in
// Task 11, when its standalone prompt lands.
export function presentationOperations() {
  return ['question', 'approval']
}

const UNAVAILABLE = (reason) => ({ status: 'unavailable', reason })

async function withLiveTui(fn) {
  const handle = liveTui()
  if (!handle) return UNAVAILABLE('no live dsh-oc-tui instance')
  return fn(handle)
}

// The handlers on their own, so they can be tested without going through the
// factories' dispatch and validation layer.
//
// The second argument is the protocol's CapabilityHandlerContext, and it must be
// forwarded to the live TUI: the abort signal lives there (`context.signal`), not
// on the request — PresentationRequestContext is only requestId / invocationId /
// origin / deadline. Dropping it would leave a modal pending forever when the
// consumer goes away.
export function createPresentationHandlers() {
  return {
    userInteraction: {
      async interact(request, context) {
        return withLiveTui((handle) => handle.interact(request, context))
      },
    },
    notification: {
      async notify(request, context) {
        return withLiveTui((handle) => handle.notify(request, context))
      },
    },
    copyText: {
      async copyText(request, context) {
        return withLiveTui((handle) => handle.copyText(request, context))
      },
    },
  }
}

// Ready for `context.protocols.implement(impl.protocol, impl)`.
// `participantId` must be the facet's own activation participant id
// (`context.identity.participantId`): the adapter rejects any other value.
export function createPresentationImplementations(participantId) {
  const handlers = createPresentationHandlers()
  return [
    userInteractionImplementation(
      participantId,
      { operations: presentationOperations() },
      handlers.userInteraction,
    ),
    notificationImplementation(participantId, handlers.notification),
    copyTextImplementation(participantId, handlers.copyText),
  ]
}
