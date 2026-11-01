#!/usr/bin/env node
/**
 * mcp-sse-bridge — mount a legacy MCP HTTP+SSE server as a stdio MCP server.
 *
 * The host's mcp-client speaks only stdio and streamable-http, and the bundled
 * MCP SDK has no legacy SSE transport. This script proxies newline-delimited
 * JSON-RPC on stdin/stdout to a legacy HTTP+SSE endpoint (MCP 2024-11-05):
 *
 *   GET  <url>            Accept: text/event-stream -> `event: endpoint` (POST url),
 *                                                     then `event: message` frames
 *   POST <endpoint>       application/json          -> the server replies on the stream
 *
 * stdout is the MCP wire: diagnostics go to stderr only.
 *
 * Zero dependencies, `node:` builtins only (needs global fetch, Node >= 20).
 */

import process from 'node:process';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 30000;

const USAGE = [
  'Usage: node bin/mcp-sse-bridge.mjs [options]',
  '',
  'Bridge a legacy MCP HTTP+SSE endpoint to newline-delimited JSON-RPC on stdio.',
  '',
  'Options:',
  '  --url <url>             SSE endpoint URL (env: MCP_SSE_URL)',
  '  --header "Name: value"  Extra request header; repeatable (env: MCP_SSE_HEADERS, JSON object)',
  '  --timeout-ms <n>        Connect/POST timeout in ms (env: MCP_SSE_TIMEOUT_MS)',
  '  --help                  Print this help and exit 0',
  '',
].join('\n');

class UsageError extends Error {}

/* ------------------------------------------------------------------ config */

function parseHeader(value) {
  const idx = value.indexOf(':');
  if (idx <= 0) throw new UsageError(`invalid --header (expected "Name: value"): ${value}`);
  const name = value.slice(0, idx).trim();
  const val = value.slice(idx + 1).trim();
  if (!name) throw new UsageError(`invalid --header (empty name): ${value}`);
  return [name, val];
}

function parseTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new UsageError(`invalid timeout: ${value} (expected a positive integer of milliseconds)`);
  }
  return n;
}

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  const existing = headers.findIndex(([k]) => k.toLowerCase() === lower);
  if (existing === -1) headers.push([name, value]);
  else headers[existing] = [name, value];
}

function parseArgv(argv) {
  const out = { help: false, url: undefined, headers: [], timeoutMs: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let name = arg;
    let inline;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const take = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`missing value for ${name}`);
      return next;
    };
    switch (name) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--url':
        out.url = take();
        break;
      case '--header':
        out.headers.push(parseHeader(take()));
        break;
      case '--timeout-ms':
        out.timeoutMs = parseTimeout(take());
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return out;
}

/** argv wins over env. */
function resolveConfig(argv, env) {
  const parsed = parseArgv(argv);
  if (parsed.help) return { help: true };

  let url = parsed.url;
  if (url === undefined || url === '') url = env.MCP_SSE_URL;
  if (url === undefined || url === '') {
    throw new UsageError('missing required --url (or MCP_SSE_URL)');
  }

  const headers = [];
  const rawHeaders = env.MCP_SSE_HEADERS;
  if (rawHeaders !== undefined && rawHeaders !== '') {
    let obj;
    try {
      obj = JSON.parse(rawHeaders);
    } catch (err) {
      throw new UsageError(`MCP_SSE_HEADERS is not valid JSON: ${err.message}`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new UsageError('MCP_SSE_HEADERS must be a JSON object of string values');
    }
    for (const [k, v] of Object.entries(obj)) {
      const t = typeof v;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        throw new UsageError(`MCP_SSE_HEADERS["${k}"] must be a string value`);
      }
      setHeader(headers, k, String(v));
    }
  }
  for (const [k, v] of parsed.headers) setHeader(headers, k, v);

  let timeoutMs = parsed.timeoutMs;
  if (timeoutMs === undefined && env.MCP_SSE_TIMEOUT_MS !== undefined && env.MCP_SSE_TIMEOUT_MS !== '') {
    timeoutMs = parseTimeout(env.MCP_SSE_TIMEOUT_MS);
  }
  if (timeoutMs === undefined) timeoutMs = DEFAULT_TIMEOUT_MS;

  return { help: false, url, headers, timeoutMs };
}

/* --------------------------------------------------------------- SSE parser */

/**
 * Incremental text/event-stream parser: `field: value` lines, blank line
 * dispatches the frame, `data:` lines of one frame join with "\n", leading
 * `:` lines are comments, CRLF (and lone CR) tolerated, multi-line data kept.
 */
function createSseParser(onFrame) {
  let lineBuf = '';
  let eventName = '';
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length === 0 && eventName === '') return;
    const frame = { event: eventName || 'message', data: dataLines.join('\n') };
    eventName = '';
    dataLines = [];
    onFrame(frame);
  };

  const handleLine = (line) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const idx = line.indexOf(':');
    let field;
    let value;
    if (idx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, idx);
      value = line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id:` / `retry:` / unknown fields are ignored.
  };

  return {
    push(chunk) {
      let text = lineBuf + chunk;
      text = text.replace(/\r\n/g, '\n');
      let hold = '';
      if (text.endsWith('\r')) {
        hold = '\r';
        text = text.slice(0, -1);
      }
      text = text.replace(/\r/g, '\n');
      lineBuf = hold;
      let idx;
      while ((idx = text.indexOf('\n')) !== -1) {
        const line = text.slice(0, idx);
        text = text.slice(idx + 1);
        handleLine(line);
      }
      lineBuf += text;
    },
    end() {
      if (lineBuf !== '') {
        const line = lineBuf;
        lineBuf = '';
        handleLine(line);
      }
      dispatch();
    },
  };
}

/* -------------------------------------------------------------------- main */

async function run(config) {
  let target;
  try {
    target = new URL(config.url);
  } catch {
    process.stderr.write(`mcp-sse-bridge: invalid url: ${config.url}\n`);
    return 2;
  }

  const headersObject = {};
  for (const [k, v] of config.headers) headersObject[k] = v;

  let exiting = false;
  let reader = null;
  const controller = new AbortController();
  let endpointValue = null;
  let endpointResolve;
  const endpointReady = new Promise((resolve) => {
    endpointResolve = resolve;
  });
  const queued = [];
  let rl = null;
  let postChain = Promise.resolve();
  let outQueue = Promise.resolve();

  const writeStdout = (text) => {
    outQueue = outQueue
      .then(
        () =>
          new Promise((resolve) => {
            let flushed = false;
            try {
              flushed = process.stdout.write(text);
            } catch {
              resolve();
              return;
            }
            if (flushed) resolve();
            else process.stdout.once('drain', resolve);
          }),
      )
      .catch(() => {});
    return outQueue;
  };

  /**
   * Exit by draining the event loop, not by calling process.exit(): on Windows
   * process.exit() while stdin is being torn down trips a libuv assertion
   * (`!(handle->flags & UV_HANDLE_CLOSING)`) and kills the bridge with a crash
   * code instead of the intended one. The unref'd fallback only fires if some
   * keep-alive handle (undici's pool) outlives stdin.
   */
  const releaseStdio = () => {
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
    try {
      if (typeof process.stdin.unref === 'function') process.stdin.unref();
    } catch {
      /* ignore */
    }
    const fallback = setTimeout(() => process.exit(process.exitCode ?? 0), 500);
    if (typeof fallback.unref === 'function') fallback.unref();
  };

  const shutdown = async (code, message) => {
    if (exiting) return code;
    exiting = true;
    if (message) process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
    if (rl) {
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    }
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    try {
      await postChain;
    } catch {
      /* ignore */
    }
    try {
      await outQueue;
    } catch {
      /* ignore */
    }
    process.exitCode = code;
    releaseStdio();
    return code;
  };

  /** One POST per line, serialized so stdin order is preserved. */
  const post = (line) => {
    postChain = postChain.then(async () => {
      if (exiting) return;
      try {
        const res = await fetch(endpointValue, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headersObject,
          },
          body: line,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (!res.ok) {
          process.stderr.write(
            `mcp-sse-bridge: POST ${endpointValue} failed: ${res.status} ${res.statusText}\n`,
          );
        }
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore body drain errors */
        }
      } catch (err) {
        process.stderr.write(
          `mcp-sse-bridge: POST ${endpointValue} error: ${err && err.message ? err.message : err}\n`,
        );
      }
    });
    return postChain;
  };

  const onFrame = (frame) => {
    if (frame.event === 'endpoint') {
      if (endpointValue !== null) return;
      const raw = frame.data.trim();
      let resolved;
      try {
        resolved = new URL(raw, target);
      } catch {
        shutdown(1, `mcp-sse-bridge: server sent an invalid endpoint URL: ${frame.data}`);
        return;
      }
      endpointValue = resolved.href;
      endpointResolve();
      for (const line of queued) post(line);
      queued.length = 0;
      return;
    }
    if (frame.event === 'message') {
      if (!exiting) writeStdout(`${frame.data}\n`);
    }
  };

  const consumeSse = async () => {
    let res;
    let connectTimedOut = false;
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      controller.abort();
    }, config.timeoutMs);
    try {
      res = await fetch(target, {
        headers: { accept: 'text/event-stream', ...headersObject },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(connectTimer);
      const detail = connectTimedOut
        ? `timed out after ${config.timeoutMs}ms`
        : err && err.message
          ? err.message
          : String(err);
      return shutdown(1, `mcp-sse-bridge: GET ${target.href} failed: ${detail}`);
    }
    clearTimeout(connectTimer);
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return shutdown(1, `mcp-sse-bridge: GET ${target.href} returned ${res.status} ${res.statusText}`);
    }
    if (!res.body) return shutdown(1, `mcp-sse-bridge: GET ${target.href} returned no body`);

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser(onFrame);
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (exiting) return 0;
        return shutdown(
          1,
          `mcp-sse-bridge: SSE stream error: ${err && err.message ? err.message : err}`,
        );
      }
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    if (exiting) return 0;
    parser.end();
    return shutdown(1, 'mcp-sse-bridge: SSE stream closed by the server');
  };

  const sseTask = consumeSse().catch((err) =>
    shutdown(1, `mcp-sse-bridge: fatal SSE error: ${err && err.stack ? err.stack : err}`),
  );

  process.stdin.on('error', () => {});
  process.stdout.on('error', () => {});
  rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (exiting) break;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (endpointValue === null) queued.push(trimmed);
    else post(trimmed);
  }

  if (exiting) {
    await sseTask;
    return 0;
  }

  // stdin EOF: wait a bounded time for the endpoint so queued messages can be
  // flushed, then exit 0.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, config.timeoutMs);
    endpointReady.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (endpointValue === null && queued.length > 0) {
    process.stderr.write(
      `mcp-sse-bridge: stdin closed before the SSE endpoint arrived; dropped ${queued.length} queued message(s)\n`,
    );
  }
  try {
    await postChain;
  } catch {
    /* ignore */
  }
  return shutdown(0);
}

async function main() {
  let config;
  try {
    config = resolveConfig(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`mcp-sse-bridge: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (config.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  return run(config);
}

main().then(
  (code) => {
    if (typeof code === 'number') process.exitCode = process.exitCode ?? code;
  },
  (err) => {
    process.stderr.write(`mcp-sse-bridge: fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
