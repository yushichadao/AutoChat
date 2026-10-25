# AutoChat

**Windows 专属的「微信侧本地 AI 助手」**：注入 hook DLL 读写本机已登录的微信号，收到消息后按策略交给本地或云端的 OpenAI 兼容模型，再把回复发回微信。

零运行时依赖（只用 Node 内置模块）、无构建步骤、只在本机运行。

> [!CAUTION]
> **三条红线，用之前请先读完 [LEGAL.md](LEGAL.md)**
> 1. **不冒充他人**与他人沟通，不用他人身份、头像、名义从事任何活动
> 2. **不向不特定多数人推送**投资、理财、中奖、刷单、保健品、贷款、赌博等信息
> 3. **不发送收款码、支付链接、「代付/代买」请求**，不代替真人做承诺
>
> 违反这些可能触及**诈骗罪（刑法 266 条）、帮信罪（287 条之二）、侵犯公民个人信息罪（253 条之一）**以及民事侵权与行政责任。
> **是 AI 干的不是免责理由** —— 配置、部署、维护的人就是行为人。
>
> 另外两条硬边界：
> 4. **只在自己电脑上、用自己的微信号**。对他人设备、他人账号注入或读取，可能触及**非法侵入计算机信息系统罪（285 条）、破坏计算机信息系统罪（286 条）**。
> 5. **不打包分发第三方 hook DLL**；仓库里随附的二进制来源与许可见 [docs/DLL-SOURCES.md](docs/DLL-SOURCES.md)，版权归原作者。

---

## 这是什么 / 面向谁 / 三分钟上手

**这是什么**
一个只做微信一件事的小工具：收消息 → 判断要不要回 → 调模型 → 清洗 → 回微信。
不连任何外部平台，不跨平台转发，不做群发。

**面向谁**

| 你是 | 从哪开始 |
| --- | --- |
| 会用电脑但不想碰命令行 | 下载便携版解压双击（`docs/GETTING-STARTED.md` 方式 A）或 `npm run gui` |
| 会 cmd / PowerShell，想脚本化 | `npm run doctor` → `npm run setup` → `npm start` |
| 想读代码做二次开发 | `src/` 六层结构，见 [CONTRIBUTING.md](CONTRIBUTING.md) |

**三分钟上手**（完整版见 [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)）

```bash
node -v                      # 需要 18 以上（推荐 22 LTS）
git clone https://github.com/yushichadao/AutoChat.git
cd AutoChat && npm ci        # 零运行时依赖，基本是空操作
npm run doctor               # 体检：缺什么会直接告诉你
npm run setup                # 向导：检测 → 锁定版本 → 匹配 DLL → 配模型 → 选小号
npm start                    # 启动（需要管理员时用 npm start -- --elevate）
```

验证：手机用**另一个号**给电脑上的小号发一句「你好」，几秒内应该收到回复。

不想装 Node、想给小白一个「下载解压、双击即开」的包？见下方「便携版构建」。

---

## 入口怎么选：命令行与图形化配置器平级

**两个入口能力对等** —— 能做的事一样多，只是呈现方式不同。共享的是同一套任务逻辑（`src/tasks/`），不是「一个是主、一个是皮」。

| 你想做的事 | 命令行 | 图形化配置器 |
| --- | --- | --- |
| 初始化 | `autochat setup` | 首启向导卡 |
| 环境体检 | `autochat doctor` | 环境体检卡 |
| 启动 / 停止服务 | `autochat start` / `stop` | 状态卡 |
| 暂停 / 恢复自动回复 | `autochat pause` / `resume` | 状态卡 / 顶栏 |
| 看状态 / 看日志 | `autochat status` / `logs` | 状态卡 / 服务日志卡 |
| 接模型、启停本地模型服务 | `autochat model test` / `model service start` | 接一个模型卡 / 模型服务卡 |
| 按会话配置 | `autochat chats ...` | 按会话配置卡 |
| 锁定微信版本、自动匹配 DLL | `autochat lock` / `autodll` | 安装与卸载卡 / 账号卡 |
| 安装 / 卸载 | `autochat install` / `uninstall` | 安装与卸载卡 |

npm 脚本只是命令行的薄别名：`npm run doctor` ≡ `autochat doctor`。

**完整的命令清单**：[docs/COMMANDS.md](docs/COMMANDS.md)

---

## 真正要准备的三件事

**① 小号（重要）**
电脑微信必须扫码登录，所以**电脑上登录的号 == 手机上的号**。如果你就用这个号在群里提问，AutoChat 分不清「你发的」和「它发的」，会把你的话当噪音丢掉 —— 表现就是「AutoChat 装死」。
做法：手机上准备另一个号（主号），电脑微信扫码登录**小号**，把小号拉进目标群。
判定方式见 `.env` 的 `WX_SELF_MODE`：小号用 `sender`（最稳），同号必须用 `id`。

**② 旧版微信 + 锁定版本**
hook DLL 与**微信版本强绑定**，微信一更新就失效（更新会直接删掉整个旧版本目录）。
先 `npm run doctor` 看版本匹配情况，再 `autochat lock` 锁定版本（阻断自动更新，也意味着放弃安全补丁）。

**③ 管理员权限**
注入 DLL 需要管理员。`autochat start --elevate` 会自动弹 UAC 提权。

模型反而是最简单的一步：本地 Ollama 或任意 OpenAI 兼容地址都行，向导里现场测一次，通了才保存。

---

## 常见故障速查

| 现象 | 多半是 | 先做这个 |
| --- | --- | --- |
| AutoChat 不理人 | 自动回复被暂停 / 模型连不上 / 群里只有你自己在说话 | `autochat status` → `autochat doctor` |
| 服务自己消失了 | 前台运行，关终端就没了 | `autochat start --background` |
| 昨天还好好的，今天不行了 | 微信自动更新了，DLL 失效 | `autochat lock` 锁定版本，`autochat autodll` 重新匹配 |
| 收不到消息 | 没配监听会话 | `.env` 的 `WX_POLL_CHATS` 填上会话 wxid |
| 群里刷屏 | 自身消息过滤失效（wxid 没拿到 / 判定方式选错） | `autochat doctor` 看「自消息判定」 |
| 模型连接失败 | 本地模型服务没开 | `autochat model service start`（Ollama 等） |
| 卸载后微信还是不能更新 | 旧版本的卸载没解除更新阻断 | 2.0.0 已修；`autochat uninstall` |

**完整清单（含代码位置与自愈措施）**：[docs/FAILURE-MODES.md](docs/FAILURE-MODES.md)

---

## 深入文档索引

| 文档 | 讲什么 |
| --- | --- |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | 换一台机器的十分钟上手清单 |
| [docs/COMMANDS.md](docs/COMMANDS.md) | 全部命令、退出码、JSON 输出、配置项速查 |
| [docs/EXPERIENCE-AUDIT.md](docs/EXPERIENCE-AUDIT.md) | 站在五种使用者角度的体验审计与能力对照表 |
| [docs/FAILURE-MODES.md](docs/FAILURE-MODES.md) | 11 类「挂掉」现象的根因、检测与自愈 |
| [docs/LOGIC-UI-ISSUES.md](docs/LOGIC-UI-ISSUES.md) | 逐条核实过的逻辑与界面缺陷清单 |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | 术语表（统一叫法与禁用词） |
| [docs/DLL-SOURCES.md](docs/DLL-SOURCES.md) | 随仓库提供的 hook DLL 来源、适配版本与许可 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更（2.0.0 有破坏性变更，看迁移指引） |
| [LEGAL.md](LEGAL.md) | 法律与合规说明（必读） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 目录结构、命令表、测试与提交规范 |

---

## 便携版构建

不想装 Node、想给小白一个「下载解压、双击即开」的包？用脚本打一个**自带 Node 运行时**的 ZIP：

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-portable.ps1
```

产物在 `dist/AutoChat-win-x64.zip`：内含 `node.exe` + 全部应用 + `AutoChat.bat` 启动器 + `使用说明.txt`。
解压后双击 `AutoChat.bat` 就能打开图形化配置器，**离线也能开**；模型（Ollama 引擎 + 小模型）在首启向导里一键联网拉取。

> 脚本首次会尝试从 nodejs.org 下载匹配版本的 `node.exe`；若网络受限，把对应 win-x64 的 `node.exe` 放到 `dist/` 再跑即可。
> 发布到 GitHub Releases 时附上这个 zip，小白就走「方式 A」了（见 [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)）。

---

## 配置项

完整列表见 [`.env.example`](.env.example)，最常用的几项：

| 键 | 作用 |
| --- | --- |
| `AI_ENABLED` | **自动回复开关**（0 = 只收消息不回复） |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 模型地址（到 `/v1` 为止）/ 模型名 / 密钥 |
| `AI_GROUP_REPLY` | 群聊什么时候回：`never` / `mention`（默认）/ `always` |
| `AI_GROUP_AT_NAMES` | 群里被 @ 时认可的称呼，**强烈建议填**（不填时任意 @ 都会触发） |
| `WX_SELF_ID` / `WX_SELF_MODE` | 本机 wxid / 判定方式（`sender` 小号、`id` 同号） |
| `WX_DLL_PATH` | hook DLL 绝对路径（`autochat autodll --write` 可自动填） |
| `WX_POLL_CHATS` | 要监听的会话（群 wxid / 好友 wxid，逗号分隔） |
| `WX_RECEIVE_MODE` | 接收方式：`webhook` / `poll` / `auto` |
| `MODEL_SERVICE_RUNNER` | 本地模型服务怎么启动（`auto` / `ollama` / `llamacpp` / `manual`） |

---

## 安全护栏

| 护栏 | 默认 | 说明 |
| --- | --- | --- |
| webhook 入口绑定 | `127.0.0.1` | 改成 `0.0.0.0` **必须**同时设 `WX_WEBHOOK_TOKEN`，否则启动直接报错 |
| 自身消息过滤 | 开启 | 已知本机 wxid 时精确过滤自己发的消息 |
| 回声识别 | 开启 | 拿不到 wxid 时用内容比对识别「自己的回复被推回来」，防止自问自答 |
| 否定语义拒绝 | 开启 | 「别回我」「不用理我」等直接不回 |
| 自动回复开关 | 由你配 | `AI_ENABLED=0` 即只接收不回复 |
| 暂停状态 | 文件即状态 | `autochat pause` 立刻生效，崩了重启仍是暂停态 |
| 限流三层 | 冷却 3s / 每小时 120 条 / 并发 2 | 防刷屏、防耗额度 |
| 配置器鉴权 | 随机令牌 | 只监听回环地址，页面请求必须带令牌；可改的 `.env` 键是白名单 |
| 密钥存放 | `.env` | 已在 `.gitignore` 里；`data/` 同样忽略 |
| 零运行时依赖 | `dependencies: {}` | 只用 Node 内置模块，`npm install` 不装任何东西 |

---

## 卸载与还原

```bash
autochat uninstall              # 停服务、去自启、删快捷方式、还原 version.dll、解除微信更新阻断
autochat uninstall --purge      # 连 .env 与 data/ 一起清掉
autochat uninstall --dry-run    # 只看会做什么，不改任何文件
autochat uninstall --force      # 连我们部署的 version.dll 一起删（谨慎）
```

**不会删你的微信聊天记录。** 微信进程里可能还驻留着已注入的 hook DLL，重启微信即可清除。

---

## 法律与合规（必读）

- **红线三条 + 硬边界两条**见本文开头与 [LEGAL.md](LEGAL.md)。
- 完整法律梳理、刑责科普、数据流向、维护者义务、举报与执法请求流程：**[LEGAL.md](LEGAL.md)**。
- 漏洞请走私密渠道：**[SECURITY.md](SECURITY.md)**（不要开公开 issue）。
- 行为准则与技术红线：**[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)**。
- 许可：**[LICENSE](LICENSE)**（源可见、含署名与 GUI 保护条款）。
- 个人号自动化违反《微信个人账号使用规范》可能被限制功能或封禁；建议小号、控制频率、不要群发。

---

## 贡献

```bash
git clone https://github.com/yushichadao/AutoChat.git
cd AutoChat && npm install
npm test              # 123 项，应全绿
npm run demo          # 不需要 DLL 与 API Key 跑通全链路
npm run doctor        # 在你自己的机器上体检
```

要求：Node.js ≥ 18；纯 ESM、无构建步骤、无 TypeScript、无 lint 框架 —— 保持简单是本项目的风格。
新增行为必须同时新增测试；提交信息参考 Conventional Commits；每个 commit 末尾加 `Signed-off-by:`。

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 作者与联系方式

- 作者 / 维护者：**Yushichadao**
- 邮箱：**yushichadao@qq.com**
- 仓库：<https://github.com/yushichadao/AutoChat>
