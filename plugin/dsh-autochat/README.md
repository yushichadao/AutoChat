# dsh-autochat

AutoChat 的 **DeepSeek Harness（dsh）插件**：在对话里查体检、启停服务、暂停回复、改配置、匹配 hook DLL。

> **插件是外壳 + 拦截器，不是第二套 AutoChat。**
> 所有判定（七步够不够）与落盘（`.env` / `config.json`）仍由 AutoChat 本体的 `src/tasks/` 完成，
> 插件只把动作翻译成一次 `autochat` CLI 调用，并在「根本性配置没走完」时拦住写操作。

## 安装

DSH → 插件 → **＋ 添加插件**，三选一：

| 方式 | 填什么 |
| --- | --- |
| 本地目录 | `<AutoChat 仓库>\plugin\dsh-autochat` |
| GitHub 仓库 | `https://github.com/yushichadao/AutoChat`（组合包在 `plugin/dsh-autochat`） |
| npm 包名 | `dsh-autochat`（发布后可用） |

命令行等价物：

```bash
dsh plugin --profile <profile> add ./plugin/dsh-autochat
```

## 装完之后：找到 AutoChat 在哪

插件按下面顺序找 AutoChat 安装目录（要含 `src/cli/index.js`）：

1. 插件配置里的 `home`（`cordis.patch.yml` 的 `config.home`）
2. 环境变量 `AUTOCHAT_HOME`
3. 从插件所在目录往上找（本地目录安装会链回仓库根，自动认出来）
4. 常见位置（`%USERPROFILE%\CodeBuddy\AutoChat`、`%USERPROFILE%\AutoChat`、`%LOCALAPPDATA%\AutoChat`）

找不到时所有工具都会明确告诉你「没找到 + 怎么指定」，不会拿猜的目录去改配置。

## 工具

| 工具 | 干什么 | 写操作 |
| --- | --- | --- |
| `autochat_preflight` | 根本性配置七步现状 | 只读 |
| `autochat_doctor` | 深度体检 | 只读 |
| `autochat_status` | 运行快照 | 只读 |
| `autochat_service` | start / stop / restart / status | ✔ 受门槛约束 |
| `autochat_reply_gate` | pause / resume / status | ✔ resume 受门槛约束 |
| `autochat_config` | 读 / 写 `.env` | ✔ 必须 `confirm:true` |
| `autochat_chats` | list / add / remove / enable / disable | ✔ |
| `autochat_apply_step` | lock-version / detect-dll / deploy-dll / fix-dll | ✔ 必须 `confirm:true` |
| `autochat_model` | test / list / service-* | 部分 |
| `autochat_logs` | 日志尾部 | 只读 |
| `autochat_version` | 版本与环境 | 只读 |
| `autochat_open_console` | 拉起图形化配置器 | 只起进程 |

另有技能 `autochat-console`（操作纪律），模型会在动手前读到。

## 门槛：根本性配置没走完就别启动

`autochat_service {action:"start"}` 与 `autochat_reply_gate {action:"resume"}` 会先查七步，
有 `bad` 项就拒绝执行并列出是哪一步坏了；确实只想先看日志，才用 `acknowledge_blocking: true`。

## 同一套工具也能当 MCP 用

`lib/mcp.js` 是同一份工具实现的 stdio MCP 传输层，给任何支持 MCP 的宿主用：

```bash
node src/mcp/server.js        # 仓库根（MCP 宿主，如 CodeBuddy IDE）
```

## 边界

- 只允许在**用户自己的电脑、自己的微信号**上操作。
- 不代替用户做承诺、不群发推广、不发送收款码或代付请求（见 AutoChat 仓库 `LEGAL.md`）。
- 不内置、不再分发微信安装包与第三方 hook DLL；`deploy-dll` 只复制本机已有的那份。
