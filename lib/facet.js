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
    const { liveTui } = await import('./bridge.js')
    let sdk
    try {
      sdk = await import('@dsh-std/sdk')
    } catch {
      // Peer dependency absent: nothing to publish. snapshot() already reports
      // the state, so activation stays a no-op rather than an error.
      return
    }
    const dispose = await activateProtocols(sdk, context, liveTui)
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

// Wired up in Task 8 / Task 10 / Task 14, one protocol per task.
async function activateProtocols() {
  return () => {}
}
