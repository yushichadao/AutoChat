/**
 * 补测：test-plan.md 里「有实现但没人验过」且**可以用自动化覆盖**的条目。
 *
 * 覆盖：R5 R10 R11 R12 R17 R19 R20 / MS1 / IR8 / HI2 / I11
 * 不覆盖：必须真机（收发、DLL 漂移实机、性能、兼容矩阵）与纯人工（文档通读、仓库整理）——见 test-plan 标注。
 *
 * 注意：本文件只补「已有测试没覆盖的分支」，不重复 bridge.test.js / normalize.test.js 已有用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT } from './helpers.js';
import { PauseState, PidFile } from '../src/core/pause.js';
import { pausedFile, pidFile } from '../src/core/paths.js';
import { trackVersion } from '../src/bridge/compat.js';
import { checkAccountSeparation, effectivePollChats } from '../src/tasks/doctor.js';
import { normalizeMessage } from '../src/protocol/normalize.js';
import { TriggerPolicy } from '../src/ai/trigger.js';
import { Memory, SCHEMA_VERSION } from '../src/ai/memory.js';
import { readImageContent } from '../src/ai/vision.js';
import { EXIT, fail } from '../src/cli/ui.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gap-'));
}

// ── R12 暂停哨兵：路径约定 / 崩溃重启仍暂停 / 无路径降级 ──
test('R12 暂停哨兵：<root>/data/paused 约定，崩了重启仍是暂停态', () => {
  const root = tmpRoot();
  assert.equal(pausedFile(root), path.join(root, 'data', 'paused'), '哨兵路径约定');

  const ps = new PauseState({ file: pausedFile(root) });
  assert.equal(ps.isPaused(), false);
  assert.deepEqual(ps.pause('回归测试'), { ok: true, message: '已暂停自动回复' });
  assert.match(fs.readFileSync(pausedFile(root), 'utf8'), /reason: 回归测试/);

  // 模拟进程崩溃后重启：新实例读同一路径，仍判定为暂停（不会失控开跑）
  assert.equal(new PauseState({ file: pausedFile(root) }).isPaused(), true);
  assert.equal(new PauseState({ file: pausedFile(root) }).status().paused, true);

  // 没配哨兵路径时降级报错，而不是抛异常
  assert.deepEqual(new PauseState({}).pause(), { ok: false, message: '没有配置暂停哨兵文件' });
});

// ── R17 陈旧 pid：进程已死不应被当成运行中 ──
test('R17 陈旧 pid：进程已死时 serviceStatus 不把它算作运行中', async () => {
  const root = tmpRoot();
  const { serviceStatus } = await import('../src/tasks/service.js');
  new PidFile({ file: pidFile(root) }).write(999997); // 几乎不可能存在的 pid
  const st = await serviceStatus(root);
  assert.equal(st.running, false, '死 pid 不应被当成运行中');
  assert.equal(st.pid, 0, '不运行时 pid 归零，便于上层判断可安全接管');
});

// ── R10 微信版本漂移感知 ──
test('R10 版本漂移：trackVersion 记录并感知变化，读不到版本不误报', () => {
  const root = tmpRoot();
  const dataDir = path.join(root, 'data');
  assert.deepEqual(trackVersion(dataDir, '4.1.10.27'), { prev: null, changed: false }, '首次记录不算漂移');
  assert.deepEqual(trackVersion(dataDir, '4.1.10.28'), { prev: '4.1.10.27', changed: true }, '版本变了要报');

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.lastWeChatVersion, '4.1.10.28');
  assert.ok(saved.updatedAt);

  assert.deepEqual(trackVersion(dataDir, ''), { prev: '4.1.10.28', changed: false }, '读不到版本不误报漂移');
});

// ── R5 小号 / 同号隔离诊断 ──
test('R5 小号隔离诊断：checkAccountSeparation 各分支结论明确', async () => {
  const cfg = { wechat: { selfId: 'wxid_self', pollChats: ['123@chatroom'], pollDb: 'message_0.db' }, chats: {} };
  const mk = (wxid) => ({
    async queryDb() {
      return { data: [{ wxid, content: 'hi', msgid: '1', createTime: 1700000000 }] };
    },
  });

  // 发言全来自自己 → 疑似同号（选错模式的典型症状）
  const self = await checkAccountSeparation({ cfg, hook: mk('wxid_self'), limit: 5 });
  assert.equal(self.level, 'warn');
  assert.match(self.detail, /全部来自本机账号/);

  // 有别的账号发言 → 小号方案成立
  const other = await checkAccountSeparation({ cfg, hook: mk('wxid_other'), limit: 5 });
  assert.equal(other.level, 'ok');

  // 没配 wxid → 无法判断，明确报 bad 而不是假装正常
  const noSelf = await checkAccountSeparation({
    cfg: { ...cfg, wechat: { ...cfg.wechat, selfId: '' } },
    hook: mk('x'),
  });
  assert.equal(noSelf.level, 'bad');

  // 没加任何会话 → 不该报警
  const noChat = await checkAccountSeparation({
    cfg: { ...cfg, wechat: { ...cfg.wechat, pollChats: [] } },
    hook: mk('x'),
  });
  assert.match(noChat.detail, /还没加入任何会话/);
});

// ── R19 撤回 / R20 语音·表情：入站 kind 正确且不触发回复 ──
test('R19/R20 撤回与语音·表情：kind 正确，且不追发不回复', () => {
  const revoked = normalizeMessage({
    wxid: 'wxid_a', roomid: '1@chatroom', type: 10000, msgid: 'm1', content: '"张三" 撤回了一条消息',
  });
  assert.equal(revoked.kind, 'system', '撤回是系统消息');

  const xml = '<sysmsg type="revokemsg"><revokemsg><msgid>123</msgid></revokemsg></sysmsg>';
  const revokedXml = normalizeMessage({ wxid: 'wxid_a', type: 10002, msgid: 'm2', content: xml });
  assert.equal(revokedXml.kind, 'system');

  assert.equal(normalizeMessage({ wxid: 'a', type: 34, msgid: 'm3', content: '' }).kind, 'voice');
  assert.equal(normalizeMessage({ wxid: 'a', type: 47, msgid: 'm4', content: '[动画表情]' }).kind, 'emoji');

  // 关键：撤回 / 语音 / 表情都不该触发回复（不追发、不引用已撤回内容）
  const t = new TriggerPolicy({ enabled: true, groupReply: 'always' });
  for (const kind of ['system', 'voice', 'emoji']) {
    const r = t.decide({ kind, text: '撤回了一条消息', images: [], chatId: 'g@chatroom', chatType: 'group' });
    assert.equal(r.ok, false, kind + ' 不应触发回复');
    assert.equal(r.reason, 'not-text');
  }
});

// ── MS1 上下文是「原始转录」而非摘要 ──
test('MS1 上下文是原始转录：逐轮原文、TTL 后即丢、落盘 schema 稳定', () => {
  const root = tmpRoot();
  const file = path.join(root, 'data', 'ai-memory.json');
  const m = new Memory({ maxTurns: 2, ttlMs: 60000, maxChars: 6000, file });

  m.push('wxid_a', 'user', '原价 100 元');
  m.push('wxid_a', 'assistant', '已记录：原价 100 元');
  assert.deepEqual(
    m.history('wxid_a'),
    [
      { role: 'user', content: '原价 100 元' },
      { role: 'assistant', content: '已记录：原价 100 元' },
    ],
    '上下文存的是逐轮原文，不是 AI 摘要'
  );

  m.push('wxid_a', 'user', '');
  assert.equal(m.history('wxid_a').length, 2, '空内容不入上下文');

  m.flush();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.__v, SCHEMA_VERSION);
  assert.ok(disk.sessions.wxid_a.messages[0].at > 0, '盘上才带时间戳');
  assert.equal(new Memory({ maxTurns: 2, ttlMs: 60000, file }).history('wxid_a').length, 2, '重启后可从盘恢复');
});

test('MS1 上下文易失：TTL 过期即清空（区别于持久的长期记忆摘要）', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'data', 'ai-memory.json');
  const m = new Memory({ maxTurns: 4, ttlMs: 50, file });
  m.push('wxid_b', 'user', '临时内容');
  assert.equal(m.history('wxid_b').length, 1);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(m.history('wxid_b'), [], 'TTL 过期应清空');
});

// ── IR8 图片隐私：日志不写图片字节 ──
test('IR8 图片隐私：日志只说「哪张、为什么」，绝不写图片字节 / base64', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ir8-'));
  const gone = path.join(dir, 'gone.png');
  const logs = [];
  const logger = { warn: (m) => logs.push(String(m)), info() {}, debug() {}, error() {} };

  readImageContent([gone], { logger });

  assert.ok(logs.length >= 1, '跳过的图应有日志说明');
  assert.ok(logs.some((l) => l.includes('gone.png')), '应说明是哪张');
  for (const l of logs) {
    assert.ok(!/base64,/.test(l), '日志不应含 base64 数据');
    assert.ok(!/[A-Za-z0-9+/]{200,}={0,2}/.test(l), '日志不应含长串图片字节');
  }
});

// ── HI2 局部只增不减 ──
test('HI2 局部只增不减：关掉某会话不影响 WX_POLL_CHATS 里的其他会话', () => {
  const cfg = {
    wechat: { pollChats: ['env1@chatroom', 'env2@chatroom'] },
    chats: {
      'off@chatroom': { enabled: false },
      'on@chatroom': { enabled: true },
    },
  };
  const list = effectivePollChats(cfg);
  assert.ok(list.includes('env1@chatroom') && list.includes('env2@chatroom'), 'WX_POLL_CHATS 不受局部关闭影响');
  assert.ok(list.includes('on@chatroom'), '启用的会话要监听');
  assert.ok(!list.includes('off@chatroom'), '禁用的会话不监听');
});

// ── I11 退出码可程序化 ──
test('I11 退出码：EXIT 常量齐备，fail() 真正设置 process.exitCode', () => {
  assert.deepEqual(EXIT, { ok: 0, error: 1, unhealthy: 2 });
  const before = process.exitCode;
  try {
    fail('普通失败');
    assert.equal(process.exitCode, EXIT.error);
    fail('体检不健康', EXIT.unhealthy);
    assert.equal(process.exitCode, 2, '体检类失败用 2，便于脚本区分');
  } finally {
    process.exitCode = before;
  }
});

// ── R11 状态三态：CLI 输出的 autoReply 明确落在三态之一 ──
test('R11 状态三态：status --json 的 autoReply 是 disabled / paused / running', () => {
  const root = tmpRoot();
  const dataDir = path.join(root, 'data');
  const envOn = path.join(root, 'on.env');
  fs.writeFileSync(envOn, 'AI_ENABLED=1\n', 'utf8');

  const run = (envFile) =>
    spawnSync(process.execPath, [path.join(ROOT, 'src/cli/index.js'), 'status', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, WX_ENV_FILE: envFile, WX_DATA_DIR: dataDir },
    });

  const r = run(envOn);
  const m = /\{[\s\S]*\}/.exec(r.stdout || '');
  assert.ok(m, 'status --json 应有 JSON 输出：' + String(r.stdout).slice(0, 200));
  const st = JSON.parse(m[0]);
  assert.ok(['disabled', 'paused', 'running'].includes(st.autoReply), 'autoReply=' + st.autoReply);
  assert.equal(st.autoReply, 'running', 'AI_ENABLED=1 且无暂停哨兵 → 运行中');

  // 写一个暂停哨兵，同一份配置应变成「已暂停」
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'paused'), 'paused at test\n', 'utf8');
  const r2 = run(envOn);
  const m2 = /\{[\s\S]*\}/.exec(r2.stdout || '');
  assert.ok(m2, '暂停后仍应输出 JSON');
  assert.equal(JSON.parse(m2[0]).autoReply, 'paused', '有哨兵 → 已暂停');

  // 关掉开关 → 未启用
  const envOff = path.join(root, 'off.env');
  fs.writeFileSync(envOff, 'AI_ENABLED=0\n', 'utf8');
  const r3 = run(envOff);
  const m3 = /\{[\s\S]*\}/.exec(r3.stdout || '');
  assert.ok(m3);
  assert.equal(JSON.parse(m3[0]).autoReply, 'disabled', '开关关闭 → 未启用');
});
