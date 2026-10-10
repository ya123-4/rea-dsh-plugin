# rea-dsh-plugin

把 [REA](https://github.com/morluto/rea)（用 agent 做逆向工程）装进 DeepSeek
Harness 的插件：**一次安装**同时注册 REA MCP 服务器（模型侧看到
`mcp__rea__*` 工具）与 REA 的 agent skill。

REA 本身是「CLI + MCP 服务器 + skill」。上游要求使用者手工接线：`rea setup
--client …` 会改写客户端配置文件并往 agent 目录里拷贝 skill。本插件免去这
一步——Harness 的插件机制同时声明这两半，运行时由插件自己定位 REA。

## 一次安装得到什么

| 组成 | 结果 |
| --- | --- |
| `@deepseek-ai/dsh-mcp-client` 条目 | REA 的 139 个 MCP 工具，形如 `mcp__rea__open_binary`、`mcp__rea__analyze_javascript_application` |
| `@deepseek-ai/dsh-skill-filesystem` 条目 | `reverse-engineer-anything`（上游方法论）与 `rea-dsh`（Harness 侧用法）两个 skill |
| `lib/launcher.mjs` | 定位 REA CLI、挑选满足版本要求的 Node、转发 stdio |

不改动任何全局安装、不改写客户端配置文件、不要求全局 npm 包：`rea-agents`
是本插件的 **optionalDependency**；若它没装上，launcher 会依次回退到全局
安装或 `npx`。

## 安装

```bash
npm pack                       # 生成 rea-dsh-plugin-0.1.0.tgz
```

再通过 Harness 安装该 `.tgz`（`plugin_manager install_bundle`，传 tarball 的
绝对路径），或把它加入 profile 的 `dependencies` 与 `dsh.profile.bundles`。

插件管理器若未热应用该 bundle，重载 Harness 即可。首次激活会连接 REA MCP
服务器；连接失败不会阻塞 Harness 启动，只是这轮会话里没有
`mcp__rea__*` 工具（`failOnStartupError: false`）。

### 前置条件

- DeepSeek Harness，内置 `@deepseek-ai/dsh-mcp-client` 与
  `@deepseek-ai/dsh-skill-filesystem`（当前桌面版或 CLI 版均可）。
- 运行 REA 需要 Node `^22.19.0 || ^24.11.0 || >=26.0.0`。Harness 自带的
  Node 运行时满足要求；否则 launcher 会在 `PATH` 上挑一个满足版本的。
- 分析引擎自备：静态 JavaScript/ASAR/产物分析不需要任何引擎；原生分析需要
  Hopper、Ghidra 或 IDA；Android 分析需要 JADX/Java。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `REA_AGENTS_ENTRY` | 显式指定 `rea-agents` 包根、`scripts/rea.mjs` 或可执行文件，优先级最高。 |
| `REA_AGENTS_NODE` | 当 Harness 自带的 Node 不适用时，指定运行 REA 的 Node。 |
| `REA_DSH_TRACE` | launcher 把解析与执行事件追加写入的文件。本 bundle 默认指向 `<插件目录>/launcher.log`，这是 stdio 握手失败时唯一的现场证据。 |
| `REA_DSH_DEBUG=1` | 把最终执行的命令行打到 stderr。 |

刻意避开 `DSH_*` 前缀：MCP 桥会从 stdio 子进程环境里剔除环境中的 `DSH_*`
变量。请把变量设在 Harness 宿主能继承的位置，或写进插件的 MCP `env` 块。

## 自检

```bash
node scripts/verify.mjs            # 契约检查 + 真实 MCP 握手
node scripts/verify.mjs --offline  # 不需要 REA 或网络
node lib/launcher.mjs --plan       # 查看 launcher 最终选中了哪个运行时
```

`verify.mjs` 会校验 bundle 契约、skill frontmatter（kebab-case 的 `name`、
非空 `description`、不含会让 provider 静默跳过该 skill 的旧驼峰键）、引用文
件是否齐全、launcher 解析计划，最后**通过 launcher 真正启动 REA** 并完成
MCP `initialize` / `tools/list` 交互，要求返回完整工具目录且包含
`analyze_javascript_application`。

在禁止创建管道的沙箱里，交互式握手会报 `SKIP` 而不是 `FAIL`；要拿真实结
果请在普通 shell 中运行。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 没有 `mcp__rea__*` 工具 | 没找到 REA，或装完没有重载 Harness。先跑 `node lib/launcher.mjs --plan`；再装 `rea-agents` 或设 `REA_AGENTS_ENTRY`；然后重载。 |
| 工具有，但某个 provider 不可用 | 属正常：静态 JavaScript/ASAR 分析不需要反汇编引擎。用 `npx -y rea-agents@6.3.0 doctor --json` 查看。 |
| 大结果返回 `resource_constraint` | 不是失败。改用 `mcp__rea__inspect_analysis_view`、请求分页，或导出 evidence bundle，不要重复分析。 |
| 首次走 `npx` 回退很慢 | 说明 optionalDependency 没装上；重装插件让 `rea-agents` 落到本地。 |
| launcher 日志以 `exit 0xFFFF0003` 结束 | REA 被跑在 Harness 的 Electron 运行时上，其原生模块 ABI 会让 REA 的 addon 直接中止。把 `REA_AGENTS_NODE` 指向真正的 Node，或在 `PATH` 上装 Node；launcher 找到真 Node 时会优先用它。 |

## 目录结构

```
cordis.patch.yml   bundle 补丁：skill provider + MCP 客户端
lib/launcher.mjs   REA 定位、Node 选择、stdio 转发
lib/index.js       空的 bundle 入口（没有需要释放的宿主状态）
skills/            reverse-engineer-anything（已适配）+ rea-dsh
scripts/           verify.mjs、verify-mcp-handshake.mjs
```

## 与上游 REA 的关系

这是独立集成，不是 REA 官方发行物。`skills/reverse-engineer-anything/` 取
自 REA，仅改写了「Connect only when needed」一节（见 [LICENSE](LICENSE)），
其余为上游原文。`rea-agents` 在安装时作为可选依赖解析，本仓库不再分发它。
REA 自身分析行为的问题请反馈给上游。

## 许可

MIT，见 [LICENSE](LICENSE)。
