import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

const { loadAccountConfig } = await import('../src/core/account-profile.js');

function makeTmp() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { tmp, dataDir };
}

test('loadAccountConfig: 全局 .env 模型压过账号 ai.json 的旧模型（根治静默覆盖）', () => {
  const { tmp, dataDir } = makeTmp();
  try {
    process.env.WX_DATA_DIR = dataDir;
    // 全局 .env：本地 qwen（用户当前真实配置）
    fs.writeFileSync(path.join(tmp, '.env'), 'AI_MODEL=qwen2.5:7b\nAI_BASE_URL=http://127.0.0.1:11434/v1\n');
    // 账号 ai.json 遗留了一份「整份快照」：含陈旧模型 + 身份键
    const adir = path.join(dataDir, 'accounts', 'wxid_test');
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(
      path.join(adir, 'ai.json'),
      JSON.stringify({
        AI_MODEL: 'deepseek-flash',
        AI_BASE_URL: 'https://api.deepseek.com/v1',
        AI_PERSONA_NAME: '测试人设',
      })
    );
    const cfg = loadAccountConfig({ rootDir: tmp, wxid: 'wxid_test' });
    // 模型 / 接口必须取全局 .env，不被 ai.json 旧值盖掉
    assert.equal(cfg.ai.model, 'qwen2.5:7b', '模型应取全局 .env，而非 ai.json 旧值');
    assert.equal(cfg.ai.baseUrl, 'http://127.0.0.1:11434/v1');
    // 身份键仍按账号隔离生效
    assert.equal(cfg.ai.personaName, '测试人设', '人设名仍按账号隔离');
  } finally {
    delete process.env.WX_DATA_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadAccountConfig: 账号 ai.json 里的非身份键一律忽略（含 unknown 账号）', () => {
  const { tmp, dataDir } = makeTmp();
  try {
    process.env.WX_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(tmp, '.env'), 'AI_MODEL=qwen2.5:7b\nAI_BASE_URL=http://127.0.0.1:11434/v1\n');
    // 模拟 legacy / unknown 账号：ai.json 里混了陈旧模型
    const adir = path.join(dataDir, 'accounts', 'unknown');
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(
      path.join(adir, 'ai.json'),
      JSON.stringify({ AI_MODEL: 'deepseek-flash', AI_PERSONA_NAME: '路人甲' })
    );
    const cfg = loadAccountConfig({ rootDir: tmp, wxid: 'unknown' });
    assert.equal(cfg.ai.model, 'qwen2.5:7b', 'unknown 账号也不该被 ai.json 旧模型覆盖');
    assert.equal(cfg.ai.personaName, '路人甲', '身份键仍生效');
  } finally {
    delete process.env.WX_DATA_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeEditableEnv: 身份键落 ai.json，其余 AI_* 落全局 .env', async () => {
  const { tmp, dataDir } = makeTmp();
  try {
    process.env.WX_DATA_DIR = dataDir;
    const { writeEditableEnv } = await import('../src/tasks/config.js');
    const r = writeEditableEnv(
      { AI_MODEL: 'qwen2.5:7b', AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_PERSONA_NAME: '测试人设' },
      tmp,
      'wxid_test'
    );
    assert.ok(r.changed.includes('AI_MODEL'), '模型应写全局 .env');
    // ai.json 只应有身份键
    const ai = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts', 'wxid_test', 'ai.json'), 'utf8'));
    assert.deepEqual(Object.keys(ai).sort(), ['AI_PERSONA_NAME'], 'ai.json 不应再含 AI_MODEL 等');
  } finally {
    delete process.env.WX_DATA_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
});
