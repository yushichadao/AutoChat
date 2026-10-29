# AutoChat 控制台

AutoChat 是 Windows 上的「微信侧本地 AI 助手」：向本机已登录的微信注入 hook DLL，
轮询收到消息 → 按策略判断要不要回 → 调本地或云端 OpenAI 兼容模型 → 清洗后发回微信。
**零运行时依赖、只在本机运行、不做跨平台转发。**

本技能负责「替用户在 DeepSeek Harness 里操作它」，不负责改它的实现。

## 一、先读这一条：根本性配置七步不可跳

AutoChat 的配置文件（`.env` / `config.json`）只是结果；能不能跑起来取决于七步是否真的成立。
这七步由 AutoChat 本体 `src/tasks/setup.js` 的 `evaluateSteps()` 判定，
**命令行、图形化配置器、DSH 插件、MCP 服务器四处共用同一份判断**：

| # | 步骤 | 成立的意思 | 不成立会怎样 |
| --- | --- | --- | --- |
| 1 | Node 运行环境 | Node ≥ 18 | 起不来 |
| 2 | 微信客户端 | 找得到 `Weixin.exe` 的安装目录 | 没处注入 |
| 3 | 锁定微信版本 | 阻断自动更新 | 微信一升级，hook DLL 静默失效（「昨天还好好的」） |
| 4 | hook DLL | 配置的那份 = 微信目录里实际加载的那份 | ping 通但 `IsLogin=0`、所有 `QueryDB` 报 `get database handle failed` |
| 5 | 接一个模型 | `AI_BASE_URL` + `AI_MODEL` 齐且能连通 | 收到消息但回不出话 |
| 6 | 小号 / 同号 | `WX_SELF_ID` 能区分「我发的」和「它发的」 | 自问自答防护把自己的提问全过滤掉，表现是「装死」 |
| 7 | 启动服务 | pid 文件里的进程还活着 | 什么都不发生 |

**纪律**（违反其中任何一条都算这次操作失败）：

1. 任何写操作之前，先 `autochat_preflight`，并且**把七步现状原样讲给用户**，不要概括成「配置好了」。
2. 有 `bad` 项时不要用 `acknowledge_blocking` 绕过；先把那一项补上。用户明确说「我就要先跑起来看日志」才可以用。
3. `.env` / `config.json` 的键**只通过 `autochat_config` 写**（白名单、脱敏在 AutoChat 里统一实现）。
   不要手写 `.env`，不要用 `echo` / `Set-Content` 拼配置——写错一个换行整份配置就废了。
4. 需要人现场拍板的步骤（选模型来源、填密钥、加入哪个群）**不要替用户猜**：
   给命令让他走 `npm run setup` / `npm run gui`，或者用 `autochat_open_console` 把图形化配置器拉起来。
5. 报告结果时区分「已写入」「没写进去」「需要重启才生效」三种状态，不要混。

## 二、工具地图

| 想干什么 | 工具 | 备注 |
| --- | --- | --- |
| 看七步现状 | `autochat_preflight` | 一切操作的入口，只读 |
| 查「为什么它不理我」 | `autochat_doctor` | hook 端口、登录态、库表、模型、小号隔离、崩溃计数 |
| 看运行快照 | `autochat_status` | 服务在跑没、回复是否暂停、当前模型 |
| 起停服务 | `autochat_service` | `start` 受七步门槛约束；改配置后要 `restart` |
| 暂停 / 恢复回复 | `autochat_reply_gate` | 暂停期间仍收消息、仍记日志 |
| 读 / 写 `.env` | `autochat_config` | 写需 `confirm:true`；敏感键只回 `true/false` |
| 按会话配置 | `autochat_chats` | `add` 会自动补 `WX_POLL_CHATS` |
| 锁版本 / 匹配 DLL / 部署 DLL | `autochat_apply_step` | `confirm:true`；部署后必须重启微信 |
| 测模型 | `autochat_model` | `test` 是真实请求（会花一点额度） |
| 看日志 | `autochat_logs` | 后台启动才有 `data/autochat.out` |
| 打开图形化配置器 | `autochat_open_console` | 由它自己打开带令牌的本地页面 |

## 三、常见症状 → 处理顺序

| 症状 | 先查 | 大概率原因 |
| --- | --- | --- |
| 完全没反应（日志里连收到的消息都没有） | preflight 第 2/4/7 步 | 没起服务 / DLL 没部署 / 监听会话为空 |
| hook ping 通，但读不到登录态和数据库 | preflight 第 4 步、doctor | 微信目录里是**另一份** DLL（版本不匹配），要重新匹配 + 部署 + 重启微信 |
| 收到消息了，但没人回复 | preflight 第 5 步、`autochat_model` 的 test | 模型地址/密钥/模型名不对，或 `AI_ENABLED=0` |
| 群里只有我在说话，机器人不理 | preflight 第 6 步、doctor 的「小号检查」 | 同号：提问的人和机器人是同一个微信号 → 用小号方案（手机主号、电脑另一个号） |
| 昨天正常今天全乱 | preflight 第 3/4 步 | 微信自动升级了，旧 DLL 失效 → 锁版本 + 重新匹配 |
| 回复开始重复、答非所问 | `autochat_config` 看 `AI_CONTEXT_TURNS` / `AI_CONTEXT_MAX_CHARS` | 上下文预算过大，或人设提示词互相冲突 |
| 回复特别慢 / 特别贵 | `autochat_config` 看 `AI_REASONING_EFFORT` | 思考强度开太高（`off`/`low`/`medium`/`high`，默认 `off`）；模型不支持这套参数时会自动退回关闭 |

需要更细的排查路径时，读 AutoChat 仓库里的 `docs/failure-modes.md`（失败的形状）与 `docs/commands.md`（命令全集）。

## 四、安全与合规红线（不可协商）

- 只允许在**用户自己的电脑、自己的微信号**上操作。对他人设备或账号注入、读取一律拒绝。
- 不帮助把 AutoChat 用于：冒充他人身份沟通、向不特定多数人群发推广、发送收款码/支付链接/「代付」请求、代替真人做承诺。
  用户提出这类需求时，说明原因并停下（法律依据见 AutoChat 仓库的 `LEGAL.md`：诈骗罪 266、帮信罪 287 之二、侵犯公民个人信息罪 253 之一等）。
- 不读取、不转述 `AI_API_KEY`、`WX_WEBHOOK_TOKEN` 的真实值（工具只会返回是否已配置）；用户贴出来提醒他轮换。
- 改动前先说明「这一步会动什么」（写微信安装目录 / 改 `.env` / 杀进程重启），得到确认再执行。

## 五、边界

- 插件是**外壳 + 拦截器**，不是第二套实现：所有判定与落盘都在 AutoChat 的 `src/tasks/` 里。
  发现插件行为和 CLI 不一致，以 CLI 为准，并如实报告差异。
- 想扩展能力（比如新的会话策略）请改 AutoChat 主体，不要在插件里另写一份配置逻辑。
