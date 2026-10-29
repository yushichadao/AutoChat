import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContactCache } from '../src/bridge/contacts.js';

// hook 对所有查询返回同一份假数据：隔离由 cache 按账号维度实现，而非靠 hook 返回不同结果。
function fakeHook(rows) {
  return { queryDb: async () => ({ data: rows }) };
}

test('ContactCache 按账号隔离：换号后旧号缓存不串入新号', async () => {
  const cache = new ContactCache({ hook: fakeHook([{ username: 'wx_x', nick_name: '', remark: '群X' }]) });

  // A 号上线，查到群X
  cache.setCurrentAccount('wxidA');
  await cache.lookup(['wx_x']);
  assert.equal(cache.nameOf('wx_x', 'wxidA'), '群X');

  // 切到 B 号：B 不应看到 A 的缓存（即便 wxid 相同，也应按账号隔离）
  cache.setCurrentAccount('wxidB');
  assert.equal(cache.nameOf('wx_x', 'wxidB'), '', 'B 号不应看到 A 号缓存的群名');
  // B 号也查了 wx_x（hook 返回群X），写入 B 自己的缓存
  await cache.lookup(['wx_x']);
  assert.equal(cache.nameOf('wx_x', 'wxidB'), '群X');
  // A 号缓存仍独立存在
  assert.equal(cache.nameOf('wx_x', 'wxidA'), '群X');

  // 清掉 B 号缓存，A 不受影响
  cache.invalidate('wxidB');
  assert.equal(cache.nameOf('wx_x', 'wxidB'), '');
  assert.equal(cache.nameOf('wx_x', 'wxidA'), '群X');
});

test('ContactCache 不传 account 时回落 current', async () => {
  const cache = new ContactCache({ hook: fakeHook([]) });
  cache.setCurrentAccount('wxidA');
  await cache.lookup(['wx_y']);
  assert.equal(cache.nameOf('wx_y'), '');
  assert.equal(cache.nameOf('wx_y', 'wxidA'), '');
});

test('ContactCache.entries 按账号隔离', async () => {
  const cache = new ContactCache({ hook: fakeHook([{ username: 'wx_z', nick_name: 'Z', remark: '' }]) });
  cache.setCurrentAccount('wxidA');
  await cache.lookup(['wx_z']);
  assert.equal(cache.entries('wxidA').length, 1);
  assert.equal(cache.entries('wxidB').length, 0);
});
