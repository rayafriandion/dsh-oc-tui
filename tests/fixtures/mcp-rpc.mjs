// The MCP messages the local fixtures answer, shared by the stdio and the
// legacy-SSE test servers so both prove the same protocol path.
//
// The protocol version is echoed from the client's own `initialize` request:
// the harness SDK proposes 2026-07-28 and falls back to older revisions, and a
// fixture that hardcoded one would only work for one SDK build.

export const FIXTURE_TOOL = {
  name: 'echo',
  description: 'Echo back the text argument',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'text to echo' } },
    required: ['text'],
    additionalProperties: false,
  },
}

// One request in, one response out — or null when the message needs no reply
// (a notification, or an unknown notification-shaped message).
export function handleRpc(message) {
  const { id, method, params } = message ?? {}
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tui-mcp-fixture', version: '1.0.0' },
      },
    }
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return null
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [FIXTURE_TOOL] } }
  if (method === 'tools/call') {
    const text = params?.arguments?.text
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo: ' + String(text ?? '') }] } }
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } }
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } }
  if (id === undefined) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } }
}
