/**
 * GUI 易用性与卸载语义补测（对应 test-plan §二 G29/G31、§6.5 I12/I13）。
 *
 * 只测「能自动化且安全」的部分：
 *  · 403 提示页（页面给中文页、接口给 JSON、绝不回显令牌、鉴权强度不变）
 *  · 卸载「移入回收站」的入参护栏（不真的删任何东西）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-guiu-'));
}

test('403：页面给中文提示页、接口给结构化错误，且绝不回显当前令牌', async () => {
  delete process.env.AC_TEST_NOAUTH; // 确保走正常校验
  const { startGui } = await import('../src/gui/server.js');
  const root = tmpRoot();
  const gui = await startGui({ rootDir: root, port: 8907, window: false });
  const base = 'http://127.0.0.1:8907/';
  try {
    // ① 页面访问（旧链接 / 没带令牌）→ 中文提示页
    const r1 = await fetch(base);
    assert.equal(r1.status, 403, '鉴权强度不变：无效令牌仍然是 403');
    assert.match(r1.headers.get('content-type') || '', /text\/html/);
    const html = await r1.text();
    assert.match(html, /打不开配置器/, '要说清发生了什么');
    assert.match(html, /autochat gui/, '要给一条能直接用的命令');
    assert.match(html, /没在跑|是旧的/, '要点出两种最常见原因');
    assert.ok(!html.includes(gui.token), '提示页绝不能回显当前令牌');

    // ② 接口访问 → 仍是结构化错误，方便调用方解析
    const r2 = await fetch(base + 'api/state');
    assert.equal(r2.status, 403);
    assert.match(r2.headers.get('content-type') || '', /application\/json/);
    const j = await r2.json();
    assert.equal(j.ok, false);

    // ③ 带正确令牌 → 正常放行（改的是提示，不是鉴权）
    const r3 = await fetch(base + '?token=' + gui.token);
    assert.equal(r3.status, 200);
  } finally {
    if (gui && gui.server) gui.server.close();
  }
});

test('卸载「移入回收站」：空路径与不存在的目录都被挡下，不碰 PowerShell', async () => {
  const { sendToRecycleBin } = await import('../src/tasks/install.js');
  const empty = await sendToRecycleBin('');
  assert.equal(empty.ok, false);
  assert.match(empty.message, /没有指定目录/);

  const gone = await sendToRecycleBin(path.join(tmpRoot(), 'no-such-dir-xyz'));
  assert.equal(gone.ok, false);
  assert.match(gone.message, /目录不存在/);

  const blank = await sendToRecycleBin('   ');
  assert.equal(blank.ok, false, '纯空白也不该往下走');
});
