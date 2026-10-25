import { readEditableEnv, writeEditableEnv } from '../../tasks/config.js';
import { PauseState } from '../../core/pause.js';
import { loadConfig } from '../../core/config.js';

/**
 * 配置读写接口：改 .env（白名单键）、暂停 / 恢复自动回复。
 */
export const routes = {
  'POST /api/env': async ({ rootDir, body }) => {
    const b = await body();
    const r = writeEditableEnv(b.values || {}, rootDir);
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ok: true, changed: r.changed, state: await buildState(rootDir) } };
  },

  'GET /api/env': async ({ rootDir }) => ({ status: 200, body: readEditableEnv(rootDir) }),

  'POST /api/gate': async ({ rootDir, body }) => {
    const b = await body();
    const cfg = loadConfig({ rootDir });
    const sw = new PauseState({ file: cfg.dataDir + '/paused' });
    const r = b.paused ? sw.pause(b.reason || '图形化配置器暂停') : sw.resume();
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ...r, gate: sw.status(), state: await buildState(rootDir) } };
  },
};
