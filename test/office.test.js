import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipRead, zipWrite, extractText, writeTextFile, writeDocx, writeXlsx } from '../src/ai/tools/office.js';
import { normalizeMessage } from '../src/protocol/normalize.js';
import { callTool, allSkillNames } from '../src/ai/tools/registry.js';
import { AIReply } from '../src/ai/replier.js';
import { ChatProfiles } from '../src/core/chats.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-office-'));

function makeReplier(cfgExtra = {}) {
  return new AIReply({
    cfg: { model: 'm', baseUrl: 'http://m', apiKey: 'k', groupReply: 'mention', maxPerHour: 120, cooldownMs: 0, maxConcurrent: 2, enabled: true, ...cfgExtra },
    ai: { baseUrl: 'http://m', model: 'm', apiKey: 'k', chat: async () => ({ text: '' }) },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    profiles: new ChatProfiles({ chats: {} }),
  });
}

test('ZIP 往返：写入后能原样读回（手写解析器的地基）', () => {
  const buf = zipWrite([
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/b.xml', data: '<x>中文</x>' },
  ]);
  const entries = zipRead(buf);
  assert.equal(entries.get('a.txt').toString('utf8'), 'hello');
  assert.equal(entries.get('dir/b.xml').toString('utf8'), '<x>中文</x>');
});

test('txt / md / csv 直接读取', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.md');
  writeTextFile(f, '# 标题\n内容行');
  const r = extractText(f);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'md');
  assert.match(r.text, /# 标题/);
  assert.match(r.text, /内容行/);
});

test('docx：生成后能解析回原文（Word 往返）', () => {
  const dir = tmp();
  const f = path.join(dir, 'report.docx');
  writeDocx(f, { title: '季度报告', paragraphs: ['第一段内容', '第二段内容'] });
  assert.ok(fs.existsSync(f), 'docx 文件应生成');
  const r = extractText(f);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'docx');
  assert.match(r.text, /季度报告/);
  assert.match(r.text, /第一段内容/);
  assert.match(r.text, /第二段内容/);
});

test('xlsx：生成后能解析回表格内容（Excel 往返）', () => {
  const dir = tmp();
  const f = path.join(dir, 'table.xlsx');
  writeXlsx(f, { sheetName: '成绩', rows: [['姓名', '分数'], ['张三', 90], ['李四', 88]] });
  assert.ok(fs.existsSync(f), 'xlsx 文件应生成');
  const r = extractText(f);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'xlsx');
  assert.match(r.text, /姓名/);
  assert.match(r.text, /张三/);
  assert.match(r.text, /90/);
  assert.match(r.text, /88/);
});

test('不支持的格式：返回 ok=false 且带原因，不抛异常', () => {
  const dir = tmp();
  const f = path.join(dir, 'x.exe');
  fs.writeFileSync(f, 'binary');
  const r = extractText(f);
  assert.equal(r.ok, false);
  assert.match(r.reason, /暂不支持/);
});

test('超长文档按 maxChars 截断，防止撑爆上下文', () => {
  const dir = tmp();
  const f = path.join(dir, 'big.txt');
  writeTextFile(f, 'x'.repeat(500));
  const r = extractText(f, { maxChars: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 200, '应被截断');
});

test('文件不存在时不抛异常，返回 ok=false', () => {
  const r = extractText(path.join(tmp(), 'nope.docx'));
  assert.equal(r.ok, false);
  assert.ok(r.reason, '应带失败原因');
});

// ── 接入主链路：入站附件识别 + 文档上下文注入 ─────────────────────────

test('入站附件识别：从常见字段里挑出受支持的文件路径', () => {
  const m = normalizeMessage(
    { wxid: 'wxid_a', content: '看看这个', filePath: 'C:\\Users\\x\\report.docx' },
    { selfId: 'me' }
  );
  assert.ok(m, '应归一化成功');
  assert.ok(m.files.includes('C:\\Users\\x\\report.docx'), `应识别出 docx 附件，实际 ${JSON.stringify(m.files)}`);
});

test('文档解读：开启后抽取附件注入上下文，关闭时不注入', async () => {
  const f = path.join(tmp(), 'note.txt');
  writeTextFile(f, '这是附件里的关键结论：预算 120 万');

  const on = makeReplier({ docAnalysis: true });
  const ctx = await on.buildDocContext({ files: [f] }, {});
  assert.ok(ctx, '开启时应注入文档上下文');
  assert.match(ctx, /预算 120 万/);

  const off = makeReplier({ docAnalysis: false });
  assert.equal(await off.buildDocContext({ files: [f] }, {}), null, '关闭时不注入');
});

test('write_doc：生成 docx 并返回文件标记（可经 [[file:]] 作为文件发送）', async () => {
  const dir = tmp();
  const r = await callTool('write_doc', {
    filename: '季度报告.docx',
    format: 'docx',
    paragraphs: ['第一段', '第二段'],
  }, { docOutDir: dir });
  assert.equal(r.ok, true, `应生成成功：${r.error || ''}`);
  assert.ok(fs.existsSync(r.path), '文件应落盘');
  assert.equal(r.marker, `[[file:${r.path}]]`);
  // 生成的文档要能被自己解析回来
  assert.match(extractText(r.path).text, /第一段/);
});

test('write_doc：文件名带路径分隔符也逃不出沙箱（清洗 + 目录校验双重）', async () => {
  const dir = tmp();
  const r = await callTool('write_doc', { filename: '../escape.txt', format: 'txt', content: 'x' }, { docOutDir: dir });
  assert.equal(r.ok, true, '文件名被清洗成安全名，仍可正常生成');
  assert.ok(path.resolve(r.path).startsWith(path.resolve(dir) + path.sep), `文件必须落在输出目录内：${r.path}`);
  assert.ok(!r.path.includes('..'), '生成路径不应包含 ..');
});

test('write_doc 不进默认白名单（写操作须显式放行）', () => {
  assert.ok(!allSkillNames().includes('write_doc'), '默认白名单不应含写操作技能');
  assert.ok(allSkillNames().includes('calculator'), '普通技能应仍在默认白名单');
});

test('文档解读：抽不出内容也不让助手失声（带失败原因继续）', async () => {
  const f = path.join(tmp(), 'x.exe');
  fs.writeFileSync(f, 'binary');
  const r = makeReplier({ docAnalysis: true });
  const ctx = await r.buildDocContext({ files: [f] }, {});
  assert.ok(ctx, '仍应给出上下文（说明抽取失败），而不是返回 null 让助手哑掉');
  assert.match(ctx, /抽取失败/);
});
