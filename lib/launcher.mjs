#!/usr/bin/env node
/**
 * REA launcher for the DeepSeek Harness plugin.
 *
 * The MCP client bridge (`@deepseek-ai/dsh-mcp-client`) spawns this file over
 * `stdio` transport, so this process owns one job: find the REA CLI, hand it
 * the same argv, and forward stdio byte-for-byte. Nothing is written to stdout
 * outside `--plan` mode, because stdout carries the MCP protocol.
 *
 * Resolution order (first match wins):
 *   1. REA_AGENTS_ENTRY — explicit rea-agents package root, `scripts/rea.mjs`,
 *                         or any executable. REA_DSH_ENTRY is accepted as a
 *                         legacy alias for explicitly configured environments.
 *   2. the plugin's own optional dependency `rea-agents`, resolved from this
 *                         file's location so pnpm's isolated layout works.
 *   3. `rea` / `rea-agents` on PATH — a global `npm i -g rea-agents`.
 *   4. `npx -y rea-agents@<pinned>` — last resort, requires registry access.
 *
 * The Node that runs REA must satisfy rea-agents' engines range
 * (^22.19.0 || ^24.11.0 || >=26.0.0). REA_AGENTS_NODE overrides the choice;
 * otherwise the harness Node is used when it qualifies, then the first
 * qualifying Node on PATH.
 */

import { spawn, execFileSync } from "node:child_process";
import { accessSync, appendFileSync, constants, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";

/**
 * Optional one-line-per-event trace. The harness starts this file from a
 * process whose stderr nobody reads, so `REA_DSH_TRACE` names a file to append
 * to instead; it is capped so a long-lived profile cannot grow without bound.
 * Tracing never throws: a diagnostic must not break the server.
 */
const tracePath = process.env.REA_DSH_TRACE;
const trace = (event, detail) => {
  if (tracePath === undefined || tracePath === "") return;
  try {
    if (statSync(tracePath, { throwIfNoEntry: false })?.size > 131_072) writeFileSync(tracePath, "");
    appendFileSync(tracePath, `${new Date().toISOString()} ${event} ${detail ?? ""}\n`);
  } catch {
    // Ignore: tracing is best effort.
  }
};

/** Pinned REA release used by the npx fallback and reported in diagnostics. */
const readPinnedVersion = () => {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
    return manifest.optionalDependencies?.["rea-agents"] ?? "latest";
  } catch {
    return "latest";
  }
};

const PINNED_REA = readPinnedVersion();

/** rea-agents engines: ^22.19.0 || ^24.11.0 || >=26.0.0 */
const supportsRea = (version) => {
  const [major = 0, minor = 0] = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (major === 22) return minor >= 19;
  if (major === 24) return minor >= 11;
  return major >= 26;
};

const fileExists = (path) => {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

/** Locate one executable name across PATH, honouring PATHEXT on Windows. */
const findOnPath = (name, environment = process.env) => {
  const extensions = windows
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
};

/** The REA entry file inside an installed `rea-agents` package root. */
const entryOfPackage = (packageRoot) => {
  for (const relative of ["scripts/rea.mjs", "bin/rea.mjs"]) {
    const candidate = join(packageRoot, relative);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
};

const isScript = (path) => /\.(mjs|cjs|js)$/iu.test(path);

const resolveRea = () => {
  const explicit = process.env.REA_AGENTS_ENTRY ?? process.env.REA_DSH_ENTRY;
  if (explicit !== undefined && explicit.trim() !== "") {
    const target = resolve(explicit.trim());
    if (!fileExists(target)) return { kind: "missing", source: "REA_AGENTS_ENTRY", requested: target };
    const entry = target.endsWith("package.json")
      ? entryOfPackage(dirname(target))
      : isScript(target)
        ? target
        : entryOfPackage(target);
    if (entry !== undefined) return { kind: "node-entry", entry, source: "REA_AGENTS_ENTRY" };
    return { kind: "executable", command: target, source: "REA_AGENTS_ENTRY" };
  }

  try {
    const entry = entryOfPackage(dirname(require.resolve("rea-agents/package.json")));
    if (entry !== undefined) return { kind: "node-entry", entry, source: "bundled dependency" };
  } catch {
    // The optional dependency is absent; keep looking.
  }

  for (const name of ["rea", "rea-agents"]) {
    const command = findOnPath(name);
    if (command !== undefined) return { kind: "executable", command, source: `PATH (${name})` };
  }

  const npx = findOnPath("npx");
  if (npx !== undefined)
    return { kind: "npx", command: npx, args: ["-y", `rea-agents@${PINNED_REA}`], source: "npx fallback" };

  return { kind: "missing", source: "none" };
};

const nodeVersionOf = (command) => {
  try {
    return execFileSync(command, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch {
    return undefined;
  }
};

/**
 * Choose the Node that will run REA, preferring a real Node over the harness
 * executable.
 *
 * Under ELECTRON_RUN_AS_NODE the harness executable behaves as Node, but its
 * module ABI is Electron's. REA loads native addons (node-pty,
 * rea-windows-x64.node), and a mismatched ABI aborts the child during startup
 * with exit code 0xFFFF0003 before the MCP handshake — verified by trace on
 * this platform. `process.versions.electron` therefore disqualifies execPath;
 * a Node on PATH is used instead, and the harness runtime only remains as the
 * last resort for a machine with no Node at all.
 */
const resolveNode = () => {
  const requested = process.env.REA_AGENTS_NODE;
  if (requested !== undefined && requested.trim() !== "") {
    const command = resolve(requested.trim());
    if (fileExists(command)) return { command, source: "REA_AGENTS_NODE" };
  }
  const onPath = findOnPath("node");
  if (onPath !== undefined) {
    const version = nodeVersionOf(onPath);
    if (version !== undefined && supportsRea(version)) return { command: onPath, source: `PATH node ${version}` };
  }
  if (process.versions.electron === undefined && supportsRea(process.versions.node))
    return { command: process.execPath, source: `harness node ${process.versions.node}` };
  return {
    command: process.execPath,
    source:
      process.versions.electron === undefined
        ? `harness node ${process.versions.node} (outside the rea-agents engines range)`
        : `harness electron ${process.versions.electron}; no Node on PATH satisfies rea-agents, so native addons may abort this child`,
  };
};

/** Arguments for cmd.exe must not smuggle shell syntax into an npx fallback. */
const SHELL_UNSAFE = /["%&|<>^!()\r\n]/u;

const spawnPlan = (plan, args) => {
  const options = { stdio: "inherit", env: process.env, cwd: process.cwd() };
  if (plan.kind === "node-entry") {
    const node = resolveNode();
    return {
      child: spawn(node.command, [plan.entry, ...args], options),
      description: `"${node.command}" "${plan.entry}"`,
    };
  }
  const argv = [...(plan.args ?? []), ...args];
  if (windows && /\.(cmd|bat)$/iu.test(plan.command)) {
    if (argv.some((value) => SHELL_UNSAFE.test(value))) {
      return { error: `refusing to pass shell-unsafe arguments through ${plan.command}` };
    }
    const line = [plan.command, ...argv].map((value) => (/[\s]/u.test(value) ? `"${value}"` : value)).join(" ");
    return {
      child: spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
        ...options,
        windowsVerbatimArguments: true,
      }),
      description: line,
    };
  }
  return { child: spawn(plan.command, argv, options), description: [plan.command, ...argv].join(" ") };
};

const report = (plan) => {
  const node = plan.kind === "node-entry" ? resolveNode() : undefined;
  return {
    plugin: "rea-dsh-plugin",
    pinnedReaVersion: PINNED_REA,
    kind: plan.kind,
    source: plan.source,
    requested: plan.requested,
    entry: plan.entry,
    command: plan.command,
    args: plan.args,
    node: node?.command,
    nodeSource: node?.source,
    harness: { platform: process.platform, arch: process.arch, node: process.versions.node },
  };
};

const main = () => {
  const argv = process.argv.slice(2);
  trace(
    "start",
    JSON.stringify({ argv, cwd: process.cwd(), execPath: process.execPath, node: process.versions.node }),
  );
  const plan = resolveRea();
  trace("plan", JSON.stringify(plan));

  if (argv[0] === "--plan" || argv[0] === "--resolve") {
    process.stdout.write(`${JSON.stringify(report(plan), null, 2)}\n`);
    return;
  }

  if (plan.kind === "missing") {
    trace("missing", plan.source);
    process.stderr.write(
      `rea-dsh-plugin: REA was not found (${plan.source}).\n` +
        "Install it with `npm install -g rea-agents`, reinstall this plugin so its\n" +
        "optional dependency resolves, or point REA_AGENTS_ENTRY at the rea-agents\n" +
        "package root or at scripts/rea.mjs.\n",
    );
    process.exitCode = 127;
    return;
  }

  const started = spawnPlan(plan, argv);
  if (started.error !== undefined) {
    trace("spawn-refused", started.error);
    process.stderr.write(`rea-dsh-plugin: ${started.error}\n`);
    process.exitCode = 127;
    return;
  }
  const { child, description } = started;
  trace("exec", description);
  if (plan.kind === "node-entry") {
    const node = resolveNode();
    if (node.command === process.execPath && process.versions.electron !== undefined)
      trace("warning", "running REA on the harness Electron runtime; native addons may abort it");
  }
  if (process.env.REA_DSH_DEBUG === "1") process.stderr.write(`rea-dsh-plugin: exec ${description}\n`);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.on("error", (error) => {
    trace("error", error.message);
    process.stderr.write(`rea-dsh-plugin: could not start REA: ${error.message}\n`);
    process.exitCode = 127;
  });
  child.on("exit", (code, signal) => {
    trace("exit", JSON.stringify({ code, signal }));
    process.exitCode = code ?? 1;
  });
};

main();
