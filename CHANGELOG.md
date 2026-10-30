# 更新日志

本项目由 **Yushichadao** 维护（yushichadao@qq.com）。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [2.0.0] - 2026-10-31

### 修复 / 改进
- **服务启停（一键全关）**：`autochat stop` 现在会一并关闭「助手主进程 + 我们拉起的本地模型服务 + 配置器 GUI + 运行日志窗口」，不再只杀助手；GUI 内的 stop 在回 200 后自行退场，不会把正在回的响应掐掉。
- **运行日志可见（不再黑屏/乱码）**：`autochat start`（后台）现在弹出一个可见的 cmd 控制台窗口，实时 tail `data/autochat.out` / `.err`；并切到 UTF-8 代码页（`chcp 65001` + `Get-Content -Encoding utf8`），中文不再乱码。关掉该窗口不会停助手。
- **账号隔离加固**：严格按账号隔离身份（人设名 / 人设文件 / 系统提示），`receiver` / `persona` / `account-profile` / `config` 相关逻辑加固。

### 新增

- **多模态（图 → 文 / 文 → 图，GAP2）**：
  - 入站带图消息走「视觉模型」理解（`AI_VISION_MODEL`，留空回落主模型），`trigger` 放行空文本带图消息；
  - 入站图片体积护栏 `AI_MAX_IMAGE_BYTES`（默认 8MB），超体积不送模型、不写日志字节、不落盘（防 base64 外发爆 token / 费用）；
  - 出站模型若返回 `[[image:...]]` / `[[file:...]]` 标记，走原生 `sendImage` / `sendFile`（微信里是真图片 / 文件，不是 markdown 围栏）；
  - 图形化配置器「接一个模型」卡新增「视觉模型」字段 + 顶部实时显示当前生效模型与视觉模型。
- **长期记忆摘要（MS）**：
  - 新增 `autochat memory` 命令：`list` / `summarize [--rebuild]` / `export [--format diary|memory|log|journal] [--chat <id>] [--json] [--out <file>]` / `clear`；
  - 摘要库 `data/ai-memory-summary.json` 独立于易失的上下文转录，持久留存、可累积、可导出、可清空；
  - 每累计 `AI_MEMORY_SUMMARY_INTERVAL`（默认 8）轮把转录并入摘要（抽取式、离线），`--rebuild` 可改用模型重算；
  - 摘要回注系统提示（MS5），跨会话记得偏好 / 约定；`LEGAL.md` 新增「长期记忆」数据流向。
- **环境体检拆分（HI4/HI5/HI6）**：
  - `autochat doctor` 默认只做环境 / 基础设施体检；群可用性独立为 `autochat chats check`（`--scope chats` 亦可）；
  - 图形化配置器新增「群可用性」卡，与「环境体检」卡分离，只读 `effectivePollChats`，绝不自动发现群。
- **可观测性（R16 / GAP5）**：
  - 限流三道闸门（冷却 / 每小时配额 / 并发）各自独立计数，`autochat status` 与图形化配置器状态展示跳过计数；
  - 助手进程每 10s 把限流统计落盘 `data/rate-limit-stats.json`，`status` 跨进程读取。

### 变更

- **思考强度控件（命令行 + 图形化配置器都有）**：
  - 命令行 `autochat effort [off|low|medium|high]`（不带参数＝只看状态，并显示「这次到底会发什么字段」），支持 `--format` 与 `--budget N`；
  - 图形化配置器「接一个模型」卡 → 高级项 → 思考强度（关闭 / 低 / 中 / 高）、思考参数格式（下拉）、思考预算 token；
  - 初始化向导（`autochat setup`）在配完模型后会问一次思考强度（回车＝关闭）。
  - 配置项：`AI_REASONING_EFFORT`（off/low/medium/high，默认 off）、`AI_REASONING_FORMAT`（默认 auto）、`AI_REASONING_BUDGET`（0＝按档位自动）。
  - **适配各家模型的思考字段**（不同厂商写法完全不同）：
    | 格式 | 字段 | 适用 |
    | --- | --- | --- |
    | `auto` | 按模型名自动判断 | 默认；认不出来退回 `standard` |
    | `standard` | `reasoning_effort` | OpenAI o 系列 / gpt-5、Grok、多数网关 |
    | `openrouter` | `reasoning.effort` / `max_tokens` | OpenRouter |
    | `qwen` | `enable_thinking` + `thinking_budget` | 通义 Qwen3 / QwQ、百度 ERNIE |
    | `anthropic` | `thinking.type` + `budget_tokens` | Claude 系 |
    | `gemini` | `extra_body.google.thinking_config` | Gemini 2.5 / 3 |
    | `thinking` | `thinking.type`（只有开/关） | DeepSeek、智谱 GLM、Kimi、混元 |
    | `ollama` | `think` | 本地 gpt-oss、llama3.x |
  - 自动识别：先看接口地址（同一个模型在不同网关字段不同，地址更准），再看模型名（带厂商前缀的先剥前缀，如 `qwen/qwen3-8b`）；
  - **服务端不认这套参数时会自动去掉再试一次**（换模型、换服务商不会把助手弄哑），并记一条 warn 日志；
  - 支持按会话单独设置：在 `config.json` 的 `chats.<会话id>.reasoningEffort` 写 `off/low/medium/high` 即可（技术群开「高」、闲聊群关掉）；
  - 体检会指出档位或格式写错的情况；写错一律退回「关闭」/「自动」，绝不因为一个词让助手失声。

### 修复

- **README 三条红线警告的星标渲染**：原第 13 行罪名列表的闭合 `**` 因未满足 CommonMark 右 flank 规则（前为 `）`、后为字母），在 GitHub 上以字面 `**` 显示；在闭合 `**` 后补逗号后恢复正常加粗。

## [2.0.0]

大版本：入口收口、源码分层重排、界面控件规范统一。

### 破坏性变更

- **删除 TUI 入口**：`src/cli/tui.js`、`npm run tui`、`autochat tui` 命令全部移除。
  迁移：`autochat tui` → `autochat setup`（向导能力已合并：环境体检、锁定微信版本、自动匹配 DLL、注入模式都在里面）。
- **删除重复的 npm 脚本**：`npm run check`（并入 `npm run doctor`）、`npm run model:test`、`npm run model:list`（并入 `npm run model`）。
  迁移：`npm run check` → `npm run doctor`；`npm run model:test` → `npm run model -- test`；`npm run model:list` → `npm run model -- list`。
- **配置项 `AI_MASTER_SWITCH` 废弃**：语义并入 `AI_ENABLED`。
  旧键仍会被读取（为 0 时同样视为「不自动回复」），体检会提示迁移，2.x 内不删。
- **源码目录重排**：`src/` 改为 `core / tasks / cli / gui / ai / bridge / protocol` 六层。
  影响：只引用内部模块路径的脚本需要改 import；命令与接口用法不变。
- **模块路径变更**：`src/config.js` → `src/core/config.js`；`src/chats.js` → `src/core/chats.js`；`src/logger.js` → `src/core/logger.js`；`src/cli/env-file.js` → `src/core/env-file.js`；`src/setup/win.js` → `src/core/win.js`；`src/bridge/switch.js` → `src/core/pause.js`（类名 `MasterSwitch` → `PauseState`）；`src/setup/server.js` → `src/gui/server.js`。
- **卸载行为变化**：`autochat uninstall` 现在会**解除微信更新通道阻断**，并支持 `--dry-run` / `--force`（原命令行卸载没做这两件事）。

### 新增

- `autochat version`：版本、Node、平台、项目目录、作者。
- `autochat logs [--lines N] [--err]`：看服务日志尾部（只读固定两个日志文件，有行数与字节上限）。
- `autochat model service start|stop|status`：一键启动 / 停止**本地模型服务**（Ollama 等），并等待就绪；只停「由 AutoChat 启动的」进程。
- `autochat start --background`（WMI 脱离终端）、`autochat start --elevate`（自动 UAC 提权）、`autochat install --service`（开机自启，后台模式）。
- 图形化配置器：首启向导卡、服务日志卡、每张卡片的「下一步建议」、模型服务卡。
- 界面控件库：开关 / 分段选择 / 动作按钮 / 标签多选；**全仓下线裸勾选框**（有测试强制）。
- 环境体检：每项带「下一步该做什么」，新增 DLL 与微信版本匹配度、端口占用、路径含空格或中文、位于同步盘等检查。
- 文档：`docs/experience-audit.md`（体验审计）、`docs/failure-modes.md`（挂掉根因）、`docs/logic-ui-issues.md`（逻辑与界面缺陷）、`docs/glossary.md`（术语表）、`docs/getting-started.md`（十分钟上手）、`docs/dll-sources.md`（DLL 来源与许可）、`docs/commands.md`（命令参考）。
- **DeepSeek Harness（dsh）插件**：新增组合包 `plugin/dsh-autochat/`（`package.json` 声明 `dsh.bundle.patch`，
  `cordis.patch.yml` 插入一行插件，入口 `index.js` 注册 12 个 `autochat_*` 原生工具 + 技能 `autochat-console`）。
  插件只是外壳与拦截器：所有动作都转成一次 `autochat` CLI 调用，判定与落盘仍由 `src/tasks/` 完成；
  根本性配置七步存在 `bad` 项时，`start` / `resume` 会被拒绝（可用 `acknowledge_blocking` 显式绕过）。
  同一套工具实现另有一个 stdio MCP 传输层（`src/mcp/server.js`），供 CodeBuddy IDE 等 MCP 宿主使用。
  装法：DSH → 插件 → 添加插件 → 本地目录 / GitHub 仓库 / npm 包名，详见 `docs/plugin.md`。

### 修复

- **手写 `WX_POLL_SQL` 的接收路径失效**：轮询改成三段式后，手写 SQL 从未被执行，配了这条的用户一条消息都收不到。已拆成两条取数路径。
- **接收路径的测试长期是红的**（2 条失败被忽略，README 却写「全绿」）：假 hook 已改成按 SQL 形态返回，补齐覆盖。
- **`autochat uninstall` 不解除微信更新通道阻断**：与文档承诺不符，卸载后微信仍锁在旧版本。
- **两处重复实现**：`config.json` 读写与环境体检各有两份实现，现已统一（写文件改为原子写）。
- **外部文本未转义**：群名 / 昵称直接拼进 DOM，群名可控时可在配置器里执行脚本。现已统一转义并加回归测试。
- **静态资源路径穿越校验过弱**：改为解析后按目录边界判断。
- **输出无条件带 ANSI 转义**：重定向到文件时不再出现转义符。

### 内部

- 退出码约定：0 正常 / 1 参数或运行错误 / 2 环境体检存在阻断项；多数命令支持 `--json`。
- 「总闸」一词弃用，统一为「自动回复开关」（配置层）与「暂停状态」（运行层）。
- `npm test` 从 108 项扩到 123 项。

## [1.0.0]

- 首个公开版本：Windows 微信侧本地 AI 助手，hook 注入 + OpenAI 兼容模型 + 命令行 / 图形化配置器双入口。

[2.0.0]: https://github.com/yushichadao/AutoChat/releases/tag/v2.0.0
[1.0.0]: https://github.com/yushichadao/AutoChat/releases/tag/v1.0.0
