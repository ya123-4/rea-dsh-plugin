# rea-dsh-plugin

One DeepSeek Harness plugin that puts [REA](https://github.com/morluto/rea)
(reverse engineering with agents) inside the harness: it registers the REA MCP
server as `mcp__rea__*` tools **and** ships the REA agent skill, in a single
install.

REA itself is a CLI plus an MCP server. Upstream expects the operator to wire
the client by hand — `rea setup --client …` edits a client configuration file
and copies a skill into the agent directory. This bundle removes that step for
DeepSeek Harness: the harness plugin system declares both halves, and the plugin
locates the REA runtime itself.

## What one install gives you

| Piece | Result |
| --- | --- |
| `@deepseek-ai/dsh-mcp-client` entry | REA's 139 MCP tools as `mcp__rea__open_binary`, `mcp__rea__analyze_javascript_application`, … |
| `@deepseek-ai/dsh-skill-filesystem` entry | the `reverse-engineer-anything` skill and the harness-side `rea-dsh` skill |
| `lib/launcher.mjs` | finds the REA CLI, chooses a compatible Node, forwards stdio |

Nothing is installed system-wide, no client configuration file is edited, and
no global npm package is required: `rea-agents` is an optional dependency of
this plugin, and the launcher falls back to a global install or to `npx` when
the optional dependency is absent.

## Install

Build the tarball and install it into a profile:

```bash
npm pack                       # produces rea-dsh-plugin-0.1.0.tgz
```

Then install that `.tgz` through the harness (`plugin_manager install_bundle`
with the absolute tarball path), or add it to a profile's `dependencies` and
`dsh.profile.bundles`.

Reload the harness if the plugin manager does not hot-apply the bundle. The
first activation connects to the REA MCP server; if that fails the harness still
starts and simply exposes no `mcp__rea__*` tools (`failOnStartupError: false`).

### Prerequisites

- DeepSeek Harness with the built-in `@deepseek-ai/dsh-mcp-client` and
  `@deepseek-ai/dsh-skill-filesystem` plugins (any current desktop or CLI
  build).
- Node `^22.19.0 || ^24.11.0 || >=26.0.0` to run REA. The harness runtime
  qualifies; the launcher falls back to a qualifying Node on `PATH`.
- Analysis engines are bring-your-own. Static JavaScript/ASAR/artifact work
  needs nothing else; native work needs Hopper, Ghidra, or IDA, and Android
  work needs JADX/Java.

## Environment

| Variable | Purpose |
| --- | --- |
| `REA_AGENTS_ENTRY` | Explicit `rea-agents` package root, `scripts/rea.mjs`, or executable. Wins over every other source. |
| `REA_AGENTS_NODE` | Node binary used to run REA, when the harness Node is unsuitable. |
| `REA_DSH_TRACE` | File the launcher appends its resolution and exec events to. This bundle sets it to `<plugin>/launcher.log`, which is the only view of a failed stdio handshake. |
| `REA_DSH_DEBUG=1` | Also log the resolved exec line to stderr. |

Names avoid the `DSH_*` prefix on purpose: the MCP bridge scrubs ambient
`DSH_*` names from stdio child environments. Set them where the harness host
inherits them, or pass them through the plugin's MCP `env` block.

## Verify

```bash
node scripts/verify.mjs            # contract checks plus a real MCP handshake
node scripts/verify.mjs --offline  # no REA or registry access required
node lib/launcher.mjs --plan       # which runtime the launcher picked
```

`verify.mjs` checks the bundle contract, skill frontmatter (kebab-case `name`,
non-empty `description`, no legacy camelCase keys that make the skill provider
skip a file), reference resolution, the launcher plan, and then starts REA
through the launcher and completes an MCP initialize/tools-list exchange,
requiring the full catalog and `analyze_javascript_application`.

In a sandbox that denies child pipes, the interactive handshake reports `SKIP`
instead of `FAIL`; run it in a normal shell for the real result.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No `mcp__rea__*` tools | REA was not found, or the harness was not reloaded after install. Run `node lib/launcher.mjs --plan`; install `rea-agents` or set `REA_AGENTS_ENTRY`; reload. |
| Tools exist, a provider is missing | Expected: static JavaScript/ASAR analysis needs no disassembler. Check `npx -y rea-agents@6.3.0 doctor --json`. |
| `resource_constraint` on a large result | Not a failure. Use `mcp__rea__inspect_analysis_view`, request a page, or export an evidence bundle instead of repeating the analysis. |
| `npx` fallback is slow on first use | The optional dependency did not install; reinstall the plugin so `rea-agents` resolves locally. |
| Launcher trace ends in `exit 0xFFFF0003` | REA was started on the harness Electron runtime, whose native-module ABI aborts REA's addons. Set `REA_AGENTS_NODE` to a real Node, or install Node on `PATH`; the launcher already prefers a real Node when it finds one. |

## Layout

```
cordis.patch.yml   bundle patch: skill provider + MCP client
lib/launcher.mjs   REA discovery, Node selection, stdio forwarding
lib/index.js       empty bundle entry (no host state to dispose)
skills/            reverse-engineer-anything (adapted) + rea-dsh
scripts/           verify.mjs, verify-mcp-handshake.mjs
```

## Relation to upstream REA

This is an independent integration, not an official REA distribution.
`skills/reverse-engineer-anything/` is adapted from REA with one rewritten
section (see [LICENSE](LICENSE)); the rest is upstream text. `rea-agents` is
resolved at install time as an optional dependency and is not redistributed
here. Reported issues in REA's own analysis behaviour belong upstream.

## License

MIT — see [LICENSE](LICENSE).
