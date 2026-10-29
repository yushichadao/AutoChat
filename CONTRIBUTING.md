# 参与 AutoChat

本项目由 **Yushichadao** 维护（yushichadao@qq.com）。欢迎 issue 与 PR —— 但请先读 [LEGAL.md](LEGAL.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)：本项目**有技术红线**，触碰红线的 PR 会被直接拒绝。

## 环境

```bash
git clone https://github.com/yushichadao/AutoChat.git
cd AutoChat
npm install        # 零运行时依赖，基本是空操作
npm test           # 231 项，应全绿
npm run demo       # 不需要 DLL 与 API Key 跑通全链路
npm run doctor     # 在你自己的机器上体检
```

要求：Node.js **18 以上**（推荐 22 LTS）。纯 ESM、无构建步骤、无 TypeScript、无 lint 框架 —— **保持简单是本项目的风格**。

## 目录结构（2.0.0）

```
src/
├── index.js          # 助手服务进程入口（npm start 走这里）
├── core/             # 核心层：配置与领域模型（不做业务判断）
│   ├── config.js     #   .env / config.json → 配置对象
│   ├── env-file.js   #   .env 行级读写（保留注释与顺序）
│   ├── chats.js      #   按会话配置的唯一读写入口
│   ├── logger.js     #   分级日志（只输出到标准流）
│   ├── paths.js      #   路径常量
│   ├── pause.js      #   暂停状态哨兵 + 单实例判定
│   └── win.js        #   Windows 集成（注册表、快捷方式、UAC 提权）
├── tasks/            # 任务层：CLI 与图形化配置器共用的唯一事实来源
│   ├── doctor.js     #   环境体检
│   ├── setup.js      #   初始化向导状态机
│   ├── install.js    #   安装 / 卸载 / 锁定微信版本
│   ├── service.js    #   助手服务启停、日志路径、崩溃计数
│   ├── model-service.js  # 本地模型服务（Ollama 等）启停
│   └── logs.js context.js chats.js config.js lock.js autodll.js model.js
├── cli/              # 命令行入口（薄）：只做参数解析与渲染
│   ├── index.js      #   分发器（≤150 行）
│   ├── ui.js         #   输出层（颜色、JSON、退出码）
│   ├── prompts.js    #   终端问答原语
│   └── commands/     #   一个命令一个文件
├── gui/              # 图形化配置器入口（薄）
│   ├── server.js     #   HTTP + 令牌 + 静态资源
│   ├── state.js      #   状态快照装配
│   ├── browser.js    #   打开独立窗口
│   ├── api/          #   REST 路由，按域拆分
│   └── ui/           #   前端：js/widgets.js + js/cards/*.js + js/main.js
├── ai/               # 模型接入
├── bridge/           # 微信注入 / 接收 / 探测
└── protocol/         # 消息归一
```

### 分层纪律（最重要的一条）

> **逻辑写在 `src/tasks/`，渲染写在各自入口（`src/cli/`、`src/gui/`）。**

- 命令行与图形化配置器是**两个平级入口**，能力必须一一对应（对照表见 [docs/experience-audit.md](docs/experience-audit.md)）。
- 不要在 CLI 命令文件或前端里写业务判断；也不要把同一份逻辑复制两份。
- npm script 只是命令行的薄别名；`tools/*.js` 只做薄封装。
## 命令

| 分类 | 命令 |
| --- | --- |
| 第一次用 | `setup`、`doctor`、`gui` |
| 运行 | `start`（`--background` / `--elevate`）、`stop`、`status`、`logs` |
| 自动回复 | `pause`、`resume` |
| 模型 | `model test` / `model list` / `model service start\|stop\|status` |
| 管理 | `chats`、`context`、`config`、`lock`、`autodll`、`install`、`uninstall`、`version` |

完整说明见 [docs/commands.md](docs/commands.md)。

## 测试

```bash
npm test                      # node --test test/*.test.js
node --test test/cli.test.js  # 单个文件
```

- **新增行为必须同时新增测试**。
- 现有测试里有三条「纪律测试」，请不要绕过：
  - `test/gui-widgets.test.js`：界面里不允许出现裸勾选框；
  - `test/gui-cards.test.js`：卡片渲染不得出现 `undefined`，外部文本必须转义；
  - `test/server-safety.test.js`：配置器接口必须校验令牌。
- 端到端用例用**随机端口**，子进程异常退出要立即失败，别连到残留进程产生假红 / 假绿。

## 文案与命名规范

- 术语一律按 [docs/glossary.md](docs/glossary.md)：例如「自动回复开关」（配置层）与「暂停状态」（运行层）不要再叫「总闸」。
- 终端输出：一行一件事，结论不加句号，需要动作时写 `→ 下一步：…`。
- 界面：卡片标题用名词短语，按钮用动词短语，说明写「关掉会怎样」。
- 代码：文件名小写短横线，导出符号 camelCase，常量全大写；函数名用动词短语带层次（`doctorReport()`、`startBackground()`）。
- 单文件 ≤400 行（前端卡片 ≤150 行）。
- 注释写「为什么」，不写「是什么」。

## 提交规范

1. `npm test` 全绿；
2. 新增行为配测试；
3. 提交信息参考 Conventional Commits（`feat(trigger): 支持按会话覆盖群聊策略`）；
4. 一次 PR 只做一件事；
5. 每个 commit 末尾加 `Signed-off-by: 你的名字 <邮箱>`（CI 会检查）。

## 会被直接拒绝的 PR

详见 [LEGAL.md](LEGAL.md) 1.2 节与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)：诈骗话术、批量群发、读取并外传他人微信数据、注入收款码 / 代付请求、移除现有安全护栏、引入真实用户数据作为测试夹具、**打包分发第三方 hook DLL**、以及复制或照搬本项目的 UI / CLI / GUI 设计或独有代码逻辑。

## 许可

源代码采用本仓库自带的**源可见许可证**（见 [LICENSE](LICENSE)）：可学习、可自用与为自用修改，但不得冒名发布、不得抄袭 GUI 视觉设计、不得照搬独有代码逻辑；公开发布衍生版需事先书面授权。
