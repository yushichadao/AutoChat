import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAutoStart, setAutoStart, getAutoStart, reg, cleanOsMessage } from '../src/core/win.js';
import { decodeCliText, isDamagedText } from '../src/core/text.js';

const TMP = 'AutoChat__selftest_tmp';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

test('命令行输出按系统代码页解码，GBK 中文不乱码', () => {
  // GBK 的「系统」两字：CF B5 CD B3
  assert.equal(decodeCliText(Buffer.from([0xcf, 0xb5, 0xcd, 0xb3])), '系统');
  // 真正的 UTF-8 仍然按 UTF-8 解
  assert.equal(decodeCliText(Buffer.from('中文', 'utf8')), '中文');
});

test('能识别出解码损坏的乱码', () => {
  assert.equal(isDamagedText('\uFFFD\uFFFD: 系统'), true, '含替换符应判为损坏');
  assert.equal(isDamagedText('锟斤拷锟斤拷'), true, '典型乱码应判为损坏');
  assert.equal(isDamagedText('ERROR: The system was unable to find the key.'), false, '干净英文不算损坏');
  assert.equal(cleanOsMessage('\uFFFD\uFFFD: 系统'), '', '损坏文本不得返回给界面');
  assert.equal(cleanOsMessage('ERROR: not found'), 'ERROR: not found', '干净文本应原样保留');
});

test('OS 报错文本损坏时不得进界面（回归：uninstall 曾显示满屏乱码）', { skip: process.platform !== 'win32' }, async () => {
  const r = await reg(['delete', RUN_KEY, '/v', TMP + '__no_such__', '/f']);
  assert.equal(r.ok, false, '删不存在的值应返回失败');
  const shown = cleanOsMessage(r.err);
  assert.ok(shown === '' || !isDamagedText(shown), '损坏的 OS 文本不得被直接展示');
});

test('取消开机自启是幂等的：本来没注册也算成功，且不返回乱码消息', { skip: process.platform !== 'win32' }, async () => {
  const r = await clearAutoStart(TMP);
  assert.equal(r.ok, true, '没注册过时不应报错');
  assert.equal(r.message || '', '', '不应带任何报错文案（避免乱码进界面）');
});

test('取消开机自启：先注册再删除，能删干净且报告成功', { skip: process.platform !== 'win32' }, async () => {
  const set = await setAutoStart(TMP, 'cmd /c echo selftest');
  assert.equal(set.ok, true, '注册临时自启项应成功');
  assert.ok((await getAutoStart(TMP)).includes('selftest'), '应能读回刚注册的值');

  const r = await clearAutoStart(TMP);
  assert.equal(r.ok, true, '删除应成功');
  assert.equal(await getAutoStart(TMP), '', '删完应读不到');
});
