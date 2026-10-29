import fs from 'node:fs';
import path from 'node:path';
import { readChats, writeChats, CHAT_FIELDS } from '../../core/chats.js';
import { syncPollChats } from '../../tasks/config.js';
import { getHookContacts, currentAccountWxid } from '../state.js';

/**
 * 按会话配置接口：增删改查、联系人搜索、文件上传。
 */
export const routes = {
  'POST /api/chats': async ({ rootDir, body }) => {
    const b = await body();
    const wxid = currentAccountWxid();
    const chats = readChats(rootDir, wxid);
    for (const [id, c] of Object.entries(b.chats || {})) {
      const clean = {};
      if (c && typeof c === 'object') {
        for (const k of CHAT_FIELDS) if (k in c) clean[k] = c[k];
      } else {
        clean.enabled = true;
      }
      // 打上归属账号，确保「每个号一套监听群」互不串：旧号专属群不会被别的号误监听
      clean.account = wxid;
      chats[id] = clean;
    }
    for (const id of b.remove || []) delete chats[id];
    writeChats(chats, rootDir, wxid);
    // 加入 / 保存会话时自动同步监听列表，避免「加了会话却收不到消息」
    const pollChats = syncPollChats(chats, b.remove || [], rootDir);
    const { buildState } = await import('../state.js');
    return { status: 200, body: { ok: true, chats, pollChats, state: await buildState(rootDir) } };
  },

  'GET /api/contacts/search': async ({ rootDir, url }) => {
    const q = (url.searchParams.get('q') || '').trim();
    // 用户主动搜索时强制重探通讯录表：刚启动助手也不至于等冷却
    const force = url.searchParams.get('force') === '1';
    try {
      const { hook, contacts } = getHookContacts(rootDir);
      const prof = await hook.selfProfile().catch(() => null);
      contacts.setCurrentAccount(prof?.wxid || undefined);
      const st = await hook.ping().catch(() => ({ ok: false }));
      if (!st.ok) {
        return {
          status: 200,
          body: {
            ok: false,
            reason: 'hook 不可达（微信没运行或 DLL 未注入）—— 先在「③ 启动助手」启动服务再搜索',
            results: [],
          },
        };
      }
      // 直接试库：通讯录表能否读到由 contacts.search 自己判断并返回真实原因，
      // 不要再拿「IsLogin」这种在 4.1.10.27 上会被 DLL 误报成 0 的字段预挡搜索
      // （原型 SnowLuma-wx 当年就是直接试库，联系人一直能读）。
      const r = await contacts.search(q, 50, { force });
      return { status: 200, body: r };
    } catch (err) {
      return { status: 200, body: { ok: false, reason: '搜索失败：' + (err?.message || err), results: [] } };
    }
  },

  /**
   * 上传人设文件（.md/.txt/.json）。
   *
   * 落到 <项目根目录>/data/persona/ 下，返回**绝对路径**写回 .env 的 AI_PERSONA_FILE：
   * 相对路径会因为「当前目录不是项目根目录」而找不到文件，助手就悄悄退回内置默认人设。
   */
  'POST /api/file/upload': async ({ rootDir, body }) => {
    const b = await body();
    const name = String(b.name || '').trim();
    const content = String(b.content || '');
    const safe = path.basename(name).replace(/[\/\\]/g, '');
    if (!safe || safe !== name || safe === '.' || safe === '..' || safe.startsWith('.')) {
      return { status: 400, body: { error: '非法文件名' } };
    }
    // 人设就是一段纯文本，统一 .txt（记事本直接能改）
    if (!/\.txt$/i.test(safe)) {
      return { status: 400, body: { error: '人设文件请用 .txt（记事本就能改）' } };
    }
    if (content.length > 200 * 1024) {
      return { status: 400, body: { error: '人设文件太大（上限 200KB）' } };
    }
    const dir = path.join(rootDir, 'data', 'persona');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safe);
    fs.writeFileSync(file, content, 'utf8');
    return { status: 200, body: { ok: true, path: file, name: safe, size: content.length } };
  },
};
