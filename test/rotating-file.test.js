import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RotatingFileWriter } from '../src/core/rotating-file.js';

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rot-')), name);
}

test('RotatingFileWriter 累积写入且体积超阈值后轮转（L7）', () => {
  const file = tmpFile('app.out');
  const w = new RotatingFileWriter(file, { maxBytes: 100, generations: 2, logger: { warn() {} } });
  // 写足够多行，触发至少一次轮转
  for (let i = 0; i < 20; i++) w.write('line-' + i + ' ' + 'x'.repeat(10));
  w.close();
  assert.ok(fs.existsSync(file), '主文件应存在');
  // 轮转后旧内容应落到 .1（最多 generations=2 代；更早的会被丢弃，符合设计）
  assert.ok(fs.existsSync(file + '.1'), '应产生 .1 代');
  const main = fs.readFileSync(file, 'utf8');
  const gen1 = fs.readFileSync(file + '.1', 'utf8');
  assert.ok(main.length > 0 && gen1.length > 0, '主文件与 .1 都应有内容');
  // 最新一行一定在主文件（最末代）
  assert.ok(main.includes('line-19'), '主文件应保留最新写入');
  // 两代之间不重叠（轮转是整文件迁移，不会重复）
  const overlap = main.split('\n').filter((l) => l && gen1.includes(l));
  assert.equal(overlap.length, 0, '主文件与 .1 不应有重复行');
});

test('RotatingFileWriter 保留指定代数、最老超出即删（L7）', () => {
  const file = tmpFile('app.out');
  const w = new RotatingFileWriter(file, { maxBytes: 50, generations: 3, logger: { warn() {} } });
  for (let i = 0; i < 60; i++) w.write('row-' + i);
  w.close();
  // 代数 .1 .2 .3 存在，.4 不应存在
  assert.ok(fs.existsSync(file + '.1'));
  assert.ok(fs.existsSync(file + '.2'));
  assert.ok(fs.existsSync(file + '.3'));
  assert.ok(!fs.existsSync(file + '.4'), '超过 generations 的代应被删除');
});

test('rotate() 可主动触发轮转（L7）', () => {
  const file = tmpFile('app.out');
  const w = new RotatingFileWriter(file, { maxBytes: 1e9, generations: 2, logger: { warn() {} } });
  w.write('before');
  w.rotate();
  w.write('after');
  w.close();
  assert.ok(fs.existsSync(file + '.1'), '主动轮转应产生 .1 代');
  assert.ok(fs.readFileSync(file, 'utf8').includes('after'));
  assert.ok(fs.readFileSync(file + '.1', 'utf8').includes('before'));
});
