import fs from 'node:fs';
import path from 'node:path';
import { buildState, currentAccountWxid } from '../state.js';
import { clearContext } from '../../tasks/context.js';
import { loadConfig } from '../../core/config.js';
import { loadActiveAccount, saveActiveAccount } from '../../core/account-profile.js';
import { probeAccount } from '../../tasks/doctor.js';

/**
 * 状态与环境体检接口。
 * 约定：每个路由返回 { status, body }，由 server.js 统一写回。
 */
export const routes = {
  'GET /api/state': async ({ rootDir }) => ({
    status: 200,
    body: await buildState(rootDir),
  }),

  // 清空上下文记忆（按当前登录账号隔离：只清本账号的 memory.json）
  'POST /api/context/clear': async ({ rootDir, body }) => {
    const b = await body();
    const r = clearContext(b?.chatId || '', rootDir, currentAccountWxid());
    return { status: 200, body: { ok: true, ...r, state: await buildState(rootDir) } };
  },

  // 当前账号管理：列出已知账号、探测到的实时账号、以及手动指定的覆盖账号。
  'GET /api/accounts': async ({ rootDir }) => {
    const cfg = loadConfig({ rootDir });
    const dataDir = cfg.dataDir;
    const active = loadActiveAccount(dataDir);
    const live = await probeAccount(rootDir).catch(() => null);
    let known = [];
    try {
      const dir = path.join(dataDir, 'accounts');
      if (fs.existsSync(dir)) {
        known = fs
          .readdirSync(dir)
          .filter((n) => n && n !== 'unknown' && fs.statSync(path.join(dir, n)).isDirectory());
      }
    } catch {
      /* ignore */
    }
    return { status: 200, body: { active, live: live || null, known } };
  },

  // 手动指定「当前账号」覆盖（优先于 hook 自动探测）。wxid 为空＝清除覆盖，回落到自动探测。
  'POST /api/account': async ({ rootDir, body }) => {
    const cfg = loadConfig({ rootDir });
    const b = await body();
    const wxid = b?.wxid ? String(b.wxid).trim() : '';
    const nickname = b?.nickname ? String(b.nickname).trim() : '';
    saveActiveAccount(cfg.dataDir, wxid, nickname);
    return { status: 200, body: { ok: true, wxid, nickname } };
  },

  'GET /api/diagnose': async ({ rootDir }) => {
    const { diagnose } = await import('../../tasks/doctor.js');
    const r = await diagnose({ rootDir });
    return { status: 200, body: r };
  },

  // 群可用性（HI7）：与 /api/diagnose（环境 / 基础设施）并列的独立检查，
  // 只回答「哪些群在听 / 表可达 / 未启用」，输入仅来自 effectivePollChats，绝不自动发现群。
  // 注意：必须实时探测当前登录账号，不能用 currentAccountWxid() 的模块级缓存——
  // 否则换号后缓存仍是旧号，会用旧号的群列表去查新号数据库，出现串台误报（旧群在新库里找不到表）。
  'GET /api/chat-availability': async ({ rootDir }) => {
    const { checkChatAvailability, probeAccount } = await import('../../tasks/doctor.js');
    const cfg = loadConfig({ rootDir });
    const override = loadActiveAccount(cfg.dataDir).wxid;
    const live = (await probeAccount(rootDir).catch(() => null))?.wxid || '';
    const wxid = override || live || '';
    const r = await checkChatAvailability({ rootDir, wxid });
    return { status: 200, body: r };
  },
};
