# 故障模式清单：项目为什么会「挂掉」

> 这份文档回答一个问题：**为什么 AutoChat 突然不回消息了 / 服务自己消失了？**
> 每一条都对照代码确认过，不写「据说」。位置标注为 `文件:行`（以 2.0.0 结构为准）。

## 先看结论：最常见的四个原因

按实际出现频率排序：

1. **微信自动更新了** —— 更新会删掉整个旧版本目录，hook DLL 随之静默失效（表 F4）。
2. **自动回复被暂停** —— `data/paused` 哨兵文件还在，崩了重启也是暂停态（表 F3）。
3. **模型服务没开** —— 配了本地模型地址，但 Ollama 没启动（表 F7）。
4. **DLL 与微信版本对不上** —— 偏移失效，hook 端口起不来或接口返回空（表 F4 / F5）。

一句话排查顺序：

```bash
autochat doctor     # 先看它列出的阻断项与修复顺序
autochat status     # 看服务在不在跑、自动回复是不是暂停态
autochat logs       # 看最后 200 行日志
```

---

## F1 服务自己消失了

| 项 | 内容 |
| --- | --- |
| 现象 | 昨天还在跑，今天进程没了；或者重启终端后服务没了 |
| 根因 A | 前台运行：服务挂在终端进程上，终端一关就没了。`autochat start` 是前台模式 |
| 根因 B | 启动失败即退出：`src/index.js` 校验配置不通过就 `process.exit(1)`，日志里能看到「配置错误」 |
| 根因 C | 单实例保护：pid 文件里记着「上一个实例」，新实例发现它还活着就自杀（`src/core/pause.js` 的 `shouldYieldToExisting`） |
| 根因 D | pid 文件陈旧：上一个实例是被强杀的，pid 还在，新实例误判「已有实例在跑」而退出 |
| 检测 | `autochat status` 看「助手服务」行；`autochat logs` 看最后几行有没有「已有实例在运行」 |
| 已做的自愈 | `autochat start --background` 用 WMI 脱离终端；`autochat start --elevate` 自动 UAC 提权；`autochat install --service` 注册开机自启（后台模式） |
| 剩余风险 | 强杀（任务管理器结束进程）仍会留下陈旧 pid，需要 `autochat stop` 再启动 |

## F2 关掉终端服务就没了

| 项 | 内容 |
| --- | --- |
| 现象 | 关掉 PowerShell / cmd 窗口，服务也没了 |
| 根因 | 默认是前台运行，服务是终端的子进程 |
| 检测 | `autochat status` → 「助手服务：没有在运行」 |
| 已做的自愈 | `autochat start --background`（WMI 创建，不在调用方的进程作业里） |
| 剩余风险 | 无 |

## F3 AutoChat 突然不回消息（但服务还在）

| 项 | 内容 |
| --- | --- |
| 现象 | 服务在跑，日志有「回调 0 轮询 N」，但一条也没回 |
| 根因 A | **暂停哨兵残留**：`data/paused` 存在 → 停止回复但继续接收。崩了重启也仍是暂停态 |
| 根因 B | **自动回复开关关闭**：`AI_ENABLED=0`（旧配置 `AI_MASTER_SWITCH=0` 已并入，体检会提示） |
| 根因 C | **自身消息过滤把消息全丢了**：拿不到本机 wxid（`WX_SELF_ID` 空）时，`sender` 模式会把所有消息当自己的丢掉 |
| 根因 D | **小号/同号选错**：电脑微信 = 手机号同号却用 `sender` → 提问者就是本机账号，全被过滤（表现：AutoChat 装死） |
| 检测 | `autochat status` 看「自动回复」三态；`autochat doctor` 看「自消息判定」「小号检查」 |
| 已做的自愈 | 体检把「自动回复开关」「暂停状态」「自消息判定」拆成三项分别报；`autochat pause/resume` 明确区分「暂停」与「关闭」 |
| 剩余风险 | 同号场景必须用 `id` 模式，程序无法自动判断，需要人配对 |

## F4 DLL 静默失效（微信更新了）

| 项 | 内容 |
| --- | --- |
| 现象 | 昨天还好好的，今天 hook 端口连不上；或 DLL 明明加载了但没反应 |
| 根因 | 微信自动更新会**整个删掉旧版本目录**，DLL 随之消失（实测 11 分钟就被升回去）；`src/bridge/compat.js` 的 `trackVersion` 能感知版本变化，但只 warn |
| 检测 | `autochat doctor` → 「DLL 与微信版本」项；`autochat autodll` 看当前版本有没有匹配方案 |
| 已做的自愈 | `autochat lock` 锁定微信版本（把 update 目录换成只读文件）；体检新增「DLL 与微信版本」精确/近似/无方案三态 |
| 剩余风险 | 锁定意味着放弃微信安全补丁；换微信大版本后仍要重新匹配 DLL |

## F5 收不到消息

| 项 | 内容 |
| --- | --- |
| 现象 | 服务正常、日志正常，就是没有消息进来 |
| 根因 A | 接收方式与 DLL 能力不符（webhook / poll / auto） |
| 根因 B | 没配 `WX_POLL_CHATS`：轮询路径不知道该看哪些会话 |
| 根因 C | DLL 没有 `/QueryDB/execute`，poll 查不了库 |
| 根因 D | 缺 `getdbkey.dll`，数据库加密读不了 |
| 检测 | `autochat doctor` → 「收消息」项会列出每个会话查到了几张表 |
| 已做的自愈 | 体检逐会话列出；配置项注释写清「填了才收得到」 |
| 剩余风险 | hook DLL 的能力由第三方决定，本项目只能探测不能补齐 |

## F6 自己回自己（刷屏、烧额度）

| 项 | 内容 |
| --- | --- |
| 现象 | 群里刷屏，每条消息都回一遍 |
| 根因 A | 自身消息过滤失效：`WX_SELF_ID` 拿不到，或 `sender` / `id` 选错 |
| 根因 B | 回声识别失效：已发消息记录（`data/sent-messages.json`）丢失或损坏 |
| 检测 | 日志里「自发」与「回声」两个计数异常上涨；`autochat doctor` 看「自消息判定」 |
| 已做的自愈 | 自身消息过滤 + 回声识别双层防护（`src/bridge/self-filter.js`）；日志单独暴露两个计数 |
| 剩余风险 | 极端情况下仍可能漏判，靠 `AI_MAX_PER_HOUR` 与冷却兜底 |

## F7 模型调不动

| 项 | 内容 |
| --- | --- |
| 现象 | 「模型连接：没成功」，或消息进来了但不回 |
| 根因 A | 本地模型服务没启动（Ollama 没开） |
| 根因 B | 限流把请求**静默丢弃**：冷却、每小时上限、并发上限三条规则叠加时不回日志（表现为「不理人」而不是「报错」） |
| 根因 C | 云端 401（密钥错）/ 429（额度或频率）/ 超时 |
| 检测 | `autochat model test`；`autochat model service status` 看本地服务在不在；日志里「跳过」计数异常 |
| 已做的自愈 | 新增 `autochat model service start/stop`，可一键拉起本地模型服务并等就绪；体检新增「模型服务」检查 |
| 剩余风险 | 限流的静默丢弃仍在排查中（见 `docs/LOGIC-UI-ISSUES.md` L2） |
## F8 端口冲突

| 项 | 内容 |
| --- | --- |
| 现象 | hook 连不上 / webhook 起不来，日志报 EADDRINUSE |
| 根因 | 30001 或 30002 被别的程序占了（常见：上一个助手服务没退干净） |
| 检测 | `autochat doctor` 的端口项；任务管理器看占用进程 |
| 已做的自愈 | 体检会列出被占用的端口 |
| 剩余风险 | 需要人工判断是不是该结束那个进程 |

## F9 启动就报错退出

| 项 | 内容 |
| --- | --- |
| 现象 | 一 `autochat start` 就退出 |
| 根因 A | 配置校验不过（`validateConfig`）：模式非法、缺 DLL 路径、webhook 绑了非回环却没 token |
| 根因 B | `.env` 损坏、语法错误 |
| 根因 C | `data/` 目录不可写（放在同步盘里被锁） |
| 根因 D | 磁盘满 |
| 检测 | 终端错误输出里有「配置错误: 」；`autochat doctor` 也会列出来 |
| 已做的自愈 | 配置校验信息更具体；体检会提示路径含空格或中文、位于同步盘 |
| 剩余风险 | 磁盘满只能靠人清理 |

## F10 单实例互相顶掉

| 项 | 内容 |
| --- | --- |
| 现象 | 明明没启动，却提示「已有实例在运行」 |
| 根因 | pid 文件里还留着上一个进程的号 |
| 检测 | `autochat status`；看 `data/autochat.pid` 内容 |
| 已做的自愈 | `autochat stop` 会清理 pid 文件；后台启动前会先看是否已在跑 |
| 剩余风险 | 强杀留下的陈旧 pid 需手工清理（下一步做自动识别） |

## F11 卸载后微信仍不能更新

| 项 | 内容 |
| --- | --- |
| 现象 | 跑完卸载，微信还是停在旧版本，不自动更新 |
| 根因 | **文档承诺与实现不符**：README 写「卸载会解除微信更新通道阻断」，但 `src/tasks/install.js` 的 `uninstall()` 原本只有「停服务 / 去自启 / 删快捷方式 / 还原 version.dll」，**没有解除 update 只读占位文件的代码** |
| 检测 | 看 APPDATA 下的 Tencent/xwechat/update 是不是一个只读文件 |
| 已做的自愈 | 2.0.0 起卸载实现合并了 `tools/uninstall.js` 的能力：哈希比对还原 version.dll、force 参数删除我们部署的 DLL、**解除 update 阻断**；命令行与图形化配置器共用同一份实现 |
| 剩余风险 | 无 |

---

## 排查工具速查

| 想知道 | 就跑 |
| --- | --- |
| 现在什么状态 | `autochat status` |
| 哪里坏了、怎么修 | `autochat doctor` |
| 最后发生了什么 | `autochat logs --lines 300` |
| 只有错误 | `autochat logs --err` |
| 模型能不能连 | `autochat model test` |
| 本地模型服务在不在 | `autochat model service status` |
| 配置里改了什么 | `autochat config get` |
| 随时拉下自动回复 | `autochat pause` / `autochat resume` |

> 相关：体验审计 · 逻辑与 UI 缺陷 · 术语表
