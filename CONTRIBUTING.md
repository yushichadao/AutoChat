# 贡献指南（Contributing）

> **English summary**: Zero runtime dependencies is a hard rule (CI enforces it). PRs must pass tests, add tests for new behavior, follow Conventional Commits, and each commit must be signed off (DCO). Contributions that improve abuse capability are rejected outright.

## 开发环境

```bash
git clone https://github.com/yushichadao/AutoChat.git
cd AutoChat
npm install            # 零运行时依赖，基本是空操作
npm test               # 测试应全绿（当前 108 项）
npm run demo           # 不需要 DLL / API Key 跑通全链路
npm run check          # 环境诊断（在你自己的机器上）
```

要求：Node.js ≥ 22；纯 ESM、无构建步骤、无 TypeScript、无 lint 框架 —— 保持简单是本项目的风格。

## 提 PR 之前

1. `npm test` 全绿；
2. 新增行为必须同时新增测试；
3. 提交信息参考 Conventional Commits（`feat(trigger): 支持按会话覆盖群聊策略`）；
4. 一次 PR 只做一件事；
5. 每个 commit **末尾加 `Signed-off-by: 你的名字 <邮箱>`**（确认作者身份并同意以本仓库 [LICENSE](LICENSE) 条款发布，CI 会检查）。

## 代码风格

2 空格缩进、单引号、分号；注释写「为什么」；每个文件顶部用一段注释说清职责边界；函数尽量小；保持零依赖现状。

## 会被直接拒绝的 PR

（详见 [LEGAL.md](LEGAL.md) 1.2 节与 [LICENSE](LICENSE) 限制）

- 诈骗话术 / 群发脚本 / 绕过风控；
- 读取并外传他人微信数据；
- 向消息体注入收款码 / 代付请求；
- 移除现有安全护栏（webhook 鉴权、自身消息过滤、限流、并发上限、否定语义拒绝）；
- 引入真实用户数据作为测试夹具；
- 打包分发第三方 hook DLL；
- **以及任何复制或照搬本软件 UI/CLI/GUI 设计、或特有代码逻辑到其他项目的改动**。

认为某条红线过严请先开 issue 讨论，不要直接提交 PR。
