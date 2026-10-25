import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/**
 * 卡片渲染冒烟测试。
 *
 * 用一份假的 state 把每张卡片都渲染一遍，确认：
 *   · 不抛异常、不渲染出 undefined / [object Object]
 *   · 不出现裸勾选框
 *   · 来自微信的文本（群名）被转义，不会变成可执行 HTML
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_JS = path.join(HERE, '..', 'src', 'gui', 'ui', 'js');

const sandbox = { window: {}, console };
sandbox.window.AutoChat = {};
vm.createContext(sandbox);
for (const f of ['widgets.js', 'cards/core.js', 'cards/model.js', 'cards/chat.js', 'cards/system.js']) {
  vm.runInContext(fs.readFileSync(path.join(UI_JS, f), 'utf8'), sandbox, { filename: f });
}
const g = sandbox.window.AutoChat;

const state = {
  running: true,
  pid: 1234,
  gate: { paused: false, reason: '', file: 'data/paused' },
  installed: { installed: true, envFile: 'D:/x/.env', autoStart: true, shortcut: false },
  autoStart: true,
  env: { AI_ENABLED: '1' },
  config: {
    ai: {
      enabled: true, deprecatedMasterSwitch: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b',
      personaFile: '', groupReply: 'mention', groupAtNames: ['小助手'], contextTurns: 8,
      contextTtlMs: 1800000, contextMaxChars: 6000, maxPerHour: 120, cooldownMs: 3000,
    },
    wechat: {
      selfId: 'wxid_self', selfMode: 'sender', receiveMode: 'auto',
      pollChats: ['123@chatroom'], dllPath: 'D:/x.dll', installDir: 'D:/Weixin',
    },
  },
  wechatVersion: '4.1.10.27',
  versionLocked: false,
  memory: [{ chatId: '123@chatroom', name: '<img src=x onerror=alert(1)>', messages: 3, updatedAt: Date.now(), last: [{ role: 'user', content: 'hi' }] }],
  chats: { '123@chatroom': { enabled: true, groupReply: 'always', personaFile: './p.md', name: '<b>群名</b>' } },
};

const onboard = { steps: [{ id: 'node', title: 'Node 运行环境', level: 'ok', detail: 'v24', next: '' }] };
const diag = { items: [{ level: 'warn', name: '锁版本', detail: '未锁', next: '锁定微信版本' }] };
const ms = { runners: [{ id: 'ollama', name: 'Ollama', installed: true, exe: 'C:/ollama.exe' }], baseUrl: 'http://127.0.0.1:11434/v1', online: false, startedByUs: false, models: [] };
const logs = { exists: true, lines: ['INFO 启动'], file: 'data/autochat.out' };
const form = { ai: { base: '', key: '', model: '', providerId: '', options: [{ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' }], result: null, review: [], atNames: '', triggerPrefix: '' }, chat: { results: [], picked: null } };

test('每张卡片都能渲染出合法 HTML', () => {
  const out = [
    g.cards.onboard(state, onboard),
    g.cards.status(state),
    g.cards.ai(state, form),
    g.cards.modelService(state, ms),
    g.cards.context(state),
    g.cards.chats(state, form.chat),
    g.cards.install(state, ''),
    g.cards.logs(state, logs),
    g.cards.diag(state, diag),
  ].join('\n');
  assert.ok(out.length > 200, '应该渲染出内容');
  assert.ok(!out.includes('undefined'), '不该出现 undefined');
  assert.ok(!out.includes('[object Object]'), '不该出现 [object Object]');
  assert.ok(!/type="checkbox"/.test(out), '不该出现裸勾选框');
});

test('来自微信的群名被转义，不会变成可执行 HTML', () => {
  const out = g.cards.chats(state, form.chat);
  assert.ok(out.includes('&lt;b&gt;群名&lt;/b&gt;'), '群名应被转义');
  assert.ok(!out.includes('<b>群名</b>'), '不能原样插入群名');
});
