# DeepSeek Harness（dsh）插件

AutoChat 同时是 **DeepSeek Harness 的插件**：在对话里查体检、启停服务、暂停回复、改配置、匹配 hook DLL。

> **插件是外壳 + 拦截器，不是第二个 AutoChat。**
> 所有判定（七步够不够）与落盘（`.env` / `config.json`）仍由 AutoChat 本体的 `src/tasks/` 完成，
> 插件只把动作翻译成一次 `autochat` CLI 调用，并在「根本性配置没走完」时拦住你启动。

组合包在仓库里的位置：`plugin/dsh-autochat/`（它是一个自洽的 npm 包，可以单独安装）。

---

## 一、装法

DSH → 插件 → **＋ 添加插件**，然后三选一：

| 方式 | 填什么 | 说明 |
| --- | --- | --- |
| 本地目录 | `C:\Users\<你>\CodeBuddy\AutoChat\plugin\dsh-autochat` | 最省事；本地目录是以 link 方式装进 profile 的，改完代码重启 DSH 即生效 |
| GitHub 仓库 | `https://github.com/yushichadao/AutoChat` | 组合包在仓库的 `plugin/dsh-autochat` 子目录 |
| npm 包名 | `dsh-autochat` | 仅在发布到 npm 之后可用 |

命令行等价物：

```bash
dsh plugin --profile <profile> add ./plugin/dsh-autochat
```

装完在「插件」页应能看到 **autochat** 这一行，可以在页面上一键启用/停用。

### 它长什么样（目录结构）

```
plugin/dsh-autochat/
├── package.json        组合包清单：dsh.bundle.patch 指向 patch 文件
├── cordis.patch.yml    插入一行插件：id=autochat，name=dsh-autochat
├── index.js            Cordis 插件入口：注册工具 + 注册技能
├── lib/cli.js          与 AutoChat 对话的那一层（跑 CLI、读七步、管门槛）
├── lib/tools.js        12 个工具的实现（与传输无关）
├── lib/skill.js        技能提供者（纪律手册）
├── lib/mcp.js          同一套工具的 MCP（stdio）传输层，给别的宿主用
├── assets/autochat-console.md  技能正文
├── icon.svg            插件页图标
└── locale/{zh,en}.json 名称与描述
```

---

## 二、装完不等于配好（这是刻意设计的）

AutoChat 能不能用，取决于七步是否真的成立：

```
① Node ≥18  ② 微信客户端  ③ 锁版本  ④ hook DLL 匹配并部署  ⑤ 模型可连通  ⑥ 小号/同号  ⑦ 服务在跑
```

这七步由 AutoChat 本体 `src/tasks/setup.js` 的 `evaluateSteps()` 判定，
**命令行、图形化配置器、DSH 插件、MCP 服务器四处共用同一份判断**。

插件的写操作会**先查这七步**，有阻断项（`bad`）就拒绝执行，除非显式加 `acknowledge_blocking`：

| 动作 | 会拦它的门槛 |
| --- | --- |
| `autochat_service`（action=start） | `node` / `wechat` / `dll` / `model` 不能是 `bad` |
| `autochat_reply_gate`（action=resume） | 同上 |
| `autochat_apply_step`（step=deploy-dll / fix-dll） | `wechat` 不能是 `bad`（不知道装在哪就没处写） |
| `autochat_config`（action=set） | 不设门槛，但**必须 `confirm:true`** |
| `autochat_apply_step` 任意步骤 | **必须 `confirm:true`**（会写微信目录 / 改系统设置） |

被拦下时回执里会带上具体是哪个步骤坏了、下一步该做什么 —— 不是在拦你，是在避免「看起来启动了但根本不可能回消息」。

---

## 三、工具清单（12 个）

| 工具 | 干什么 | 写操作 |
| --- | --- | --- |
| `autochat_preflight` | 七步现状 + 汇总 | 只读 |
| `autochat_doctor` | 深度体检：hook 端口、登录态、库表、模型、小号隔离、崩溃计数 | 只读 |
| `autochat_status` | 运行快照：服务、pid、是否暂停、模型、监听会话 | 只读 |
| `autochat_service` | `start` / `stop` / `restart` / `status` | ✔ 受门槛约束 |
| `autochat_reply_gate` | `pause` / `resume` / `status` | ✔ resume 受门槛约束 |
| `autochat_config` | 读 / 写 `.env` | ✔ 必须 confirm |
| `autochat_chats` | `list` / `add` / `remove` / `enable` / `disable` | ✔ |
| `autochat_apply_step` | `lock-version` / `detect-dll` / `deploy-dll` / `fix-dll` | ✔ 必须 confirm |
| `autochat_model` | `test` / `list` / `service-status` / `service-start` / `service-stop` | 部分 |
| `autochat_logs` | 日志尾部（`lines`、`err`） | 只读 |
| `autochat_version` | 版本与运行环境 | 只读 |
| `autochat_open_console` | 拉起图形化配置器（浏览器界面） | 只起进程 |

另有技能 **`autochat-console`**（操作纪律：七步不可跳、症状→处理、合规红线），模型会在动手前读到。

---

## 四、首次使用流程（跟着走完七步）

```text
1. autochat_preflight                 ← 先看全部七步，不要跳过
2. 按第一个 bad 项处理（一次一个）
     · lock  → autochat_apply_step {step:"lock-version", confirm:true}
     · dll   → autochat_apply_step {step:"detect-dll", confirm:true}
               autochat_apply_step {step:"deploy-dll", confirm:true}
               然后重启微信（hook DLL 只在微信启动时加载）
     · model → 人自己选来源：autochat_open_console（或终端 npm run setup）
               配完 autochat_model {action:"test"} 验一次
     · self  → 小号方案：手机主号 + 电脑另一个号跑 AutoChat
3. autochat_preflight                 ← 复核，直到阻断 0
4. autochat_service {action:"start"}
5. 手机用另一个号给电脑上的号发一句「你好」，几秒内应有回复
```

凡是「要人现场拍板」的步骤（选模型、填密钥、加哪个群），插件**不会替你猜**：
用 `autochat_open_console` 开图形化配置器，或在 AutoChat 目录里跑 `npm run setup`。

---

## 五、插件怎么找到 AutoChat

优先级：

1. **插件配置里的 `home`** —— 在 profile 的 `cordis.patch.yml` 里给这一行加 `config.home`
   （需要在插件那一层之上再叠一层 patch；直接改组合包里的 `cordis.patch.yml` 会在升级时被覆盖）
2. 环境变量 `AUTOCHAT_HOME`
3. 从插件包目录往上找（本地目录安装会链回仓库根，自动认出）
4. 常见位置：`%USERPROFILE%\CodeBuddy\AutoChat`、`%USERPROFILE%\AutoChat`、`%LOCALAPPDATA%\AutoChat`

判定标准只有一个：该目录下存在 `src/cli/index.js`。
每次回执的第一行都是 `【action】 {"home":"…","homeSource":"…"}`，
**怀疑「配到另一份副本上了」时先看这一行。**

---

## 六、排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件页看不到 autochat 行 | 组合包没装成 / 被版本兼容检查挡了 | 看 DSH 的安装日志；`engines.dsh` 范围是 `>=0.2.0 <0.3.0` |
| 插件行在，但工具没出现 | 插件行被禁用，或 `tools` 服务没挂上 | 在插件页打开这行；确认 agent preset 里带了本插件 |
| 工具报「没找到 AutoChat 安装目录」 | 插件装在别处且不是从仓库目录装的 | 设 `AUTOCHAT_HOME`，或在 patch 里填 `config.home` |
| `start` 被拦住 | 七步里有 `bad` | 先处理阻断项；确实只想看日志才用 `acknowledge_blocking` |
| `config set` 说「没写进去」 | 键不在白名单里 | 白名单见 `src/tasks/config.js` 的 `EDITABLE_ENV`；不要手改 `.env` |
| 改了配置没效果 | 只改了磁盘，进程还在用旧配置 | `autochat_service {action:"restart"}` |
| 微信重启后插件读不到消息 | hook DLL 只在微信启动时加载 | 部署后必须重启微信，再 `autochat_service {action:"restart"}` |

---

## 七、同一套工具也能当 MCP 用

`lib/mcp.js` 是同一份工具实现的 stdio MCP 传输层，给任何支持 MCP 的宿主用
（CodeBuddy IDE、Claude Code 等）：

```bash
node src/mcp/server.js        # 仓库根（MCP 宿主用；仓库里的 .mcp.json 指向它）
```

两个出口共用 `lib/tools.js`，所以行为完全一致。

---

## 八、发布（维护者）

两个包必须**同版本**发布，顺序是先组合包、后本体：

```bash
# ① 登录（只做一次，凭据由 npm 自己保管）
npm login --registry=https://registry.npmjs.org/
npm whoami

# ② 改版本号：plugin/dsh-autochat/package.json 与根 package.json 同步
#    并更新 CHANGELOG.md

# ③ 先发组合包
cd plugin/dsh-autochat
npm publish --access public

# ④ 再发本体
cd ../..
npm publish --access public
```

`prepublishOnly` 会在 publish 前自动跑一遍全量测试，红就发不出去。

> [!WARNING]
> **根包不能再叫 `install` / `uninstall` 的 npm script** —— 这两个名字是 npm 生命周期钩子，
> 消费者 `npm i -g autochat` 时会被自动执行（安装器是交互式的，非交互环境下会卡住或失败）。
> 已改名为 `install-service` / `uninstall-service`。

## 九、安全边界

- 插件不读取 `AI_API_KEY`、`WX_WEBHOOK_TOKEN` 的真实值（AutoChat 侧就把它们脱敏成 `true/false`）。
- 插件不内置、不再分发微信安装包与第三方 hook DLL；`deploy-dll` 只复制**你本机已有**的那份 DLL。
- 只允许在**自己的电脑、自己的微信号**上操作；冒充他人、群发推广、发送收款码/代付请求等用途一律拒绝
  （法律依据见 [LEGAL.md](../LEGAL.md)）。
