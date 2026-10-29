# 上手指南

> 详细解释见 [README](../README.md)，排查问题见 [故障模式](failure-modes.md)。

AutoChat 有两条上手路线：

- **方式 A：便携版（推荐小白）** —— 从 GitHub 下载 `AutoChat-win-x64.zip`，解压双击即开，**不用装 Node、不用敲命令**，模型在向导里一键联网拉取。
- **方式 B：命令行** —— 适合会敲命令 / 要做开发的，需要本机装 Node 18+ 并用 `npm` 跑命令。

---

## 方式 A：便携版（小白 · 下载安装包 · 点点鼠标）

不用装 Node、不用敲命令，解压即开。

1. 去 GitHub Releases 下载 `AutoChat-win-x64.zip`，解压到任意位置（建议纯英文路径，例如 `D:\AutoChat`）。
2. 双击 `AutoChat.bat`（想没有黑色窗口就双击 `AutoChat-后台.vbs`）。
   - 第一次 Windows 可能弹 SmartScreen「已保护你的电脑」，点「仍要运行」即可（这是开源工具，没人给它买代码签名证书，属正常现象）。
3. 浏览器自动打开「AutoChat 配置器」，跟着首启向导走：
   - 装好并登录**电脑版微信**（这一步必须你自己来，AutoChat 不能替你注册微信）。
   - 点「注入 hook」（会弹 UAC 提权窗口，允许它）——把 AI 接到微信上。
   - 选模型：推荐「本地模型(Ollama)」。本机没装 Ollama？在「模型服务」卡点**「下载并安装 Ollama」**，会自动拉官方安装包并静默安装；装好后点**「启动模型服务」**，再点**「拉取默认模型」**（会下载约 1GB 的小模型 `qwen2.5:1.5b`，请保持联网）。
   - 回到「接一个模型」卡确认地址与模型名，点**保存**；在「服务」卡点**启动助手**。
4. 之后微信里收到消息，AI 就会自动回复。想停就在配置器点「暂停自动回复」。

> 便携版把 Node 运行时打进了包里，**离线也能打开配置器**；只有模型（Ollama 引擎 + 小模型）在首次配置时联网下载。
> 自己打包便携版见 [README](../README.md#便携版构建) 或 `tools/build-portable.ps1`。

---

## 方式 B：命令行（开发者 / 会敲命令）

### 0. 先看要求

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

> 不想用命令行：直接去 GitHub Releases 下载 `AutoChat-win-x64.zip` 解压也行（**发布包已内含维护者自制、专为 AutoChat 适配的 hook DLL，解压即用，无需另外下载或寻找 DLL**）。
> 注意：纯 `git clone` 的仓库里**不含** hook 二进制（二进制不入库），请直接用发布包；`git clone` 方案仅适合要改代码的开发者。

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

命令行之外也可以用图形界面：`npm run gui`（浏览器打开，与命令行能力等价）。图形化配置器里还能**一键下载安装 Ollama** 并拉取本地小模型，最适合小白（见方式 A）。

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
| 开机自启 | `npm run install-service -- --service` |
| 卸载还原 | `npm run uninstall-service` |

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
npm run uninstall-service            # 停服务、去自启、删快捷方式、还原 version.dll、解除微信更新阻断
npm run uninstall-service -- --purge # 连 .env 与 data/ 一起清掉
```

不会删你的微信聊天记录。

> 相关：[术语表](glossary.md) · [DLL 来源](dll-sources.md) · [故障模式](failure-modes.md)
