// The TUI's own command line: placement coordinate, the commands the TUI always
// owns, and their human-readable descriptions.
//
// ZERO imports, deliberately. lib/index.js (the cordis bundle entry, loaded on
// every profile start) needs this data, and anything it imports statically must
// not reach an optional peer — @dsh-std/* are optional peers npm does not
// install, so a module-scope import of one would make lib/index.js fail at load
// time and the TUI would not start at all.

// Product-owned coordinates use the tui.dsh/* namespace, per the ecosystem
// governance rules.
export const COMMAND_PLACEMENT = Object.freeze({ apiVersion: 'tui.dsh/v1alpha1', kind: 'CommandLine' })

// Commands the TUI always owns. /model and /provider are deliberately absent:
// runCommand asks ctx.commands.find() first, so the harness owns them whenever
// it registers them and the TUI only supplies the fallback.
export const TUI_OWNED_COMMANDS = Object.freeze([
  'settings', 'help', 'stats', 'new', 'resume', 'clear', 'cancel', 'rewind', 'quit',
])

// Mirrors the `title` of each contributed command in dsh-plugin.json.
export const COMMAND_DESCRIPTIONS = Object.freeze({
  settings: 'Open the TUI settings pages',
  help: 'Show the TUI key and command reference',
  stats: 'Show session token and cache statistics',
  new: 'Start a new session',
  resume: 'Resume a persisted session',
  clear: 'Clear the transcript',
  cancel: 'Cancel the running turn',
  rewind: 'Rewind the session to an earlier point',
  quit: 'Leave the TUI',
})
