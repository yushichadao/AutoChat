import fs from 'node:fs';
import path from 'node:path';
import { readChats, writeChats, CHAT_FIELDS } from '../../core/chats.js';
import { getHookContacts } from '../state.js';

/**
 * 按会话配置接口：增删改查、联系人搜索、文件上传。
 */
export const routes = {
  'POST /api/chats': async ({ rootDir, body }) => {
    const b = await body();
    const chats = readChats(rootDir);
    for (const [id, c] of Object.entries(b.chats || {})) {
      const clean = {};
      if (c && typeof c === 'object') {
        for (const k of CHAT_FIELDS) if (k in c) clean[k] = c[k];
      } else {
        clean.enabled = true;
      }
      chats[id] = clean;
    }
    for (const id of b.remove || []) delete chats[id];
    writeChats(chats, rootDir);
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ok: true, chats, state: await buildState(rootDir) } };
  },

  'GET /api/contacts/search': async ({ rootDir, url }) => {
    const q = url.searchParams.get('q') || '';
    try {
      const { hook, contacts } = getHookContacts(rootDir);
      const st = await hook.ping().catch(() => ({ ok: false }));
      if (!st.ok) {
        return { status: 200, body: { ok: false, reason: 'hook 不可达（微信没运行或 DLL 未注入）', results: [] } };
      }
      const results = await contacts.search(q);
      return { status: 200, body: { ok: true, results } };
    } catch {
      return { status: 200, body: { ok: false, results: [] } };
    }
  },

  'POST /api/file/upload': async ({ rootDir, body }) => {
    const b = await body();
    const name = String(b.name || '').trim();
    const content = String(b.content || '');
    const safe = path.basename(name).replace(/[\/\\]/g, '');
    if (!safe || safe !== name || safe === '.' || safe === '..' || safe.startsWith('.')) {
      return { status: 400, body: { error: '非法文件名' } };
    }
    const dir = path.join(rootDir, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), content, 'utf8');
    return { status: 200, body: { ok: true, path: './data/' + safe } };
  },
};
