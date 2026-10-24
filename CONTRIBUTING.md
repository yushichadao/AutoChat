# 贡献指南（CONTRIBUTING）

感谢你愿意参与 AutoChat。这个项目很小，但它碰的是**真实账号、真实对话、真实法律边界**，所以贡献门槛比一般小工具高一些。

## 开始之前

请先阅读：

| 文件 | 为什么必读 |
|---|---|
| [LEGAL.md](LEGAL.md) | 禁止用途、免责声明、以及为什么某些贡献会被直接拒绝 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 行为准则，含本项目特有的"技术红线" |
| [SECURITY.md](SECURITY.md) | 如果你发现的是漏洞，请走私密渠道而不是 PR |

## 环境

```bash
git clone <your-fork-url>
cd AutoChat
npm install          # 零运行时依赖，基本是空操作
npm test             # 66 项测试，应当全绿
npm run demo         # 不需要 DLL / API Key 跑通全链路
npm run check        # 环境诊断（在你自己的机器上）
```

要求：Node.js ≥ 22。代码是纯 ESM，无构建步骤，无 TypeScript，无 lint 框架 —— 保持简单是本项目的风格。

## 提 PR 之前

1. `npm test` 全绿
2. 新增行为必须**同时新增测试**
3. 提交信息使用中文或英文均可，格式参考 Conventional Commits：
   `feat(trigger): 支持按会话覆盖群聊策略`
4. 一次 PR 只做一件事

## 代码风格

- 2 空格缩进，单引号，分号
- 注释写"为什么"，不写"做了什么"
- 每个文件顶部用一段注释说清这个文件的职责边界
- 函数尽量小；超过 60 行考虑拆分
- 保持**零运行时依赖**的现状：新增依赖需要在 PR 里说明理由

## 会被直接拒绝的 PR

以下改动不会进入讨论（详见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 与 [LEGAL.md](LEGAL.md) 1.2 节）：

- 诈骗话术、群发脚本、绕过风控的实现
- 读取并外传他人微信数据的功能
- 向消息体注入收款码 / 代付请求
- 移除现有安全护栏（webhook 鉴权、自身消息过滤、限流、并发上限、否定语义拒绝）
- 引入真实用户数据作为测试夹具
- 打包分发第三方 hook DLL（尤其是闭源方案）

如果你认为某条红线过严，**请先开 issue 讨论**，不要直接提交 PR。

## 提交签署（Sign-off）

请在每个 commit 信息末尾加一行：

```
Signed-off-by: Your Name <your@email>
```

这表示你确认该提交的作者身份与内容，并同意其以本项目许可条款发布。CI 会检查这一行。

## 报告漏洞

**不要用 PR 或 issue 报告漏洞。** 见 [SECURITY.md](SECURITY.md)。

## 提问

- 功能怎么用 → 看 [README.md](README.md) 与 `npm run check`
- 微信版本能不能用 → 看 `src/bridge/profiles.js`，或提 issue 问
- 合规问题 → 看 [LEGAL.md](LEGAL.md)；**法律问题请咨询执业律师**，我们给不了法律意见
- 想法与建议 → 开 discussion 或 issue

## 许可

你的贡献将以 **MIT** 许可发布（见 [LICENSE](LICENSE)）。提交即表示你同意。
