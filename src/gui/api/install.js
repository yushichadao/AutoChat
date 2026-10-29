import fs from 'node:fs';
import { install, uninstall } from '../../tasks/install.js';
import { lockWeChatUpdate } from '../../tasks/lock.js';
import { detectBuiltinDll } from '../../tasks/autodll.js';
import { writeEditableEnv } from '../../tasks/config.js';
import { loadConfig } from '../../core/config.js';
import { deployProxyDll } from '../../bridge/injector.js';
import { detectWeChat } from '../../bridge/process.js';
import { HookLifecycle } from '../../bridge/hook-lifecycle.js';
import { createLogger } from '../../core/logger.js';

/**
 * 安装 / 卸载 / 锁定版本 / 自动选 DLL 接口。
 */
export const routes = {
  'POST /api/install': async ({ rootDir, body }) => {
    const b = await body();
    const r = await install({
      rootDir,
      env: b.env || {},
      chats: b.chats || {},
      autostart: Boolean(b.autostart),
      shortcut: Boolean(b.shortcut),
      deployDll: Boolean(b.deployDll),
      lock: Boolean(b.lock),
      service: Boolean(b.service),
    });
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ...r, state: await buildState(rootDir) } };
  },

  'POST /api/uninstall': async ({ rootDir, body }) => {
    const b = await body();
    const r = await uninstall({
      rootDir,
      purge: Boolean(b.purge),
      force: Boolean(b.force),
      recycle: Boolean(b.recycle),
    });
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ...r, state: await buildState(rootDir) } };
  },

  'POST /api/lock': async ({ rootDir }) => {
    const r = await lockWeChatUpdate();
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ...r, state: await buildState(rootDir) } };
  },

  'POST /api/autodll': async ({ rootDir, body }) => {
    const b = await body();
    const cfg = loadConfig({ rootDir });
    const d = await detectBuiltinDll(rootDir, cfg.wechat.installDir);
    if (d.path && b.write) writeEditableEnv({ WX_DLL_PATH: d.path }, rootDir);
    const { buildState } = await import('../state.js');
    return { status: 200, body: { version: d.version, path: d.path, state: await buildState(rootDir) } };
  },

  /** 自定义 hook DLL 路径：校验文件存在且为 .dll 后写入 WX_DLL_PATH。 */
  'POST /api/wechat/dll': async ({ rootDir, body }) => {
    const b = await body();
    const p = String((b && b.path) || '').trim();
    if (!p) return { status: 400, body: { ok: false, message: '请填写 DLL 路径' } };
    if (!/\.dll$/i.test(p)) return { status: 400, body: { ok: false, message: '路径必须以 .dll 结尾' } };
    if (!fs.existsSync(p)) return { status: 400, body: { ok: false, message: '该文件不存在：' + p } };
    writeEditableEnv({ WX_DLL_PATH: p }, rootDir);
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ok: true, path: p, message: '已写入 WX_DLL_PATH', state: await buildState(rootDir) } };
  },

  /**
   * 把当前配置的 hook DLL 写进微信安装目录（version.dll，DLL 劫持位）。
   *
   * 为什么需要这个接口：微信启动时只加载安装目录下的 version.dll，
   * 配置里的 WX_DLL_PATH 只是「从哪拷」。两者不一致时跑的是旧 DLL，
   * 表现就是 hook 能 ping 通、但 IsLogin=0、数据库句柄全失败。
   */
  'POST /api/wechat/deploy': async ({ rootDir }) => {
    const cfg = loadConfig({ rootDir });
    const dll = cfg.wechat.dllPath;
    if (!dll || !fs.existsSync(dll)) {
      return { status: 400, body: { ok: false, message: '还没配置 hook DLL，或文件不存在：' + (dll || '(空)') } };
    }
    const wechat = await detectWeChat(cfg.wechat.installDir).catch(() => null);
    const dir = cfg.wechat.installDir || (wechat && wechat.dir) || '';
    if (!dir) {
      return { status: 400, body: { ok: false, message: '没检测到微信安装目录，先在 .env 里填 WX_INSTALL_DIR' } };
    }
    try {
      const target = await deployProxyDll(dir, dll, true);
      const { buildState } = await import('../state.js');
      return {
        status: 200,
        body: {
          ok: true,
          target,
          needsRestart: true,
          message: '已把配置的 DLL 写入微信目录，重启微信后生效',
          state: await buildState(rootDir),
        },
      };
    } catch (err) {
      return {
        status: 200,
        body: {
          ok: false,
          message: '写入失败：' + err.message + '（通常需要管理员权限；微信正在运行时也可能被占用）',
        },
      };
    }
  },

  /**
   * 一键自动补齐：微信版本不对就（引导/启动）重装对应版本，DLL 不对就部署项目匹配的并重启。
   * 哪里不对补哪里，最后用 IsLogin 校验是否真的可用。
   */
  'POST /api/wechat/auto-repair': async ({ rootDir }) => {
    const cfg = loadConfig({ rootDir });
    const logger = createLogger('auto-repair', cfg.logLevel);
    try {
      const lc = new HookLifecycle(cfg.wechat, logger);
      const r = await lc.autoRepair();
      const { buildState } = await import('../state.js');
      return {
        status: 200,
        body: {
          ok: r.ok,
          phase: r.phase,
          needsUser: Boolean(r.needsUser),
          targetVersion: r.targetVersion || '',
          envLine: r.envLine || '',
          releaseUrl: r.releaseUrl || '',
          message: r.message || '已完成自动补齐',
          steps: r.steps || [],
          state: await buildState(rootDir),
        },
      };
    } catch (err) {
      return {
        status: 200,
        body: { ok: false, phase: 'error', message: '自动补齐失败：' + err.message },
      };
    }
  },

  /**
   * 仅把微信安装包路径写入 .env（不启动安装包）。
   * 让用户能提前把 WX_INSTALLER_PATH 设好，或与「运行安装包」分开用。
   */
  'POST /api/wechat/installer-save': async ({ rootDir, body }) => {
    const b = await body();
    const p = String((b && b.path) || '').trim();
    if (!p) return { status: 400, body: { ok: false, message: '请填写安装包路径' } };
    if (!/\.exe$/i.test(p)) return { status: 400, body: { ok: false, message: '安装包必须是 .exe' } };
    writeEditableEnv({ WX_INSTALLER_PATH: p }, rootDir);
    const exists = fs.existsSync(p);
    return {
      status: 200,
      body: {
        ok: true,
        message: exists ? '已保存安装包路径到 .env' : '已保存路径，但该文件当前不存在（请确认路径或先下载安装包）',
      },
    };
  },

  /**
   * 运行本地微信安装包（逆版本安装）。
   * 合规：本项目不内置、不转发微信安装包，只运行用户自己指定的本地 .exe。
   */
  'POST /api/wechat/installer': async ({ rootDir, body }) => {
    const b = await body();
    const p = String((b && b.path) || '').trim();
    if (!p) return { status: 400, body: { ok: false, message: '请填写安装包路径' } };
    if (!/\.exe$/i.test(p)) return { status: 400, body: { ok: false, message: '安装包必须是 .exe' } };
    if (!fs.existsSync(p)) return { status: 400, body: { ok: false, message: '文件不存在：' + p } };
    writeEditableEnv({ WX_INSTALLER_PATH: p }, rootDir);
    const { execFile } = await import('node:child_process');
    await new Promise((resolve) => {
      const safe = p.replace(/'/g, "''");
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${safe}' -Verb RunAs`],
        { windowsHide: true },
        () => resolve()
      );
    });
    return { status: 200, body: { ok: true, message: '已启动安装包（如弹出 UAC 请允许）' } };
  },
};
