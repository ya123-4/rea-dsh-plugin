#!/usr/bin/env node
/**
 * MCP handshake probe used by `npm run verify`.
 *
 * Starts REA exactly the way the harness does — through `lib/launcher.mjs mcp`
 * — completes the MCP initialize/initialized exchange and lists tools, then
 * reports one JSON summary on stdout. Any launcher or REA stderr is forwarded
 * to this process's stderr so a failure is diagnosable.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(packageRoot, "lib", "launcher.mjs");

const child = spawn(process.execPath, [launcher, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });

const pending = new Map();
let nextId = 1;
const send = (method, params) => {
  const id = nextId++;
  pending.set(id, method);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return id;
};

const waitFor = (id, timeoutMs) =>
  new Promise((settle, fail) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (responses.has(id)) {
        const message = responses.get(id);
        if (message.error !== undefined) fail(new Error(`${pending.get(id)} failed: ${JSON.stringify(message.error)}`));
        else settle(message.result);
        return;
      }
      if (Date.now() > deadline) {
        fail(new Error(`${pending.get(id)} timed out after ${timeoutMs} ms`));
        return;
      }
      setTimeout(poll, 40);
    };
    poll();
  });

const responses = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  try {
    const message = JSON.parse(text);
    if (typeof message.id === "number") responses.set(message.id, message);
  } catch {
    process.stderr.write(`non-JSON line on MCP stdout: ${text.slice(0, 200)}\n`);
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
// A sandbox that denies pipe creation fails here; report it as a summary so the
// caller can distinguish "cannot test in this environment" from "REA is broken".
child.on("error", (error) => {
  process.stdout.write(`${JSON.stringify({ error: `could not spawn the launcher: ${error.message}` })}\n`);
  process.exitCode = 1;
});

const finish = (payload, code) => {
  child.stdin.end();
  child.kill();
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = code;
};

try {
  const initialize = send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "rea-dsh-plugin-verify", version: "0.1.0" },
  });
  const welcome = await waitFor(initialize, 180_000);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const listing = await waitFor(send("tools/list", {}), 180_000);
  const tools = (listing.tools ?? []).map((tool) => tool.name);
  finish(
    {
      serverName: welcome.serverInfo?.name,
      serverVersion: welcome.serverInfo?.version,
      protocolVersion: welcome.protocolVersion,
      toolCount: tools.length,
      sampleTools: tools.slice(0, 8),
      hasAnalyzeJavaScriptApplication: tools.includes("analyze_javascript_application"),
      hasOpenBinary: tools.includes("open_binary"),
    },
    0,
  );
} catch (error) {
  finish({ error: error instanceof Error ? error.message : String(error) }, 1);
}
