# 安全政策（Security Policy）

> **English summary**: Security vulnerabilities must be reported privately via GitHub's "Security → Report a vulnerability" or directly to the maintainer. Do not open public issues for vulnerabilities. A pre-deployment self-check list is provided below.

## 报告漏洞（私密渠道）

**请不要在公开 issue / PR 中报告漏洞** —— 公开即意味着漏洞在被修复前已对所有人可见。

- 打开本仓库 **Security → Report a vulnerability** 提交私密报告；
- 平台不可用时，私下联系维护者（见仓库主页联系方式）。

报告请包含：

- 漏洞类型
- 影响面
- 最小复现步骤
- 影响版本
- 你的联系方式

维护者承诺 **3 个工作日内首次回应**，严重漏洞 **14 天内修复**，修复后致谢（可匿名）。
**不接受以披露相威胁的勒索行为**。

## 以下属于「设计使然」，不作为漏洞受理

（欢迎提改进建议）

- 注入 hook DLL 本身会修改微信进程运行时；
- hook DLL 是第三方二进制，安全性由其作者负责；
- hook 只发生在本机微信进程内，用在他人设备 / 账号上读取数据属违法（见 [LEGAL.md](LEGAL.md) 1.4 节）；
- `WX_HOOK_PORT`（30001）暴露本机微信库读写能力是 hook DLL 的设计，请勿把该端口暴露到网络；
- 使用云端模型会把聊天内容发往第三方；
- 自动化使用可能违反《微信个人账号使用规范》导致封号。

## 部署前自查

- `WX_WEBHOOK_BIND` 保持 `127.0.0.1`（改 `0.0.0.0` 时必须设 `WX_WEBHOOK_TOKEN`）；
- `WX_SELF_ID` 已填本机 wxid；
- `AI_GROUP_AT_NAMES` 已配；
- 限流 / 并发已收紧；
- `WX_HOOK_PORT` 未转发公网；
- `.env` 未提交版本库（`data/ai-memory.json` 是明文聊天记录，勿同步网盘）。
