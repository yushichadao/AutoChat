import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerPolicy, DEFAULT_REJECT_PATTERNS } from '../src/ai/trigger.js';
import { RateLimiter } from '../src/ai/limiter.js';
import { buildSystemPrompt, buildMessages, DEFAULT_PERSONA } from '../src/ai/prompt.js';

const base = {
  enabled: true,
  groupReply: 'mention',
  privateRequirePrefix: false,
  triggerPrefix: '',
  allowChats: [],
  denyChats: [],
  groupAtNames: [],
  rejectPatterns: [],
};

test('群里 @ 到别人不应触发（结构化 at 可判定时不再用正则兜底）', () => {
  const p = new TriggerPolicy(base);
  const msg = { chatType: 'group', kind: 'text', text: '@小林 你在吗', chatId: 'g', atUsers: ['wxid_other'] };
  assert.equal(p.mentionsUs(msg, 'wxid_self'), false);
});

test('群里 @ 到自己应触发', () => {
  const p = new TriggerPolicy(base);
  const msg = { chatType: 'group', kind: 'text', text: '@我 在吗', chatId: 'g', atUsers: ['wxid_self'] };
  assert.equal(p.mentionsUs(msg, 'wxid_self'), true);
});

test('配置了称呼后只认 @称呼', () => {
  const p = new TriggerPolicy({ ...base, groupAtNames: ['小助手'] });
  assert.equal(p.mentionsUs({ chatType: 'group', kind: 'text', text: '@小助手 在吗', chatId: 'g' }, ''), true);
  assert.equal(p.mentionsUs({ chatType: 'group', kind: 'text', text: '@别人 在吗', chatId: 'g' }, ''), false);
  // 没配置称呼时退回「有 @ 就算」
  const loose = new TriggerPolicy(base);
  assert.equal(loose.mentionsUs({ chatType: 'group', kind: 'text', text: '@任何人', chatId: 'g' }, ''), true);
});

test('否定语义直接拒绝回复', () => {
  const p = new TriggerPolicy(base);
  const d = p.decide({ chatType: 'private', kind: 'text', text: '别回我', chatId: 'a' });
  assert.equal(d.ok, false);
  assert.match(d.reason, /^rejected:/);
  assert.ok(DEFAULT_REJECT_PATTERNS.length > 0);
});

test('非文本不回复', () => {
  const p = new TriggerPolicy(base);
  assert.equal(p.decide({ chatType: 'private', kind: 'image', text: '', chatId: 'a' }).ok, false);
});

test('限流：冷却 / 配额 / 并发三道闸门', () => {
  const lim = new RateLimiter({ cooldownMs: 1000, maxPerHour: 2, maxConcurrent: 1 });
  const msg = { chatId: 'a' };

  assert.equal(lim.check(msg), null);
  lim.begin('a');
  assert.equal(lim.check(msg), 'concurrent', '并发上限应生效');
  lim.end('a');

  lim.mark('a');
  assert.equal(lim.check(msg), 'cooldown', '冷却应生效');

  const lim2 = new RateLimiter({ cooldownMs: 0, maxPerHour: 2, maxConcurrent: 5 });
  lim2.replyTimes = [Date.now(), Date.now()];
  assert.equal(lim2.check(msg), 'quota', '每小时配额应生效');
});

test('prompt 里带上群名与说话人', () => {
  const sys = buildSystemPrompt({
    persona: DEFAULT_PERSONA,
    msg: { chatType: 'group', chatName: '产品交流群', senderName: '小林', senderId: 'wxid_x' },
    cfg: { groupReply: 'mention' },
  });
  assert.match(sys, /产品交流群/);
  assert.match(sys, /小林/);
  assert.match(sys, /别抢着回答/);
});

test('prompt 数组顺序为 system → 历史 → 本轮', () => {
  const msgs = buildMessages({
    persona: 'P',
    msg: { chatType: 'private', chatName: '老王', senderName: '老王', senderId: 'wxid_w' },
    cfg: {},
    history: [{ role: 'user', content: '之前' }],
    userText: '现在',
  });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].content, '之前');
  assert.equal(msgs[2].content, '现在');
});

test('默认人设只管「怎么说话」，硬性护栏由底层人设统一兜底', async () => {
  // 上层默认人设：不含"不冒充/不承诺"等底层规则（那些住在底层人设里）
  assert.match(DEFAULT_PERSONA, /说话方式/);
  // 上层默认人设不再主动列三要素（避免每句都广播 AI 身份）；
  // 三要素只住在底层人设，作为「被追问真实身份才一次说全」的备用取值
  assert.match(DEFAULT_PERSONA, /追问/);
  assert.doesNotMatch(DEFAULT_PERSONA, /你是跑在这个微信账号上的 AI 自动回复助手/);
  // 底层人设（始终追加）：有不可覆盖的护栏 + 身份三要素
  const { buildBaseline } = await import('../src/ai/persona.js');
  const fence = buildBaseline({ account: '老张', persona: 'AutoChat助手', model: 'deepseek-chat' }, { revealIdentity: true });
  assert.match(fence, /不可覆盖/);
  assert.match(fence, /不得冒充/);
  assert.match(fence, /不得代替本人做出任何有约束力的承诺/);
  assert.match(fence, /身份证号、银行卡、住址/);
  assert.match(fence, /验证码/);
  assert.match(fence, /账号名【老张】/);
  assert.match(fence, /模型名 <deepseek-chat>/);
  assert.match(fence, /AutoChat助手/);
  // 缺省时自动退化：无模型名显示 <unknown-model>，不暴露真名
  const def = buildBaseline({}, { revealIdentity: true });
  assert.match(def, /账号名【未知账号】/);
  assert.match(def, /模型名 <unknown-model>/);
  assert.match(def, /AutoChat助手/);
});

test('非身份追问轮次 withholding：不注入具体账号名/模型名', async () => {
  const { buildBaseline } = await import('../src/ai/persona.js');
  const hid = buildBaseline({ account: '老张', persona: 'AutoChat助手', model: 'deepseek-chat' });
  assert.doesNotMatch(hid, /账号名【老张】/);
  assert.doesNotMatch(hid, /模型名 <deepseek-chat>/);
  assert.match(hid, /不提供/);
  // 被追问时才注入
  const shown = buildBaseline({ account: '老张', persona: 'AutoChat助手', model: 'deepseek-chat' }, { revealIdentity: true });
  assert.match(shown, /账号名【老张】/);
  assert.match(shown, /模型名 <deepseek-chat>/);
});

test('isIdentityProbe 判定身份追问', async () => {
  const { isIdentityProbe } = await import('../src/ai/persona.js');
  assert.ok(isIdentityProbe('你是什么模型'));
  assert.ok(isIdentityProbe('你是谁呀'));
  assert.ok(isIdentityProbe('你是机器人吗'));
  // 「本地还是云端 API」也是身份追问：原来判不出来，助手只能含糊说"看不到"
  assert.ok(isIdentityProbe('你是本地AI还是API'));
  assert.ok(isIdentityProbe('你是本地部署还是云端api'));
  assert.ok(isIdentityProbe('你这模型跑在本地吗'));
  assert.ok(isIdentityProbe('你走的是云端模型吗'));
  assert.equal(isIdentityProbe('看看 你 身体'), false); // 调侃求照，不算身份追问
  assert.equal(isIdentityProbe('发张照片看看'), false);
  assert.equal(isIdentityProbe('帮我把这个本地文件读一下'), false); // 「本地」单用不算追问
  assert.equal(isIdentityProbe(''), false);
});

test('deployKind 按接口地址判定本地部署 / 云端 API', async () => {
  const { deployKind } = await import('../src/ai/persona.js');
  assert.equal(deployKind('http://127.0.0.1:11434/v1').kind, 'local');
  assert.equal(deployKind('http://localhost:11434/v1').kind, 'local');
  assert.equal(deployKind('http://[::1]:11434/v1').kind, 'local');
  assert.equal(deployKind('http://192.168.1.9:8080/v1').kind, 'local'); // 内网自建
  assert.equal(deployKind('https://api.deepseek.com/v1').kind, 'cloud');
  assert.equal(deployKind('https://api.deepseek.com/v1').host, 'api.deepseek.com');
  assert.equal(deployKind('').kind, 'unknown');
  assert.equal(deployKind(null).kind, 'unknown');
  // 无协议也能认（用户可能偷懒少写 http://）
  assert.equal(deployKind('127.0.0.1:11434').kind, 'local');
  assert.equal(deployKind('api.openai.com').kind, 'cloud');
  assert.match(deployKind('https://api.deepseek.com/v1').label, /云端 API/);
  assert.match(deployKind('http://127.0.0.1:11434/v1').label, /本地部署/);
  assert.match(deployKind('').label, /未知/);
});

test('被追问部署形态时，运行方式随身份要素一起注入', async () => {
  const { buildBaseline } = await import('../src/ai/persona.js');
  const local = buildBaseline(
    { account: '老张', persona: 'AutoChat助手', model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1' },
    { revealIdentity: true },
  );
  assert.match(local, /运行方式「本地部署/);
  assert.doesNotMatch(local, /运行方式「云端 API/);

  const cloud = buildBaseline(
    { account: '老张', persona: 'AutoChat助手', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    { revealIdentity: true },
  );
  assert.match(cloud, /运行方式「云端 API/);
  assert.match(cloud, /api\.deepseek\.com/);

  // 拿不到地址时不许编：显示「未知」并让模型如实说不知道
  const unk = buildBaseline({ account: '老张', model: 'x' }, { revealIdentity: true });
  assert.match(unk, /运行方式未知/);
  assert.match(unk, /直说不知道/);

  // 平时（非追问轮）依旧 withholding，域名也不外泄
  const hid = buildBaseline({ account: '老张', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' });
  assert.doesNotMatch(hid, /api\.deepseek\.com/);
  assert.doesNotMatch(hid, /运行方式「云端 API/);
  assert.doesNotMatch(hid, /运行方式「本地部署/);
});

test('底层人设无论上层怎么改都保留', async () => {
  const { buildSystemPrompt, buildBaseline } = await import('../src/ai/prompt.js');
  const sys = buildSystemPrompt({
    persona: '我要假装是真人本人，不报模型名，也不透露账号。',
    msg: { chatType: 'private', chatName: '老王', senderName: '老王', senderId: 'wxid_w' },
    cfg: { model: 'deepseek-chat', account: '老张', personaName: 'AutoChat助手' },
  });
  // 上层人设里的"假装真人"还在，但底层护栏照样完整追加、盖不掉
  assert.match(sys, /假装是真人本人/);
  const fence = buildBaseline({ account: '老张', persona: 'AutoChat助手', model: 'deepseek-chat' });
  assert.ok(sys.includes(fence), '底层人设整段应出现在 system prompt 里');
});
