# 更新日志

本项目由 **Yushichadao** 维护（yushichadao@qq.com）。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
- 文档：`docs/EXPERIENCE-AUDIT.md`（体验审计）、`docs/FAILURE-MODES.md`（挂掉根因）、`docs/LOGIC-UI-ISSUES.md`（逻辑与界面缺陷）、`docs/GLOSSARY.md`（术语表）、`docs/GETTING-STARTED.md`（十分钟上手）、`docs/DLL-SOURCES.md`（DLL 来源与许可）、`docs/COMMANDS.md`（命令参考）。

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
