# AutoChat 2.0.0 计划（产品与设计规格）

> ⚠ **本版本为测试版（不稳定）**：2.0.0 仍在验证中，功能与行为可能变动，请勿用于生产或关键场景。

> **版本**：2.0.0（`package.json` 已落地）。本文件是 2.0.0 的**产品 / 设计计划（spec）**，讲“做什么、为什么、怎么组织”。
> **对应的验证清单**是内部《AutoChat 一体化测试方案 v2.0.0》。两者并列、命名区分，避免认错文档：本文件 = 计划；内部测试方案 = 测试方案。
> 本文基于**当前代码库实况**从零重写（非旧 `plan.md` 的搬运）；凡与旧计划不符处，以代码为准。

---


## 1. 产品定位与面向对象

- AutoChat = **Windows 专属的「微信侧本地 AI 助手」**：注入 hook DLL 读写本机已登录微信号，收到消息后按策略交给本地 / 云端 OpenAI 兼容模型，再把回复回发微信。
- 面向对象（优先级）：
  1. **主用户**：会用电脑但不懂技术的普通用户（双击即用、出错有中文引导）。
  2. **进阶用户**：会脚本化的使用者（CLI、自托管模型、远程只读监控）。
  3. **二次开发者（自用）**：基于插件 / DSH / MCP 扩展能力者——以本机自行修改为主，见 §8 治理政策。
- 真正门槛不在配模型，而在：**hook DLL 与微信版本强绑定 + 需要管理员权限 + 需要旧版微信**。
- **平台边界（明确不做）**：仅支持 Windows + Windows 版微信；**不支持手机端（iOS / Android）**，也不做跨平台 / 移动端适配——项目强依赖 Windows 专属的 hook DLL 注入与微信 Windows 客户端。

## 2. 架构（当前实况）

`src/` 实际分层（职责分离，任务层为唯一事实来源）：

```
src/
├── index.js                 # 助手服务进程入口（编排 core / bridge）
├── config.js chats.js logger.js   # 根级核心单例
├── core/      # config / env-file / chats / logger / paths / win / pause
├── tasks/     # doctor setup install service model-service logs context chats config lock autodll model（CLI 与 GUI 共用）
├── cli/       # index + commands/* + ui + prompts（终端入口）
├── gui/       # server / api / state / browser / ui（图形化配置器，浏览器单页）
├── ai/        # trigger / limiter / prompt / responder（模型接入）
├── bridge/    # hook-client / dialect / self-filter / receiver / compat（注入·接收·归一）
├── protocol/  # normalize（消息归一，含图片 / 文件解析）
├── mcp/       # MCP 服务器（autochat mcp）
└── setup/     # 安装器
```

- **两入口平级**：CLI（`src/cli`）与图形化配置器（`src/gui`）各自能独立完成「体检 → 配置 → 安装 → 启动 → 观察 → 暂停 → 卸载」全链，不允许一端缺项。
- **任务层 `src/tasks/` 是唯一事实来源**：新能力先落 tasks，两端只做「解析 + 渲染」。
- **零运行时依赖**：`package.json` 的 `dependencies: {}`（CI 检查）；GUI 为原生 HTML/CSS/JS + 本地回环 HTTP（随机令牌鉴权），不改 Electron。


## 3. 入口、命令与脚本（当前实况）

- **npm scripts（实际）**：`start / dev / test / demo / doctor / setup / gui / status / logs / version / model / model-service / install-service / uninstall-service / pause / resume / stop / dist / mcp`。
- **已下线的过时脚本**（对照旧计划，现已无）：`check`、`model:test`、`model:list`、`tui`（npm 别名已删）。
- **`autochat` 子命令**：`doctor / setup / gui / status / logs / version / model / model-service / pause / resume / stop / install / uninstall / start`，以及 `tui`。
  - ⚠ **与旧计划的重要偏差**：旧 `plan.md` 写明「TUI 彻底取消（删除 `src/cli/tui.js` 与 `autochat tui` 命令）」，但**当前代码仍保留** `src/cli/tui.js` 与 `autochat tui` 命令（仅 npm 别名被删，命令本体未删）。本文以代码为准：TUI 仍是可用入口之一；若后续决定真正下线，需在 `index.js` 与 `tui.js` 同步删除并补回归用例。
- **退出码约定**：`0` 正常 / `1` 参数或运行错误 / `2` 环境体检存在 bad 项。


## 4. 核心能力

- **四类对象的动词体系**（命令与文案必须带对象名）：助手服务 `start/stop`；自动回复 `AI_ENABLED` 开关 + `pause/resume`；模型服务 `model-service start/stop`；会话 `chats enable/disable`。
- **开关 / 状态体系**（已统一，禁用「总闸」旧词）：自动回复开关（`AI_ENABLED`，下次启动生效）、暂停状态（`data/paused` 哨兵，立即生效）、会话开关（`chats[id].enabled`，立即）、回复范围（`AI_ALLOW_CHATS`/`AI_DENY_CHATS`）。
- **限流**：冷却 / 每小时上限 / 并发上限三类独立计数，叠加时不静默丢弃（有日志）。
- **自身消息过滤**：sender/id 双模式 + 回声双层，防自回自。
- **hook DLL 注入 / 接收 / 归一**：receiver 三段式轮询、`compat` 版本漂移感知、`normalize` 消息归一。
- **图片 / 文件传输**：传输层已具备，AI 侧未接（见 §6）。


## 5. 术语与文案统一（已落地，见 `docs/glossary.md`）

- 统一中文名：图形化配置器（非网页 / 前端）、助手服务、模型服务、hook DLL、注入模式 / 接收方式、版本档案 `profiles`、自研 DLL 命名 `AC-<适配微信版本号>`。
- 禁用词已清理（grep 自检）：旧 1.0.0 时代残留「总闸 / 双账号 / 勾选框 / 另一种皮 / AutoChat contributors」及旧六位数字 DLL 代号。
- 作者 / 维护者统一为 **Yushichadao**（`yushichadao@qq.com`），package.json / README / LICENSE / SECURITY / CHANGELOG / 落地页一致。


## 6. 图像识别路线（现状与排期）

- **现状（代码实证）**：
  - 传输层已具备——`protocol/normalize.js` 已解析 `image/file/thumb`；`bridge/hook-client.js` 已实现原生 `sendImage()` / `sendFile()`（可实现原生发图 / 发文件）。
  - AI 侧未接入——`ai/responder.js` 仍纯文本，未把 `images` 喂给模型 `messages`；`config.js` 仅有 `AI_MODEL/AI_BASE_URL/AI_API_KEY`，**无 `AI_VISION_MODEL`**。

- **决策与排期**：
  1. **先接云端视觉 / 生图模型**（OpenAI 兼容，新增 `AI_VISION_MODEL`）：把图片理解 / 生图纳入自动回复链路。
  2. **后续视隐私与算力扩展本地视觉模型**（图片不出机）。
  - 路径对比与可行性探针（F1–F12）详见 `test-plan.md` §9；实现探针（IR1–IR13，含 IR13 入站大图体积护栏）见其 §3.1。

## 7. 插件 / DSH / MCP 能力

- **DSH 插件**：`plugin/dsh-autochat/`（含 README、`cordis.patch.yml`、`locale/{zh,en}.json`）。作为**外壳扩展，不替代本体**，受七步门槛约束；`engines.dsh` 范围须与宿主匹配。
- **MCP 服务**：`src/mcp/server.js` + `autochat mcp` 启动，以 Model Context Protocol 暴露 AutoChat 能力，供支持 MCP 的客户端调用。
- **二次开发文档**：插件写法、MCP 接法、六层结构、发版纪律（同版本双发）在 `docs/` 中提供——但受 §8 治理政策约束（自用为主）。


## 8. 治理与贡献政策（单维护者）

- 本项目由 **Yushichadao 单维护**；GitHub 仓库**不接受外部 Pull Request 与分支合并**。
- 如需修改：请自行 clone / 下载后在本机改动（fork 自用受 `LICENSE` 约束，但不会被并入上游）。
- `LICENSE` 照常生效（仓库 `"license": "SEE LICENSE IN LICENSE"`）：开源许可允许下载与自用修改，但**不代表接受上游贡献**。
- 安全漏洞：仍走 `SECURITY.md` 的私密报告邮箱 `yushichadao@qq.com`（仅报告通道，非贡献通道）。
- 影响文档：若 `CONTRIBUTING.md` 当前写有“欢迎贡献 / 接受 PR”类表述，需同步修正为上述政策。


## 9. 测试与质量门禁

- **一体化测试方案**：`docs/test-plan.md`（v2.0.0）——十维度（连接 / 触发 / 效果 / 安全 / 兼容 / 可靠 / 安装 / 文档 / 体验 / 合规），IR1–IR13 实现探针 + F1–F12 可行性探针，GAP1–GAP12 缺口清单。
- **门禁**：`node --test` 全绿；`prepublishOnly` 跑测试；禁用词 / 旧 DLL 代号 grep 自检；前端裸 `<input type="checkbox">` 扫描（`test/gui-widgets.test.js`）；CLI↔GUI↔npm 三方能力对照。


## 10. 版本、署名与发布

- `version` 2.0.0（`package.json`）；`autochat version` 输出 AutoChat 2.0.0 / Node / 平台 / 作者与联系方式。
- 发布纪律：组合包与本体**同版本双发**；`files` 与 `dependencies:{}` 与实际一致；`prepublishOnly` 测试门禁。
- 文档集（`docs/`）：`experience-audit` / `getting-started` / `commands` / `failure-modes` / `logic-ui-issues` / `dll-sources` / `glossary` / **`plan-2.0.0`（本文件）** / `test-plan`；落地页 `docs/index.html`。


## 11. 版本兼容矩阵与依赖地狱预警

> 本项目各组件版本**互相绑定**，混用即「依赖地狱」。当前版本桥已验证可打通使用；升级须按矩阵重锁。

### 当前版本兼容矩阵（可打通）

| 组件 | 当前可用版本 | 约束 / 备注 |
| --- | --- | --- |
| AutoChat | `2.0.0` | 助手服务本体 |
| 版本桥 / 自研 hook DLL | `AC-4.1.10.27`（文件 `version-ac-4.1.10.27.dll`） | 须与微信版本**精确一致**；由 `autodll`+`lock` 锁定，禁止随意更换 |
| 微信（Windows） | `4.1.10.27`（版本档案 `profiles` 覆盖） | 旧版；新大版本须重新匹配 DLL |
| Node | `>=18`（实测 18 / 20 / 22 通过） | 运行环境 |
| 操作系统 | Windows 10 / 11（64 位） | 不支持手机 / iOS / Android |

- 当前版本桥（`AC-4.1.10.27` ↔ 微信 `4.1.10.27`）**已验证可打通使用**，对应文件 `tools/wxhook/version-ac-4.1.10.27.dll`。
- 新大版本微信出现时，须重新为对应微信版本构建 / 匹配 DLL（自研 DLL 按 `AC-<适配微信版本号>` 命名），**不做「自动跨版本换 DLL」**。

### 依赖地狱预警（务必遵守）

1. **禁止混用版本**：不要把不同版本的 AutoChat / hook DLL / 微信 / Node 搭配使用。
2. **DLL 与微信强绑定**：错配会直接断桥（历史上换 DLL 致整项目失灵）——这是**有意根基设计**，非缺口；微信大版本更新后必须重锁 DLL（`autodll` + `lock`）。
3. **零运行时依赖契约**：`package.json` 的 `dependencies:{}`；**不要 `npm install` 额外包**，否则破坏零依赖、引发版本冲突。
4. **单实例**：同一微信账号不要同时跑多个 AutoChat 实例（pid / state 冲突、自身消息回环）。
5. **无自动更新**：因 DLL 强绑定，本项目不自动更新；`autochat doctor` / `autochat version` 会提示版本过旧，升级前对照 `CHANGELOG` 与本矩阵。

### 落地页同步

- 落地页 `docs/index.html` 的「版本与兼容」区已展示上述矩阵与依赖地狱预警（避免用户在官网被误导混装版本）。

## 12. 微信号实时识别与多账号先后支持（2.0.0 新增设计）

### 12.1 目标与背景
同一台电脑**先后（非同时）**登录多个微信号是常态。原方案依赖手填 `WX_SELF_ID` 识别「自己发的消息」，换号时旧号 wxid 残留会导致：自消息过滤失效（自问自答 / 刷屏 / 烧额度）、`ContactCache` 联系人 / 群名缓存串号、旧群配置误用于新号（误回复 / 信息泄露）。本设计为 2.0.0 明确新增**实时识别 + 按账号隔离**。

### 12.2 实时识别当前登录微信号
- 运行时（`src/index.js`）已用 hook `/GetSelfProfile`（wxid + nickname）覆盖手填值（实时 > 兜底 > 手填）。
- GUI 状态快照（`src/gui/state.js` 的 `buildState`）经 `probeAccount()` 调用 hook 实时取 `account.{wxid, nickname, source}`，前端卡片只读展示「当前登录：昵称(wxid)」+ 来源（微信实时 / 本地库 / 配置文件）。
- CLI `autochat self` 优先级对齐为实时优先，并标注来源。

### 12.3 移除手动输入
- GUI「自消息识别」卡片**不再提供 wxid 输入框**；`WX_SELF_ID` 降级为 hook 不可达时的离线兜底值（UI 不暴露编辑）。
- 防窜号：若 `.env` 的 `WX_SELF_ID` 与实时 wxid 不一致，GUI 显示醒目红条告警。

### 12.4 多微信号先后支持（配置 / 缓存按账号维度隔离）
- `ContactCache` 改为 `account → (wxid → name)`；`lookup / search / nameOf` 接收 `account`，新增 `setCurrentAccount` / `invalidate(account)`，切号时清旧号缓存。
- `config.json` 的 `chats` 支持可选 `account` 字段；`effectivePollChats(cfg, currentWxid)` 仅返回「无 account 或 account===currentWxid」的群，旧号专属群换号后不监听、不回复。

### 12.5 换号窜号防护
- 运行时维护 `currentWxid`：每次 hook 连通比对 `selfProfile().wxid`。
- 不一致（换号）→ 暂停回复（gate pause）+ 清 ContactCache 旧号 + 重新对齐水位 + 日志告警 + GUI 红条。

### 12.6 关联
- 与 §4「自身消息过滤」「hook DLL 注入」衔接；与 §8 治理（单维护者、红线）无冲突。
- 验证清单见 `test-plan.md` §二 G24/G25、§三 R25、§六 S6。


## 13. 范围决策（2026-10-27 用户拍板）

> 本节记录「明确不做」的项，避免后续重复讨论或误当缺口。

### 13.1 IR3 本地视觉模型 → 改为「不支持即明确提示」（已实现）
- **不做**本地视觉模型接入（本机 llava 一类不在计划内）。
- **要做**：本机纯文本模型（如 ollama 文本档）收到图片时，必须在**读图之前**判定并明确告知用户，而不是把 `image_url` 塞进去报 400 或静默忽略。
- 判定前置同时保证 **图片字节不出机**（`IR8`）：判定为不支持时不读盘、不组装 `image_url`。
- 实现：`src/ai/vision.js` 的 `visionSupport({ baseUrl, visionModel })`；`replier.handle` 在带图分支短路并 `deliver` 提示。
- 例外：用户显式配置了 `AI_VISION_MODEL`（哪怕指向本机 llava）即视为「能看」，恢复看图能力。
- 配置：`AI_VISION_UNSUPPORTED_TEXT` 可自定义提示文案（已加入 `EDITABLE_ENV` 白名单）。
- 用例：`test/multimodal.test.js` 的 IR3 四项。


### 13.2 G22 流式输出 → 不做
微信消息本身是一次性投递，且客户端不渲染思维链与 ` ``` ` 围栏，流式输出在微信侧不可实现。

### 13.3 GAP1 免安装 exe → 不做
现状已有入口（GUI 双击 / CLI），无打包 Node 运行时的计划。

### 13.4 GAP7~GAP12 → 不做
可视化工作流 / 触发动作、群管理、远程只读监控、多模型路由与自动 fallback、企业微信合规通道文档、配置版本化与回滚——**均超出项目研发范畴**。

### 13.5 仍在范围内
`GAP2` 多模态（已实现入站理解 + 出站原生图片/文件）、`GAP3` 对话导出、`GAP4` 长期记忆、`GAP5` 资源占用可观测、`GAP6` 陈旧 pid 自动识别。

## 14. GUI 易用性与生命周期计划（2026-10-27 新增）

> 来源：真机使用反馈（对齐缺陷、下拉被轮询收起、弹窗字面 `\n`、「一键修复」意义不明）与三项配置器改进提议。
> 对应测试条目：`test-plan.md` §二 G26–G32、§三 R25–R27、§6.5 I12–I15、§五 D14。

### 14.1 已修（2026-10-27 当场落地）
| 缺陷 | 根因 | 修法 |
| --- | --- | --- |
| 弹窗文案显示字面 `\n` | `main.js` 里把换行写成了 `'\\n'`（双反斜杠），alert/confirm 原样输出 | 全部改回真实 `\n`（一键修复确认框、3 个结果 alert、installLog 拼接）|
| 下拉菜单点开几秒后被自动收起 | 4s 轮询 `refresh→render()` 整体重建 DOM，`.dropdown.open` 被冲掉 | 轮询回调检测 `.dropdown.open` 存在则跳过本轮重绘（与「输入中不重绘」同策略）|
| 人设卡两列控件不对齐 | 「人设名」标签太长换 3 行，把左列输入框压下去 | 标签缩短为「人设名」，长说明移到下方 hint |
| 「一键修复」提示里 DLL 名过时 | 展示用了版本档案的 `dll` 字段（仍是 `aixed/WeChat-Hook（main）`），而实际内置 DLL 已改名 | `profiles.js` 新增 `dllLabel` 展示字段（`dll` 字段保留原值——`resolveBuiltinDll` 靠它做版本匹配，不能动），展示处用 `dllLabel || dll` |

### 14.2 「一键修复」按钮的定位（回应「不知道它存在的意义」）
一键修复 = **「哪里不对补哪里」**：微信没装→引导；版本不支持→用本地安装包重装；DLL 不对→部署匹配的并重启微信；最后轮询校验登录态。它**不是**日常按钮，正常配置下永远用不到。已把确认框文案改得更直白；后续（G31/G32）会让体检卡直接解释「哪一项不对、修复会做什么」。

### 14.3 配置器易用三件套（I14，可行性评估，按侵入性低→高）
| # | 改动 | 可行性 | 代价 / 风险 |
| --- | --- | --- | --- |
| 1 | 403 返回中文提示页（说明没在跑 / 链接过期 + 复制启动命令按钮）| **可行，低侵入** | 只改 `gui/server.js` 的 403 分支：纯文本 → 自包含 HTML 页；不影响鉴权逻辑 |
| 2 | token 持久化复用（`data/gui.json` 已有就不再随机换）| **可行，低侵入** | 启动时读已有 token，无才生成；token 仍只存本机该文件，安全面不变；历史链接不再失效 |
| 3 | 配置器后台常驻（关窗口不停）/ 托盘化 | **可行，中侵入** | 第一步用现成模式：`node src/cli/index.js gui --background`（复用 `start --background` 的脱离控制台机制）即可；**系统托盘图标**需要额外的托盘宿主进程（PowerShell NotifyIcon 或第三方依赖，与零依赖原则冲突），建议作为独立后续项单独评估 |

> 已定：**① 做**。②③ 先只做影响评估、不改代码（用户要求「先考虑后果与对项目性质影响」）。

### 14.3.1 ② token 持久化复用 —— 影响评估（暂不实现）

**现状**：每次 `startGui` 都 `crypto.randomBytes(16)` 生成新 token 写入 `data/gui.json`；**同一端口上已在运行时会复用**（`server.js` 读取既有 `gui.json` 直接打开，不重复起服务）。所以真正会变的只有一点：**跨重启也复用同一个 token**。

**后果**
- 收益：书签 / 聊天里存过的链接不再失效。
- 风险**不在技术，在「有效期性质」变了**：
  1. token 由「本次启动有效」变成「长期有效」。泄露窗口从一次会话变成永久。本项目 token 只存本机 `data/gui.json`（chmod 600），主要泄露途径恰恰是**用户自己把带 token 的链接贴出去**（真实发生过）或截图外发 —— 持久化会让这类外泄永久有效。
  2. 与「关掉窗口就等于停掉配置器」的现状耦合：现在关窗口 → 进程退出 → token 自然作废；持久化后 token 长期挂着。
  3. 鉴权强度不变（仍绑 127.0.0.1 + token），但**暴露时长**显著变长。

**若要做的折中**：token 持久化 + **有效期**（如 7 天）或**重启 N 次后轮换**；界面显示「令牌创建于 X」并给「重新生成令牌」按钮；轮换时旧链接走 ① 的中文提示页。

### 14.3.2 ③ 后台常驻 / 托盘化 —— 影响评估（暂不实现）

**现状**：`npm run gui` 是前台进程，关控制台窗口即停（`server.js` 已明确提示「关掉这个窗口就等于停掉配置器」）。

**后果**
- 收益：关窗口不停；配合开机自启更顺手。
- **与项目性质冲突（关键）**：
  1. 配置器是**管理面**（能改 `.env`、启停服务、卸载）。让它常驻 = 本机长期开着一个能改配置的 HTTP 管理端口。攻击面从「用完即关」变成「长期开放」——即便绑 127.0.0.1 + token，性质也变了。
  2. 与 `autochat start --background`（助手服务常驻）性质不同：助手常驻是业务必需（要收消息），配置器常驻不是必需 —— 打开时再起即可，启动很快。
  3. 可见性变差：常驻后用户容易忘了它在跑，桌面无任何痕迹。
  4. **托盘化额外冲突**：项目核心性质是 `dependencies:{}` 零依赖。系统托盘需要额外进程 / 原生模块或 PowerShell NotifyIcon 脚本，会破坏零依赖，且又是一个「常驻」信号。

**若要做的折中**：默认**仍是用完即关**；只有显式 `--background` 才常驻；常驻期间必须在 `autochat status` / `doctor` 里暴露「配置器正在后台运行，端口 X」并给出停止方式。托盘建议不做。

> 待拍板：看完评估后再决定 ②③ 是否做、按哪种折中做。


### 14.4 覆盖关系可见化（G31，与「全局 A / 群 B 到底用谁」）
原则：**局部覆盖全局时必须可见**。落点：
- 会话卡每个会话行显示覆盖徽标（`模型B·覆盖` / `人设B` / `思考B`），点开看「全局 A → 此会话 B」；
- 全局卡（模型 / 思考 / 人设）显示「被 N 个会话覆盖」；
- 运行日志的回复行已带实际模型名（`AI→群 [模型] 内容`），是最终事实。
思考模式按会话覆盖后端已支持（`chats[id]` → `aiForChat` 透传，`reasoning.test.js` 已测），缺的是 **GUI 出口与提示**，属 G31/G32 范畴。

### 14.5 卸载语义（I12/I13/D14）
- 「卸载服务」只做三件事：解除开机自启、移除 DLL 部署位、删服务/快捷方式 —— **程序本体不动**，文案必须写清。
- 「卸载软件」是另一个动作：要么在卸载卡提供「同时把程序移入回收站」的可选步骤（I13 方案①），要么给明确的手动删除指引（方案②）。二选一，待拍板。

## 15. 群聊多人发言「合批回答」可行性评估（2026-10-27，用户提，待拍板）

> 用户看到别的软件有「把几个人的话合批、统一分析回答」的能力，问项目能否做。
> 结论：**技术可行、插入点干净、复用度高；真正的拦路虎是隐私与范围归属，不是技术。** 尚未决定实现，先评估。

### 15.1 是什么
群聊里把一段时间窗口内多人的发言攒成一批，调一次模型，产出一段综合回答发回群。区别于现网「每条 @ 触发一次回复」。

### 15.2 技术可行性：高
- **插入点明确**：`src/index.js:232` 的 `receiver.on('message', (msg) => air.handle(msg))`。在它前面加一层 `BatchAggregator` 即可：
  `receiver.on('message', (m) => aggregator.push(m)); aggregator.on('batch', (b) => air.handle(b.asMessage()));`
- **可复用现有能力**：`trigger.decide`（触发判定，已支持按会话覆盖）决定「谁开窗口」；`replier.handle` 把整批拼成一条合成消息即可复用（prompt.js 已能生成「群里跟你说话的是 X」）；G30 的 loading 正好用于攒批期间提示「正在汇总 N 条发言」。
- **窗口机制**：按 `chatId` 分组缓冲；第一条触发消息开启窗口（默认 ~10s，可配）；窗口内收集该群所有人发言（含非触发者）；窗口闭合 → 一次性调用模型 → 综合回复发群。

### 15.3 必须决策的三个点（决定能否落地）

**① 隐私（最重要，与项目性质冲突）**
合批 = 把**多人原始对话**发给模型。若用**云端模型**，等于把群友私聊外发给第三方 —— 直接撞「本地优先、不出私聊、不碰他人账号」的定位。
→ 建议：合批模式**默认仅本地方可**（Ollama/本地视觉）；用云端模型需显式二次确认 + 文案警示「将把多人对话发往云端」。可做成全局开关 `AI_BATCH_REQUIRE_LOCAL=1`（默认开）。

**② 触发与回复语义**
- 谁开窗口：第一条 @ 我们 / 关键词 / 带图？还是任意群消息？
- 窗口时长：太短合不了几条，太长别人都走了（建议 8–15s 可配）
- 回复落点：发到群（普通消息，不 @ 特定人，因为是「总结性」回答）
- 与现网并存：按会话可配「合批 / 逐条」，不强制全局切换

**③ 范围归属（需用户重新拍板）**
用户此前把 GAP7–12（含**群管理 / 工作流**）砍了，理由是「超出项目研发范畴」。合批回答本质属于**群聊增强 / 群管理**，**可能踩到已砍的范围线**。故本项定位为「待重新拍板是否纳入」，不是默认做。

### 15.4 实现成本：中（约 1–2 天）
- 新增 `src/ai/batch-aggregator.js`（分组缓冲 + 定时器 + 合成 message）
- `src/index.js` 插一层（约 5 行）
- 边界：reconcile 漏接补偿（现按消息，合批后补整批还是补窗口？）、限流口径（窗口内一批算一次）、上下文记忆是否记多人发言
- 测试：`test/batch-aggregator.test.js`（窗口闭合、多人合并、本地模型限制、按会话开关）

### 15.5 建议路径
先决策 ①（默认仅本地方可）+ ③（是否纳入范围）；若过，则按「按会话可选合批、默认关」实现，不破坏现网逐条回复。`test-plan.md` 暂不立项（未决定做）。

### 15.6 已决定实现（2026-10-27 用户拍板）
用户明确要「加一个高级设置（全局 / 按某些群 / 个人）：单消息回复还是多消息回复」，并对设计四问拍板：
1. **窗口触发**：第一条 @ 我们的消息开启窗口（推荐项）；
2. **窗口大小**：在 **10 分钟**以内、攒 **近 10 条**「符合触发、尚未被单独处理」的群消息即发（以二者先到为准，另加 20s 静默期兜底，避免只 1 条 @ 也要等满窗）；
3. **云端模型**：允许合批，但**首次开合批且用的是云端模型时弹一次隐私确认**（GUI 拦截，不静默）；
4. **默认模式**：全局默认 **单消息回复**，按需给个别群开合批（最稳，不破坏现有行为）。

**落地点**：
- 配置：`AI_REPLY_MODE`（single/batch）、`AI_BATCH_WINDOW_MS=600000`、`AI_BATCH_MAX_MESSAGES=10`、`AI_BATCH_FLUSH_DELAY_MS=20000`；按会话 `chats[id].replyMode` 覆盖。
- 后端：`src/ai/batch-aggregator.js`（按 chatId 缓冲、条数/时间/静默三条件闭合、合成消息交给 `AIReply.handle(msg.batch=true)` 跳过触发判定）；`src/index.js` 接入（batch 会话消息先聚合，single / 非窗口消息直走原 `handle`）；`replier.handle` 支持 `msg.batch`。
- GUI：全局「回复模式」分段（`cards/chat.js`）+ 会话行「怎么回」覆盖分段（G31 标签可见）；云端开合批弹确认（`main.js`）。
- 测试：`test/batch-aggregator.test.js`（7 项全过）+ `tools/gui-e2e.mjs` G33。

**语义边界**：窗口由第一条**任意**群消息开启（不止触发消息），这样窗口内普通群友的发言也能并入上下文；但整窗若没有任何「该被处理」的消息（纯闲聊），flush 时直接丢弃、不回复。合批回复发到原群（不 @ 特定人，因为是总结性回答）。


## 16. 联网搜索与使用技巧（待规划能力，2026-10-27 提出）

### 16.1 现状核查（代码实证）
- **联网搜索**：不支持。AI 链路为 `replier.handle` → `responder.generate` → 单次 `chat/completions`（`src/ai/client.js`），无 tool / function calling、无 web fetch。用户消息只走上下文（记忆）与系统提示，模型若无联网能力则纯靠训练知识。
- **使用技巧**：现有「tips」仅为 `src/ai/probe.js` 的 `reviewConfig` 配置校验提示（填模型地址对不对）及 `gui/ai.js` 暴露的同类 tips——**不是**面向操作者的「使用技巧」文档 / 功能，也不是助手「给使用技巧」的能力。
- 结论：两项均**当前不支持**；但**技术上均可实现**，故补计划（验证条目见 `test-plan.md` §7.5）。

### 16.2 联网搜索（Web Search）

**可行性：高，但必须做成可选 + 默认关闭**（隐私优先 / 离线优先 / 零依赖原则）。

**范围定调（2026-10-27，经用户复核修订）**：联网搜索**不硬排除本地模型**——策略 B（自抓取注入）不依赖模型 tool-calling，本地模型（llama / qwen 等）技术上同样可用，可行性与云端一致。真正的不确定性在**用户接受度**：本地模型用户多为「数据不出机」而选本地，而联网搜索必然把查询发往第三方 provider，与隐私预期冲突。故本地联网搜索**允许但必须显式 opt-in + 默认关 + 醒目披露**（见隐私红线），由用户自行权衡，不在代码层禁止。

**实现策略（策略 B 为默认主路径，A 为可选增强）**：
- **策略 B（自我抓取注入，默认，推荐）**：不依赖模型是否支持 `tools`。在 `replier.handle` 的 `buildMessages` 前插入「搜索决策」：
  - 触发可配：`always`（每条都搜）/`auto`（启发式：含时间敏感词「今天 / 最新 / 2026」、知识截止后事实、或显式前缀 `/web`）/`prefix`（仅 `/web` 前缀）。
  - 命中 → 调 `src/ai/tools/web-search.js` 的 provider 抽象（可配 Tavily / SerpAPI / Bing / 自建）→ 结果清洗（截断、去广告、限条数）后注入上下文 → 再走原 `chat/completions`。
  - **对 API 与本地模型均零门槛**：只要 endpoint 是 OpenAI 兼容的 `chat/completions` 即可，无论它是否支持 `function_calling`——抓取与注入都在 AutoChat 侧完成，模型只是收到带搜索结果的上下文。本地模型（llama / qwen 等）同样能走 B（抓取与推理解耦），**技术上可行**；但因隐私预期，本地开启时必须弹警示（见隐私红线），默认关。
- **策略 A（模型原生 tool-calling，可选增强）**：声明 `web_search` 工具，解析 `tool_calls` → 调搜索 provider → 结果回填再二次调用。仅当**确认** endpoint 支持 `tools` 时作为增强开启；不作默认，因 API 支持度参差。

**架构落点**：
- 新 `src/ai/tools/web-search.js`：provider 抽象 + 结果清洗。
- `src/ai/replier.js`：搜索决策步骤（仅当 `AI_WEB_SEARCH` 开启且命中触发）。
- `src/core/config.js` 新增：`AI_WEB_SEARCH`(off/on)、`AI_WEB_SEARCH_PROVIDER`、`AI_WEB_SEARCH_KEY`、`AI_WEB_SEARCH_MODE`(always/auto/prefix)、`AI_WEB_SEARCH_TRIGGER`(前缀，默认 `/web`)。
- `src/chats.js`：支持 per-chat 覆盖（某些群允许搜、某些不允许）。
- GUI：model 卡「高级项」加 web search 开关 + provider + key + 模式；chat 卡 per-chat 覆盖。

**隐私 / 红线（与项目性质一致）**：
- 搜索会把**用户消息文本**发往第三方 provider。必须 explicit opt-in、日志标注、GUI 明示「开启后查询内容会发往 X」。
- 默认 off；与 LEGAL.md 的「数据外发」条款一致。注：联网搜索**本质就把查询发往第三方 provider**，与用本地还是云端模型无关（抓取是独立于模型推理的一步）；故不做「本地方可」限制，而是靠 explicit opt-in + 全程明示 + 日志标注来守住隐私红线。
- 配置示例：
  ```
  AI_WEB_SEARCH=on
  AI_WEB_SEARCH_PROVIDER=tavily
  AI_WEB_SEARCH_KEY=xxx
  AI_WEB_SEARCH_MODE=auto
  ```

**实现成本：中（约 1–2 天）**；测试：`test/web-search.test.js`（provider 抽象、触发判定、结果注入、隐私默认关、per-chat 覆盖），对应 `test-plan.md` §7.5 的 WS1–WS5（WS5 覆盖本地模型开启时的隐私警示）。

> **实现状态（2026-10-27）**：后端已实现并单测通过（`src/ai/tools/web-search.js` + `replier.buildWebSearchContext` 在 `buildMessages` 后注入 system 消息；provider 支持 tavily / serpapi / bing / custom；默认关闭、本地模型开启时 GUI 弹隐私警示）。GUI 高级项已加「联网搜索」开关 / provider / key / 模式，`.env` 亦可配。


### 16.3 使用技巧（Usage Tips）—— 已由项目文档覆盖，不另立计划

用户确认：使用技巧（in-product help / 文档）已由项目现有 MD 文档（如 `docs/getting-started.md`、命令文档等）覆盖，**不重复立项、不计缺口**。原 `test-plan.md` 的 GAP14 / UT1–UT3 已撤销。

> 注：(B)「让 AI 给使用技巧」属 prompt 层面，无需代码；如需「联网查最新技巧 / 教程」，即 §16.2 的一个应用场景（归到 web search）。若未来要做 GUI 帮助卡 / `autochat tips` CLI 命令等 in-product 增强，再单独立项。

### 16.4 AI 工具调用 / Skills 框架（2026-10-27 用户确认含义后补）

> 用户明确「技巧（Skills）= AI 工具调用（tool calling）」。现状：AutoChat 当前**对任何模型（本地 / 云端）都没有**工具调用能力——仅单次 `chat/completions`，无 `tools` 声明 / `tool_calls` 解析 / 执行循环。属项目整体未实现，非本地与云端的差距。

**可行性：高**。OpenAI 兼容协议原生支持 `tools` + `tool_calls`；云端服务天然可用；本地后端（Ollama 等）对支持 function calling 的模型（llama3.1 / qwen2.5 等）也支持。缺的只是 AutoChat 侧的**工具注册 + 执行循环 + 护栏**。

**与 §16.2 联网搜索的关系（建议收编）**：§16.2 策略 A 本质就是「`web_search` 工具」。建议把联网搜索统一收编进本工具框架——`web_search` 作为内置 skill 之一；§16.2 策略 B（自抓取注入）保留为「不依赖 endpoint 支持 tools」的兼容兜底（对不支持 `function_calling` 的 API / 本地模型也能用）。避免两套并行机制。

**架构落点**：
- 新 `src/ai/tools/` 工具注册表：每个 skill = `{ name, description, parameters(json schema), execute(args) }`。首期内置：`web_search`（复用 §16.2 provider）、`calculator`、`time/date`（可选 `remind` / `note`）。
- `src/ai/responder.js`：当 `AI_TOOLS=on` 时首次请求带 `tools`；解析 `tool_calls` → 逐个 `execute` → 结果回填再二次（或多次）调用，直到无 `tool_calls`（ReAct 式循环）。
- `src/core/config.js` 新增：`AI_TOOLS`(off/on)、`AI_TOOLS_ALLOW`(白名单，逗号分隔)、`AI_TOOLS_MAX_ROUNDS`(防死循环，默认 5)。
- `src/chats.js`：支持 per-chat 覆盖（某些群允许工具、某些不允许）。
- GUI：model 卡「高级项」加工具开关 + 白名单；chat 卡 per-chat 覆盖。

**安全护栏（与 §4 / LEGAL 红线一致）**：
- 工具执行必须**白名单 + 显式 opt-in**；危险工具（发消息 / 删文件 / 外部写）默认禁用。
- 每次工具调用记日志（工具名 + 入参摘要，不落敏感值）；`AI_TOOLS_MAX_ROUNDS` 兜底防模型陷入无限调用。
- 不越界：工具仅增强回答，**不自动接管群 / 不替人承诺**（踩 §13 已砍的群管理 / 工作流红线则否决）。

**实现成本：中–高（约 3–5 天）**；测试：`test/tool-calling.test.js`（`tool_calls` 解析、执行循环、白名单、最大轮次、`web_search` 工具复用、per-chat 覆盖），对应 `test-plan.md` §7.6 的 SK1–SK4。

> **实现状态（2026-10-27）**：已实现并单测通过（`src/ai/tools/registry.js` + `loop.js` + `client.js` 透传 `tools` / `tool_calls` + `replier.runReply` ReAct 循环；内置 web_search / calculator / time，白名单 + `AI_TOOLS_MAX_ROUNDS` 护栏；GUI 高级项已加「AI 工具调用」开关与白名单）。


### 16.5 范围与红线复核
- 不踩 §13 的「明确不做」：联网搜索是**显式 opt-in** 的能力扩展，非自动接管；AI 工具调用同样受白名单 + 护栏约束，危险工具默认禁用（使用技巧已确认由项目文档覆盖，不另立计划，见 §16.3）。
- 与 §8 治理（单维护者、红线）无冲突：搜索 / 工具 provider 由用户自带 key，项目不内置任何第三方密钥 / 服务。
- 关联测试：`test-plan.md` §7.5（GAP13、WS1–WS5）、§7.6（GAP15、SK1–SK4）。

## 17. 高级模式、基础办公与发布前修复（2026-10-28 实现登记）

> 本章为**已实现**能力与发布前修复的登记，供发布说明与回归对照。

### 17.1 双模型路由与长任务占位（§16.4 的姊妹能力）

- **默认一个模型**：`AI_MODEL_ROUTING` 默认关，始终用用户配置的 `AI_MODEL`，行为可预测。
- **高级模式**：按复杂度在两个**都由用户指定**的模型间切换——轻量 `AI_LIGHT_MODEL/BASE_URL/API_KEY` 打简单任务，复杂任务升级主模型。复杂度判定走**纯规则**（带附件 / 会联网 / 会用工具 / 超 200 字 / 复杂任务标记 / **生成型任务：写代码、长文**），**绝不为此额外调一次模型**。
- **全局 / 会话两级**：`ChatProfiles` 覆盖（`modelRouting` / `lightModel` / `lightBaseUrl`），会话优先。
- **长任务占位（用户定为 B 方案，默认开）**：判定为长任务先发「正在XX中……」，结果**另起一条新消息**（微信无法原地替换，这是两条真消息）。文案按场景：解析文件 / 联网检索 / 处理（工具）/ 编写代码 / 撰写。
- **关键认知（用户纠偏）**：「慢 ≠ 用工具」——写代码、长文不调工具也慢，既算复杂（走主模型）也算长任务（先提示）。
- 实现：`src/ai/router.js` + `replier.aiForLight` + `responder.sendNotice`。


### 17.2 文档解读与基础办公（零依赖）

- **硬约束**：`package.json` 零运行时依赖 → docx/xlsx/pptx/pdf 解析**不引 npm 库**，用 Node 内置 zlib 手写最小 ZIP 读写 + XML 提取（`src/ai/tools/office.js`）。
- **抽取**（入站）：txt/md/csv/json/log/yml/ini 直读；docx/xlsx/pptx 走 ZIP+XML；**pdf 尽力而为**（Flate 流文本算子，扫描件抽不出）。入站附件由 `normalize.pickFiles` 按「值像受支持路径」尽力识别（不同 hook 字段名差异大，识别不到按纯文本处理）。
- **注入**：抽取文本作为 system 消息注入（与联网搜索策略 B 同手法）；单份超长按 `AI_DOC_MAX_CHARS` 截断；**某份失败带原因继续，不让助手失声**。抽取**纯本地**，与联网搜索是两回事。
- **生成**（出站）：`write_doc` 技能生成 md/txt/docx/xlsx，返回 `[[file:路径]]`，由 responder 走 `sendFile` 发**真文件消息**；图片走 `[[image:]]` → `sendImage`。按「危险工具默认禁用」原则 `write_doc` 标记 **restricted，不进默认白名单**，须显式写进 `AI_TOOLS_ALLOW`。
- **沙箱**：只能写 `AI_DOC_OUT_DIR`（默认 `data/outbox`）；文件名清洗（分隔符→`_`、去前导点）+ 目录校验双重防穿越。
- 开关 `AI_DOC_ANALYSIS` 默认关，**全局 / 会话两级**。


### 17.3 发布前修复登记（2026-10-28，均由用户实测发现）

| 问题 | 根因 | 修复 |
|---|---|---|
| 会话开关「关」变「开」 | 界面写入字符串 `'0'`，`Boolean('0')` 为 true | `chats.js` 引入 `triBool` 三态解析（含回归测试） |
| 微信已适配版本被要求「重装到同一版本」 | `describeSupport` 精确命中时**没返回 `level`**，`autoRepair` 判 `undefined !== 'exact'` 恒真 | 所有分支带回 `level`；并加兜底：目标版本==当前版本时拒绝重装并引导 doctor |
| 卸载确认框不反映「移入回收站」状态 | 开关渲染的是 `data-sw` 属性，代码用 `getElementById` 永远拿 null | 改 `querySelector('[data-sw=…]')` |
| 日志面板永远停在旧快照 | `refresh()` 只在 `force` 时拉日志，4 秒自动刷新不带日志 | 日志随常规刷新拉取（失败沿用上一次） |
| `web_search` 技能拦掉免 key 的 custom | 一刀切要求 key | 按 provider `needsKey` 判断；custom 缺端点才报端点错 |
| 工具串行慢 | 多个独立工具逐个 await | 改 `Promise.all` 并行、按原顺序回填；默认最大轮次 5→3 |


### 17.4 CLI / GUI 对齐情况

- **env 级**：`autochat config set` 与 GUI 共用同一份 `EDITABLE_ENV` 白名单，新键（联网搜索/工具/路由/文档）CLI 均可设——**对齐**。
- **会话级**：`autochat chats set <id> key=value` 走 `upsertChat`（不过滤白名单）。口径差异记录在案：CLI 是本地高权限入口，可写包括 `apiKey` 在内的字段；GUI/API 按 `CHAT_FIELDS` 过滤、拒绝写密钥。如需收紧再单独立项。
- **可见性**（本轮补齐）：`autochat chats list` 现展示全部灰度覆盖（联网搜索/AI工具/双模型路由/长任务提示/文档解读/轻量模型/回复模式），`autochat status` 现展示五个能力开关及关键参数——与 GUI 高级项、会话卡覆盖标签一致。


### 17.5 真机验证清单（发布前必须过一遍，单测覆盖不到微信侧）

1. 真实群消息触发回复（基础链路）。
2. 联网搜索（Tavily key 或自建 custom）：时间敏感问题 → 回复含检索结果；日志出现「联网搜索触发」。
3. AI 工具（需支持 function calling 的模型）：算式 / 问时间 / `/web` 前缀；多工具同轮是否并行（看耗时）。
4. **入站附件**：群里发 docx/xlsx/pptx/pdf/txt → 先收「正在解析文件……」再收到解读（`pickFiles` 是否认出你的 hook 的附件字段是**最大不确定点**）。
5. `write_doc`（白名单显式加入后）：让 bot 生成报告 → 收到**文件消息**且能打开。
6. 双模型路由：配轻量模型后，闲聊走轻量、写代码走主模型（看日志「模型路由」行）。
7. 长任务提示：确认提示与结果是两条消息、顺序正确。
8. 自动修复：精确支持版本不再弹「重装到同一版本」。


## 附：关键契约（精要，完整见 `docs/glossary.md` 与 `test-plan.md`）

- 环境体检项结构：`{ level:'ok'|'warn'|'bad', name, detail, next }`。
- 四类对象命令矩阵：助手服务 `start/stop`；自动回复 `AI_ENABLED`+`pause/resume`；模型服务 `model-service start/stop`；会话 `chats enable/disable`。
- 开关体系：自动回复开关 `ai.enabled`；暂停 `pause.isPaused()`；会话 `chats[id].enabled`；范围 `ai.allowChats/denyChats`。
- GUI 控件规范：`.sw` 开关 / `.seg` 分段 / `.act` 动作按钮 / `.chip` 标签多选；**禁用裸勾选框**。
- 退出码：0 / 1 / 2（见 §3）。
- 设计取舍（非缺口）：不做 i18n（仅中文 + 英文摘要）；插件只做外壳；不内置 / 再分发微信安装包与第三方 DLL；**不支持手机端（iOS / Android），仅 Windows + Windows 版微信**；hook / DLL 强绑定微信版本是**有意根基设计**（历史上换 DLL 致整项目失灵），由 `autodll`+`lock` 显式管理。

---
