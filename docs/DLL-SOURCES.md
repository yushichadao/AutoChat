# hook DLL 来源与许可

> **本项目自带维护者专门适配的 hook DLL（first-party），随 GitHub Releases 的便携发布包直接提供，开箱即用。**
> 也就是说：对支持的微信版本，**直接用发布包里那份自制 DLL 即可，不必自己去网上找、去下载第三方 DLL**。
> 下方表中标注「维护者自制」的就是它（推荐默认）。第三方来源的 DLL 方案（如 miloira/wxhook）仍列出供需要的人自行获取，其许可与安全性由各作者负责，本项目不担保、也不随包分发。
>
> 这些二进制是否使用、用在哪台机器上，由你自己判断并承担后果。

## 〇、目前支持的版本桥（确认好使）

以 **AutoChat 2.0.0** 为准，唯一确认开箱好使的微信版本链是 **4.1.10.27**：

| AutoChat | Hook（自研 DLL） | 微信 | 注入方式 | 收发能力 |
| --- | --- | --- | --- | --- |
| 2.0.0 | `version-ac-4.1.10.27.dll`（即 AC-4.1.10.27，原 483840 构建） | 4.1.10.27 | inject 直接加载；或 proxy 以 `version.dll` 名义注入安装目录 | 发送 ✅；接收靠 DB 轮询 |

- 同一份 483840 构建有两种用法：注入式直接加载 `version-ac-4.1.10.27.dll`；代理式由 AutoChat 把它复制为微信安装目录下的 `version.dll`（默认 `.env` 走 proxy，`WX_DLL_PATH` 指向该副本，即你当前最可用的配置）。
- 旧构建 `version-aixed.dll`（main/MinGW，4.1.10.27 启动即崩 `0xc0000005`）与 `version-gcc16.dll`（冗余兜底）已弃用删除，不再保留。
- **其他微信版本（4.1.15.x / 3.9.x / 4.1.8.67 等）不在发布包内**：`resolveBuiltinDll` 对它们返回 `null`，需用户自备第三方 DLL（miloira / lyx102），详见三、四、。

## 一、随仓库提供的文件

| 文件 | 来源 | 适配微信版本 | 发送 | 接收 | 许可与归属 |
| --- | --- | --- | --- | --- | --- |
| `tools/wxhook/version-ac-4.1.10.27.dll` | 作者自制，基于 aixed/WeChat-Hook（main 分支，GCC16 构建；原 483840 构建改名） | 4.1.10.27 | 支持 | 不支持（需 DB 轮询） | 作者自制，源码公开方案改编 |
| `tools/wxhook/mini.dll` / `mini2.dll` / `mini_c.dll` / `mini_gcc16.dll` | miloira/wxhook | 3.9.x ~ 4.1.15.x | 支持 | 支持 | MIT，开源仓库 |
| `tools/wxhook/getdbkey.dll` | miloira/wxhook | 通用 | — | — | MIT，用于取数据库密钥 |
| `tools/wxhook/libstdc++-6.dll` / `libwinpthread-1.dll` | MinGW 运行时 | 通用 | — | — | MinGW 运行库，随附供 DLL 依赖 |
| `tools/wechat-hook/version.dll` / `version-592.dll` | 作者自制，proxy 模式通用注入 | 通用（proxy） | 支持 | 支持 | 作者自制 |

## 二、怎么用

```bash
autochat autodll            # 按本机微信版本自动匹配，并告诉你匹配到哪个（优先命中发布包里自带的维护者自制 DLL）
autochat autodll --write    # 匹配后直接写进 .env 的 WX_DLL_PATH
```

也可以手填：`AI` 卡 → 账号卡 → hook DLL 路径，或直接改 `.env` 的 `WX_DLL_PATH`。

## 三、版本对应表

| 微信版本 | 用哪个 |
| --- | --- |
| 4.1.10.27 | `tools/wxhook/version-ac-4.1.10.27.dll`（**维护者自制、随发布包提供，本项目当前默认；原 483840 构建，已弃用 aixed/gcc16 旧构建**） |
| 3.9.x ~ 4.1.15.x | `tools/wxhook/mini*.dll` 系列（第三方 miloira/wxhook，需自行获取，由 `autochat autodll` 探测） |
| 任意（proxy 模式） | `tools/wechat-hook/version.dll`（**维护者自制、随发布包提供**），复制成微信目录下的 `version.dll` |

## 四、注意事项

1. **DLL 与微信版本强绑定**：微信一更新，DLL 就失效（甚至文件都没了）。先 `autochat lock` 锁定版本。
2. **维护者自制 DLL 已随发布包提供**：GitHub Releases 的 `AutoChat-win-x64.zip`（由 `tools/build-portable.ps1` 生成）内含 `tools/wxhook/version-ac-4.1.10.27.dll` 等自制适配 DLL，解压即用；**纯 `git clone` 因二进制不入库而不含这些文件，请直接用发布包**，不要再从别处找。
3. **第三方二进制版权归原作者**：第三方 DLL（如 miloira/wxhook 系列）本项目只是「提供获取指引」，不代表背书；许可证以各上游仓库为准，且不随发布包分发。
4. **想要别的方案**：见 `src/bridge/profiles.js` 的版本档案表，里面列了各第三方方案的仓库地址与许可。

> 相关：[十分钟上手](getting-started.md) · [故障模式](failure-modes.md)
