import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile, describeSupport, canReceive, PROFILES } from '../src/bridge/profiles.js';
import { advise } from '../src/bridge/compat.js';

test('精确命中返回 exact', () => {
  const r = resolveProfile('4.1.10.27');
  assert.equal(r.level, 'exact');
  assert.equal(r.profile.dll, 'aixed/WeChat-Hook（main）');
});

test('同三段命中 patch，但不视为可用', () => {
  const r = resolveProfile('4.1.15.13');
  assert.equal(r.level, 'patch');
  const d = describeSupport('4.1.15.13');
  assert.equal(d.ok, false, '补丁号不同不应判定为可用');
  assert.match(d.text, /4\.1\.15\.56/);
});

test('只有主次版本相同返回 minor', () => {
  const r = resolveProfile('4.1.9.99');
  assert.equal(r.level, 'minor');
});

test('完全未知版本返回 none', () => {
  assert.equal(resolveProfile('9.9.9').level, 'none');
  assert.equal(describeSupport('9.9.9').profile, null);
});

test('空版本不抛错', () => {
  assert.equal(resolveProfile('').level, 'none');
  assert.equal(describeSupport('').ok, false);
});

test('档案能回答能否收消息', () => {
  assert.equal(canReceive('4.1.10.27'), false, '开源 main 分支已移除接收 hook');
  assert.equal(canReceive('3.9.5.81'), true);
  assert.equal(canReceive('0.0.0'), false);
});

test('所有档案都有来源与许可字段', () => {
  for (const p of PROFILES) {
    assert.ok(p.wechat, '缺版本号');
    assert.ok(p.dll, `缺 dll: ${p.wechat}`);
    assert.ok(p.url?.startsWith('https://'), `缺 url: ${p.wechat}`);
    assert.ok(p.license, `缺许可: ${p.wechat}`);
  }
});

test('DLL 无回调能力时自动切成轮询', () => {
  const a = advise({
    version: '4.1.10.27',
    probe: { reachable: true, canSend: true, canReceivePush: false, canQueryDb: true, capabilities: {} },
    cfg: { receiveMode: 'webhook', pollSql: 'SELECT 1' },
  });
  assert.equal(a.changes.receiveMode, 'poll');
});

test('DLL 无查库能力时自动切回 webhook', () => {
  const a = advise({
    version: '3.9.5.81',
    probe: { reachable: true, canSend: true, canReceivePush: true, canQueryDb: false, capabilities: {} },
    cfg: { receiveMode: 'auto', pollSql: '' },
  });
  assert.equal(a.changes.receiveMode, 'webhook');
});

test('探测不到发送接口会告警', () => {
  const a = advise({
    version: '4.1.10.27',
    probe: { reachable: true, canSend: false, canReceivePush: true, canQueryDb: true, capabilities: {} },
    cfg: { receiveMode: 'webhook', pollSql: '' },
  });
  assert.ok(a.warnings.some((w) => /发送接口/.test(w)));
});
