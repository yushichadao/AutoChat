import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/core/config.js';

function tmpRoot(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-robust-'));
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(root, '.env'), lines.join('\n') + '\n', 'utf8');
  return root;
}

/** R23：非法枚举 / 极端值不能让加载崩溃，要么优雅回落、要么被 validateConfig 明确报错。 */
test('非法枚举不崩、且能被 validateConfig 明确报错（R23）：AI_GROUP_REPLY=bogus', () => {
  const cfg = loadConfig({ env: { AI_GROUP_REPLY: 'bogus' }, rootDir: tmpRoot() });
  // 加载本身不能抛错（不崩）
  assert.ok(cfg.ai.groupReply === 'bogus');
  const res = validateConfig(cfg);
  assert.ok(Array.isArray(res), 'validateConfig 应返回错误数组');
  assert.ok(res.some((e) => e.includes('AI_GROUP_REPLY')), '应明确指出非法枚举');
});

test('极端数字不崩溃（R23）：超长 / 负数 / 非数字', () => {
  const cfg = loadConfig({
    env: {
      AI_CONTEXT_TURNS: '999999999999999999999',
      AI_COOLDOWN_MS: '-5',
      AI_MAX_PER_HOUR: 'abc',
      AI_MAX_REPLY_CHARS: '',
    },
    rootDir: tmpRoot(),
  });
  assert.ok(Number.isFinite(cfg.ai.contextTurns));
  assert.ok(Number.isFinite(cfg.ai.cooldownMs));
  assert.ok(Number.isFinite(cfg.ai.maxPerHour));
  assert.equal(cfg.ai.maxReplyChars, 900); // 空串回落默认
});

test('validateConfig 对残缺配置不抛错（R23）', () => {
  const partial = {
    ai: { enabled: false, model: '', baseUrl: '', apiKey: '' },
    wechat: { selfMode: 'sender', pollChats: [] },
    chats: {},
  };
  assert.doesNotThrow(() => validateConfig(partial));
});

test('禁用词自检：产品代码不出现「总闸 / 双账号 / 另一种皮」（D4/D5）', () => {
  // 直接遍历活跃源码目录做自检（不依赖 git / shell，避免环境差异）
  const dirs = ['src/ai', 'src/bridge', 'src/core', 'src/tasks', 'src/cli', 'src/gui/ui'];
  const re = /总闸|双账号|另一种皮/;
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(p);
      } else if (/\.js$/.test(e.name)) {
        const txt = fs.readFileSync(p, 'utf8');
        const m = txt.match(re);
        if (m) hits.push(p + ': ' + m[0]);
      }
    }
  };
  for (const d of dirs) {
    if (fs.existsSync(d)) walk(d);
  }
  assert.deepEqual(hits, [], '活跃源码里不应出现禁用词：\n' + hits.join('\n'));
});
