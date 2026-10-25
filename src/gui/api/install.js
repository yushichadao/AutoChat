import fs from 'node:fs';
import { install, uninstall } from '../../tasks/install.js';
import { lockWeChatUpdate } from '../../tasks/lock.js';
import { detectBuiltinDll } from '../../tasks/autodll.js';
import { writeEditableEnv } from '../../tasks/config.js';

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
    const r = await uninstall({ rootDir, purge: Boolean(b.purge), force: Boolean(b.force) });
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
    const d = await detectBuiltinDll(rootDir);
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
};
