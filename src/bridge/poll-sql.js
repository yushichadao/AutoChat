import crypto from 'node:crypto';

/**
 * 按会话生成「读本地消息库」的 SQL。
 *
 * 微信把每个会话的消息存在一张分表里，表名 = Msg_ + md5(会话id)，
 * 所以要知道群 wxid 才能算出表名（群是 xxx@chatroom，好友是 wxid_xxx）。
 *
 * 一次只能查一张表，所以每个会话一条 SQL，轮询时逐条执行。
 */

export function chatTable(chatId) {
  return 'Msg_' + crypto.createHash('md5').update(String(chatId), 'utf8').digest('hex');
}

/**
 * 会话表所在的库。
 *
 * 微信可能把消息分到 message_0.db / message_1.db …，
 * 但具体分法各版本不一致（有的按会话哈希、有的按时间轮转），
 * 猜错就直接查不到表。所以这里不做猜测，返回基础库名，
 * 由调用方在「表不存在」时逐个库回退（见 receiver 的 fallbackDb）。
 */
export function chatDb(chatId, base = 'message_0.db') {
  return base;
}

/** 可能的候选库，用于表不存在时回退。 */
export function candidateDbs(base = 'message_0.db', count = 8) {
  const m = /^message_(\d+)\.db$/i.exec(base);
  if (!m) return [base];
  const start = Number(m[1]) || 0;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(`message_${start + i}.db`);
  return out;
}

const escape = (s) => String(s).replace(/'/g, "''");

/**
 * 轻量批次：只取 local_id（主键）。
 *
 * 重要背景（微信 hook /QueryDB/execute 的坑）：
 * 当结果集里「任一行的 message_content 无法被序列化」时，hook 会把整条查询
 * 返回空（status=0、data=[]，不报错）。而「SELECT message_content + WHERE
 * local_type=1」会命中全群文本消息，只要有一条坏内容（某些 BLOB / zstd）整批
 * 就落空，机器人从而永远收不到消息 → 表现为「AI 无反应」。
 * 因此批次只取主键，正文用 buildRowSql 逐条按 local_id 取。
 */
export function buildPollSql(chatId, limit = 30) {
  const table = chatTable(chatId);
  const lim = Number(limit) || 30;
  return `SELECT local_id FROM ${table} WHERE local_type = 1 ORDER BY local_id DESC LIMIT ${lim}`;
}

/**
 * 单行明细：逐条按 local_id 取完整一行（含 message_content / 发送者）。
 * 单行查询在 hook 下稳定；即便某条内容损坏，也只有那一条失败，不会拖垮整批。
 * 发送者 wxid 用 resolveSenders 单独解析（见 receiver.js），这里只带回 real_sender_id。
 */
export function buildRowSql(chatId, localId) {
  const table = chatTable(chatId);
  const id = Number(localId);
  if (!Number.isFinite(id)) return null;
  return (
    `SELECT local_id AS msgid,` +
    ` real_sender_id AS rid,` +
    ` create_time AS createTime,` +
    ` message_content AS content` +
    ` FROM ${table} WHERE local_id = ${id}`
  );
}

/**
 * 一次性生成多个会话的轮询 SQL。
 * @returns {{chatId:string, db:string, sql:string}[]}
 */
export function buildPollPlan(chatIds, { limit = 30, dbBase = 'message_0.db' } = {}) {
  const out = [];
  for (const id of chatIds) {
    const chatId = String(id || '').trim();
    if (!chatId) continue;
    const db = chatDb(chatId, dbBase);
    out.push({ chatId, db, table: chatTable(chatId), limit, sql: buildPollSql(chatId, limit) });
  }
  return out;
}
