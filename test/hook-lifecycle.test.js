import test from 'node:test';
import assert from 'node:assert/strict';
import { needsProxyDeploy, pickReinstallTarget, HookLifecycle } from '../src/bridge/hook-lifecycle.js';
import { HookClient, DEFAULT_ENDPOINTS } from '../src/bridge/hook-client.js';

// 用注入的 hash 函数避免真实文件 IO，直接覆盖各分支（path.join 在 Windows 出反斜杠，统一归一）
const mk = (map) => (f) => { const k = String(f).replace(/\\/g, '/'); return k in map ? map[k] : null; };

test('安装目录 DLL 与微信版本不匹配 → 必须走代理模式（用内置匹配版）', () => {
  const d = needsProxyDeploy({
    installDir: 'C:/wx',
    configured: 'C:/cfg/wrong.dll', // 配置也是错版本
    expected: 'C:/builtin/right.dll',
    hash: mk({ 'C:/wx/version.dll': 'aaa', 'C:/cfg/wrong.dll': 'aaa', 'C:/builtin/right.dll': 'bbb' }),
  });
  assert.equal(d.use, true);
  assert.equal(d.dllPath, 'C:/builtin/right.dll');
  assert.match(d.reason, /版本不匹配/);
});

test('安装目录 DLL 错版本、但配置恰好就是正确版 → 用配置部署', () => {
  const d = needsProxyDeploy({
    installDir: 'C:/wx',
    configured: 'C:/cfg/right.dll',
    expected: 'C:/builtin/right.dll',
    hash: mk({ 'C:/wx/version.dll': 'aaa', 'C:/cfg/right.dll': 'bbb', 'C:/builtin/right.dll': 'bbb' }),
  });
  assert.equal(d.use, true);
  assert.equal(d.dllPath, 'C:/cfg/right.dll');
});

test('安装目录 DLL 与配置不一致（版本未必错）→ 按配置部署', () => {
  const d = needsProxyDeploy({
    installDir: 'C:/wx',
    configured: 'C:/cfg/a.dll',
    expected: null, // 没内置匹配方案
    hash: mk({ 'C:/wx/version.dll': 'xxx', 'C:/cfg/a.dll': 'yyy' }),
  });
  assert.equal(d.use, true);
  assert.equal(d.dllPath, 'C:/cfg/a.dll');
});

test('安装目录 DLL 与配置、期望都一致 → 不必走代理模式（直接注入即可）', () => {
  const d = needsProxyDeploy({
    installDir: 'C:/wx',
    configured: 'C:/cfg/a.dll',
    expected: 'C:/builtin/a.dll',
    hash: mk({ 'C:/wx/version.dll': 'same', 'C:/cfg/a.dll': 'same', 'C:/builtin/a.dll': 'same' }),
  });
  assert.equal(d.use, false);
});

test('安装目录里根本没有 version.dll → 注入模式是唯一路径，不强行重启', () => {
  const d = needsProxyDeploy({
    installDir: 'C:/wx',
    configured: 'C:/cfg/a.dll',
    expected: 'C:/builtin/a.dll',
    hash: mk({ 'C:/cfg/a.dll': 'same', 'C:/builtin/a.dll': 'same' }), // 无 version.dll 项
  });
  assert.equal(d.use, false);
});

test('pickReinstallTarget：精确版本返回自身', () => {
  assert.equal(pickReinstallTarget('4.1.10.27').wechat, '4.1.10.27');
});

test('pickReinstallTarget：更新的不支持版本 → 在同系列里挑最接近的高版本', () => {
  const t = pickReinstallTarget('4.1.20.1');
  assert.equal(t.wechat.startsWith('4.1.'), true);
  assert.equal(Number(t.wechat.split('.')[1]), 1); // 仍是 4.1 系列
});

test('pickReinstallTarget：旧的不支持版本 → 退到同主版本最接近者', () => {
  const t = pickReinstallTarget('3.9.5.5');
  assert.equal(t.wechat.startsWith('3.9.'), true);
});

test('pickReinstallTarget：跨大版本也总能返回一个受支持条目', () => {
  const t = pickReinstallTarget('9.9.9.9');
  assert.ok(t && typeof t.wechat === 'string' && /\d+\.\d+\.\d+\.\d+/.test(t.wechat));
});

// ── autoRepair 的结论必须带原因 ──────────────────────────────────────────
// 曾经第④步直接 return {ok:false, steps}，没有 message，界面只能弹「未能自动修复」，
// 用户完全不知道卡在「hook 没响应」还是「没登录」。
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const mkLifecycle = () => {
  const lc = new HookLifecycle(
    { installDir: 'C:/wx', dllPath: 'C:/cfg/ac.dll', host: '127.0.0.1', port: 1, readyTimeoutMs: 50, endpoints: {} },
    quiet
  );
  // 绕开真实文件系统探测与 30s 轮询
  lc.resolveInstall = async () => ({ exe: 'C:/wx/Weixin.exe', dir: 'C:/wx', version: '4.1.10.27', major: 4 });
  return lc;
};

test('autoRepair：hook 无响应时给出「没有响应」的原因，而不是空文案', async () => {
  const lc = mkLifecycle();
  lc.verifyLogin = async () => null;
  const r = await lc.autoRepair();
  assert.equal(r.ok, false);
  assert.match(r.message, /没有响应/);
  assert.match(r.message, /127\.0\.0\.1:1/);
  assert.ok(Array.isArray(r.steps) && r.steps.length > 0);
});

test('autoRepair：微信未登录时提示去登录', async () => {
  const lc = mkLifecycle();
  lc.verifyLogin = async () => false;
  const r = await lc.autoRepair();
  assert.equal(r.ok, false);
  assert.match(r.message, /未登录/);
  assert.match(r.message, /登录/);
});

test('autoRepair：登录正常时 ok=true 且说明用了哪份 DLL', async () => {
  const lc = mkLifecycle();
  lc.verifyLogin = async () => true;
  const r = await lc.autoRepair();
  assert.equal(r.ok, true);
  assert.match(r.message, /4\.1\.10\.27/);
  assert.match(r.message, /ac\.dll/);
});

test('HookClient 不传 endpoints 时用默认端点（不能因 .ep.status 未定义而假装连不上）', () => {
  const c = new HookClient({ host: '127.0.0.1', port: 1 });
  assert.equal(c.ep.status, DEFAULT_ENDPOINTS.status);
  assert.equal(c.ep.sendText, DEFAULT_ENDPOINTS.sendText);
});
