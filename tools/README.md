# tools/ 说明

本目录混了三类东西，用之前先看清是哪一类。

## 一、当前项目（AutoChat，Node/JS）—— 这些是进版本库的，也是现在用的

| 文件 | 作用 |
|---|---|
| `demo.js` | 一键演示：假 hook + 假模型，跑通「微信来消息 → 模型回复 → 发回微信」，不需要 DLL / API Key |
| `mock-hook.js` | 假 hook DLL，可伪造入站消息、模拟别家字段方言 |
| `mock-ai.js` | 假 OpenAI 兼容服务，回显用户消息（顺便暴露调用记录） |
| `check-env.js` | 环境体检：微信版本、DLL、权限、hook 能力、自身 wxid、webhook 暴露面、按会话配置、AI 联通性（薄封装，真正逻辑在 `src/tasks/doctor.js`） |
| `uninstall.js` | 卸载/还原：还原 `version.dll`、解除微信更新通道阻断、可选清理 `data/` |

入口在 `package.json` 的 scripts 里：`npm run demo` / `npm run doctor` / `npm run uninstall`。

## 二、上一代 Python 实现遗留 —— 保留在本地，**不进版本库**

`bot_db.py`、`webui.py`、`intent.py`、`tasks.py`、`reply_rules.py`、`list_chats.py`、
`wx-*.py`、`wxq.py`、`wxmsgs.py`、`dbg_group*.py`、`test_*.py`

这些是 **Python 版微信自动回复脚本**（含一个 8899 端口的 Web 控制台）的遗留文件。
当前 `src/` 与 `package.json` 的脚本**都不引用**它们，跑 `npm start` / `npm test` 用不到。

已通过 `.gitignore` 排除在版本库之外，但仍保留在本地磁盘上（历史经验：微信数据库查询手法）。

> 之所以只忽略不删除：这些脚本里还有几处踩过的坑记录（`Msg_<md5>` 分表、`contact.db`、
> `Name2Id`、隐式相对导入等）。确认不再需要后可以直接删掉整个 `tools/*.py`。

## 三、第三方源码与工具链 —— 保留在本地，**不进版本库**

| 目录 | 说明 |
|---|---|
| `wechat-hook/`、`wxhook/` | 第三方 hook DLL 源码（编译 `version.dll` 用），**许可各异，不可随本项目再分发** |
| `mingw64/` | MinGW-w64 工具链（编译 C++ 用，体积大） |
| `reverse/`、`ide/` | 逆向分析资料与个人 IDE 辅助 |
| `wx-ui/` | 早期 UI 尝试 |

已通过 `.gitignore` 排除。需要时按下面自行获取：

```bash
# hook DLL 源码（按你需要的方案二选一，许可请看各自的仓库）
git clone https://github.com/aixed/WeChat-Hook.git tools/wechat-hook
git clone https://github.com/miloira/wxhook.git      tools/wxhook

# MinGW-w64（Windows）
pwsh -File tools/get-mingw.ps1
```

`build-aixed.ps1` 是编译 hook DLL 的脚本，产物属于第三方项目。
npm 包不附带任何二进制；仓库随附的部分 hook DLL 见 [docs/DLL-SOURCES.md](../docs/DLL-SOURCES.md)（含许可与来源），其余第三方源码不进版本库。
