// How a model or reasoning-effort choice reaches the agent, across the two host
// generations.
//
// dsh 0.2.1 and earlier own no selection state: the only lever is the
// `agent/request` waterfall, and a listener there is expected to hand back a
// different provider/model (0.2.1's loop only rejects a config that names
// neither).
//
// dsh 0.2.2 fixes the route at step preparation — before prompt assembly and
// before `agent/pre-step` — and makes that same waterfall reject a changed
// route by throwing `agent/request proposed "…" after step preparation fixed
// "…"`, which kills the turn. A choice has to be recorded between steps with
// `agent.model.select()`, which appends a durable `model/selection` event.
//
// Both paths are selected by feature detection on the live agent rather than by
// a version string: `agent.model` does not exist on the older line at all, so
// its presence is the honest discriminator and one build keeps working on both.

export function recordsSelections(agent) {
  return Boolean(agent && agent.model && typeof agent.model.select === 'function')
}

// The route/effort overrides the `agent/request` waterfall should return, or
// null when the config already carries what the TUI wants.
//
// `config` is what the loop proposed, `preference` the TUI's own choice (an
// explicit /model or /provider, else anything set from the settings surface),
// `defaults` the resolved agent options, and `effort` the validated reasoning
// level — `undefined` keeps the adapter's default behavior.
export function legacyRouteOverrides(config, preference, defaults, effort) {
  const overrides = {}
  if (preference?.provider) overrides.provider = preference.provider
  else if (!config?.provider && defaults?.provider) overrides.provider = defaults.provider
  if (preference?.model) overrides.model = preference.model
  else if (!config?.model && defaults?.model) overrides.model = defaults.model
  if (effort) overrides.reasoningEffort = effort
  return Object.keys(overrides).length === 0 ? null : overrides
}

// Record one complete selection on a host that owns it. `preference` wins over
// the agent's current selection, which in turn wins over what the view shows —
// so a `/model` without a provider still writes a complete pair.
//
// `withEffort` is opt-in on purpose: a model switch drops the explicit effort so
// the new adapter's default applies (`loadEffortSlider` then re-reads that
// model's own ladder), while an effort change always carries it. A selection
// equal to the recorded one is a no-op on the host side, so callers do not have
// to compare first.
export function recordSelection(agent, preference, view, { withEffort = false, effort } = {}) {
  if (!recordsSelections(agent)) return null
  const current = typeof agent.model.current === 'function' ? agent.model.current() ?? {} : {}
  const provider = preference?.provider ?? current.provider ?? view?.provider
  const model = preference?.model ?? current.model ?? view?.model
  if (!provider || !model) return null
  const selection = { provider, model }
  if (withEffort && effort) selection.reasoningEffort = effort
  try {
    agent.model.select(selection)
  } catch {
    // A host that rejects the selection (an unregistered route, a disposed
    // agent) must not take the interface down: the next request reports the
    // stale route through the loop's own error channel.
    return null
  }
  return selection
}
