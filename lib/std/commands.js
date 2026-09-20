// CommandRuntime for the TUI: the TUI *hosts* a command line, so it provides
// the runtime that lists and executes commands.
//
// It only answers for its own placement coordinate. A command published without
// placements is publishable on every surface, so filtering by placement is what
// keeps a web UI from offering /settings and /rewind, which it cannot run.
//
// The implementation comes from @dsh-std/command's factory rather than being
// hand-built, because the adapter validates what a facet stages:
//
//   capabilityImplementation(participantId, support, value)
//     requires typeof value.handle === 'function'
//     requires value.participantId === the facet's activation participantId
//     requires sameProtocol(value.protocol, support)
//
// (packages/adapter-dsh/src/index.ts:1774). A plain { catalog, execute } object
// throws there, and a throw during mount rolls back every component in the
// profile — so the factory is not a convenience, it is the contract. That static
// import is also why the facet must load this module with a dynamic import
// inside its existing try/catch, exactly as it does for lib/std/presentation.js.

import { liveTui } from '../bridge.js'
import { commandRuntimeImplementation } from '@dsh-std/command'
import { COMMAND_PLACEMENT, TUI_OWNED_COMMANDS, COMMAND_DESCRIPTIONS } from './command-list.js'

// The peer-free data lives in ./command-list.js so lib/index.js can read it
// without reaching @dsh-std/command. Re-exported here so this module stays the
// single import site for its existing consumers and tests.
export { COMMAND_PLACEMENT, TUI_OWNED_COMMANDS, COMMAND_DESCRIPTIONS } from './command-list.js'

export const COMMAND_API_VERSION = 'commands.dsh/v1alpha1'

function placementMatches(placement) {
  return placement?.apiVersion === COMMAND_PLACEMENT.apiVersion
    && placement?.kind === COMMAND_PLACEMENT.kind
}

const EMPTY_CATALOG = Object.freeze({ apiVersion: COMMAND_API_VERSION, commands: Object.freeze([]) })

// The raw command name out of a command line, for the execution receipt. The
// standard does not define a tokenizer, so this deliberately only strips the
// leading slash and stops at the first whitespace.
function commandNameOf(line) {
  const trimmed = String(line ?? '').trim()
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  const match = /^[^\s]+/.exec(withoutSlash)
  return match ? match[0] : ''
}

// The handler on its own, so it can be tested without the factory's dispatch
// and input validation.
export function createCommandRuntimeHandler() {
  return {
    async catalog(input) {
      if (!placementMatches(input?.placement)) return EMPTY_CATALOG
      const handle = liveTui()
      if (!handle) return EMPTY_CATALOG
      const commands = await handle.commandCatalog(input)
      return { apiVersion: COMMAND_API_VERSION, commands: commands ?? [] }
    },

    async execute(input) {
      if (!placementMatches(input?.placement)) return undefined
      const handle = liveTui()
      if (!handle) return undefined
      const result = await handle.executeCommand(String(input.line ?? ''), input)
      if (result === undefined || result === null) return undefined
      return { apiVersion: COMMAND_API_VERSION, commandId: commandNameOf(input.line), result }
    },
  }
}

// Ready for `context.protocols.implement(impl.protocol, impl)`.
// `participantId` must be the facet's own activation participant id
// (`context.identity.participantId`): the adapter rejects any other value.
export function createCommandRuntimeImplementation(participantId) {
  return commandRuntimeImplementation(participantId, createCommandRuntimeHandler())
}
