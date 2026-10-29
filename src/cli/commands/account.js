import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { loadActiveAccount, saveActiveAccount } from '../../core/account-profile.js';
import { probeAccount } from '../../tasks/doctor.js';
import { line, json } from '../ui.js';

/**
 * autochat account —— 查看 / 指定「当前账号」覆盖。
 * 用途：hook 自动探测偶发拿不到 wxid 时，手动把当前号钉死，保证 GUI 与助手都认准这一个号。
 */
export async function run(ctx) {
  const sub = (ctx.positional[0] || 'status').toLowerCase();
  const cfg = loadConfig({ rootDir: ROOT });

  if (sub === 'set') {
    const wxid = ctx.positional[1];
    if (!wxid) {
      line('bad', '用法：autochat account set <wxid> [昵称]');
      return;
    }
    const nickname = ctx.positional[2] || '';
    saveActiveAccount(cfg.dataDir, wxid, nickname);
    line('ok', '已把当前账号覆盖设为', wxid + (nickname ? '（' + nickname + '）' : ''));
    line('hint', 'GUI 与助手下次读取即生效；想回落到自动探测用 autochat account clear');
    return;
  }

  if (sub === 'clear') {
    saveActiveAccount(cfg.dataDir, '', '');
    line('ok', '已清除账号覆盖，回落到 hook 自动探测');
    return;
  }

  if (sub === 'list') {
    const live = await probeAccount(ROOT).catch(() => null);
    const active = loadActiveAccount(cfg.dataDir);
    json({
      active: active.wxid ? active : null,
      live: live || null,
    });
    line('ok', '当前覆盖：', active.wxid || '（无，自动探测）', active.nickname ? '· ' + active.nickname : '');
    line('hint', '实时探测：', live && live.wxid ? live.wxid : '（探测不到）', live && live.source ? '· ' + live.source : '');
    return;
  }

  if (sub === 'migrate') {
    // 把旧的全局 config.json.chats（按会话配置）迁到某个账号的独立目录，
    // 让旧号保留配置、又不污染新号的隔离空间。目标 wxid 必须显式给出。
    const wxid = ctx.positional[1];
    if (!wxid) {
      line('bad', '用法：autochat account migrate <旧号wxid> [昵称]');
      return;
    }
    const nickname = ctx.positional[2] || '';
    const cfgPath = path.join(ROOT, 'config.json');
    let raw = {};
    if (fs.existsSync(cfgPath)) {
      try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { raw = {}; }
    }
    if (!raw || typeof raw !== 'object') raw = {};
    const oldChats = (raw.chats && typeof raw.chats === 'object') ? raw.chats : {};
    const targetDir = path.join(cfg.dataDir, 'accounts', wxid);
    fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, 'chats.json');
    let merged = {};
    if (fs.existsSync(targetFile)) {
      try { merged = JSON.parse(fs.readFileSync(targetFile, 'utf8')); } catch { merged = {}; }
    }
    if (!merged || typeof merged !== 'object' || Array.isArray(merged)) merged = {};
    // 旧全局 chats 的字段（groupReply / replyMode / ...）合并进目标；已存在的会话不覆盖
    let moved = 0;
    for (const [id, v] of Object.entries(oldChats)) {
      if (!merged[id]) { merged[id] = v; moved++; }
    }
    fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2));
    // 迁移完成后清空全局 chats，避免两份并存导致混乱
    if (raw.chats) {
      delete raw.chats;
      fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
    }
    line('ok', '已将 config.json 里 ' + Object.keys(oldChats).length + ' 个会话配置迁移到 data/accounts/' + wxid + '/chats.json（新增 ' + moved + ' 个）');
    line('hint', '旧号（' + wxid + '）重新登录并被探测到时自动认领这份配置；新号保持隔离、不受影响');
    if (nickname) saveActiveAccount(cfg.dataDir, wxid, nickname);
    return;
  }

  line('bad', '用法：autochat account <set|clear|list|migrate>');
}
