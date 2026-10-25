# AutoChat

**微信侧的本地 AI 助手（仅适用于 Windows）。** 一个本机登录的微信号，收到消息后按策略交给本地/云端模型，再把回复发回微信。

**只做微信一件事**：收消息 → 判断要不要回 → 调模型 → 清洗 → 回微信。
不连任何外部平台，不跨平台转发，不依赖第三方 bot 框架。**零运行时依赖**（只用 Node 内置模块）。

> [!CAUTION]
> **三条红线，用之前请先读完 [LEGAL.md](LEGAL.md)**
> 1. **不冒充他人**与他人沟通，不用他人身份、头像、名义从事任何活动
> 2. **不向不特定多数人推送**投资、理财、中奖、刷单、保健品、贷款、赌博等信息
> 3. **不发送收款码、支付链接、"代付/代买"请求**，不代替真人做承诺
>
> 违反这些可能触及**诈骗罪（刑法 266 条）、帮信罪（287 条之二）、侵犯公民个人信息罪（253 条之一）**
> 以及民事侵权与行政责任。**是 AI 干的不是免责理由** —— 配置、部署、维护的人就是行为人。
>
> **另外两条硬边界**：
> 4. **只在自己电脑上、用自己的微信号**。本项目靠注入 hook DLL 读写本机微信进程；对他人设备、他人账号注入或读取，可能触及**非法侵入计算机信息系统罪（刑法 285 条）、破坏计算机信息系统罪（286 条）**（分析见 [LEGAL.md 1.4 节](LEGAL.md#14-非法侵入计算机信息系统罪刑法第-285286-条-本项目是否涉及)）。
> 5. **不打包分发第三方 hook DLL**，它是第三方作品（许可含 MIT / 源码公开 / 闭源），随包分发会构成著作权侵权。
>
> 完整风险清单、禁止用途、免责声明效力边界见 **[LEGAL.md](LEGAL.md)**。

```
微信客户端 ──注入 hook DLL──> 本机 HTTP(30001) ──> AutoChat ──> OpenAI 兼容模型
                                    ▲                            (本地或云端)
                                    └── 回调 30002
```

---

## 目录

- [先看效果](#先看效果不需要-dll也不需要-api-key)
- [准备：小号方案](#准备小号方案重要)
- [快速开始](#快速开始)
- [拿到 hook DLL](#1-拿到-hook-dll)
- [锁住微信版本](#2-锁住微信版本这一步不能省)
- [选择注入方式](#3-选择注入方式)
- [自适应](#自适应)
- [收消息的两条腿](#收消息的两条腿)
- [接一个模型（本地或云端）](#接一个模型本地或云端)
- [AI 自动回复](#ai-自动回复)
- [按会话差异化配置](#按会话差异化配置)
- [上下文记忆](#上下文记忆)
- [总闸：随时暂停](#总闸随时暂停自动回复)
- [命令行](#命令行cli)
- [图形化配置器](#图形化配置器)
- [一键安装与卸载](#一键安装与卸载)
- [异机部署](#异机部署一键配置)
- [安全护栏](#安全护栏)
- [配置项](#配置项)
- [目录结构](#目录)
- [测试](#测试)
- [卸载与还原](#卸载与还原)
- [开源与治理](#开源与治理)
- [法律风险与后果](#法律风险与后果必读)

---

## 先看效果（不需要 DLL，也不需要 API Key）

```bash
npm install
npm run demo
```

会拉起一个假的微信 hook 和一个假的模型服务，完整跑「朋友发消息 → 调模型 → 回消息」，两轮对话，第二轮能看出上下文确实带上了：

```
「朋友」→ 你好，在忙吗
「我」  → 收到：你好，在忙吗

「朋友」→ 那晚上一起吃饭？
「我」  → 收到：那晚上一起吃饭？

模型被调用 2 次；第二轮请求携带的上下文轮数：4 条消息
```

换成真 DLL 和真 Key 时代码一行不用改。

---

## 准备：小号方案（重要）

**为什么需要两个号**：电脑版微信必须**扫码登录**，所以电脑上登录的号 == 你手机上的号。也就是说，跑在这台电脑上的 AutoChat 就是「你自己」。如果只有你自己在群里提问，机器人会把你的话当成别人的提问 —— 自问自答、刷屏、烧额度。

| 形态 | 群里提问的人 | `WX_SELF_MODE` | 说明 |
|---|---|---|---|
| 手机主号 + 电脑小号 | 别人（主号在手机上说话） | `sender` | **推荐**，最省事 |
| 同号（电脑就是主号） | 别人 | `id` | 用「机器人发过的消息 id」精确排除自己的回复 |
| 群里只有你自己 | —— | —— | 机器人没得可答，属正常现象，不是故障 |

**推荐步骤**：

1. 注册一个小号（另一台手机注册，或请朋友协助扫码登录）。
2. 电脑微信扫码登录**小号**；手机主号继续日常使用。
3. 把小号拉进目标群，让群里其他人正常聊天。
4. 跑 `autochat doctor`，看「小号检查」这一项：
   - 绿色 = 检测到群里还有别的账号在发言，形态正确；
   - 黄色 = 最近消息的发送者全是你本机账号 —— 该用 `id` 模式，或者干脆换号。
5. 按体检结论设 `.env` 里的 `WX_SELF_MODE`：
   - 小号 → `sender`（按 wxid 过滤，稳）
   - 同号 → `id`（按「机器人发过的消息 id」精确过滤）

> ⚠️ **同号时必须用 `id`。** 用 `sender` 会把你自己的提问也一起丢掉，机器人表现就是「不理人」。
> 图形化配置器的「小号」卡片里可以一键切换，不用手改文件。

---

## 快速开始

**最省事的路子（三步）**：

```bash
npm install
npm run setup       # 初始化向导：选模型 → 填密钥 → 当场测试通了才保存
npm start           # 启动
```

向导会把「模型从哪来、模型叫什么、密钥去哪拿」一步步问清楚，最后**当场发一句话验证**能不能用，通了才写进配置。

> 图形界面版：`npm run gui` → 打开「AI 助手」卡片，同样是选来源 → 填信息 → 点「测试一下」。

手改配置文件的老路子也支持：

```bash
npm install
cp .env.example .env      # 填 WX_DLL_PATH、AI_* 等
npm run check             # 先诊断环境（含 AI 连通性实测）
npm start
```

`npm run check` 会逐项检查：微信安装与版本、进程、DLL、管理员权限、hook 端口、能力探测、**本机 wxid 是否已确认**、**webhook 入口是否暴露在网络上**、按会话配置、AI 接口是否真的能通。

不想碰命令行，也可以直接用图形界面（见 [图形化配置器](#图形化配置器)）：

```bash
npm run gui        # 浏览器打开配置器
npm run doctor     # 体检：为什么机器人不理我
```

### 1. 拿到 hook DLL

DLL 负责注入到 `Weixin.exe`，在进程内起一个本地 HTTP 服务（默认 `30001`）。它靠进程内的固定偏移工作，**微信一变它就失效**；微信平均 1~2 周发一个版本。

目前公开可用的方案（`src/bridge/profiles.js` 维护这张表），经 GitHub 复核：

| 微信版本 | DLL | 发送 | 接收 | 许可 |
|---|---|---|---|---|
| 4.1.15.56 / 4.1.15.50 | miloira/wxhook | 是 | 是 | MIT（开源仓库） |
| 4.1.10.27 | aixed/WeChat-Hook（main） | 是 | 否 | 源码公开（未声明许可证） |
| 4.1.8.67 | lyx102/WeChatHook | 是 | 是 | MIT |
| 3.9.10.16 | aixed/WeChat-Hook（old_version） | 是 | 是 | 源码公开（未声明许可证） |
| 3.9.5.81 | miloira/wxhook（开源版） | 是 | 是 | MIT |

`miloira/wxhook` 开源仓库现覆盖 3.9.x 至 4.1.15.x 的大量版本（官方描述含 4.1.15.56 等）；本项目仅维护代表性版本档案，新版本可经 `node tools/check-env.js` 探测。

**本项目内置自制 DLL（开箱即用，无需自行反编译 / 编译）**

为省去自行构建，仓库 `tools/` 已附带作者自制的若干 DLL，两种获取方式任选其一：
- **clone 自带**：`git clone` 后直接位于 `tools/wechat-hook/`、`tools/wxhook/` 下；
- **Release 下载**：GitHub Releases 的 `v1.0.0` 页面提供同名附件。

| 文件 | 来源 / 适配版本 | 发送 | 接收 | 说明 |
|---|---|---|---|---|
| `tools/wxhook/WeChat-Hook-main/version-aixed.dll` | aixed/WeChat-Hook(main) → **微信 4.1.10.27** | ✅ | 轮询 | 作者当前自用版本；接收靠 `/QueryDB/execute` 轮询 |
| `tools/wxhook/mini.dll`、`mini2.dll`、`mini_c.dll`、`mini_gcc16.dll`、`version-gcc16.dll` | miloira/wxhook | ✅ | ✅ | 覆盖 3.9.x–4.1.15.x，由 `npm run check` 探测适配 |
| `tools/wechat-hook/version.dll`、`version-592.dll` | proxy 模式通用注入 | ✅ | ✅ | 改名 `version.dll` 放入微信目录由系统加载（见[注入方式](#3-选择注入方式)） |
| `tools/wxhook/getdbkey.dll` | 提取微信数据库密钥 | — | — | 仅 DB 轮询接收时使用 |
| `tools/wxhook/libstdc++-6.dll`、`libwinpthread-1.dll` | MinGW 运行时依赖 | — | — | 上述 MinGW 编译的 DLL 运行时需要，已一并附带 |

> 若你的微信版本不在上表，仍可按 `src/bridge/profiles.js` 的第三方方案自行获取，或等版本档案更新。所有第三方方案由相应仓库维护，许可见上文表格与 `profiles.js`。

> **平台限制**：本项目**仅适用于 Windows** —— 底层依赖微信 Windows 客户端与注入式 hook DLL（`CreateRemoteThread + LoadLibraryW`）。不支持 macOS、Linux、微信 macOS 版、网页版与手机版。

### 2. 锁住微信版本（这一步不能省）

> **获取对应版本的微信客户端**：本项目内置的 DLL 与微信版本强绑定（如 `version-aixed.dll` 适配 `4.1.10.27`）。官方不提供旧版安装包，可参考第三方汇总站 [微信 Windows 历史版本汇总](https://rodert.github.io/wechat-win-versions/) 获取历史版本（**非官方，下载请自行甄别安全性与合规性；本项目不托管任何微信安装包**）。

微信会自动更新，而且**更新时把旧版本目录整个删掉**。后果极其迷惑：DLL 明明加载过、端口也起过，突然就全部失效。

堵住的办法是让微信无法创建下载目录（`update` 换成同名只读文件）：

```powershell
$up = "$env:APPDATA\Tencent\xwechat\update"
Remove-Item $up -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType File -Path $up -Force | Out-Null
(Get-Item $up).IsReadOnly = $true
```

> 想恢复正常更新：跑 `npm run uninstall`（见 [卸载与还原](#卸载与还原)）。
>
> 注意：停在旧版本意味着错过微信的安全补丁，请自行权衡。

### 3. 选择注入方式

```ini
WX_INJECT_MODE=inject   # 对已登录的微信进程直接注入，不重启
WX_DLL_PATH=D:\tools\wxhook.dll
```

`inject` 走 `CreateRemoteThread + LoadLibraryW`，需要管理员权限，失败会自动回退到 `proxy`：

```ini
WX_INJECT_MODE=proxy    # 把 DLL 复制成 version.dll 放进微信目录，重启微信由系统加载
```

---

## 自适应

四个层面，都不需要你改代码：

**1. 版本档案**（`src/bridge/profiles.js`）
注册表或安装目录读版本，按「精确 → 同三段 → 同主次 → 未知」匹配，直接告诉你这个版本有没有可用 DLL、能不能收消息。新增版本只改这张表。

**2. 能力探测**（`src/bridge/probe.js`）
不猜厂商，直接向 hook 端口逐个试 `/SendTextMsg`、`/QueryDB/status`、`/QueryDB/execute` 等接口，认出它到底支持什么。发送类只发空对象探路由，不会真的发消息。

**3. 接口方言**（`src/bridge/dialect.js`）
各家 DLL 的字段名不一样，写死任何一个换个 DLL 就废：

| 方言 | 请求体 |
|---|---|
| `wxidorgid+msg` | `{"wxidorgid":"wxid_x","msg":"hi"}` |
| `wxid+content` | `{"wxid":"wxid_x","content":"hi"}` |
| `to+text` | `{"to":"wxid_x","text":"hi"}` |
| `to_wxid+msg` | `{"to_wxid":"wxid_x","msg":"hi"}` |

路径也会一起试（`/SendTextMsg`、`/send_text`、`/api/sendText`、`/SendMsg`）。只有收到**明确失败标志**才换下一个组合，命中后写进 `data/dialect.json`，下次直接命中不再逐个试。

判定逻辑刻意保守：`code=0`、空响应体都算成功 —— 宁可把「没看懂」当成功，也不能误判导致同一条消息重发。

**4. 运行时自愈**（`src/bridge/receiver.js`）
DLL 声称支持回调，也可能因为偏移失效一直不推。只要配了 `WX_POLL_SQL`，webhook 静默超过 `WX_WEBHOOK_IDLE_FALLBACK_MS`（默认 120s）就自己把轮询打开。

`data/state.json` 记住上次成功运行的微信版本，微信悄悄升级后下次启动会直接提醒「偏移可能已失效」。

---

## 收消息的两条腿

发消息只依赖 DLL 的 `/SendTextMsg`。收消息麻烦一些，两个方式同时支持：

| 方式 | 条件 | 说明 |
|---|---|---|
| `webhook` | DLL 支持 `CallBackURL` 启动参数 | DLL 收到消息就 POST 到 `http://127.0.0.1:30002/wechat`，延迟最低 |
| `poll` | DLL 提供 `/QueryDB/execute` | 定时查库，覆盖不支持回调的 DLL |
| `auto` | 默认 | 两条腿都开，共享一套去重，谁先到算谁的 |

轮询需要自己给出 SQL，列名按约定起别名：

```ini
WX_POLL_SQL=SELECT MsgSvrID AS msgid, StrTalker AS wxid, StrContent AS content, CreateTime AS createTime FROM MSG WHERE CreateTime > strftime('%s','now') - 60
```

字段归一化在 `src/protocol/normalize.js`：不同 DLL 的 `wxid/from/fromUser`、`content/msg/text`、`roomid/roomId/conversationId` 都会被识别；XML 消息里的 `<atuserlist>` 会被解析成结构化 @ 列表；群消息正文里 `wxid_xxx:` 的前缀会被剥掉。

> ⚠️ **务必配置 `WX_SELF_ID`**（你本机微信的 wxid）。
> 微信的 `MSG` 表同时含有**自己发出去的消息**。拿不到本机 wxid 时，机器人会把自己的回复当成别人的提问，形成「自问自答」—— 无限循环、刷屏、烧额度。
> 网关会先尝试从 hook 的 `/GetSelfProfile` 读取，读不到再从本地 Message 库取 `StrAccount` 兜底；仍然拿不到时会**自动关闭数据库轮询**并提示你手工配置。
>
> 拿到 wxid 之后还要选**判定方式** `WX_SELF_MODE`：`sender`（按 wxid 过滤，小号用）或 `id`（按已发消息 id 精确过滤，同号用）。选错的表现都是「机器人不理人」，判定方法见 [准备：小号方案](#准备小号方案重要)。

---

## 接一个模型（本地或云端）

AutoChat 用的是**标准 OpenAI 协议**（地址 + `/v1/chat/completions`），所以市面上几乎所有模型都能接。你要填的其实只有三样东西：

| 要填的 | 是什么 | 本地模型 | 云端 API |
|---|---|---|---|
| 接口地址 | 模型服务在哪 | `http://127.0.0.1:11434/v1` 这种 | 服务商给你的地址（一般以 `/v1` 结尾） |
| 模型名 | 用哪个模型 | 例如 `qwen2.5:7b` | 例如 `deepseek-chat` |
| 密钥 | 你的账号凭证 | **不用填** | 必填（一般是 `sk-` 开头） |

### 选哪种：本地还是云端

| | 本地（Ollama / LM Studio） | 云端（DeepSeek / Kimi / 通义…） |
|---|---|---|
| 花钱 | 不花钱 | 按量计费，多数有免费额度 |
| 隐私 | 消息不出本机 | 会发到服务商 |
| 速度 | 看电脑，普通机器十几字/秒 | 快 |
| 门槛 | 要装软件、要下载模型（几 GB） | 注册就能用 |
| 适合 | 自己的聊天、涉密内容 | 想要更好的效果 |

### 三种配置方式，挑一个

**① 向导（最省事，一步步照着答）**

```bash
autochat setup
```

它会先扫一遍你电脑上有没有已经在跑的本地模型服务（Ollama / LM Studio / vLLM），把找到的直接列在最上面让你选；然后问你要不要填密钥、选哪个模型，**最后当场发一句话测试**，通了才问你「要不要保存」。

**② 图形化配置器（点点鼠标）**

```bash
autochat gui
```

「AI 助手」卡片是三步的：① 选模型从哪来（本地已启动的服务会标「● 在线」）→ ② 填地址/密钥/模型名 → ③ 点「**测试一下能不能用**」，它会真的发一句话，把模型的原话显示出来给你看，通了再保存。

**③ 手改 `.env`（熟练之后最快）**

```ini
AI_ENABLED=1
AI_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=sk-你的密钥
AI_MODEL=deepseek-chat
```

### 支持清单

**本地（不用密钥）**

| 名称 | 地址 | 怎么开始 |
|---|---|---|
| Ollama | `http://127.0.0.1:11434/v1` | 装好后终端跑 `ollama serve`，再 `ollama pull qwen2.5:7b` |
| LM Studio | `http://127.0.0.1:1234/v1` | 打开 LM Studio → Local Server → Start Server |
| llama.cpp / vLLM / One-API | `http://127.0.0.1:8000/v1` | 自己把推理服务跑起来 |

**云端（要密钥）**

| 名称 | 地址 | 默认模型 | 密钥在哪申请 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) |
| Kimi / 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | [platform.moonshot.cn](https://platform.moonshot.cn/console/api-keys) |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | [百炼控制台](https://bailian.console.aliyun.com/) |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`（有免费） | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | [siliconflow.cn](https://cloud.siliconflow.cn/account/ak) |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

其它任何服务商只要兼容 OpenAI 协议，选「其它」把地址贴进去就行。

### 卡住了？看这张表

`autochat test` 会把技术报错翻译成人话，对照着处理就行：

| 它说的 | 真正的原因 | 怎么办 |
|---|---|---|
| 连不上：模型服务还没启动 | 本机的模型服务没开 | 开 `ollama serve`，或在 LM Studio 点 Start Server |
| 密钥不对 | 密钥没填，或复制时漏了字符 | 重新复制一次，别带空格和引号 |
| 模型名不对 | 地址通了，但没这个模型 | `autochat models` 看有哪些，挑一个填上 |
| 额度用完了或请求太频繁 | 云端余额不足 / 请求太密 | 充值，或把 `AI_MAX_PER_HOUR` 调小 |
| 太慢了，超时 | 本地模型在加载权重，或网慢 | 调大 `AI_TIMEOUT_MS`，或换小一点的模型 |
| 找不到这个网址 | 地址拼错，或网络不通 | 检查地址是不是抄漏了 `/v1` |

### 命令速查

```bash
autochat setup        # 初始化向导（第一次用先跑这个）
autochat providers    # 看所有能接的方式
autochat models       # 列出服务端有哪些模型
autochat test         # 测试当前配置能不能用
```

---

## AI 自动回复

模型接好之后，回复策略、人设、上下文都在这一层调。最小配置：

```ini
AI_ENABLED=1
AI_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=sk-xxxx
AI_MODEL=deepseek-chat
```

（地址和模型名从上一节「接一个模型」抄；腾讯云 TokenHub 的 `hy3` 这类专有模型，把地址换成它控制台给的那个即可。）

### 什么时候回

| 场景 | 默认行为 | 配置 |
|---|---|---|
| 私聊 | 每条都回 | `AI_PRIVATE_REQUIRE_PREFIX=1` 可改成必须带前缀 |
| 群聊 | 需要被点名才回 | `AI_GROUP_REPLY=never / mention / always` |
| 群里被 @ | **优先用结构化 @ 判定** | `AI_GROUP_AT_NAMES=小助手,机器人` |
| 带前缀 | 配了 `AI_TRIGGER_PREFIX` 就只认前缀 | 发「小助手 在吗」触发，前缀自动剥掉 |
| 某些会话 | 默认都回 | `AI_ALLOW_CHATS=wxid_a,wxid_b` 只回这些；`AI_DENY_CHATS=` 排除某些，黑名单优先 |
| 明确拒绝 | 命中「别回我 / 不用理我 / 安静」直接不回 | `AI_REJECT_PATTERNS=` 自定义 |

> **强烈建议配置 `AI_GROUP_AT_NAMES`。** 不配时群消息里出现任意 `@` 都会触发，容易被误触发、被刷额度。
> 能解析到结构化 @ 时（`atuserlist`），只有真的 @ 到你才算。

### 人设

优先级：**按会话配置** > `AI_PERSONA_FILE` > `AI_SYSTEM_PROMPT` > 内置默认。

默认人设刻意写成「微信上聊天的普通人」：简短、不列表、不暴露 AI 身份，并内置两条护栏 —— **不代替本人做承诺**（不答应借钱/约见面/确认交易）、**不透露验证码等敏感信息**。

要改就直接写 `AI_SYSTEM_PROMPT`，或者放一个 `persona.txt` 用文件管理：

```ini
AI_PERSONA_FILE=./persona.txt
```

### 上下文与节奏

- 每个会话独立历史，只保留最近 `AI_CONTEXT_TURNS` 轮，闲置 `AI_CONTEXT_TTL_MS` 后自动清空
- 同一会话两次回复间隔不小于 `AI_COOLDOWN_MS`，全局每小时不超过 `AI_MAX_PER_HOUR`
- **全局同时处理的条数不超过 `AI_MAX_CONCURRENT`**（默认 2），防止群成员恶意 @ 刷额度
- 同一会话前一条没回完不会再并发调用
- 回复会去掉 markdown 标记（微信不渲染），超过 `AI_MAX_REPLY_CHARS` 按段落拆成多条发
- 上下文落盘在 `data/ai-memory.json`（原子写，重启不丢）

---

## 按会话差异化配置

同一个微信号，在不同群可以表现完全不同。写在项目根的 `config.json`（示例见 `config.example.json`）：

```json
{
  "chats": {
    "123456789@chatroom": {
      "enabled": true,
      "groupReply": "always",
      "personaFile": "./persona-group.txt",
      "model": "deepseek-chat"
    },
    "wxid_friend_example": {
      "enabled": false
    },
    "tech-group@chatroom": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "apiKey": "",
      "model": "qwen2.5:7b"
    }
  }
}
```

| 字段 | 作用 |
|---|---|
| `enabled` | `false` = 这个会话完全不理（群里不想让机器人说话就关掉它） |
| `groupReply` | 覆盖全局的 `never / mention / always` |
| `triggerPrefix` | 覆盖全局的触发前缀（如这个群只认「小助手」） |
| `personaFile` | 这个会话专属的人设文件 |
| `systemPrompt` | 这个会话专属的内联人设（与 personaFile 二选一） |
| `model` | **单独给这个会话换模型**（不给就用全局 `AI_MODEL`） |
| `baseUrl` | 单独给这个会话换接口地址（本地推理 / 不同厂商） |
| `apiKey` | 单独给这个会话的密钥（注意：明文写在 `config.json`，别提交到公开仓库） |

> **按会话换模型不增加复杂度**：默认全局一个模型（单一化），只在「某个群想用便宜模型 / 单独走本地推理」时才给那个会话写 `model`（或 `baseUrl` + `apiKey`）。只要给了其中任意一项，该会话就会据此新建客户端，其余会话不受影响。

会话 id 就是微信的会话标识：群是 `xxx@chatroom`，好友是 `wxid_xxx`。
不配置就用全局设置；`npm run check` 会列出当前生效的按会话配置。

---

## 上下文记忆

- **按会话隔离**：每个群 / 每个好友一份独立历史，互不串味
- **双重裁剪**：轮数 `AI_CONTEXT_TURNS`（默认 8 轮）+ 字符预算 `AI_CONTEXT_MAX_CHARS`（默认 6000），先到先裁，从最早的开始丢 —— 长对话不会被单条超长消息撑爆
- **自动过期**：闲置 `AI_CONTEXT_TTL_MS`（默认 30 分钟）后清空，避免隔夜旧话题被翻出来
- **落盘**：原子写 `data/ai-memory.json`，重启不丢；文件写坏了会自动从 `.bak` 恢复
- **随时查看 / 清空**：

```bash
autochat context                            # 列出所有会话的上下文
autochat context 123456@chatroom           # 看某个会话
autochat context --clear                    # 清空全部
autochat context 123456@chatroom --clear   # 只清某个会话
```

图形化配置器的「上下文」卡片里也能看到每个会话的轮数与最后更新时间，并一键清空。

---

## 总闸：随时暂停自动回复

自动化最怕停不下来。总闸做了两层保险：

| 层 | 位置 | 生效时机 |
|---|---|---|
| 运行时哨兵 | `data/paused` | **立刻**，不用重启，服务运行中随时生效 |
| 配置项 | `AI_MASTER_SWITCH=0` | 下次启动时生效 |

- 暂停后**仍然接收消息、仍然记日志**，只是不再调模型、不再回复 —— 方便事后复盘。
- 哨兵是文件，**进程崩了重启也仍然是暂停态**，不会「一重启又开始刷屏」。
- 三种入口，效果完全一样：

```bash
autochat pause          # 暂停（可带原因：autochat pause 群里在吵）
autochat resume         # 恢复
autochat stop           # 整个服务停掉
```

图形化配置器顶栏有「立即暂停 / 恢复」按钮；`autochat status` 会显示当前总闸是开是关。

---

## 命令行（CLI）

所有事情都能命令行做完 —— 图形化配置器只是同一套逻辑的另一种皮。装成本地命令后是 `autochat`（未安装则为 `node src/cli/index.js <命令>`）。

| 命令 | 作用 |
|---|---|
| `autochat setup` | **初始化向导**：一步步照着答就能用（第一次用先跑这个） |
| `autochat providers` | 看有哪些模型可以接（本地 / 云端，含申请密钥的网址） |
| `autochat models` | 列出服务端到底有哪些模型 |
| `autochat test` | 测试当前配置能不能用（只说人话） |
| `autochat start` | 前台启动服务 |
| `autochat status` | 状态总览：服务 / 总闸 / 模型 / 自消息模式 / 监听会话 / 上下文 / 已存会话数 |
| `autochat doctor` | 环境体检 + **「为什么机器人不理我」**三选一提示 |
| `autochat pause [原因]` | 立刻停止自动回复 |
| `autochat resume` | 恢复自动回复 |
| `autochat stop` | 停掉整个服务进程 |
| `autochat chats list\|add\|rm\|enable\|disable <会话id>` | 按会话差异化配置 |
| `autochat context [会话id] [--clear]` | 查看 / 清空上下文 |
| `autochat config get\|set` | 读 / 写 `.env`（`set` 保留注释与顺序，只动你指定的行） |
| `autochat install [--autostart] [--shortcut] [--deploy-dll]` | 一键安装 |
| `autochat uninstall [--purge]` | 一键卸载 |
| `autochat gui [--no-window] [--port 8788]` | 图形化配置器（默认自动打开单例浏览器窗口；端口被自己占用则复用旧实例，不重复起服务） |

`npm run` 也提供部分命令的快捷方式（完整列表见 `package.json` 的 `scripts`），常用：`status` / `doctor` / `gui` / `pause` / `resume` / `stop` / `setup` / `check` / `uninstall`。

> `.env` 改完要重启服务才生效（`autochat stop` → `autochat start`）。**总闸不用重启**，写了哨兵文件即刻生效。
>
> **单实例**：同一时间只允许一个助手实例。直接再跑一次 `autochat start` 会被拦下来并提示已有实例的 pid（两个助手对着同一个群回复会重复、还双倍烧额度）；`autochat stop` 停掉旧的之后才能起新的。

---

## 图形化配置器

零依赖（不用 Electron），本地 HTTP + 单页，浏览器打开就能用。

```bash
autochat gui            # 浏览器打开
autochat gui --window   # 用 Edge 的 --app 模式开独立桌面窗口
```

界面里的卡片：

| 卡片 | 能做什么 |
|---|---|
| 状态 | 服务在不在跑、总闸开没开、AI 启用没有（顶栏可暂停/恢复、启动/停止服务） |
| 小号 | 体检结论 + 一键切换 `sender` / `id` |
| AI | 三步向导：选模型来源（本地已启动的会标「● 在线」）→ 填地址/密钥/模型名 → 点「测试一下能不能用」；下面折叠着群策略、@称呼、限流、温度等高级项 |
| 上下文 | 保留轮数 / 字符预算 / 闲置超时，每个会话显示**汉字群名/昵称**（连上 hook 时自动查），一键清空 |
| 按会话配置 | 增删改会话级开关 / 群策略 / 人设；新会话支持**关键字搜索联系人**（群名/昵称/微信号模糊匹配）直接加入，列表同样显示汉字名 |
| 安装与卸载 | 一键安装（可含自启、快捷方式）、一键卸载 |
| 体检明细 | `doctor` 的逐项结果与提示 |

安全上：配置器只监听 `127.0.0.1`，每次启动生成**随机令牌**，页面请求必须带上（`?token=` 或 `X-AutoChat-Token` 头），防止本机任意网页用 CSRF 方式改你的配置；可编辑的 `.env` 键是**白名单**，界面碰不到别的键。

用起来有几点值得知道：

- 顶栏的三个徽标（服务 / 总闸 / AI）**每 4 秒自动刷新**，服务在别处被启停或崩了，界面会自己跟上；正在输入时不会抢焦点。
- 点「启动服务」时，服务会**脱离配置器窗口与终端**独立运行（Windows 下走 WMI 创建进程），关掉窗口不会把服务带走。
- 服务日志固定写到 `data/autochat.out`（错误在 `data/autochat.err`），超过 2 MB 自动滚一代。
- 已经有实例在跑时，再点「启动服务」不会起第二个 —— 两个助手对着同一个群回复会重复且双倍烧额度。

---

## 一键安装与卸载

```bash
autochat install --autostart --shortcut        # 装 + 开机自启 + 桌面快捷方式
autochat install --autostart --shortcut --deploy-dll   # 额外把 DLL 部署成 version.dll（proxy 模式）
autochat install AI_BASE_URL=http://127.0.0.1:11434/v1 AI_MODEL=qwen2.5:7b   # 顺手写 .env
autochat uninstall                              # 卸
autochat uninstall --purge                      # 连配置与数据一起清
```

**安装**会做：

1. 环境体检（Node 版本、微信客户端与版本、hook DLL 是否就位）
2. 写 `.env`（**保留注释**，不覆盖你已有的值）
3. 可选：注册开机自启（注册表 `HKCU → CurrentVersion → Run`）
4. 可选：创建桌面快捷方式「AutoChat 配置器」（双击直接开图形界面）
5. 可选：proxy 模式下把 DLL 复制成 `version.dll` 放进微信目录

**卸载**会做：停服务 → 去自启 → 删快捷方式 → 还原 `version.dll` → 解除微信更新通道阻断；`--purge` 额外删除 `data/`（AI 上下文等）。

> 卸载不会碰你的微信聊天记录。删掉我们部署的 `version.dll` 需要显式 `--force`（见 [卸载与还原](#卸载与还原)）。

---

## 异机部署（一键配置）

本项目**零运行时依赖**（只用 Node 内置模块），换一台机器只需要 Node 本体，没有要下载的 npm 包。

**目标机要求**：Windows、微信客户端（版本见 [自适应](#自适应)）、[Node.js ≥ 22](https://nodejs.org/)。

```bash
# 1. 把项目拷过去（git clone 或直接复制目录）
git clone https://github.com/yushichadao/AutoChat.git
cd AutoChat

# 2. 安装（零依赖，秒级完成）
npm ci

# 3. 一键配置：图形界面（推荐）或命令行向导
npm run gui          # 浏览器配置器：选模型 → 填密钥 → 测试 → 保存
npm run setup        # 或者：终端向导，当场测通才保存

# 4. 体检，按提示把 hook DLL 就位
npm run check

# 5. 启动
npm start
```

几点说明：

- **配置不会随仓库走**：`.env`、`config.json`、`data/`（上下文记忆、pid 等）都在 `.gitignore` 里，异机要重新配一遍 —— 这是有意的，聊天上下文属于本机隐私。
- **hook DLL 不随包分发**（许可原因，见 [LEGAL.md](LEGAL.md) 2.3 节），按 [拿到 hook DLL](#1-拿到-hook-dll) 自行获取，放到任意路径后把 `WX_DLL_PATH` 指过去。
- 想把旧机器的**上下文记忆**带过去：停服务后把旧机 `data/ai-memory.json` 拷到新机同路径即可；`.env` 也可以照抄再改 DLL 路径。
- 装完跑一遍 `autochat doctor`，全绿再开闸。

---

## 安全护栏

| 护栏 | 默认 | 说明 |
|---|---|---|
| webhook 监听地址 | `127.0.0.1` | 不暴露到局域网。改成 `0.0.0.0` **必须**同时配 `WX_WEBHOOK_TOKEN`，否则启动直接报错 |
| webhook 鉴权 | 关闭 | 配了 token 后请求需带 `X-AutoChat-Token` 头或 `?token=` |
| 自身消息过滤 | 开启 | 已知本机 wxid 时精确过滤自己发的消息 |
| 回声识别 | 开启 | 拿不到 wxid 时用内容比对识别「自己的回复被推回来」，防止自问自答 |
| 触发词白名单 | 未配 | 建议配 `AI_GROUP_AT_NAMES` |
| 否定语义拒绝 | 开启 | 「别回我」等直接不回 |
| 总闸 | 打开 | `AI_MASTER_SWITCH=0` 或 `data/paused` 哨兵，立刻停止自动回复（仍收消息、仍记日志） |
| 限流三层 | 冷却 3s / 120 条每小时 / 并发 2 | 防刷屏、防耗额度 |
| 配置器鉴权 | 随机令牌 | 只监听回环地址，页面请求必须带令牌；`.env` 只允许改白名单键 |
| 密钥存放 | `.env` | 已在 `.gitignore` 中；`data/` 同样忽略 |
| 零运行时依赖 | `dependencies: {}` | 只用 Node 内置模块，`npm install` 不装任何东西 |

---

## 配置项

完整列表见 `.env.example`，几个关键项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WX_HOOK_PORT` | `30001` | DLL 在微信进程里监听的端口 |
| `WX_WEBHOOK_PORT` | `30002` | 助手接收 DLL 回调的端口 |
| `WX_WEBHOOK_BIND` | `127.0.0.1` | 回调监听地址；非回环必须配 token |
| `WX_WEBHOOK_TOKEN` | 空 | 回调鉴权 token |
| `WX_SELF_ID` | 空 | **本机微信 wxid**，用于过滤自身消息 |
| `WX_SELF_MODE` | `sender` | 判定自身消息的方式：`sender`（小号用）/ `id`（同号用，见 [小号方案](#准备小号方案重要)） |
| `WX_READY_TIMEOUT_MS` | `30000` | 注入后等待端口就绪的上限 |
| `WX_SKIP_INJECT` | `0` | 置 1 跳过注入，适合 hook 已在运行或联调 |
| `WX_POLL_CHATS` | 空 | 要监听的会话（群 `xxx@chatroom` / 好友 `wxid_xxx`），逗号分隔 |
| `WX_POLL_DB` | `message_0.db` | 会话分表所在的消息库 |
| `AI_ENABLED` | `0` | 是否启用自动回复 |
| `AI_MASTER_SWITCH` | `1` | 总闸，`0` = 立刻停止自动回复 |
| `AI_GROUP_AT_NAMES` | 空 | 群里被 @ 时认可的称呼，强烈建议填 |
| `AI_MAX_CONCURRENT` | `2` | 同时处理的条数上限 |
| `AI_CONTEXT_TURNS` | `8` | 每个会话保留几轮上下文 |
| `AI_CONTEXT_MAX_CHARS` | `6000` | 每个会话上下文的字符预算上限 |

接口路径都能覆盖（`WX_EP_SEND_TEXT` 等），换一个 DLL 厂商不用改代码。

---

## 目录结构

```
src/
  index.js              启动编排：注入 → 探测 → 接收 → AI 回复
  config.js             .env / config.json 解析与校验
  chats.js              按会话（群/好友）的差异化配置
  logger.js             分级日志
  cli/
    index.js            命令行入口（install/uninstall/config/start/status/doctor/gui/chats/context/pause/resume/stop）
    env-file.js         .env 行级读写，保留注释与顺序
  setup/
    installer.js        一键安装 / 卸载：环境体检、自启、快捷方式、DLL 部署与还原
    diagnose.js         环境体检：AI 开关、总闸、自消息模式、hook、轮询、小号
    server.js           图形化配置器后端（本地 HTTP + 随机令牌 + 白名单改配置）
    win.js              Windows 集成：注册表自启、桌面快捷方式、进程管理
    gui-window.ps1      用 Edge --app 模式开桌面窗口
    ui/                 配置器单页（index.html / style.css / app.js，零依赖）
  bridge/process.js     微信安装探测、进程枚举、模块加载检测、端口探测
  bridge/injector.js    CreateRemoteThread 注入、version.dll 代理部署、重启微信
  bridge/hook-lifecycle.js 注入编排：inject → 失败回退 proxy → 等端口就绪
  bridge/hook-client.js hook DLL 的 HTTP 客户端
  bridge/profiles.js    微信版本 → 可用 DLL 的档案表
  bridge/probe.js       运行时探测 DLL 实际支持哪些接口
  bridge/dialect.js     接口字段方言表 + 命中结果持久化
  bridge/compat.js      版本/能力/配置三方对齐，自动纠偏
  bridge/receiver.js    webhook 服务 + 数据库轮询 + 去重 + 自身消息过滤
  bridge/poll-sql.js    会话分表 SQL 与增量水位
  bridge/contacts.js    通讯录缓存：群名与昵称注入 prompt
  bridge/self-filter.js 自身消息过滤（sender / id 两种模式 + 内容回声兜底）
  bridge/switch.js      总闸哨兵（data/paused）与 pid 文件
  protocol/normalize.js 各家 DLL 的消息字段归一化（含结构化 @ 与群名）
  ai/client.js          OpenAI 兼容客户端（hy3 等）
  ai/providers.js       模型接入预设表（本地/云端，含一步步指引与密钥申请链接）
  ai/probe.js           连通性探测：拉模型列表、试聊一句、扫本机服务、错误翻译
  ai/trigger.js         触发策略：@ 判定、否定语义、黑白名单、会话覆盖
  ai/limiter.js         冷却 / 每小时配额 / 全局并发上限
  ai/prompt.js          人设与 prompt 组装（含群名注入）
  ai/responder.js       清洗、拆条、投递
  ai/replier.js         AI 回复流水线门面
  ai/memory.js          按会话的上下文（轮数 + 字符预算 + TTL），原子落盘
tools/
  demo.js               一键演示：假 hook + 假模型，无需 DLL 跑通全链路
  mock-hook.js          假 DLL，可伪造入站消息、模拟别家方言
  mock-ai.js            假 OpenAI 服务，回显用户消息
  check-env.js          环境诊断（含 AI 连通性实测）
  uninstall.js          还原 version.dll、解除更新通道阻断、可选清理数据
```

---

## 测试

```bash
npm test
```

99 项：字段归一化（含结构化 @、群名、群内 wxid 前缀剥离）、版本档案匹配、方言自动学习、webhook 静默自愈、**webhook token 鉴权**、**自身消息过滤（sender / id 两种模式）与回声识别**、**按会话配置（停用/群策略/人设）**、AI 触发/黑白名单/否定语义/限流/并发/清洗/上下文、prompt 群名注入、**数据库内容解码（明文 / hex / zstd）**、**会话分表 SQL 与增量水位**、**总闸哨兵**、**上下文字符预算与落盘重启不丢**、**`.env` 行级编辑（注释与顺序不丢）**、**单实例保护判定**，以及四条端到端链路（微信→AI→微信并带上下文、别家方言自动学习、自身消息不触发 AI、token 校验）。

模型接入这一层另有 9 项：**服务商预设的完整性**（地址带版本号、本地不索要密钥、步骤够详细）、**按地址反查服务商**、**错误翻译**（连接被拒/401/404/429/500/域名解析 全都要翻译成「下一步该干什么」）、**配置点评**（地址漏 /v1、误填 /chat/completions、云端没密钥）、**拉模型列表**与**试聊一句**（对着本地假服务跑，含鉴权头）、失败时给出人话而不是原始报错。

端到端用例使用**随机端口**，并在子进程异常退出时立即失败，避免连到残留进程产生假红/假绿。

端到端手动验证：

```bash
node tools/mock-hook.js --port 30001
# 另开一个终端
WX_SKIP_INJECT=1 npm start
# 伪造一条微信消息
curl -X POST http://127.0.0.1:30001/debug/incoming -H "Content-Type: application/json" -d '{"wxid":"wxid_target","content":"hello"}'
```

---

## 卸载与还原

```bash
npm run uninstall            # 还原 version.dll + 解除微信更新通道阻断
npm run uninstall -- --dry-run   # 只看会做什么
npm run uninstall -- --purge     # 连 data/ 一起删（AI 上下文等）
npm run uninstall -- --force     # 连我们部署的 version.dll 一起删掉
```

或者用新 CLI（会**额外**停服务、去开机自启、删桌面快捷方式）：

```bash
autochat uninstall            # 停服务 + 去自启 + 删快捷方式 + 还原 version.dll
autochat uninstall --purge    # 连 .env 与 data/ 一起清
```

会把 proxy 模式部署的 `version.dll` 还原回原版、恢复微信的自动更新、提示重启微信以清掉驻留的 hook DLL。删除我们部署的 DLL 需要显式加 `--force`，避免误删你原本就有的 `version.dll`。

---

## 源可见与治理

> 独立治理文件（GitHub 入口）：[CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · [SECURITY.md](SECURITY.md)

**许可性质**：AutoChat 采用自定义 **源可见许可证**（非 OSI 标准开源许可）。代码公开、可学习、可自用与为自用修改，但**禁止冒用原作者名义发布、禁止抄袭 UI/CLI/GUI、禁止照搬独有代码逻辑**——详见仓库根目录的 [LICENSE](LICENSE)（中英双语）。

| 文件 | 内容 |
|---|---|
| [LICENSE](LICENSE) | 自定义源可见许可证：授权范围 + 署名/冒名、UI·CLI·GUI 抄袭、独有代码逻辑三类硬性限制 |
| [LEGAL.md](LEGAL.md) | **法律与合规说明**：禁止用途、诈骗等违法行为的法律后果、免责声明效力边界、执法请求与侵权投诉流程 |
| `.github/` | CI（测试 + 签署检查 + 零依赖检查）、Issue/PR 模板 |

**几条项目约定**：

- **零运行时依赖** —— CI 会检查，新增依赖需要在 PR 里说明理由。
- **不分发第三方 hook DLL** —— 只提供名称、版本适配与获取指引；任何第三方 hook DLL（无论 MIT / 源码公开 / 闭源）严禁打包进发行物。DLL 由其作者授权，本项目不作担保。
- **不提供任何担保** —— 按「现状」提供；免责声明在中国法域下只能约束你与维护者之间的合同关系，不能对抗受害人，也不能免除刑事责任。
- **维护者有权拒绝 PR** —— 凡触及 [LEGAL.md](LEGAL.md) 1.2 节禁止用途的贡献，一律不接受。
- **安全问题请走私密渠道** —— 不要开公开 issue。

### 贡献（开发环境 + 提交规范）

环境：

```bash
git clone https://github.com/yushichadao/AutoChat.git
cd AutoChat
npm install            # 零运行时依赖，基本是空操作
npm test              # 测试应全绿（当前 108 项）
npm run demo          # 不需要 DLL / API Key 跑通全链路
npm run check         # 环境诊断（在你自己的机器上）
```

要求：Node.js ≥ 22；纯 ESM、无构建步骤、无 TypeScript、无 lint 框架——保持简单是本项目的风格。

提 PR 之前：

1. `npm test` 全绿；2. 新增行为必须同时新增测试；3. 提交信息参考 Conventional Commits（`feat(trigger): 支持按会话覆盖群聊策略`）；4. 一次 PR 只做一件事；5. 每个 commit **末尾加 `Signed-off-by: 你的名字 <邮箱>`**（确认作者身份并同意以本仓库 LICENSE 条款发布，CI 会检查）。

代码风格：2 空格缩进、单引号、分号；注释写"为什么"；每个文件顶部用一段注释说清职责边界；函数尽量小；保持零依赖现状。

**会被直接拒绝的 PR**（详见 [LEGAL.md](LEGAL.md) 1.2 节与 LICENSE 限制）：诈骗话术/群发脚本/绕过风控；读取并外传他人微信数据；向消息体注入收款码/代付请求；移除现有安全护栏（webhook 鉴权、自身消息过滤、限流、并发上限、否定语义拒绝）；引入真实用户数据作为测试夹具；打包分发第三方 hook DLL；**以及任何复制或照搬本软件 UI/CLI/GUI 设计、或特有代码逻辑到其他项目的改动**。认为某条红线过严请先开 issue 讨论，不要直接提交 PR。

### 行为准则（含本项目特有技术红线）

我们承诺营造无骚扰、互相尊重的环境，接受多元观点、对事不对人。不可接受的行为包括：骚扰、人身攻击、未经许可发布他人私人信息（真实 wxid、聊天记录、手机号等）、在代码/issue/PR 中出现违法用途示范。

由于本项目涉及自动化消息，滥用可能直接导致使用者承担**刑事责任**（诈骗罪、帮信罪等，详见 [LEGAL.md](LEGAL.md)）。以下内容**一律不予受理**：① 诈骗话术/钓鱼模板/话术剧本；② 批量群发、批量加好友、绕过风控；③ 读取导出他人微信数据并对外分发；④「代付/收款码」注入；⑤ 以单一目的提高滥用能力的改动；⑥ 真实用户数据作为测试夹具；⑦ 移除或规避护栏；⑧ 对他人设备/账号注入或读取数据（可能构成非法侵入计算机信息系统罪，刑法 285 条）。这些不是价值观问题，而是会直接给使用者带来刑事风险的技术贡献。

### 安全（漏洞报告 + 部署自查）

**请在私密渠道报告漏洞，不要在公开 issue/PR 中报告**（公开即意味着漏洞在被修复前已对所有人可见）：打开本仓库 **Security → Report a vulnerability** 提交私密报告；平台不可用时私下联系维护者。报告请包含：漏洞类型、影响面、最小复现步骤、影响版本、你的联系方式。维护者承诺 3 个工作日内首次回应，严重漏洞 14 天内修复，修复后致谢（可匿名）。**不接受以披露相威胁的勒索行为**。

以下属于"设计使然"，不作为漏洞受理（欢迎提改进建议）：注入 hook DLL 本身会修改微信进程运行时；hook DLL 是第三方二进制、安全性由其作者负责；hook 只发生在本机微信进程内，用在他人设备/账号上读取数据属违法（见 LEGAL.md 1.4 节）；`WX_HOOK_PORT`（30001）暴露本机微信库读写能力是 hook DLL 的设计，请勿把该端口暴露到网络；使用云端模型会把聊天内容发往第三方；自动化使用可能违反《微信个人账号使用规范》导致封号。

部署前自查：`WX_WEBHOOK_BIND` 保持 `127.0.0.1`（改 `0.0.0.0` 时必须设 `WX_WEBHOOK_TOKEN`）；`WX_SELF_ID` 已填本机 wxid；`AI_GROUP_AT_NAMES` 已配；限流/并发已收紧；`WX_HOOK_PORT` 未转发公网；`.env` 未提交版本库（`data/ai-memory.json` 是明文聊天记录，勿同步网盘）。

---

## 法律风险与后果（必读）

**工具本身不违法，你用它干的事才违法。**

用 AutoChat 冒充他人身份沟通、批量发投资/中奖/刷单信息、发送收款码或代付请求、导出他人聊天记录给别人、把改造后的版本交给别人用于诈骗 —— 这些行为在中国法域下可能触及：

- **诈骗罪**（《刑法》第 266 条）：数额较大 3 千–1 万起，巨大 3 万–10 万起，特别巨大 50 万起；十年以上直至无期
- **帮助信息网络犯罪活动罪**（《刑法》第 287 条之二）：明知他人用其实施犯罪仍提供帮助，三年以下至七年
- **非法利用信息网络罪**（《刑法》第 287 条之一）：把工具改造成诈骗/信息窃取工具对外提供
- **侵犯公民个人信息罪**（《刑法》第 253 条之一）、**侵犯通信自由**（《刑法》第 103 条）
- **非法侵入计算机信息系统罪**（《刑法》第 285 条）/ **破坏计算机信息系统罪**（《刑法》第 286 条）：**只在自己电脑、用自己微信号**；对他人设备或他人账号注入、读取数据即越线（另见 [LEGAL.md 1.4 节](LEGAL.md)）
- **民事侵权**（《民法典》人格权编与侵权责任编）：姓名权、肖像权、名誉权、隐私权、个人信息权益，含精神损害赔偿
- **行政责任**：《治安管理处罚法》、《微信个人账号使用规范》（封号、停止服务）、《反电信网络诈骗法》
- **AI 标识义务**：《人工智能生成合成内容标识办法》（2025-09-01 施行）等对「以真人身份对外发言」有合规要求

**「是 AI 干的」不是抗辩理由**：配置、部署、维护的人就是行为人，自动化只会让金额更大、更难否认。

完整梳理、红线清单、正当用法、开发者/分发者义务、日志与证据的注意事项，见 **[LEGAL.md](LEGAL.md)**。

> 本文不构成法律意见。涉及具体情形请咨询执业律师。

---

## 风险

个人号自动化违反《微信个人账号使用规范》，被检测到会限制功能或封禁账号。建议用小号、控制频率、不要群发。DLL 注入属于修改客户端运行时的操作，请自行评估；使用旧版微信意味着放弃其安全补丁。

### 微信客户端与本地数据风险（务必看）

本工具对微信消息库**只读**，不会删除或隐藏你的聊天记录。但以下现象与风险确实存在，且都来自**微信 PC 客户端自身**，与 AutoChat 无关，请提前知情：

- **消息「不渲染」（看起来像没了）**：在微信里用「独立聊天窗口（小窗口）」或快速在多个会话间切换后，主窗口的某个会话消息列表偶尔会**空白、不重绘**。这**不是消息丢失**——底层数据库完好（用 `autochat doctor` 或 `tools/wxmsgs.py` 仍能读到全部记录）。让消息重新显示：在该会话上**点一下 / 滚动一下 / 切到别的会话再切回**，通常即恢复；不行就**重启微信**。
- **微信可能弹出「修复」对话框**：微信偶尔会因数据库状态异常（如被外部进程占用、版本不匹配、异常退出）弹出「数据库损坏，是否修复」之类的提示。**不要急着点「修复」**——WeChat 的「修复聊天记录」会重建数据库，可能**丢失最近一段时间的聊天记录**。优先选择**正常重启微信**，多数情况下数据能自行恢复；确需修复时请先做好备份，并知晓可能丢近期记录。
- **降低风险的建议（核心是「隔离」）**：
  - **用独立的「小号」跑机器人，把上述所有微信客户端风险隔离在次要账号上**。小号被封、客户端异常、甚至误点「修复」丢记录，都不会波及你日常使用的主号聊天记录——这是性价比最高、最稳妥的一条。主号只负责在群里正常说话，机器人挂在小号上（见 [准备：小号方案](#准备小号方案重要)）。
  - 避免频繁开关独立聊天窗口、避免让本机微信在多人 / 多群高负载下长时间运行；
  - 保持微信版本与所用 hook DLL 匹配（见 [自适应](#自适应) 与 [锁住微信版本](#2-锁住微信版本这一步不能省)），减少客户端自身异常；
  - **定期备份微信聊天记录**（微信内置「设置 → 聊天 → 聊天记录迁移与备份」），这是应对任何客户端意外（含微信自带的修复）最稳妥的手段。

> 一句话总结：消息「看不见」基本都是微信自己的显示 bug，数据还在；真正要小心的是微信弹出的「修复」按钮——点下去可能真把近期记录清掉。AutoChat 全程只读，不会动你的数据。

本项目与腾讯 / 微信及其运营方无隶属或授权关系，仅供学习与技术研究，按「现状」提供，风险自负。
