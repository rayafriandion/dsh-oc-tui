// The @dsh-std facet entry declared by dsh-plugin.json.
//
// HARD CONSTRAINT: this module must never start the TUI. The TUI's lifecycle
// belongs to the cordis bundle rows in cordis.patch.yml; the adapter mounts
// this facet in ADDITION to those rows, and the TUI seizes the terminal
// (raw mode, alt screen, mouse tracking), so a second instance would fight the
// first rather than merely duplicate it.
//
// The facet is therefore an interop surface: it publishes protocol
// implementations whose handlers forward through lib/bridge.js to whichever TUI
// instance is live, and reports `degraded` when none is.
//
// @dsh-std/sdk is loaded dynamically and defensively. A throw from this module
// makes the adapter's mountProfileComponents roll back EVERY component it had
// already mounted in the profile, so a missing peer dependency here must
// degrade, never throw.

const DEGRADED_MESSAGE =
  'dsh-oc-tui is activated by its cordis bundle rows (cordis.patch.yml); '
  + 'no live TUI instance is registered, so no protocol support is published.'

export default {
  async activate(context) {
    try {
      // Presence check only: the protocol modules import what they need
      // themselves. The guard stays because a throw here would roll back every
      // component the adapter had already mounted in this profile.
      await import('@dsh-std/sdk')
    } catch {
      // Peer dependency absent: nothing to publish. snapshot() already reports
      // the state, so activation stays a no-op rather than an error.
      return
    }
    const dispose = await activateProtocols(context)
    context.scope.add(dispose)
  },

  async deactivate() {
    // Everything is registered through context.scope, which the lifecycle
    // coordinator disposes on deactivation. Nothing to do here.
  },

  async snapshot() {
    const { liveTui } = await import('./bridge.js')
    if (!liveTui()) return { state: 'degraded', message: DEGRADED_MESSAGE }
    return { state: 'active' }
  },
}

// Each protocol lands in its own task; the list grows as they do.
async function activateProtocols(context) {
  const disposers = []

  // Imported dynamically so a missing @dsh-std/presentation degrades this facet
  // instead of throwing: a throw here makes the adapter's
  // mountProfileComponents roll back every component it had already mounted.
  let createPresentationImplementations
  try {
    ({ createPresentationImplementations } = await import('./std/presentation.js'))
  } catch {
    return () => {}
  }
  // The adapter validates each staged implementation: it must expose `handle`,
  // its participantId must equal this facet's activation participant id, and
  // its protocol must equal the support it is staged with
  // (packages/adapter-dsh/src/index.ts:1774).
  for (const implementation of createPresentationImplementations(context.identity.participantId)) {
    disposers.push(context.protocols.implement(implementation.protocol, implementation))
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* teardown must not mask the original failure */ }
    }
  }
}
