# hook DLL 来源与许可

> 仓库里**随源码一起提供**若干 hook DLL（下表逐个列出来）。
> 这些二进制的著作权属于各自作者，本项目**不担保**其安全性与合法性；
> 是否使用、用在哪台机器上，由你自己判断并承担后果。
>
> 重要：npm 上发布的包里**不含**这些二进制 —— 只有 `git clone` 仓库才会带上。

## 一、随仓库提供的文件

| 文件 | 来源 | 适配微信版本 | 发送 | 接收 | 许可与归属 |
| --- | --- | --- | --- | --- | --- |
| `tools/wxhook/WeChat-Hook-main/version-aixed.dll` | 作者自制，基于 aixed/WeChat-Hook（main 分支） | 4.1.10.27 | 支持 | 不支持（需 DB 轮询） | 作者自制，源码公开方案改编 |
| `tools/wxhook/version-gcc16.dll` | 作者自制，基于 aixed/WeChat-Hook | 4.1.x（gcc16 构建） | 支持 | 视版本 | 作者自制 |
| `tools/wxhook/mini.dll` / `mini2.dll` / `mini_c.dll` / `mini_gcc16.dll` | miloira/wxhook | 3.9.x ~ 4.1.15.x | 支持 | 支持 | MIT，开源仓库 |
| `tools/wxhook/getdbkey.dll` | miloira/wxhook | 通用 | — | — | MIT，用于取数据库密钥 |
| `tools/wxhook/libstdc++-6.dll` / `libwinpthread-1.dll` | MinGW 运行时 | 通用 | — | — | MinGW 运行库，随附供 DLL 依赖 |
| `tools/wechat-hook/version.dll` / `version-592.dll` | 作者自制，proxy 模式通用注入 | 通用（proxy） | 支持 | 支持 | 作者自制 |

## 二、怎么用

```bash
autochat autodll            # 按本机微信版本自动匹配，并告诉你匹配到哪个
autochat autodll --write    # 匹配后直接写进 .env 的 WX_DLL_PATH
```

也可以手填：`AI` 卡 → 账号卡 → hook DLL 路径，或直接改 `.env` 的 `WX_DLL_PATH`。

## 三、版本对应表

| 微信版本 | 用哪个 |
| --- | --- |
| 4.1.10.27 | `tools/wxhook/WeChat-Hook-main/version-aixed.dll`（本项目当前自用版本） |
| 3.9.x ~ 4.1.15.x | `tools/wxhook/mini*.dll` 系列（由 `autochat autodll` 探测） |
| 任意（proxy 模式） | `tools/wechat-hook/version.dll`，复制成微信目录下的 `version.dll` |

## 四、注意事项

1. **DLL 与微信版本强绑定**：微信一更新，DLL 就失效（甚至文件都没了）。先 `autochat lock` 锁定版本。
2. **第三方二进制版权归原作者**：本项目只是「随仓库附带」，不代表背书；许可证以各上游仓库为准。
3. **本项目不分发 npm 包里的这些文件**：`npm i` 装的包里没有 hook 二进制，只有 `git clone` 才有。
4. **想要别的方案**：见 `src/bridge/profiles.js` 的版本档案表，里面列了各第三方方案的仓库地址与许可。

> 相关：[十分钟上手](GETTING-STARTED.md) · [故障模式](FAILURE-MODES.md)
