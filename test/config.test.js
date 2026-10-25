import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/core/config.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-cfg-'));
}

test('死配置 AI_STRIP_MARKDOWN / AI_MAX_REPLY_CHARS 默认生效（不再 no-op）', () => {
  const cfg = loadConfig({ env: {}, rootDir: tmpRoot() });
  assert.equal(cfg.ai.stripMarkdown, true);
  assert.equal(cfg.ai.maxReplyChars, 900);
});

test('.env 可覆盖死配置', () => {
  const cfg = loadConfig({
    env: { AI_STRIP_MARKDOWN: '0', AI_MAX_REPLY_CHARS: '1500' },
    rootDir: tmpRoot(),
  });
  assert.equal(cfg.ai.stripMarkdown, false);
  assert.equal(cfg.ai.maxReplyChars, 1500);
});

test('config.json 解析失败不抛出，按空配置继续（故障隔离）', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'config.json'), '{ this is not valid json');
  const cfg = loadConfig({ env: {}, rootDir: root });
  assert.deepEqual(cfg.chats, {});
});

test('validateConfig 拦截非法 inject 模式（缺 DLL 路径）', () => {
  const cfg = loadConfig({ env: {}, rootDir: tmpRoot() });
  cfg.wechat.mode = 'inject';
  const errs = validateConfig(cfg);
  assert.ok(errs.some((e) => /WX_DLL_PATH/.test(e)), '应提示需要 WX_DLL_PATH');
});
