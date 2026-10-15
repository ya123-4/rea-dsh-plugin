---
name: rea-dsh
description: Operate the REA reverse-engineering tools that this DeepSeek Harness plugin registers as mcp__rea__* and the bundled rea CLI. Use when checking whether REA is available, choosing between MCP tools and the CLI, reading REA evidence, or repairing a missing REA runtime on Windows, macOS, or Linux.
---

# REA inside DeepSeek Harness

This plugin (`rea-dsh-plugin`) is the whole REA integration: one install
registers the REA MCP server and the `reverse-engineer-anything` skill. For the
investigation methodology itself, load that skill; this skill covers the
harness side — availability, routing, and repair.

## What the plugin installs

- MCP server `rea` over stdio, exposing 170 tools as `mcp__rea__<tool>`
  (`mcp__rea__open_binary`, `mcp__rea__analyze_javascript_application`, …).
- The `reverse-engineer-anything` skill, plus this one.
- A launcher (`lib/launcher.mjs`) that locates the REA CLI and forwards stdio.

Nothing is installed system-wide: no global npm package, no client config edit,
no MCP entry in a client's own configuration file.

## Decide how to reach REA

1. If `mcp__rea__*` tools are in this session's tool list, call them directly.
   They carry the same workflows, Evidence and limits as the CLI. Do not run
   setup or diagnostics first.
2. If they are absent but the plugin is installed, the session predates the
   plugin, the MCP server failed to start, or REA itself is missing. Diagnose
   before repairing; never reinstall the plugin as a first move.
3. Use the CLI when the MCP server is unavailable, when output must be written
   to a file, or when a caller-supplied process should run outside the
   harness. `npx -y rea-agents@6.4.0 <command> --json` always works when the
   registry is reachable.

`mcp__rea__*` availability is not proof that a *provider* is installed.
Static JavaScript/ASAR/artifact/archive analysis needs no disassembler; native
work needs Hopper, Ghidra, or IDA supplied by the operator, and Android work
needs its own JADX/Java prerequisites. A `provider_unavailable` result is about
that provider, not about REA.

## Diagnose

```bash
node "<plugin>/lib/launcher.mjs" --plan     # resolution plan as JSON
node "<plugin>/lib/launcher.mjs" --version  # REA version through the launcher
npx -y rea-agents@6.4.0 doctor --json       # readiness for the installed host
npx -y rea-agents@6.4.0 providers --json    # provider inventory and reasons
```

`--plan` reports which of the four resolution sources won (`REA_AGENTS_ENTRY`,
the bundled optional dependency, `PATH`, or the `npx` fallback) and which Node
will run REA. `<plugin>` is this package's root; when it is not obvious, use the
directory that contained this `SKILL.md` and step up two levels.

Repairs, in order of preference:

1. Reinstall the plugin so its `optionalDependencies` resolve (`rea-agents`).
2. `npm install -g rea-agents@6.4.0`, then reload the harness.
3. Set `REA_AGENTS_ENTRY` to the `rea-agents` package root or to its
   `scripts/rea.mjs`. Set `REA_AGENTS_NODE` only when the Node running REA is
   wrong. Both names survive the MCP bridge's environment scrubbing, unlike
   `DSH_*` names.

REA requires Node `^22.19.0 || ^24.11.0 || >=26.0.0`. The harness runtime
usually qualifies; the launcher falls back to a qualifying Node on `PATH`.

## Rules that matter in this harness

- Pass absolute paths. MCP tools run in the harness process's working
  directory, not in a terminal the model just used.
- Large Evidence is not a failure. If a result reports `resource_constraint`
  with `details.resource: "transport"`, follow the upstream instruction: use
  `mcp__rea__inspect_analysis_view`, request a page, or export a bundle
  instead of repeating the analysis.
- One investigation, one session. Reuse `mcp__rea__binary_session` state and
  close native sessions with `mcp__rea__close_binary` when finished.
- Findings must separate observations, inferences, and unknowns, and cite
  Evidence IDs. Never present static analysis as observed execution.
- REA is local-only and read-only on targets: it does not upload artifacts and
  does not modify the binary under analysis.
