import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGui } from '../src/gui/server.js';

/**
 * 本地文件浏览 / 预览接口（/api/fs/*）——起真实 GUI 服务打真实请求。
 *
 * 这些接口支撑界面的「选择文件…」弹窗与人设预览，浏览器拿不到绝对路径，
 * 只能靠本机服务端列目录，所以必须真跑一遍：盘符 / 列目录 / 读 txt / 拒绝非文本。
 */
async function withGui(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-guifs-'));
  const prev = process.env.AC_TEST_NOAUTH;
  process.env.AC_TEST_NOAUTH = '1';
  // 随机端口可能被别的用例占掉（server-safety 等也在随机端口起服务），占用就换一个重试
  let server = null;
  let lastErr = null;
  for (let i = 0; i < 4 && !server; i += 1) {
    const port = 40000 + Math.floor(Math.random() * 15000);
    try {
      server = (await startGui({ port, rootDir: root, window: false })).server;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!server) throw lastErr || new Error('起 GUI 服务失败');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, root);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.AC_TEST_NOAUTH;
    else process.env.AC_TEST_NOAUTH = prev;
  }
}

test('/api/fs/list：不传 dir 时返回盘符（Windows）或空根', async () => {
  await withGui(async (base) => {
    const r = await (await fetch(`${base}/api/fs/list`)).json();
    assert.ok(Array.isArray(r.roots), '应返回 roots 数组');
    // 非 Windows 上没有盘符约定，允许空数组；Windows 上至少要有系统盘
    if (process.platform === 'win32') assert.ok(r.roots.length > 0, 'Windows 应列出盘符');
  });
});

test('/api/fs/list：列目录能拿到子目录与文件名', async () => {
  await withGui(async (base, root) => {
    fs.mkdirSync(path.join(root, 'subdir'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    const r = await (await fetch(`${base}/api/fs/list?dir=${encodeURIComponent(root)}`)).json();
    assert.equal(r.dir, path.resolve(root));
    assert.ok(r.dirs.includes('subdir'), `应含子目录，实际 ${JSON.stringify(r.dirs)}`);
    assert.ok(r.files.includes('a.txt'), `应含文件，实际 ${JSON.stringify(r.files)}`);
  });
});

test('/api/fs/read：能预览 txt，且拒绝非文本文件（不提供任意文件读取）', async () => {
  await withGui(async (base, root) => {
    const txt = path.join(root, 'persona.txt');
    fs.writeFileSync(txt, '你是一个助手');
    const ok = await (await fetch(`${base}/api/fs/read?path=${encodeURIComponent(txt)}`)).json();
    assert.equal(ok.text, '你是一个助手');

    const exe = path.join(root, 'x.exe');
    fs.writeFileSync(exe, 'MZ');
    const bad = await fetch(`${base}/api/fs/read?path=${encodeURIComponent(exe)}`);
    assert.equal(bad.status, 400, 'exe 必须拒绝');
    const badBody = await bad.json();
    assert.match(badBody.error, /只支持预览/);
  });
});

test('/api/fs/read：缺 path 直接 400', async () => {
  await withGui(async (base) => {
    const res = await fetch(`${base}/api/fs/read`);
    assert.equal(res.status, 400);
  });
});
