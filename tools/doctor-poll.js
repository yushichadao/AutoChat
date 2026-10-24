#!/usr/bin/env node
/**
 * 轮询链路体检 —— 「为什么群里没反应」的第一站。
 *
 * 干的事和运行时一模一样：按配置生成 SQL → 查本地库 → 归一化成消息对象。
 * 区别只是不回复，只打印，顺便把水位对齐情况也说清楚。
 *
 * 用法：
 *   node tools/doctor-poll.js                # 用 .env 的配置
 *   node tools/doctor-poll.js --chat 123@chatroom --limit 5
 */
import { loadConfig } from '../src/config.js';
import { HookClient } from '../src/bridge/hook-client.js';
import { buildPollPlan, buildPollSql, buildRowSql, candidateDbs } from '../src/bridge/poll-sql.js';
import { normalizeDbRow } from '../src/protocol/normalize.js';
import { decodeDbContent } from '../src/protocol/db-decode.js';

const args = process.argv.slice(2);
const argVal = (name, def = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const cfg = loadConfig();
const chats = argVal('chat')
  ? argVal('chat').split(',').map((s) => s.trim()).filter(Boolean)
  : cfg.wechat.pollChats;
const limit = Number(argVal('limit', '5')) || 5;

if (!chats.length) {
  console.log('没有要检查的会话：.env 里配 WX_POLL_CHATS，或用 --chat 指定');
  process.exit(1);
}

const hook = new HookClient({
  host: cfg.wechat.host,
  port: cfg.wechat.port,
  endpoints: cfg.wechat.endpoints,
});

const plan = buildPollPlan(chats, { limit, dbBase: cfg.wechat.pollDb });
console.log(`hook ${cfg.wechat.host}:${cfg.wechat.port}｜本机 wxid ${cfg.wechat.selfId || '(未配置!)'}`);
console.log('');

let bad = 0;
for (const p of plan) {
  console.log(`── ${p.chatId}  表 ${p.table}  库 ${p.db}`);

  // 1) 轻量批次：只取 local_id（hook 对「多列 + message_content + WHERE」查询会返回空）
  const batch = buildPollSql(p.chatId, 30);
  let ids = null;
  for (const db of candidateDbs(p.db)) {
    try {
      const res = await hook.queryDb(batch, db);
      const arr = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null;
      if (arr) {
        ids = arr;
        console.log(`   库 ${db} 命中 ${arr.length} 条 local_id`);
        break;
      }
    } catch (err) {
      console.log(`   库 ${db} 查询失败: ${err.message}`);
    }
  }

  if (!ids) {
    console.log('   ✗ 所有库都查不到这张表 —— 会话 id 是否正确？该会话在这台电脑上登录过吗？');
    bad += 1;
    continue;
  }

  // 2) 逐条按 local_id 取完整明细（正文 / 发送者）
  const recent = ids
    .map((r) => Number(r.local_id ?? r.msgid))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)
    .slice(0, limit);
  const rows = [];
  for (const id of recent) {
    const rowSql = buildRowSql(p.chatId, id);
    if (!rowSql) continue;
    let hit = null;
    for (const db of candidateDbs(p.db)) {
      try {
        const res = await hook.queryDb(rowSql, db);
        const arr = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null;
        if (arr && arr.length) {
          hit = arr[0];
          break;
        }
      } catch {
        /* 换下一个库 */
      }
    }
    if (hit) {
      hit.roomid = p.chatId; // 与运行时一致：roomid 在 JS 里补，避免 SQL 常量触发 hook 空返回
      rows.push(hit);
    }
  }

  if (!rows.length) {
    console.log('   · 表在，但最近没有可读取的文本消息');
    continue;
  }

  for (const row of rows) {
    const msg = normalizeDbRow(row, { selfId: cfg.wechat.selfId });
    if (!msg) {
      console.log(`   · 归一化失败: ${JSON.stringify(row).slice(0, 120)}`);
      continue;
    }
    const who = msg.senderId === cfg.wechat.selfId ? '（我自己）' : msg.senderId;
    console.log(
      `   #${msg.id} ${msg.chatType} ${who} [${msg.kind}] ${JSON.stringify(
        String(msg.text).slice(0, 60)
      )}`
    );
  }

  const raw = rows[0];
  const rawContent = raw?.content ?? '';
  if (typeof rawContent === 'string' && /^[0-9a-f]+$/i.test(rawContent.trim())) {
    console.log(`   提示: 库里 content 是十六进制，解码后 = ${JSON.stringify(decodeDbContent(rawContent).slice(0, 60))}`);
  }
  console.log('');
}

process.exit(bad ? 1 : 0);
