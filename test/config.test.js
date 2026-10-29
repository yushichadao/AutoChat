import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/core/config.js';
import { syncPollChats, readEditableEnv } from '../src/tasks/config.js';
import { effectivePollChats } from '../src/tasks/doctor.js';

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

test('加入会话自动并入 WX_POLL_CHATS，且不删手填项', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.env'), 'WX_POLL_CHATS=manual@chatroom,old@chatroom\n', 'utf8');
  const next = syncPollChats(
    { 'new@chatroom': { enabled: true }, 'off@chatroom': { enabled: false } },
    ['old@chatroom'],
    root,
  );
  // 手填的 manual 保留、新增的 new 加入、被移除的 old 剔除、停用的 off 不加入
  assert.deepEqual(next, ['manual@chatroom', 'new@chatroom']);
  assert.equal(readEditableEnv(root).WX_POLL_CHATS, 'manual@chatroom,new@chatroom');
});

test('WX_POLL_CHATS 为空时用「按会话配置」里启用的会话兜底', () => {
  const cfg = {
    wechat: { pollChats: [] },
    chats: { 'a@chatroom': { enabled: true }, 'b@chatroom': { enabled: false } },
  };
  assert.deepEqual(effectivePollChats(cfg), ['a@chatroom']);
});

test('validateConfig 拦截非法 inject 模式（缺 DLL 路径）', () => {
  const cfg = loadConfig({ env: {}, rootDir: tmpRoot() });
  cfg.wechat.mode = 'inject';
  const errs = validateConfig(cfg);
  assert.ok(errs.some((e) => /WX_DLL_PATH/.test(e)), '应提示需要 WX_DLL_PATH');
});

test('.env 优先于进程环境变量（残留变量不能顶掉用户配置）', () => {
  const root = tmpRoot();
  fs.writeFileSync(
    path.join(root, '.env'),
    'AI_BASE_URL=https://api.deepseek.com/v1\nAI_MODEL=deepseek-flash\n',
    'utf8',
  );
  const prevBase = process.env.AI_BASE_URL;
  const prevModel = process.env.AI_MODEL;
  // 模拟「某个终端/父进程里还留着上一套配置」：它不能盖掉 .env 里用户写的
  process.env.AI_BASE_URL = 'http://127.0.0.1:11434/v1';
  process.env.AI_MODEL = 'qwen2.5:7b';
  try {
    const cfg = loadConfig({ rootDir: root });
    assert.equal(cfg.ai.baseUrl, 'https://api.deepseek.com/v1', '地址应以 .env 为准');
    assert.equal(cfg.ai.model, 'deepseek-flash', '模型应以 .env 为准');
    assert.ok(
      cfg.configSource.shadowedEnv.includes('AI_BASE_URL'),
      '被挡住的环境变量要记下来，启动日志才能查来源',
    );
    assert.ok(cfg.configSource.shadowedEnv.includes('AI_MODEL'));
    assert.ok(cfg.configSource.envFileExists);
  } finally {
    if (prevBase === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = prevBase;
    if (prevModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = prevModel;
  }
});

test('枚举项留空＝用默认值，不会把助手卡在「配置错误」上', () => {
  const root = tmpRoot();
  // 界面某些保存路径会把没选的枚举写成空行；留空的本意是「不特别指定」
  fs.writeFileSync(
    path.join(root, '.env'),
    'AI_ENABLED=1\nAI_BASE_URL=https://api.deepseek.com/v1\nAI_MODEL=deepseek-flash\nAI_GROUP_REPLY=\n' +
      'WX_INJECT_MODE=\nWX_DLL_PATH=C:/x/version.dll\nWX_RECEIVE_MODE=\n',
    'utf8',
  );
  const cfg = loadConfig({ env: {}, rootDir: root });
  assert.equal(cfg.ai.groupReply, 'mention', '留空的群聊策略应回落到 mention');
  assert.equal(cfg.wechat.mode, 'inject', '留空的注入模式应回落到 inject');
  assert.deepEqual(validateConfig(cfg), [], '留空不该被当成非法值');
});

test('调用方显式传入 env 时仍以它为准（测试与程序内调用不受 .env 影响）', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.env'), 'AI_MODEL=deepseek-flash\n', 'utf8');
  const cfg = loadConfig({ env: { AI_MODEL: 'qwen2.5:7b' }, rootDir: root });
  assert.equal(cfg.ai.model, 'qwen2.5:7b');
});
