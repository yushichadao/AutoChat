import { loadConfig } from '../core/config.js';
import { ROOT } from '../core/paths.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PauseState } from '../core/pause.js';
import { detectWeChat, isPortOpen } from '../bridge/process.js';
import { resolveProfile } from '../bridge/profiles.js';
import { HookClient } from '../bridge/hook-client.js';
import { buildPollPlan } from '../bridge/poll-sql.js';
import { normalizeDbRow } from '../protocol/normalize.js';
import { checkEnvironment } from './install.js';
import { listModels, explainError } from '../ai/probe.js';
import { EFFORT_LEVELS, EFFORT_LABELS, REASONING_FORMATS, explainReasoning } from '../core/reasoning.js';

/**
 * 体检：把「为什么助手不理我」拆成几个能回答的问题。
 *
 * 最容易踩的一条是账号：
 * 电脑微信必须扫码登录，所以电脑上登录的号 == 手机上的号。
 * 如果你就用这个号在群里提问，那「提问的人」和「助手所在的账号」是同一个，
 * 自问自答防护会把你的话全当噪音丢掉 —— 表现就是「助手装死」。
 *
 * 正解是用小号：手机用主号，电脑登录另一个号（专门跑助手），
 * 这样主号在群里说话、助手用另一个号回应，两者 wxid 不同，判定才成立。
 */

export const ok = (name, detail = '') => ({ level: 'ok', name, detail });
export const warn = (name, detail = '') => ({ level: 'warn', name, detail });
export const bad = (name, detail = '') => ({ level: 'bad', name, detail });

/**
 * 微信安装目录里的 version.dll 是否就是配置的那份。
 *
 * 微信启动时只加载安装目录下的 version.dll；WX_DLL_PATH 只是「从哪拷」。
 * 两者不一致时跑的是旧 DLL，症状是 hook 能 ping 通、但 IsLogin=0、
 * 所有 QueryDB 都报 “get database handle ... failed”。
 */
export function checkDeployedDll(cfg, wechatDir) {
  const configured = cfg.wechat.dllPath;
  const dir = wechatDir || cfg.wechat.installDir;
  if (!configured || !dir) return null;
  const target = path.join(dir, 'version.dll');
  if (!fs.existsSync(target)) {
    return warn('hook DLL 部署', '微信目录里还没有 version.dll —— 点「写入微信目录」后再启动微信');
  }
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return null;
  }
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  let same = false;
  try {
    same = fs.existsSync(configured) && hash(target) === hash(configured);
  } catch {
    same = false;
  }
  if (!same) {
    return bad(
      'hook DLL 部署',
      `微信目录里是另一份 DLL（${(st.size / 1048576).toFixed(1)} MB），与配置的 ${path.basename(configured)} 不一致 —— ` +
        '微信加载的是旧那份，表现就是 hook 能 ping 通但读不到登录态和数据库'
    );
  }
  return ok('hook DLL 部署', `${target}（与配置一致）`);
}

/**
 * 实际生效的监听会话 = WX_POLL_CHATS ∪ 「按会话配置」里启用的会话（**并集**）。
 *
 * 为什么必须是并集、而不是「WX_POLL_CHATS 非空就只用它」：
 * 界面里加入新群写的是 config.json 的 chats；只要 WX_POLL_CHATS 里已经有别的群，
 * 旧逻辑就会把新群整个忽略 —— 表现正是「群里 @ 它、它就是不回，日志也干干净净」。
 * 只加不减：用户在 .env 里手填的会话不会被删。
 *
 * 边界（红线，不要改）：这里的输入**只能**来自用户显式配置的两处
 * （.env 的 WX_POLL_CHATS、config.json 的 chats）。
 * 严禁为了「省事」加上自动发现 —— 扫描本地库里的群表、把通讯录 / 会话列表里的
 * 群自动纳入监听，等于在没有授权的情况下替用户决定「AI 可以在哪些群说话」。
 * 未经本人明确授权的群，一律不监听、不读取、不回复。
 */
/**
 * 监听会话清单 = WX_POLL_CHATS ∪ 已启用的 config.json 会话（并集）。
 * @param {object} cfg 配置
 * @param {string} [currentWxid] 当前登录微信号。若提供，则仅保留「无 account 或 account===currentWxid」的会话，
 *   旧号专属群（带 account 且与当前号不一致）被排除，避免换号后误监听/误回复（跨库信息泄露）。
 */
export function effectivePollChats(cfg, currentWxid) {
  const fromEnv = Array.isArray(cfg?.wechat?.pollChats) ? cfg.wechat.pollChats : [];
  const fromJson = Object.keys(cfg?.chats || {}).filter((id) => {
    const c = cfg.chats[id] || {};
    if (c.enabled === false) return false;
    if (currentWxid && c.account && c.account !== currentWxid) return false;
    return true;
  });
  const out = [];
  for (const id of [...fromEnv, ...fromJson]) {
    const s = String(id || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 检查监听会话里的消息是不是全都来自本机账号（小号方案的判据）。 */
export async function checkAccountSeparation({ cfg, hook, limit = 20 } = {}) {
  const chats = effectivePollChats(cfg, cfg.wechat.selfId);
  if (!chats.length) return ok('小号检查', '还没加入任何会话，加入后会自动检查');

  const selfId = cfg.wechat.selfId;
  if (!selfId) return bad('小号检查', '未配置 WX_SELF_ID，无法判断消息来源');

  const plan = buildPollPlan(chats, { limit, dbBase: cfg.wechat.pollDb });
  const senders = new Map();
  for (const p of plan) {
    let rows = null;
    for (const db of [p.db, 'message_0.db']) {
      try {
        const res = await hook.queryDb(p.sql, db);
        const arr = Array.isArray(res?.data) ? res.data : null;
        if (arr) {
          rows = arr;
          break;
        }
      } catch {
        /* 换下一个库 */
      }
    }
    if (!rows) continue;
    for (const row of rows) {
      const msg = normalizeDbRow(row, { selfId, selfMode: 'id' });
      if (!msg || !msg.senderId) continue;
      senders.set(msg.senderId, (senders.get(msg.senderId) || 0) + 1);
    }
  }

  const others = [...senders.entries()].filter(([id]) => id !== selfId);
  if (!others.length) {
    return warn(
      '小号检查',
      `最近的发言全部来自本机账号 ${selfId} —— 群里的提问者就是你本人，` +
        'AutoChat 分不清「你发的」和「它发的」。建议用小号方案：手机用主号，电脑登录另一个号专门跑 AutoChat'
    );
  }
  return ok(
    '小号检查',
    `群里有其他账号发言（${others.map(([id, n]) => `${id}×${n}`).join('、')}）`
  );
}

/**
 * 轮询能不能拿到消息、表在不在。
 * @param {{canRecvPush?: boolean}} canRecvPush 当前 DLL 是否支持主动回调；
 *   false 时「没配轮询」不是无所谓，而是**收不到任何消息**，必须按 bad 报。
 */
export async function checkPoll({ cfg, hook, canRecvPush } = {}) {
  const listenChats = effectivePollChats(cfg, cfg.wechat.selfId);
  if (!listenChats.length && !cfg.wechat.pollSql) {
    if (canRecvPush === false) {
      return {
        level: 'bad',
        name: '收消息',
        detail: '当前 hook DLL 不支持消息回调，又没配置 WX_POLL_CHATS —— 会一条消息都收不到',
        next: '去「按会话配置」加入要监听的群 / 好友（自动写入 WX_POLL_CHATS）',
      };
    }
    if (canRecvPush === true) return ok('收消息', '由 hook DLL 主动回调，无需轮询');
    return warn('收消息', '既没有 WX_POLL_CHATS 也没有 WX_POLL_SQL —— 只有支持回调的 DLL 才收得到消息');
  }
  if (!listenChats.length) return ok('收消息', '使用手写 WX_POLL_SQL');

  const plan = buildPollPlan(listenChats, { limit: 3, dbBase: cfg.wechat.pollDb });
  const out = [];
  for (const p of plan) {
    let hit = null;
    for (const db of [p.db, 'message_0.db']) {
      try {
        const res = await hook.queryDb(p.sql, db);
        const arr = Array.isArray(res?.data) ? res.data : null;
        if (arr) {
          hit = { db, count: arr.length };
          break;
        }
      } catch {
        /* 换下一个 */
      }
    }
    out.push(
      hit
        ? ok(`会话 ${p.chatId}`, `表 ${p.table} @ ${hit.db}，取到 ${hit.count} 行`)
        : bad(`会话 ${p.chatId}`, `找不到表 ${p.table}`)
    );
  }
  return out;
}

/**
 * 模型能不能连上。
 *
 * 只拉模型列表（GET /models），不发聊天请求 —— 不花钱、不占额度，几毫秒就出结果。
 * 拉不到就用人话告诉他问题出在哪、下一步干什么。
 */
export async function checkModel({ cfg } = {}) {
  const base = cfg.ai.baseUrl;
  if (!base) {
    return bad('模型连接', '还没填接口地址 —— 跑 autochat setup 一步步选一下就好');
  }
  const r = await listModels({ baseUrl: base, apiKey: cfg.ai.apiKey, timeoutMs: 6000 });
  if (!r.ok) {
    const ex = explainError(new Error(r.error), { baseUrl: base });
    return bad('模型连接', `${ex.title}：${ex.detail}`);
  }
  if (!r.models.length) {
    return warn('模型连接', `连上了 ${base}，但它没返回模型列表（地址可能不是 /v1 根目录）`);
  }
  if (cfg.ai.model && !r.models.includes(cfg.ai.model)) {
    return warn(
      '模型连接',
      `连上了，但这个服务上没有「${cfg.ai.model}」这个模型名。可用：${r.models.slice(0, 5).join('、')}`
    );
  }
  return ok('模型连接', `${base} 可用，模型 ${cfg.ai.model} 在（这台服务共有 ${r.models.length} 个模型）`);
}

/** 一次跑完所有体检项。 */
export async function diagnose({ rootDir = ROOT, scope = 'infra' } = {}) {
  // 群可用性单独成项（见 checkChatAvailability / HI4）：diagnose 默认只做环境 / 基础设施体检。
  if (scope === 'chats') return checkChatAvailability({ rootDir });

  const cfg = loadConfig({ rootDir });
  const items = [];

  for (const c of await checkEnvironment({ rootDir })) {
    items.push(c.ok ? ok(c.name, c.detail) : bad(c.name, c.detail));
  }

  // hook DLL 与微信版本是否匹配：版本一变，偏移就失效
  const detected = await detectWeChat(cfg.wechat.installDir).catch(() => null);
  // 微信目录里实际加载的 DLL 是否就是配置的那份
  const dllItem = checkDeployedDll(cfg, detected && detected.dir);
  if (dllItem) items.push(dllItem);
  // 当前版本对应的 DLL 方案能不能主动回调 —— 决定「没配轮询」是正常还是致命
  const profile = detected && detected.version ? resolveProfile(detected.version).profile : null;
  if (detected && detected.version && cfg.wechat.dllPath) {
    const p = resolveProfile(detected.version);
    const level = p.level === 'exact' ? p.level : p.level === 'major' ? 'warn' : 'bad';
    items.push(
      level === 'exact'
        ? ok('DLL 与微信版本', detected.version + ' 精确匹配')
        : level === 'warn'
          ? warn('DLL 与微信版本', detected.version + ' 只是近似匹配，可能偏移失效')
          : bad('DLL 与微信版本', detected.version + ' 没有已知方案，DLL 多半不兼容')
    );
  }

  // 端口占用：30001 被别的程序占了，hook 连不上
  for (const port of [cfg.wechat.port, cfg.wechat.webhookPort]) {
    if (!(await isPortOpen(cfg.wechat.host, port))) continue;
    items.push(ok('端口 ' + port, '已被占用（可能是助手服务或 hook 在用）'));
  }

  // 项目路径含空格 / 中文：PowerShell 拼接容易出问题
  if (/[\s\u4e00-\u9fa5]/.test(rootDir)) {
    items.push(warn('项目路径', '含空格或中文，少数命令可能需要加引号'));
  }
  if (/同步|OneDrive|Dropbox/i.test(rootDir)) {
    items.push(warn('项目路径', '看起来在同步盘里，data/ 可能被同步锁住'));
  }

  items.push(
    cfg.ai.enabled
      ? ok('AI', `已启用，模型 ${cfg.ai.model}，地址 ${cfg.ai.baseUrl || '(未填)'}`)
      : warn('AI', '未启用（AI_ENABLED=0），只收消息不回复')
  );
  items.push(await checkModel({ cfg }));
  items.push(
    cfg.ai.enabled
      ? ok('自动回复开关', '已启用（AI_ENABLED=1）· 关掉只收消息，需重启生效')
      : bad('自动回复开关', '没启用（AI_ENABLED=0）· 不会回复任何消息')
  );

  // 思考强度：写错了要明确报出来（写错时值会退回 off，不提示的话用户以为开了其实没开）
  const rx = explainReasoning({
    effort: cfg.ai.reasoningEffort,
    format: cfg.ai.reasoningFormat,
    budget: cfg.ai.reasoningBudget,
    model: cfg.ai.model,
    baseUrl: cfg.ai.baseUrl,
  });
  if (cfg.ai.reasoningEffortRaw && !EFFORT_LEVELS.includes(String(cfg.ai.reasoningEffortRaw).toLowerCase())) {
    items.push(
      bad('思考强度', `AI_REASONING_EFFORT=${cfg.ai.reasoningEffortRaw} 认不出来 · 只能是 off/low/medium/high（autochat effort high）`)
    );
  } else if (cfg.ai.reasoningFormatRaw && !REASONING_FORMATS.includes(String(cfg.ai.reasoningFormatRaw).toLowerCase())) {
    items.push(
      bad('思考格式', `AI_REASONING_FORMAT=${cfg.ai.reasoningFormatRaw} 认不出来 · 用 auto 让它按模型名自动判断最省事`)
    );
  } else {
    items.push(
      ok(
        '思考强度',
        rx.effort === 'off'
          ? '关闭（不额外花 token）· autochat effort high 可调成 低/中/高'
          : `${EFFORT_LABELS[rx.effort]}（${rx.effort}）· ${rx.formatLabel} · 将发送 ${rx.describe || '（空）'}`
      )
    );
  }

  const pauseState = new PauseState({ file: path.join(cfg.dataDir, 'paused') });
  items.push(
    pauseState.isPaused()
      ? warn('暂停状态', '已暂停自动回复（仍接收消息、仍记日志）· autochat resume 恢复')
      : ok('暂停状态', '运行中 · autochat pause 可随时拉下')
  );

  if (cfg.ai.deprecatedMasterSwitch) {
    items.push(warn('旧配置项', 'AI_MASTER_SWITCH 已废弃（2.0.0 起请用 AI_ENABLED）'));
  }
  items.push(
    cfg.wechat.selfMode === 'id'
      ? warn(
          '自消息判定',
          '当前是 id 模式（按 AutoChat 发过的消息 id 精确过滤）—— 电脑号与手机号同号时必须这样'
        )
      : ok('自消息判定', 'sender 模式（按 wxid 过滤），适合小号方案')
  );

  // 基础设施连通性：hook 服务是否可达（只报「连不连得上」，不报「哪些群能收到」）
  const hook = new HookClient({
    host: cfg.wechat.host,
    port: cfg.wechat.port,
    endpoints: cfg.wechat.endpoints,
    dbName: cfg.wechat.pollDb,
  });
  const ping = await hook.ping();
  items.push(
    ping.ok ? ok('hook 服务', `${cfg.wechat.host}:${cfg.wechat.port} 可用`) : bad('hook 服务', `连不上 ${cfg.wechat.host}:${cfg.wechat.port}`)
  );

  return { cfg, items, ok: items.every((i) => i.level !== 'bad') };
}

/**
 * 群可用性体检（HI5 / HI6 / HI7）：逐群报「表可达 / 找不到表 / 未启用」，
 * 与 `diagnose`（环境 / 基础设施）并列，不混进主体检列表。
 *
 * 红线：输入**只**来自 effectivePollChats（WX_POLL_CHATS ∪ 已启用的 chats），
 * 绝不自动发现群 / 扫库 —— 未经本人明确授权的会话一律不监听、不读取、不回复。
 */
export async function checkChatAvailability({ rootDir = ROOT } = {}) {
  const cfg = loadConfig({ rootDir });
  const items = [];
  const hook = new HookClient({
    host: cfg.wechat.host,
    port: cfg.wechat.port,
    endpoints: cfg.wechat.endpoints,
    dbName: cfg.wechat.pollDb,
  });

  const ping = await hook.ping();
  items.push(
    ping.ok ? ok('hook 服务', `${cfg.wechat.host}:${cfg.wechat.port} 可用`) : bad('hook 服务', `连不上 ${cfg.wechat.host}:${cfg.wechat.port}`)
  );
  if (!ping.ok) return { cfg, items, ok: false };

  const login = await hook.confirmLogin(3000).catch(() => null);
  if (login === false) {
    items.push({
      level: 'bad',
      name: '微信登录',
      detail: 'hook 已连上，但微信还没登录（读不到本机账号）—— 读不到通讯录和消息',
      next: '先在微信里完成登录，再回来点「刷新」；登录前搜索联系人一定搜不到',
    });
    return { cfg, items, ok: false };
  }

  const detected = await detectWeChat(cfg.wechat.installDir).catch(() => null);
  const profile = detected && detected.version ? resolveProfile(detected.version).profile : null;
  const poll = await checkPoll({ cfg, hook, canRecvPush: profile ? profile.recv : undefined });
  items.push(...(Array.isArray(poll) ? poll : [poll]));
  items.push(await checkAccountSeparation({ cfg, hook }));

  return { cfg, items, ok: items.every((i) => i.level !== 'bad') };
}
