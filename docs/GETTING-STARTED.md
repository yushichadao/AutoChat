# 十分钟上手（换一台机器）

> 目标：从零到「小号能自动回消息」，十分钟内走完。
> 详细解释见 [README](../README.md)，排查问题见 [故障模式](FAILURE-MODES.md)。

## 0. 先看要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 64 位（macOS / Linux 不支持） |
| Node.js | **18 以上**（推荐装 22 LTS）· [nodejs.org](https://nodejs.org) |
| 微信 | Windows 版微信，**并扫码登录要跑回复的那个号** |
| 权限 | 注入 hook DLL 需要**管理员**权限 |

```bash
node -v     # 应该 >= v18
```

## 1. 拿代码

```bash
git clone https://github.com/yushichadao/AutoChat.git
cd AutoChat
npm ci      # 零运行时依赖，这一步基本是空操作
```

> 不想用命令行：直接下载仓库 zip 解压也行。
> 但 **hook DLL 只随 git 仓库提供**，zip 里同样有（都是仓库内容）。

## 2. 体检（先看缺什么）

```bash
npm run doctor
```

会逐项告诉你：Node 版本、微信是否装好、DLL 是否匹配、模型能不能连、自动回复是不是暂停。
**有红色阻断项就先按提示处理**，不要跳到下一步。

## 3. 配置（向导会一步步问）

```bash
npm run setup
```

向导会带你看：检测环境 → 锁定微信版本 → 自动匹配 hook DLL → 选模型（本地 Ollama 或云端 API，现场测一次）→ 选小号 / 同号。

命令行之外也可以用图形界面：`npm run gui`（浏览器打开，与命令行能力等价）。

## 4. 启动

```bash
npm start                # 前台跑，日志直接打在终端
npm start -- --background   # 后台跑，关终端也在
```

注入需要管理员权限时，用 `npm start -- --elevate`（自动弹 UAC）。

## 5. 验证

1. 手机上用**另一个号**（主号）给电脑上的小号发一句「你好」。
2. 小号应该几秒内回一句。
3. 没回？按顺序查：

```bash
npm run status    # 服务在不在跑、自动回复是不是暂停态
npm run logs      # 最后 200 行日志
npm run doctor    # 还有哪些阻断项
```

## 6. 常用命令

| 想做什么 | 命令 |
| --- | --- |
| 看状态 | `npm run status` |
| 体检 | `npm run doctor` |
| 看日志 | `npm run logs` |
| 暂停 / 恢复自动回复 | `npm run pause` / `npm run resume` |
| 停止服务 | `npm run stop` |
| 启动本地模型服务（Ollama） | `npm run model-service -- start` |
| 开机自启 | `npm run install -- --service` |
| 卸载还原 | `npm run uninstall` |

## 7. 换机器时会遇到的几件事

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 配置全是空的 | `.env`、`config.json`、`data/` **不随仓库走**（有意的：聊天上下文是隐私） | 重新跑 `npm run setup`；要迁移就把旧机 `.env` 拷过来，密钥自己再填 |
| 收不到消息 | 没配监听会话 | 把会话 wxid 填进 `.env` 的 `WX_POLL_CHATS` |
| DLL 突然失效 | 微信自动更新了 | `npm run doctor` 看「DLL 与微信版本」；`npm run lock` 锁版本 |
| 端口被占 | 上一个服务没退干净 | `npm run stop` 再启动 |
| 路径里有空格 / 中文 | 少数命令需要引号 | 体检会提示；把项目挪到简单路径更省事 |
| 装在 OneDrive / 桌面同步目录 | `data/` 可能被同步锁住 | 把项目移到本地磁盘（如 `D:\AutoChat`） |

## 8. 卸载

```bash
npm run uninstall            # 停服务、去自启、删快捷方式、还原 version.dll、解除微信更新阻断
npm run uninstall -- --purge # 连 .env 与 data/ 一起清掉
```

不会删你的微信聊天记录。

> 相关：[术语表](GLOSSARY.md) · [DLL 来源](DLL-SOURCES.md) · [故障模式](FAILURE-MODES.md)
