import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RateLimiter } from '../src/ai/limiter.js';

test('RateLimiter 三道闸门独立计数（R16 / GAP5）', () => {
  const r = new RateLimiter({ cooldownMs: 1000, maxPerHour: 2, maxConcurrent: 1 });
  const mk = (id) => ({ chatId: id });

  // 冷却：同一会话 1s 内第二次被拦
  assert.equal(r.check(mk('a')), null);
  r.mark('a');
  assert.equal(r.check(mk('a')), 'cooldown');
  assert.equal(r.cooldownHits, 1);

  // 配额：每小时上限 2 次
  const r2 = new RateLimiter({ cooldownMs: 0, maxPerHour: 2, maxConcurrent: 0 });
  assert.equal(r2.check(mk('x')), null); r2.mark('x');
  assert.equal(r2.check(mk('y')), null); r2.mark('y');
  assert.equal(r2.check(mk('z')), 'quota');
  assert.equal(r2.quotaHits, 1);

  // 并发：上限 1，占用后第二会话被拦
  const r3 = new RateLimiter({ cooldownMs: 0, maxPerHour: 0, maxConcurrent: 1 });
  r3.begin('a');
  assert.equal(r3.check(mk('b')), 'concurrent');
  assert.equal(r3.concurrentHits, 1);
});

test('RateLimiter.stats() 暴露三类独立跳过计数', () => {
  const r = new RateLimiter({ cooldownMs: 1000, maxPerHour: 5, maxConcurrent: 2 });
  r.mark('a');
  r.cooldownHits = 3; r.quotaHits = 2; r.concurrentHits = 1; r.inflight.add('a');
  const s = r.stats();
  assert.equal(s.cooldownHits, 3);
  assert.equal(s.quotaHits, 2);
  assert.equal(s.concurrentHits, 1);
  assert.equal(s.inflight, 1);
  assert.equal(s.cooldownMs, 1000);
});

test('RateLimiter 落盘统计快照供跨进程读取（R16）', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rl-')), 'stats.json');
  const r = new RateLimiter({ cooldownMs: 0, maxPerHour: 1, maxConcurrent: 0 }, { statsFile: file });
  r.mark('a');
  r.quotaHits = 7;
  r.flush();
  assert.ok(fs.existsSync(file), '统计文件应已写入');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(obj.quotaHits, 7);
  assert.equal(obj.maxPerHour, 1);
  // 无 statsFile 时 flush 是 no-op，不报错
  const r2 = new RateLimiter({});
  assert.doesNotThrow(() => r2.flush());
});
