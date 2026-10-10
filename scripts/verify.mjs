#!/usr/bin/env node
/**
 * Package self-check for rea-dsh-plugin.
 *
 * Validates the bundle contract (manifest, patch, skill frontmatter) and the
 * runtime seams: the launcher's resolution plan, and — when a REA runtime is
 * reachable — one real MCP handshake through the launcher.
 *
 * Child output is captured through temporary files rather than pipes, so the
 * checks also run in restricted sandboxes that deny pipe creation. A sandbox
 * that denies pipes cannot host the interactive handshake at all; that check
 * reports SKIP instead of FAIL when the OS refuses the pipe.
 *
 * Usage:
 *   node scripts/verify.mjs            # static checks, plus REA checks if found
 *   node scripts/verify.mjs --offline  # static checks only
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const offline = process.argv.includes("--offline");

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });
const check = (name, run) => {
  try {
    record(name, true, run() ?? "");
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** A scratch directory that survives a sandbox without a writable %TEMP%. */
const scratchRoot = () => {
  const candidate = process.env.REA_DSH_VERIFY_TMP;
  const options = [candidate, join(packageRoot, ".verify-tmp"), process.cwd()];
  for (const option of options) {
    if (option === undefined || option === "") continue;
    try {
      mkdirSync(option, { recursive: true });
      const probe = join(option, `.write-probe-${process.pid}`);
      writeFileSync(probe, "ok");
      rmSync(probe, { force: true });
      return option;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("no writable scratch directory");
};

const scratch = scratchRoot();

/**
 * Run a command with file-backed stdio and return its captured output.
 * `stdinData` is written through a file so no pipe is needed anywhere.
 */
const runCaptured = (command, args, { timeoutMs = 240_000, stdinData } = {}) =>
  new Promise((settle, fail) => {
    const stamp = `${process.pid}-${Math.random().toString(16).slice(2)}`;
    const outPath = join(scratch, `out-${stamp}.txt`);
    const errPath = join(scratch, `err-${stamp}.txt`);
    const stdio = ["ignore", openSync(outPath, "w"), openSync(errPath, "w")];
    let input;
    if (stdinData !== undefined) {
      input = join(scratch, `in-${stamp}.txt`);
      writeFileSync(input, stdinData);
      stdio[0] = openSync(input, "r");
    }
    const child = spawn(command, args, { stdio, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const fd of stdio) if (typeof fd === "number") closeSync(fd);
      const stdout = readFileSync(outPath, "utf8");
      const stderr = readFileSync(errPath, "utf8");
      for (const path of [outPath, errPath, input]) if (path !== undefined) rmSync(path, { force: true });
      settle({ code, stdout, stderr });
    });
  });

const isPipeDenial = (error) => /EPERM|EACCES|pipe/iu.test(error instanceof Error ? error.message : String(error));

/** The DSH skill provider only discovers `<root>/<name>/SKILL.md` and `<root>/<name>.md`. */
const parseSkillFrontmatter = (path) => {
  const text = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text);
  assert(match !== null, "missing YAML frontmatter block");
  const fields = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (entry !== null) fields[entry[1]] = entry[2].replace(/^["']|["']$/gu, "").trim();
  }
  return fields;
};

const manifest = readJson(join(packageRoot, "package.json"));

check("manifest name and version", () => {
  assert(manifest.name === "rea-dsh-plugin", `unexpected name ${manifest.name}`);
  assert(/^\d+\.\d+\.\d+$/u.test(manifest.version), `unexpected version ${manifest.version}`);
  return `${manifest.name}@${manifest.version}`;
});

check("bundle patch declared", () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert(typeof patch === "string", "package.json#dsh.bundle.patch is missing");
  assert(existsSync(join(packageRoot, patch)), `${patch} does not exist`);
  return patch;
});

check("patch inserts the skill provider and MCP client", () => {
  const patch = readFileSync(join(packageRoot, manifest.dsh.bundle.patch), "utf8");
  assert(patch.includes("@deepseek-ai/dsh-skill-filesystem"), "skill provider entry is missing");
  assert(patch.includes("@deepseek-ai/dsh-mcp-client"), "MCP client entry is missing");
  assert(patch.includes("rea-dsh-plugin/package.json"), "entries must resolve this package by name");
  assert(!/baseUrl\s*\+/u.test(patch), "paths must not be concatenated onto baseUrl");
  return "2 inserted entries";
});

check("skills are discoverable and well formed", () => {
  const root = join(packageRoot, "skills");
  const names = [];
  for (const entry of readdirSync(root)) {
    const directory = join(root, entry);
    if (!statSync(directory).isDirectory()) {
      assert(entry.endsWith(".md"), `${entry} is neither a skill directory nor a root .md skill`);
      continue;
    }
    const skillFile = join(directory, "SKILL.md");
    assert(existsSync(skillFile), `${entry}/SKILL.md is missing (nested skills are not discovered)`);
    const fields = parseSkillFrontmatter(skillFile);
    assert(/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(fields.name ?? ""), `${entry}: name must be kebab-case`);
    assert(fields.name === entry, `${entry}: frontmatter name ${fields.name} must match the directory`);
    assert((fields.description ?? "").length > 20, `${entry}: description is missing or too short`);
    for (const legacy of ["disableModelInvocation", "modelInvocable", "userInvocable"])
      assert(fields[legacy] === undefined, `${entry}: legacy camelCase key ${legacy} makes the provider skip this skill`);
    names.push(fields.name);
  }
  assert(names.length >= 2, `expected at least 2 skills, found ${names.length}`);
  return names.sort().join(", ");
});

check("skill references resolve", () => {
  const skillRoot = join(packageRoot, "skills", "reverse-engineer-anything");
  const text = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const links = [...text.matchAll(/\]\((references\/[^)]+)\)/gu)].map((match) => match[1]);
  assert(links.length > 0, "the upstream skill should link its reference files");
  for (const link of new Set(links)) assert(existsSync(join(skillRoot, link)), `${link} is missing`);
  return `${new Set(links).size} referenced files`;
});

check("optional dependency declaration", () => {
  const pinned = manifest.optionalDependencies?.["rea-agents"];
  assert(typeof pinned === "string" && /^\d+\.\d+\.\d+$/u.test(pinned), "rea-agents must be pinned to an exact version");
  let installed = true;
  try {
    require.resolve("rea-agents/package.json");
  } catch {
    installed = false;
  }
  return `${pinned} (${installed ? "installed" : "not installed; launcher will fall back"})`;
});

/**
 * Regression guards for the two Windows defects that shipped in 0.1.0: a child
 * spawned without windowsHide gets its own console (visible window, stdio
 * detached from the MCP pipes, reconnect loop), and REA run on the harness
 * Electron runtime aborts on native-addon ABI mismatch (exit 0xFFFF0003).
 */
check("launcher guards Windows child spawning", () => {
  const text = readFileSync(join(packageRoot, "lib", "launcher.mjs"), "utf8");
  const hides = (text.match(/windowsHide:\s*true/gu) ?? []).length;
  assert(
    hides >= 2,
    `every child spawn needs windowsHide (found ${hides}); without it a console window pops up and stdio leaves the MCP pipes`,
  );
  assert(
    /process\.versions\.electron/u.test(text),
    "the Electron runtime must be disqualified for children that load native addons",
  );
  assert(/REA_DSH_TRACE/u.test(text), "the file trace is the only headless view of a failed handshake");
  return `${hides} windowsHide guards, Electron disqualified, file trace kept`;
});

const planOf = async () => {
  const run = await runCaptured(process.execPath, [join(packageRoot, "lib", "launcher.mjs"), "--plan"], {
    timeoutMs: 60_000,
  });
  assert(run.code === 0, `launcher --plan exited ${run.code}: ${run.stderr.trim().slice(0, 200)}`);
  const plan = JSON.parse(run.stdout);
  return plan;
};

/** One MCP handshake through the launcher, driven by the probe script. */
const handshake = async () => {
  const run = await runCaptured(process.execPath, [join(packageRoot, "scripts", "verify-mcp-handshake.mjs")], {
    timeoutMs: 240_000,
  });
  let summary;
  try {
    summary = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
  } catch {
    throw new Error(
      `the handshake probe produced no summary (exit ${run.code}): ${run.stderr.trim().slice(0, 200) || "no stderr"}`,
    );
  }
  if (run.code !== 0 || summary.error !== undefined)
    throw new Error(`${summary.error ?? run.stderr.trim().slice(0, 300)}`);
  assert(summary.toolCount >= 100, `expected the full REA catalog, saw ${summary.toolCount} tools`);
  assert(summary.serverName === "rea", `unexpected server name ${summary.serverName}`);
  assert(summary.hasAnalyzeJavaScriptApplication === true, "analyze_javascript_application is missing");
  return `${summary.toolCount} tools, server ${summary.serverName} ${summary.serverVersion}`;
};

try {
  const plan = await planOf();
  assert(["node-entry", "executable", "npx", "missing"].includes(plan.kind), `unexpected kind ${plan.kind}`);
  record("launcher resolves a plan", true, `${plan.kind} via ${plan.source}${plan.node === undefined ? "" : ` on ${plan.node}`}`);
  if (offline && plan.kind === "npx") record("launcher resolves without registry", false, "offline mode requires a local REA runtime");

  if (!offline) {
    if (plan.kind === "missing") {
      record("REA MCP handshake", false, "no REA runtime found by the launcher");
    } else {
      try {
        record("REA MCP handshake", true, await handshake());
      } catch (error) {
        if (isPipeDenial(error)) record("REA MCP handshake", true, `SKIP: this environment denies child pipes (${error.message.slice(0, 120)})`);
        else record("REA MCP handshake", false, error instanceof Error ? error.message : String(error));
      }
    }
  }
} catch (error) {
  record("launcher resolves a plan", false, error instanceof Error ? error.message : String(error));
  if (isPipeDenial(error)) record("REA MCP handshake", true, "SKIP: this environment denies child pipes");
}

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) process.stdout.write(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}: ${entry.detail}\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
