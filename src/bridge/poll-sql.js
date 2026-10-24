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
 * 轮询某个会话的新消息。
 *
 * · 只取文本消息（local_type = 1），图片/语音等交给别的通道
 * · JOIN Name2Id 把 real_sender_id 换成真实 wxid（群里每个人一个 rowid）
 * · ORDER BY local_id DESC 取最近若干条，增量靠调用方的水位判断
 */
export function buildPollSql(chatId, { limit = 30, db = '' } = {}) {
  const table = chatTable(chatId);
  const room = /@chatroom$/i.test(chatId) ? escape(chatId) : '';
  return (
    `SELECT m.local_id AS msgid,` +
    ` COALESCE(n.user_name, '') AS wxid,` +
    ` m.message_content AS content,` +
    ` m.create_time AS createTime,` +
    ` '${room}' AS roomid` +
    ` FROM ${table} m` +
    ` LEFT JOIN Name2Id n ON n.rowid = m.real_sender_id` +
    ` WHERE m.local_type = 1` +
    ` ORDER BY m.local_id DESC LIMIT ${Number(limit) || 30}`
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
    out.push({ chatId, db, table: chatTable(chatId), sql: buildPollSql(chatId, { limit, db }) });
  }
  return out;
}
