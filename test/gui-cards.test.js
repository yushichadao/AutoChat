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
    g.cards.wechat(state),
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

test('HI7 群可用性卡独立渲染：与体检卡分离、群名转义、空输入不崩', () => {
  const avail = {
    ok: false,
    items: [
      { level: 'bad', name: '<img src=x onerror=alert(1)>', detail: '找不到消息表', next: '检查配置' },
      { level: 'warn', name: '另一个群', detail: '未启用自动回复', next: '在配置里打开' },
      { level: 'ok', name: '正常群', detail: '表可达', next: '' },
    ],
  };
  const out = g.cards.chatAvailability(state, avail);
  assert.ok(out.length > 50, '应渲染出内容');
  assert.ok(!out.includes('undefined'), '不该出现 undefined');
  assert.ok(out.includes('群可用性'), '标题应出现');
  // 来自微信的群名同样被转义，不能变成可执行 HTML
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), '可用性卡群名应被转义');
  assert.ok(!out.includes('<img src=x onerror=alert(1)>'), '不能原样插入群名');
  // 空输入（尚未查询）返回空串，不崩
  assert.equal(g.cards.chatAvailability(state, null), '', '未查询时返回空串');
});

test('数字输入框带默认值且 value 属性引号闭合', () => {
  const out = g.cards.ai(state, form);
  // 曾经的 bug：value="120 data-bind=... 少了闭合引号，数字框全是空的
  assert.ok(out.includes('value="120"'), '每小时上限应有默认 120');
  assert.ok(out.includes('value="3000"'), '会话间隔应有默认 3000');
  assert.ok(out.includes('value="2"'), '并发上限应有默认 2');
  assert.ok(!/value="\d+\s+data-bind/.test(out), 'value 与被绑定属性之间不能粘连');
});

test('拉到模型后可以点选切换模型', () => {
  const form2 = {
    ai: Object.assign({}, form.ai, {
      providerId: 'ollama',
      models: ['qwen2.5-coder:7b', 'qwen2.5:1.5b', 'qwen2.5:7b'],
    }),
  };
  const out = g.cards.ai(state, form2);
  assert.ok(out.includes('id="aiModel"'), '模型名应始终可编辑');
  assert.equal((out.match(/data-model=/g) || []).length, 3, '每个模型都应可点选');
  assert.ok(out.includes('data-model="qwen2.5:1.5b"'), '应带上具体模型名');
});

test('思考强度控件在界面上：关闭 / 低 / 中 / 高 四档', () => {
  const out = g.cards.ai(state, form);
  assert.ok(out.includes('data-bind="ai.reasoningEffort"'), '应有思考强度控件');
  for (const v of ['off', 'low', 'medium', 'high']) {
    assert.ok(out.includes(`data-val="${v}"`), `应有 ${v} 这一档`);
  }
  assert.ok(out.includes('data-select="ai.reasoningFormat"'), '应有思考参数格式下拉');
  assert.ok(out.includes('data-bind="ai.reasoningBudget"'), '应有思考预算输入框');
  assert.ok(out.includes('id="reasoningPreview"'), '应显示「这次会发什么」的提示');
});

test('思考参数格式下拉覆盖了各家模型的写法', () => {
  const out = g.cards.ai(state, form);
  for (const f of ['auto', 'standard', 'openrouter', 'qwen', 'anthropic', 'gemini', 'thinking', 'ollama']) {
    assert.ok(out.includes(`value="${f}"`), `应有 ${f} 这一项`);
  }
});

test('思考强度的当前档位会被标出来', () => {
  const st2 = JSON.parse(JSON.stringify(state));
  st2.config.ai.reasoningEffort = 'high';
  const out = g.cards.ai(st2, form);
  assert.ok(
    /class="seg-item on" data-seg="reasoningEffort" data-val="high"/.test(out),
    '当前档位应带 on 样式'
  );
});

test('模型卡顶部显示「当前真正生效」的地址与模型（别只显示下拉框预选值）', () => {
  const st2 = JSON.parse(JSON.stringify(state));
  st2.config.ai.baseUrl = 'https://api.deepseek.com/v1';
  st2.config.ai.model = 'deepseek-flash';
  const out = g.cards.ai(st2, form);
  assert.ok(out.includes('当前生效'), '应显示当前生效的配置');
  assert.ok(out.includes('https://api.deepseek.com/v1'), '应显示真正的接口地址');
  assert.ok(out.includes('deepseek-flash'), '应显示真正的模型名');
});

test('密钥字段说明「填了立即自动保存、清空可删」', () => {
  const out = g.cards.ai(state, form);
  assert.ok(out.includes('自动保存'), '应说明填了立即自动保存并替换旧的');
  assert.ok(out.includes('清空'), '应说明清空可删除');
});

test('未配密钥时默认显示「未配置」并带自动保存钩子', () => {
  const form2 = { ai: { base: 'http://127.0.0.1:11434/v1', key: '', model: '', providerId: 'custom', options: [], result: null, atNames: '', triggerPrefix: '' } };
  const out = g.cards.ai(state, form2);
  assert.ok(out.includes('未配置'), '未配密钥时应显示「未配置」');
  assert.ok(out.includes('data-secret="ai.key"'), '密钥框应带 data-secret 以便失焦自动保存');
});

test('已配密钥时显示「已配置」并预填真值', () => {
  const st2 = JSON.parse(JSON.stringify(state));
  st2.secrets = { aiApiKey: { present: true, value: 'sk-abc123xyz', preview: 'sk-a…xyz' } };
  const form2 = { ai: { base: 'http://127.0.0.1:11434/v1', key: '', model: '', providerId: 'custom', options: [], result: null, atNames: '', triggerPrefix: '' } };
  const out = g.cards.ai(st2, form2);
  assert.ok(out.includes('已配置'), '已配密钥应显示「已配置」');
  assert.ok(out.includes('sk-abc123xyz'), '应预填已保存的真值（本人本机，不外发）');
});
