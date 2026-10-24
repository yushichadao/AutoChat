import { loadConfig, ROOT } from '../config.js';
import { HookClient } from '../bridge/hook-client.js';
import { buildPollPlan } from '../bridge/poll-sql.js';
import { normalizeDbRow } from '../protocol/normalize.js';
import { checkEnvironment } from './installer.js';
import { listModels, explainError } from '../ai/probe.js';

/**
 * 体检：把「为什么机器人不理我」拆成几个能回答的问题。
 *
 * 最容易踩的一条是账号：
 * 电脑微信必须扫码登录，所以电脑上登录的号 == 手机上的号。
 * 如果你就用这个号在群里提问，那「提问的人」和「机器人所在的账号」是同一个，
 * 自问自答防护会把你的话全当噪音丢掉 —— 表现就是「机器人装死」。
 *
 * 正解是双账号：手机用主号，电脑登录另一个号（专门跑机器人），
 * 这样主号在群里说话、机器人用另一个号回应，两者 wxid 不同，判定才成立。
 */

export const ok = (name, detail = '') => ({ level: 'ok', name, detail });
export const warn = (name, detail = '') => ({ level: 'warn', name, detail });
export const bad = (name, detail = '') => ({ level: 'bad', name, detail });

/** 检查监听会话里的消息是不是全都来自本机账号（双账号方案的判据）。 */
export async function checkAccountSeparation({ cfg, hook, limit = 20 } = {}) {
  const chats = cfg.wechat.pollChats;
  if (!chats.length) return warn('双账号检查', '没有配置 WX_POLL_CHATS，跳过');

  const selfId = cfg.wechat.selfId;
  if (!selfId) return bad('双账号检查', '未配置 WX_SELF_ID，无法判断消息来源');

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
      '双账号检查',
      `最近的发言全部来自本机账号 ${selfId} —— 群里的提问者就是你本人，` +
        '机器人分不清「你发的」和「它发的」。建议按双账号方案：手机用主号，电脑登录另一个号专门跑机器人'
    );
  }
  return ok(
    '双账号检查',
    `群里有其他账号发言（${others.map(([id, n]) => `${id}×${n}`).join('、')}）`
  );
}

/** 轮询能不能拿到消息、表在不在。 */
export async function checkPoll({ cfg, hook } = {}) {
  if (!cfg.wechat.pollChats.length && !cfg.wechat.pollSql) {
    return warn('收消息', '既没有 WX_POLL_CHATS 也没有 WX_POLL_SQL，只能靠 DLL 回调');
  }
  if (!cfg.wechat.pollChats.length) return ok('收消息', '使用手写 WX_POLL_SQL');

  const plan = buildPollPlan(cfg.wechat.pollChats, { limit: 3, dbBase: cfg.wechat.pollDb });
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
export async function diagnose({ rootDir = ROOT } = {}) {
  const cfg = loadConfig({ rootDir });
  const items = [];

  for (const c of await checkEnvironment({ rootDir })) {
    items.push(c.ok ? ok(c.name, c.detail) : bad(c.name, c.detail));
  }

  items.push(
    cfg.ai.enabled
      ? ok('AI', `已启用，模型 ${cfg.ai.model}，地址 ${cfg.ai.baseUrl || '(未填)'}`)
      : warn('AI', '未启用（AI_ENABLED=0），只收消息不回复')
  );
  items.push(await checkModel({ cfg }));
  items.push(
    cfg.ai.masterSwitch === false
      ? bad('总闸', '配置里 AI_MASTER_SWITCH=0，不会回复任何消息')
      : ok('总闸', '打开（可用 autochat pause 随时拉下）')
  );
  items.push(
    cfg.wechat.selfMode === 'id'
      ? warn(
          '自消息判定',
          '当前是 id 模式（按机器人发过的消息 id 精确过滤）—— 电脑号与手机号同号时必须这样'
        )
      : ok('自消息判定', 'sender 模式（按 wxid 过滤），适合双账号方案')
  );

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

  if (ping.ok) {
    const poll = await checkPoll({ cfg, hook });
    items.push(...(Array.isArray(poll) ? poll : [poll]));
    items.push(await checkAccountSeparation({ cfg, hook }));
  }

  return { cfg, items, ok: items.every((i) => i.level !== 'bad') };
}
