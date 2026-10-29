import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TriggerPolicy } from '../src/ai/trigger.js';
import { readImageContent, parseOutbound, resolveOutboundMedia, visionSupport } from '../src/ai/vision.js';
import { Responder } from '../src/ai/responder.js';
import { AIReply } from '../src/ai/replier.js';
import { AIClient } from '../src/ai/client.js';

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mm-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('trigger 放行带图消息（IR11）：群聊空文本带图也算触发', () => {
  const t = new TriggerPolicy({ enabled: true, groupReply: 'mention' });
  const r1 = t.decide({ kind: 'image', text: '', images: ['/x.png'], chatId: 'g@chatroom', chatType: 'group' });
  assert.equal(r1.ok, true, '空文本带图应触发');
  const r2 = t.decide({ kind: 'text', text: '', images: [], chatId: 'g@chatroom', chatType: 'group' });
  assert.equal(r2.ok, false, '纯空文本不触发');
  const r3 = t.decide({ kind: 'voice', text: '', images: [], chatId: 'g@chatroom', chatType: 'group' });
  assert.equal(r3.ok, false, '无图的语音不触发');
});

test('readImageContent：读图成 image_url 块，跳过缺失/超大（IR13）', () => {
  const img = tmpFile('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const big = tmpFile('b.png', Buffer.alloc(100));
  // 让 big 超过护栏
  const res = readImageContent([img, '/nope.png', big], { maxBytes: 10 });
  assert.equal(res.blocks.length, 1, '正常图纳入 1 张');
  assert.match(res.blocks[0].image_url.url, /^data:image\/png;base64,/);
  const reasons = res.skipped.map((s) => s.reason);
  assert.ok(reasons.includes('missing'));
  assert.ok(reasons.includes('too-large'));
  // 不限制时两张都纳入
  const res2 = readImageContent([img, big], { maxBytes: 0 });
  assert.equal(res2.blocks.length, 2);
});

test('parseOutbound：拆出图片/文件标记，文本去围栏（IR9/IR10/IR12）', () => {
  const out = parseOutbound('请看图 [[image:data:image/png;base64,AAA]] 和文件 [[file:/tmp/x.pdf]]');
  assert.equal(out.images.length, 1);
  assert.equal(out.files.length, 1);
  assert.equal(out.text, '请看图 和文件', '标记移除后不应残留双空格');
  const onlyText = parseOutbound('普通文本 ```code```');
  assert.equal(onlyText.images.length, 0);
  assert.equal(onlyText.files.length, 0);
  assert.equal(onlyText.text, '普通文本 ```code```');
});

test('resolveOutboundMedia：data URI 写临时文件，路径原样返回', () => {
  const p1 = resolveOutboundMedia('data:image/png;base64,iVBORw0KGgo=', { tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mm2-')) });
  assert.ok(fs.existsSync(p1), 'data URI 解码成临时文件');
  const p2 = resolveOutboundMedia('/tmp/x.png');
  assert.equal(p2, '/tmp/x.png');
  assert.equal(resolveOutboundMedia(''), null);
});

test('Responder.deliver：文本走 sendText，图片标记走 sendImage（IR9/IR10）', async () => {
  const calls = { text: [], image: [], file: [] };
  const hook = {
    sendText: async (to, t) => { calls.text.push(t); return { ok: true }; },
    sendImage: async (to, f) => { calls.image.push(f); return { ok: true }; },
    sendFile: async (to, f) => { calls.file.push(f); return { ok: true }; },
  };
  const r = new Responder({ ai: {}, cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mm3-')) }, hook, logger: { warn() {} } });
  const res = await r.deliver('chat', '看图 [[image:data:image/png;base64,iVBORw0KGgo=]] 结束');
  assert.equal(res.ok, true);
  assert.equal(calls.text.length, 1);
  assert.ok(!calls.text[0].includes('[['), '文本里不应残留图片标记');
  assert.equal(calls.image.length, 1, '走了原生发图');
  // 纯文本 + stripMarkdown
  const r2 = await r.deliver('chat', '**粗体**');
  assert.ok(calls.text.some((t) => t === '粗体'));
});

test('handle：带图消息组装多模态内容块并路由到视觉模型（IR2/IR6）', async () => {
  const orig = AIClient.prototype.chat;
  const calls = [];
  AIClient.prototype.chat = function (messages) {
    calls.push({ model: this.model, last: messages[messages.length - 1] });
    return Promise.resolve({ text: '这是一只猫', usage: null, model: this.model });
  };
  try {
    const img = tmpFile('cat.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ai = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'global-model' });
    const reply = new AIReply({
      cfg: { enabled: true, groupReply: 'mention', visionModel: 'vision-model', maxImageBytes: 8 * 1024 * 1024 },
      ai,
      memory: { history: () => [], push: () => {} },
      hook: { sendText: async () => ({ ok: true }) },
      logger: { warn() {}, info() {}, debug() {} },
      profiles: { get: () => ({}), persona: () => 'p' },
    });
    await reply.handle({
      chatId: 'g@chatroom', senderId: 'other', text: '这是什么', kind: 'image',
      chatType: 'group', images: [img],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'vision-model', '带图消息走视觉模型');
    const content = calls[0].last.content;
    assert.ok(Array.isArray(content), 'user 内容是多模态数组');
    assert.ok(content.some((b) => b.type === 'image_url'));
    assert.ok(content.some((b) => b.type === 'text' && b.text === '这是什么'));
  } finally {
    AIClient.prototype.chat = orig;
  }
});

test('handle：带图但视觉模型未配 → 回落全局模型（IR6 回落）', async () => {
  const orig = AIClient.prototype.chat;
  const calls = [];
  AIClient.prototype.chat = function (messages) {
    calls.push(this.model);
    return Promise.resolve({ text: 'ok', usage: null, model: this.model });
  };
  try {
    const img = tmpFile('dog.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ai = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'global-model' });
    const reply = new AIReply({
      cfg: { enabled: true, groupReply: 'mention', maxImageBytes: 8 * 1024 * 1024 },
      ai,
      memory: { history: () => [], push: () => {} },
      hook: { sendText: async () => ({ ok: true }) },
      logger: { warn() {}, info() {}, debug() {} },
      profiles: { get: () => ({}), persona: () => 'p' },
    });
    await reply.handle({ chatId: 'g@chatroom', senderId: 'other', text: '这是什么', kind: 'image', chatType: 'group', images: [img] });
    assert.equal(calls[0], 'global-model');
  } finally {
    AIClient.prototype.chat = orig;
  }
});

test('handle：图片全被体积护栏拦下且无文字 → 跳过不调模型（IR13）', async () => {
  const orig = AIClient.prototype.chat;
  let called = 0;
  AIClient.prototype.chat = function () { called += 1; return Promise.resolve({ text: 'x', usage: null, model: 'm' }); };
  try {
    const big = tmpFile('huge.png', Buffer.alloc(200));
    const ai = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'global-model' });
    const reply = new AIReply({
      cfg: { enabled: true, groupReply: 'mention', visionModel: 'vision-model', maxImageBytes: 10 },
      ai,
      memory: { history: () => [], push: () => {} },
      hook: { sendText: async () => ({ ok: true }) },
      logger: { warn() {}, info() {}, debug() {} },
      profiles: { get: () => ({}), persona: () => 'p' },
    });
    const r = await reply.handle({ chatId: 'g@chatroom', senderId: 'other', text: '', kind: 'image', chatType: 'group', images: [big] });
    assert.equal(r, null);
    assert.equal(called, 0, '不应调用模型');
  } finally {
    AIClient.prototype.chat = orig;
  }
});

test('visionSupport：本机地址未配视觉模型 → 不支持；配了 / 云端 → 支持（IR3）', () => {
  assert.equal(visionSupport({ baseUrl: 'http://127.0.0.1:11434/v1' }).ok, false, '本机纯文本模型不支持');
  assert.equal(visionSupport({ baseUrl: 'http://localhost:11434/v1' }).ok, false);
  assert.equal(visionSupport({ baseUrl: 'http://[::1]:11434/v1' }).ok, false);
  const llava = visionSupport({ baseUrl: 'http://127.0.0.1:11434/v1', visionModel: 'llava' });
  assert.equal(llava.ok, true, '显式配了本机视觉模型就支持');
  assert.equal(llava.reason, 'vision-model');
  assert.equal(visionSupport({ baseUrl: 'https://api.deepseek.com/v1' }).ok, true, '云端回落全局模型');
  assert.equal(visionSupport({}).ok, true, '没地址不误判成本机');
  // 不能把「长得像内网」的外网域名误判成本机（否则会白白拦掉正常看图）
  assert.equal(visionSupport({ baseUrl: 'https://127.0.0.1.evil.com/v1' }).local, false);
});

test('handle：本地模型不支持视觉 → 提示用户，不调模型也不读图（IR3）', async () => {
  const orig = AIClient.prototype.chat;
  let called = 0;
  AIClient.prototype.chat = function () { called += 1; return Promise.resolve({ text: 'x', usage: null, model: 'm' }); };
  const sent = [];
  try {
    const img = tmpFile('local.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ai = new AIClient({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5:7b' });
    const reply = new AIReply({
      cfg: { enabled: true, groupReply: 'mention', baseUrl: 'http://127.0.0.1:11434/v1', maxImageBytes: 8 * 1024 * 1024 },
      ai,
      memory: { history: () => [], push: () => {} },
      hook: { sendText: async (to, t) => { sent.push(t); return { ok: true }; } },
      logger: { warn() {}, info() {}, debug() {} },
      profiles: { get: () => ({}), persona: () => 'p' },
    });
    const r = await reply.handle({ chatId: 'g@chatroom', senderId: 'other', text: '', kind: 'image', chatType: 'group', images: [img] });
    assert.equal(called, 0, '本机纯文本模型不应被调去看图');
    assert.equal(sent.length, 1, '应给用户一条明确提示，而不是静默失败');
    assert.match(sent[0], /不支持看图/);
    assert.equal(r, sent[0]);
  } finally {
    AIClient.prototype.chat = orig;
  }
});

test('handle：本机配了视觉模型（如 llava）→ 正常看图（IR3 例外）', async () => {
  const orig = AIClient.prototype.chat;
  const calls = [];
  AIClient.prototype.chat = function () { calls.push(this.model); return Promise.resolve({ text: '一只猫', usage: null, model: this.model }); };
  try {
    const img = tmpFile('cat2.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ai = new AIClient({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5:7b' });
    const reply = new AIReply({
      cfg: { enabled: true, groupReply: 'mention', baseUrl: 'http://127.0.0.1:11434/v1', visionModel: 'llava', maxImageBytes: 8 * 1024 * 1024 },
      ai,
      memory: { history: () => [], push: () => {} },
      hook: { sendText: async () => ({ ok: true }) },
      logger: { warn() {}, info() {}, debug() {} },
      profiles: { get: () => ({}), persona: () => 'p' },
    });
    await reply.handle({ chatId: 'g@chatroom', senderId: 'other', text: '这是什么', kind: 'image', chatType: 'group', images: [img] });
    assert.equal(calls.length, 1, '配了本机视觉模型就该正常调');
    assert.equal(calls[0], 'llava');
  } finally {
    AIClient.prototype.chat = orig;
  }
});

test('handle：不支持看图时的提示文案可自定义（AI_VISION_UNSUPPORTED_TEXT）', async () => {
  const orig = AIClient.prototype.chat;
  AIClient.prototype.chat = function () { return Promise.resolve({ text: 'x', usage: null, model: 'm' }); };
  const sent = [];
  try {
    const img = tmpFile('t.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ai = new AIClient({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5:7b' });
    const reply = new AIReply({
      cfg: { enabled: true, groupReply: 'mention', baseUrl: 'http://127.0.0.1:11434/v1', visionUnsupportedText: '本模型看不了图', maxImageBytes: 8 * 1024 * 1024 },
      ai,
      memory: { history: () => [], push: () => {} },
      hook: { sendText: async (to, t) => { sent.push(t); return { ok: true }; } },
      logger: { warn() {}, info() {}, debug() {} },
      profiles: { get: () => ({}), persona: () => 'p' },
    });
    await reply.handle({ chatId: 'g@chatroom', senderId: 'other', text: '', kind: 'image', chatType: 'group', images: [img] });
    assert.equal(sent[0], '本模型看不了图');
  } finally {
    AIClient.prototype.chat = orig;
  }
});
