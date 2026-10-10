/**
 * rea-dsh-plugin is a bundle, not a standalone plugin: the whole integration is
 * declared in `cordis.patch.yml`, which inserts
 *
 *   - `@deepseek-ai/dsh-skill-filesystem` rooted at this package's `skills/`,
 *     so the model can load `reverse-engineer-anything` and `rea-dsh`; and
 *   - `@deepseek-ai/dsh-mcp-client` for the REA MCP server, started through
 *     `lib/launcher.mjs`, whose tools appear as `mcp__rea__<tool>`.
 *
 * Keeping the entry empty means a bundle re-install or HMR swap cannot leak
 * host state: there are no services, hooks, or tools to dispose here.
 */
export {};
