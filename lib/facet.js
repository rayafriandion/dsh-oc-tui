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
// The optional peers that can throw are @dsh-std/presentation and
// @dsh-std/command, imported dynamically by activateProtocols. A throw from
// this module makes the adapter's mountProfileComponents roll back EVERY
// component it had already mounted in the profile, so those imports are
// guarded and a missing peer degrades, never throws.

const DEGRADED_MESSAGE =
  'dsh-oc-tui is activated by its cordis bundle rows (cordis.patch.yml); '
  + 'no live TUI instance is registered, so no protocol support is published.'

const NO_DECLARED_SUPPORTS_MESSAGE =
  'a Community v0.15 manifest cannot declare protocol supports, and the lifecycle '
  + 'requires a declared support before a facet may stage one; no protocol support '
  + 'is published. See the plan\'s blocking-findings section.'

// Whether the last activate() staged nothing because the facet declares no
// supports. Assigned on every activate path so a later activation with declared
// supports clears it.
let stagedNothing = false

export default {
  async activate(context) {
    // A facet may only stage protocols that its OWN projection declares as
    // supports: LifecycleCoordinator.stageProtocol throws
    // `facet attempted to implement undeclared protocol ...` for anything else,
    // and a throw here makes the adapter's mountProfileComponents roll back
    // every component in the profile.
    //
    // A Community v0.15 manifest cannot declare supports at all — the schema
    // rejects both `requires.supports` and a top-level `supports`, and
    // projectManifest emits only `protocols.requires` — and nothing in
    // adapter-dsh writes protocols.supports onto a facet either. So for this
    // plugin the declared list is empty, and staging anything would throw. We
    // therefore stage nothing and let snapshot() report why. If upstream ever
    // lets a v0.15 component declare supports, this same code stages normally.
    //
    // No presence probe for @dsh-std/sdk: nothing in lib/ consumes it, and the
    // only optional peer that can actually throw is @dsh-std/presentation,
    // which activateProtocols guards itself. A probe here would silently
    // suppress the registration whenever sdk alone is absent, even though
    // nothing needs it.
    if (declaredSupports(context).length === 0) {
      stagedNothing = true
      return
    }
    stagedNothing = false
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
    if (stagedNothing) return { state: 'degraded', message: NO_DECLARED_SUPPORTS_MESSAGE }
    return { state: 'active' }
  },
}

// The supports this facet's own projection declares, or [] when it declares
// none. Matched on participantId first because it is unique per activation,
// falling back to the facet name.
function declaredSupports(context) {
  const selected = context?.plan?.selected ?? []
  const mine = selected.find((row) => row?.participantId === context?.identity?.participantId)
    ?? selected.find((row) => row?.identity?.facet === context?.identity?.facet)
  return mine?.facet?.protocols?.supports ?? []
}

// Each protocol lands in its own task; the list grows as they do.
async function activateProtocols(context) {
  const disposers = []
  const disposeAll = () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* teardown must not mask the original failure */ }
    }
  }

  // Imported dynamically so a missing @dsh-std/presentation degrades this facet
  // instead of throwing: a throw here makes the adapter's
  // mountProfileComponents roll back every component it had already mounted.
  let createPresentationImplementations
  try {
    ({ createPresentationImplementations } = await import('./std/presentation.js'))
  } catch {
    return disposeAll
  }
  // The adapter validates each staged implementation: it must expose `handle`,
  // its participantId must equal this facet's activation participant id, and
  // its protocol must equal the support it is staged with
  // (packages/adapter-dsh/src/index.ts:1774).
  for (const implementation of createPresentationImplementations(context.identity.participantId)) {
    disposers.push(context.protocols.implement(implementation.protocol, implementation))
  }

  // lib/std/commands.js statically imports @dsh-std/command, which npm does not
  // install (optional peer). A failed import degrades the command surface only:
  // presentation stays published, and the disposer returned below still tears
  // those registrations down.
  let createCommandRuntimeImplementation
  try {
    ({ createCommandRuntimeImplementation } = await import('./std/commands.js'))
  } catch {
    return disposeAll
  }
  // The adapter validates the staged implementation and requires its
  // participantId to equal this facet's activation participant id
  // (packages/adapter-dsh/src/index.ts:1774).
  const commandRuntime = createCommandRuntimeImplementation(context.identity.participantId)
  disposers.push(context.protocols.implement(commandRuntime.protocol, commandRuntime))

  return disposeAll
}
