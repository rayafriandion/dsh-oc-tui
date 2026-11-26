import { t, tv } from './i18n.js'

export function teamSnapshot(ctx, agent) {
  const teams = ctx.get('agentTeams')
  if (!agent || !teams?.isEnabled) return null
  const root = ctx.get('subagents')?.rootOf?.(agent) ?? agent
  // Team's command API rejects reads while disabled; its public projection
  // retains the board so switching mode never hides the saved tasks.
  const view = ctx.get('sessionProjections')?.snapshot?.(root.session, ['agentTeam'])?.values?.agentTeam
  if (view) return { enabled: view.enabled, tasks: view.tasks ?? [] }
  const enabled = teams.isEnabled(agent)
  return { enabled, tasks: enabled ? teams.listTasks?.(agent) ?? [] : [] }
}

export function teamModeRow(ctx, agent) {
  if (!ctx.get('agentTeams')?.setEnabled) return null
  const state = teamSnapshot(ctx, agent)
  return {
    kind: 'team-mode', label: t('team.mode'), value: state?.enabled ? 'on' : 'off',
    valueLabel: state ? tv(state.enabled ? 'on' : 'off') : t('session.startFirst'),
    options: ['off', 'on'].map((value) => ({ value, label: tv(value) })), disabled: !agent,
    agentId: agent ? String(agent.session.id) : undefined,
  }
}

export function teamBoard(ctx, agent) {
  const state = teamSnapshot(ctx, agent)
  const items = []
  const mode = teamModeRow(ctx, agent)
  if (mode) items.push(mode)
  for (const task of state?.tasks ?? []) {
    items.push({
      label: task.subject, value: [task.id, t('team.status.' + task.status), task.ownerName || task.ownerId].filter(Boolean).join(' · '),
      disabled: true,
    })
    if (task.description) items.push({ label: task.description, wide: true, indent: 1, disabled: true })
    if (task.blockedBy?.length) items.push({
      label: t('team.blockedBy', { ids: task.blockedBy.join(', ') }), wide: true, indent: 1, disabled: true,
    })
    for (const warning of task.writeScopeWarnings ?? []) {
      items.push({ label: warning, wide: true, indent: 1, tone: 'warning', disabled: true })
    }
  }
  if (!state?.tasks.length) items.push({ label: t('team.empty'), disabled: true, selectable: false })
  return { items, title: t('team.title'), subtitle: '/team', settings: null }
}
