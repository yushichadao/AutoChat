# 命令参考

所有命令都在**项目根目录**下运行（也就是含 `package.json` 的目录）。
装了全局命令后直接敲 `autochat`；否则用 `node src/cli/index.js <命令>`。

## 通用约定

| 约定 | 说明 |
| --- | --- |
| 退出码 | 0 正常 / 1 参数或运行错误 / 2 环境体检存在阻断项 |
| `--json` | 多数命令支持，输出机器可读结果 |
| `--no-color` | 关闭颜色（重定向到文件时本就自动关闭） |
| `--help` | 部分命令支持 |

## 命令一览

### 第一次用

| 命令 | 作用 |
| --- | --- |
| `autochat setup` | **初始化向导**：检测环境 → 锁定微信版本 → 自动匹配 DLL → 选模型 → 选小号/同号 → 启动建议 |
| `autochat setup --only <步骤>` | 只跑某一步（步骤 id：`node` `wechat` `lock` `dll` `model` `self` `start`） |
| `autochat setup --non-interactive` | 只体检不提问（脚本 / CI 用） |
| `autochat doctor` | 环境体检：问题清单 + 按依赖顺序的修复步骤 |
| `autochat gui` | 图形化配置器（`--port`、`--no-window`） |

### 运行

| 命令 | 作用 |
| --- | --- |
| `autochat start` | 前台启动助手服务 |
| `autochat start --background` | 后台启动（脱离终端，日志写文件） |
| `autochat start --elevate` | 自动弹 UAC 提权后启动 |
| `autochat stop` | 停止助手服务 |
| `autochat status` | 当前状态快照（服务 / 自动回复 / 配置 / 上下文） |

### 自动回复

| 命令 | 作用 |
| --- | --- |
| `autochat pause [原因]` | 暂停自动回复（立刻生效，仍接收消息、仍记日志） |
| `autochat resume` | 恢复自动回复 |

### 模型

| 命令 | 作用 |
| --- | --- |
| `autochat model test` | 测试当前模型配置能不能用 |
| `autochat model list` | 列出服务端有哪些模型 |
| `autochat model providers` | 看所有能接的服务商（本地 / 云端） |
| `autochat model service status` | 本地模型服务状态 |
| `autochat model service start` | 启动本地模型服务（Ollama 等）并等就绪 |
| `autochat model service stop` | 停止**由 AutoChat 启动的**模型服务 |

### 管理

| 命令 | 作用 |
| --- | --- |
| `autochat chats list` | 列出按会话配置 |
| `autochat chats add\|rm\|enable\|disable <会话id>` | 增删 / 启停一个会话 |
| `autochat chats set <会话id> key=value` | 改某个会话的字段 |
| `autochat context [会话id]` | 查看上下文记忆 |
| `autochat context [会话id] --clear` | 清空（不指定会话 id 即清空全部） |
| `autochat config get [KEY]` | 读 .env（敏感键只显示「是否已配置」） |
| `autochat config set KEY=VALUE` | 写 .env（只允许白名单键） |
| `autochat lock` | 锁定微信版本（阻断自动更新） |
| `autochat lock --status` | 只看锁定状态 |
| `autochat autodll` | 按本机微信版本自动匹配 hook DLL |
| `autochat autodll --write` | 匹配后写进 .env |
| `autochat install [--autostart] [--shortcut] [--deploy-dll] [--lock] [--service]` | 一键安装 |
| `autochat uninstall [--purge] [--force] [--dry-run]` | 一键卸载还原 |
| `autochat version` | 版本、Node、平台、项目目录、作者 |

## npm 脚本

npm script 只是命令行的薄别名，行为完全一致：

```
start  dev  test  demo  doctor  setup  gui  status  logs  version
model  model-service  install  uninstall  pause  resume  stop
```

## 环境变量速查

| 键 | 作用 |
| --- | --- |
| `AI_ENABLED` | **自动回复开关**（0 = 只收消息不回复） |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 模型地址 / 模型名 / 密钥 |
| `AI_GROUP_REPLY` | 群聊什么时候回：`never` / `mention` / `always` |
| `AI_GROUP_AT_NAMES` | 群里被 @ 时认可的称呼（强烈建议填） |
| `WX_SELF_ID` / `WX_SELF_MODE` | 本机 wxid / 判定方式（`sender` 或 `id`） |
| `WX_DLL_PATH` | hook DLL 绝对路径 |
| `WX_POLL_CHATS` | 要监听的会话（群 wxid / 好友 wxid） |
| `WX_RECEIVE_MODE` | 接收方式：`webhook` / `poll` / `auto` |
| `MODEL_SERVICE_RUNNER` / `MODEL_SERVICE_CMD` | 本地模型服务怎么启动 |

完整列表见 `.env.example`。

> 相关：[十分钟上手](GETTING-STARTED.md) · [术语表](GLOSSARY.md) · [故障模式](FAILURE-MODES.md)
