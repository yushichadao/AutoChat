import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIReply } from '../src/ai/replier.js';
import { AIClient } from '../src/ai/client.js';
import { writeDocx } from '../src/ai/tools/office.js';

/**
 * 端到端管线测试：真实消息对象 → 完整 handle 链路 → 假 hook 记录实际发出去的消息。
 *
 * 这是「真机验证清单」里能自动化的部分（不含微信驱动本身）：
 * 附件解读、长任务两条消息、工具生成文档走文件消息、双模型路由落点，
 * 全部跑真实的 handle 流程，而不是只测某个函数。
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-e2e-'));
const silence = { info() {}, warn() {}, debug() {}, error() {} };

function cfg(over = {}) {
  return {
    enabled: true,
    model: 'main-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k',
    contextTurns: 8, contextTtlMs: 0, contextMaxChars: 6000,
    cooldownMs: 0, maxPerHour: 0, maxConcurrent: 2,
    groupReply: 'always', privateRequirePrefix: false, triggerPrefix: '',
    maxReplyChars: 900, stripMarkdown: true, replyMode: 'single',
    webSearch: false, aiTools: false, modelRouting: false, longTaskNotice: false,
    docAnalysis: false, docMaxChars: 12000,
    ...over,
  };
}

/** 假 OpenAI 服务：handler(body, callIndex) 决定这次返回什么（可返回 tool_calls）。 */
function startFakeAI(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handler(body, calls.length)));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, calls })));
}

const chatResp = (content) => ({ model: 'm', choices: [{ message: { role: 'assistant', content } }] });

function makeReply({ fake, hook, cfgOver = {}, chatId = 'g@chatroom' }) {
  const client = new AIClient({ baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'k', model: 'main-model', timeoutMs: 5000, logger: silence });
  return new AIReply({
    cfg: cfg({ ...cfgOver, baseUrl: `http://127.0.0.1:${fake.port}/v1` }),
    ai: client,
    memory: { history: () => [], push: () => {} },
    hook,
    logger: silence,
    selfWxid: 'me',
  });
}

// ── ① 入站附件：先发「正在解析文件……」，再发解读；文档内容确实进了 prompt ──

test('e2e① 文档解读：附件文本进 prompt，且先提示后结果（两条消息）', async () => {
  const dir = tmp();
  const doc = path.join(dir, 'report.docx');
  writeDocx(doc, { title: '季度报告', paragraphs: ['关键结论：季度预算 120 万'] });

  const fake = await startFakeAI(() => chatResp('总结：预算 120 万'));
  const sent = [];
  const air = makeReply({
    fake,
    hook: { sendText: async (to, t) => { sent.push(t); return { ok: true }; } },
    cfgOver: { docAnalysis: true, longTaskNotice: true },
  });
  try {
    const out = await air.handle({
      chatId: 'g@chatroom', chatType: 'group', senderId: 'wxid_other', senderName: '朋友',
      kind: 'text', text: '帮我总结这份文档', files: [doc],
    });
    assert.equal(out, '总结：预算 120 万');
    assert.equal(sent.length, 2, '长任务应发两条：提示 + 结果');
    assert.equal(sent[0], '正在解析文件……');
    assert.equal(sent[1], '总结：预算 120 万');
    // 文档内容必须真的进了模型请求
    const msgs = fake.calls[0].body.messages;
    const blob = JSON.stringify(msgs);
    assert.match(blob, /季度预算 120 万/, '模型应看到附件内容');
  } finally {
    fake.server.close();
  }
});

// ── ② 关闭长任务提示时只发一条 ────────────────────────────────────────

test('e2e② 关掉长任务提示：只发结果一条消息', async () => {
  const dir = tmp();
  const doc = path.join(dir, 'a.docx');
  writeDocx(doc, { paragraphs: ['内容'] });
  const fake = await startFakeAI(() => chatResp('好的'));
  const sent = [];
  const air = makeReply({
    fake,
    hook: { sendText: async (to, t) => { sent.push(t); return { ok: true }; } },
    cfgOver: { docAnalysis: true, longTaskNotice: false },
  });
  try {
    await air.handle({ chatId: 'g@chatroom', chatType: 'group', senderId: 'wxid_other', kind: 'text', text: '看看', files: [doc] });
    assert.equal(sent.length, 1, '关掉提示就只该有一条');
    assert.equal(sent[0], '好的');
  } finally {
    fake.server.close();
  }
});

// ── ③ 工具生成文档 → 以「文件消息」发出 ────────────────────────────────

test('e2e③ write_doc：生成的文档走 sendFile 作为文件消息发送', async () => {
  const dir = tmp();
  const fake = await startFakeAI((body, n) => {
    if (n === 1) {
      return {
        model: 'm',
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'write_doc', arguments: JSON.stringify({ filename: '报告.docx', format: 'docx', paragraphs: ['第一段', '第二段'] }) } },
        ] } }],
      };
    }
    // 第二轮：把工具返回的路径以 [[file:]] 标记写进回复
    const toolMsg = [...body.messages].reverse().find((m) => m.role === 'tool');
    const res = JSON.parse(toolMsg.content);
    return chatResp(`报告已生成：[[file:${res.path}]]`);
  });
  const sent = { text: [], file: [] };
  const air = makeReply({
    fake,
    hook: {
      sendText: async (to, t) => { sent.text.push(t); return { ok: true }; },
      sendFile: async (to, f) => { sent.file.push(f); return { ok: true }; },
    },
    cfgOver: { aiTools: true, aiToolsAllow: ['write_doc'], docOutDir: dir, longTaskNotice: true },
  });
  try {
    const out = await air.handle({ chatId: 'g@chatroom', chatType: 'group', senderId: 'wxid_other', kind: 'text', text: '生成一份报告发我' });
    assert.ok(out, '应产出回复');
    assert.equal(sent.file.length, 1, '应作为文件消息发出');
    assert.ok(fs.existsSync(sent.file[0]), '发出去的文件必须真实存在');
    assert.match(sent.file[0], /报告\.docx$/);
    assert.equal(sent.text[0], '正在处理……', '工具调用属长任务，先发提示');
  } finally {
    fake.server.close();
  }
});

// ── ④ 双模型路由：简单走轻量、复杂走主模型（各自独立的假服务）─────────

test('e2e④ 双模型路由：闲聊落轻量模型，复杂任务落主模型', async () => {
  const main = await startFakeAI(() => chatResp('主模型答复'));
  const light = await startFakeAI(() => chatResp('轻量模型答复'));

  const air = new AIReply({
    cfg: cfg({
      modelRouting: true,
      lightModel: 'light-1',
      lightBaseUrl: `http://127.0.0.1:${light.port}/v1`,
      baseUrl: `http://127.0.0.1:${main.port}/v1`,
    }),
    ai: new AIClient({ baseUrl: `http://127.0.0.1:${main.port}/v1`, apiKey: 'k', model: 'main-model', timeoutMs: 5000, logger: silence }),
    memory: { history: () => [], push: () => {} },
    hook: { sendText: async () => ({ ok: true }) },
    logger: silence,
    selfWxid: 'me',
  });
  try {
    await air.handle({ chatId: 'g@chatroom', chatType: 'group', senderId: 'wxid_o', kind: 'text', text: '你好' });
    assert.equal(light.calls.length, 1, '闲聊应走轻量模型');
    assert.equal(main.calls.length, 0);

    await air.handle({ chatId: 'g@chatroom', chatType: 'group', senderId: 'wxid_o', kind: 'text', text: '帮我分析这个方案并总结' });
    assert.equal(main.calls.length, 1, '复杂任务应升级主模型');
    assert.equal(light.calls.length, 1, '轻量模型不应被复杂任务调用');
  } finally {
    main.server.close();
    light.server.close();
  }
});
