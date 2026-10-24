import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactCache } from '../src/bridge/contacts.js';

/** 模拟 DLL 的 QueryDB：某些库/表查不到会抛错，找到的返回数据。 */
function fakeHook({ failDbs = [], tableRows = {} } = {}) {
  return {
    async queryDb(sql, db) {
      if (failDbs.includes(db)) throw new Error(`no such table/db: ${db}`);
      const table = /FROM\s+(\w+)/i.exec(sql)?.[1] || 'contact';
      const rows = tableRows[`${db}.${table}`];
      if (!rows) throw new Error(`no such table: ${table}`);
      return { data: rows };
    },
  };
}

test('联系人库名漂移时自动回退到 MicroMsg.db', async () => {
  const hook = fakeHook({
    failDbs: ['contact.db'],
    tableRows: { 'MicroMsg.db.contact': [{ username: 'wxid_abc', nick_name: '小明', remark: '' }] },
  });
  const cc = new ContactCache({ hook });
  await cc.lookup(['wxid_abc']);
  assert.equal(cc.activeDb, 'MicroMsg.db');
  assert.equal(cc.nameOf('wxid_abc'), '小明');
});

test('contact.db 正常时直接用，不回退', async () => {
  const hook = fakeHook({
    tableRows: { 'contact.db.contact': [{ username: 'wxid_x', nick_name: '小红', remark: '备注名' }] },
  });
  const cc = new ContactCache({ hook });
  await cc.lookup(['wxid_x']);
  assert.equal(cc.activeDb, 'contact.db');
  // remark 优先于 nick_name
  assert.equal(cc.nameOf('wxid_x'), '备注名');
});

test('老版本表名大写 Contact 也能命中', async () => {
  const hook = fakeHook({
    failDbs: ['contact.db'],
    tableRows: { 'MicroMsg.db.Contact': [{ username: 'wxid_y', nick_name: '阿强', remark: '' }] },
  });
  const cc = new ContactCache({ hook });
  await cc.lookup(['wxid_y']);
  assert.equal(cc.activeTable, 'Contact');
  assert.equal(cc.nameOf('wxid_y'), '阿强');
});

test('所有库/表都查不到时安全降级（不抛错、名字留空）', async () => {
  const hook = fakeHook({ failDbs: ['contact.db', 'MicroMsg.db', 'MicroMsg.db.bak'] });
  const cc = new ContactCache({ hook });
  await cc.lookup(['wxid_z']);
  assert.equal(cc.activeDb, null);
  assert.equal(cc.nameOf('wxid_z'), '');
});
