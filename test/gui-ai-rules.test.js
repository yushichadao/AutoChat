import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/**
 * 模型卡「别把用户配好的东西改掉」的规则测试。
 *
 * 这几条规则防的是同一类事故：界面在用户不知情时改写了地址和模型名，
 * 于是「明明配了 DeepSeek，却跑本机千问」。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_JS = path.join(HERE, '..', 'src', 'gui', 'ui', 'js');

const sandbox = { window: {}, console };
sandbox.window.AutoChat = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(UI_JS, 'ai-rules.js'), 'utf8'), sandbox, { filename: 'ai-rules.js' });
const rules = sandbox.window.AutoChat.aiRules;

const OPTIONS = [
  { id: 'ollama', name: '本机 Ollama（已启动）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'deepseek', name: 'DeepSeek（云端，便宜）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
];

test('配的地址在预设表里 → 选中对应来源', () => {
  assert.equal(rules.pickProviderId(OPTIONS, 'https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(rules.pickProviderId(OPTIONS, 'http://127.0.0.1:11434/v1'), 'ollama');
});

test('配的地址不在预设表里 → 落到「自定义」，绝不落到第一个（本机 Ollama）', () => {
  assert.equal(rules.pickProviderId(OPTIONS, 'https://my.gateway.example.com/v1'), 'custom');
});

test('什么都没配 → 才允许默认第一个（这时选谁都不会覆盖用户配置）', () => {
  assert.equal(rules.pickProviderId(OPTIONS, ''), 'ollama');
});

test('密钥字段留空＝保持原样，不会把 .env 里已配好的密钥抹掉', () => {
  const values = rules.collectEnvValues(
    [['AI_BASE_URL', 'https://api.deepseek.com/v1'], ['AI_API_KEY', ''], ['AI_MODEL', 'deepseek-flash']],
    ['AI_API_KEY', 'WX_WEBHOOK_TOKEN'],
  );
  assert.equal('AI_API_KEY' in values, false);
  assert.equal(values.AI_BASE_URL, 'https://api.deepseek.com/v1');
  assert.equal(values.AI_MODEL, 'deepseek-flash');
});

test('密钥字段填了值才写回', () => {
  const values = rules.collectEnvValues([['AI_API_KEY', 'sk-123']], ['AI_API_KEY']);
  assert.equal(values.AI_API_KEY, 'sk-123');
});

test('保存时地址/模型变了 → 需要先确认，并给出「从什么换成什么」', () => {
  const plan = rules.planAiSave({
    live: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    base: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    key: '',
  });
  assert.equal(plan.needConfirm, true);
  assert.equal(plan.from.base, 'https://api.deepseek.com/v1');
  assert.equal(plan.to.model, 'qwen2.5:7b');
  assert.equal(plan.values.AI_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal(plan.values.AI_MODEL, 'qwen2.5:7b');
});

test('保存时没变化 → 不需要确认（不打扰正常保存）', () => {
  const plan = rules.planAiSave({
    live: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
  });
  assert.equal(plan.needConfirm, false);
});

test('切到本机地址 → 顺手清掉残留的云端密钥（避免「云端 key + 本机地址」错配）', () => {
  const plan = rules.planAiSave({
    live: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    base: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    key: 'sk-旧云端密钥',
  });
  assert.equal(plan.local, true);
  assert.equal(plan.values.AI_API_KEY, null, '本机来源不应写密钥');
});

test('取不到值的控件（分段选择/开关没有 el.value）不会被写成空串', () => {
  // 曾经的 bug：div 上的 data-bind 取不到 value，被当成 '' 写回 .env，
  // 于是 AI_GROUP_REPLY 变成空、助手启动被配置校验拦下。
  const values = rules.collectEnvValues(
    [['AI_GROUP_REPLY', undefined], ['AI_ENABLED', undefined], ['AI_BASE_URL', 'https://api.deepseek.com/v1']],
    ['AI_API_KEY'],
  );
  assert.equal('AI_GROUP_REPLY' in values, false, '取不到值的键宁可不写');
  assert.equal('AI_ENABLED' in values, false);
  assert.equal(values.AI_BASE_URL, 'https://api.deepseek.com/v1');
});

test('云端地址 → 填了密钥就写回，没填就保持原样', () => {
  const withKey = rules.planAiSave({
    live: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    key: 'sk-new',
  });
  assert.equal(withKey.values.AI_API_KEY, 'sk-new');
  const noKey = rules.planAiSave({
    live: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    key: '',
  });
  assert.equal('AI_API_KEY' in noKey.values, false);
});
