import fs from 'node:fs';
import path from 'node:path';
import { readEditableEnv, writeEditableEnv } from '../../tasks/config.js';
import { PauseState } from '../../core/pause.js';
import { loadConfig } from '../../core/config.js';
import { loadPersona, DEFAULT_PERSONA } from '../../ai/persona.js';

/**
 * 配置读写接口：改 .env（白名单键）、暂停 / 恢复自动回复、人设导出。
 */
export const routes = {
  'POST /api/env': async ({ rootDir, body }) => {
    const b = await body();
    const r = writeEditableEnv(b.values || {}, rootDir);
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ok: true, changed: r.changed, state: await buildState(rootDir) } };
  },

  'GET /api/env': async ({ rootDir }) => ({ status: 200, body: readEditableEnv(rootDir) }),

  /**
   * 把「当前人设」（没配就是内置默认）落成一份本地文件，
   * 并把**绝对路径**写进 AI_PERSONA_FILE。
   *
   * 为什么要落成文件：界面上贴一段长文本不好改，而相对路径会因为工作目录
   * 不是项目根目录而读不到 —— 读不到时助手会悄悄退回内置默认人设。
   */
  'POST /api/persona/export': async ({ rootDir, body }) => {
    const b = await body();
    const cfg = loadConfig({ rootDir });
    const cur = loadPersona(cfg, rootDir);
    const dir = path.join(rootDir, 'data', 'persona');
    fs.mkdirSync(dir, { recursive: true });
    const name = String(b.name || 'persona.txt').trim() || 'persona.txt';
    const safe = path.basename(name).replace(/[\/\\]/g, '');
    if (!/\.txt$/i.test(safe)) return { status: 400, body: { error: '人设文件请用 .txt' } };
    const file = path.join(dir, safe);
    if (fs.existsSync(file) && b.overwrite !== true) {
      return { status: 409, body: { error: '该文件已存在，确认是否覆盖', path: file } };
    }
    const head = '# AutoChat 人设文件\n' +
      '# 改完保存即可（重启助手后生效）。\n' +
      '# 注意：无论这里怎么写，回复里都必须能看出是 AI，且不冒充真人 / 不冒充别家 AI\n' +
      '# —— 这两条写在系统提示里，不会被本文件覆盖。\n\n';
    const text = (cur.source === 'default' ? DEFAULT_PERSONA : cur.text) || DEFAULT_PERSONA;
    fs.writeFileSync(file, head + text + '\n', 'utf8');
    writeEditableEnv({ AI_PERSONA_FILE: file }, rootDir);
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ok: true, path: file, state: await buildState(rootDir) } };
  },

  'POST /api/gate': async ({ rootDir, body }) => {
    const b = await body();
    const cfg = loadConfig({ rootDir });
    const sw = new PauseState({ file: cfg.dataDir + '/paused' });
    const r = b.paused ? sw.pause(b.reason || '图形化配置器暂停') : sw.resume();
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ...r, gate: sw.status(), state: await buildState(rootDir) } };
  },
};
