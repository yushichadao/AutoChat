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
import { buildPollPlan } from '../src/bridge/poll-sql.js';
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

  let rows = null;
  for (const db of [p.db, ...Array.from({ length: 8 }, (_, i) => `message_${i}.db`)].filter(
    (d, i, a) => a.indexOf(d) === i
  )) {
    try {
      const res = await hook.queryDb(p.sql, db);
      const arr = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null;
      if (arr) {
        rows = arr;
        console.log(`   库 ${db} 命中 ${arr.length} 行`);
        break;
      }
    } catch (err) {
      console.log(`   库 ${db} 查询失败: ${err.message}`);
    }
  }

  if (!rows) {
    console.log('   ✗ 所有库都查不到这张表 —— 会话 id 是否正确？该会话在这台电脑上登录过吗？');
    bad += 1;
    continue;
  }
  if (!rows.length) {
    console.log('   · 表在，但没有文本消息');
    continue;
  }

  for (const row of rows.slice(0, limit)) {
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
  const rawContent = raw?.content ?? raw?.message_content ?? '';
  if (typeof rawContent === 'string' && /^[0-9a-f]+$/i.test(rawContent.trim())) {
    console.log(`   提示: 库里 content 是十六进制，解码后 = ${JSON.stringify(decodeDbContent(rawContent).slice(0, 60))}`);
  }
  console.log('');
}

process.exit(bad ? 1 : 0);
