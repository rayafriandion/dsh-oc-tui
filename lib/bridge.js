// The live-TUI registry: the one place that answers "is a TUI instance running,
// and how do I reach it".
//
// The @dsh-std facet (lib/facet.js) does not own the TUI's lifecycle — the
// cordis bundle rows in cordis.patch.yml do. The facet only publishes protocol
// implementations whose handlers forward here. Because the adapter's mount
// order relative to the bundle rows is not guaranteed, handlers must look the
// handle up at call time (late binding) rather than capture it at activation.
//
// No dependencies: lib/index.js imports this, so it must stay free of anything
// that could fail to resolve in a lean profile.

let active = null

// Register the running TUI. Returns an idempotent release function that only
// clears the registry if this registration is still the current one — a newer
// registration must survive an older one's teardown.
export function registerLiveTui(handle) {
  active = handle
  let released = false
  return () => {
    if (released) return
    released = true
    if (active === handle) active = null
  }
}

// The current TUI handle, or null when no TUI is running. Callers must handle
// null: it is the normal state when the facet is mounted in a profile whose
// bundle rows did not load.
export function liveTui() {
  return active
}
