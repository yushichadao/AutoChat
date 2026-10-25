import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLocalModel, DEFAULT_MODEL } from '../src/tasks/model-service.js';
import { readEnvFile } from '../src/core/env-file.js';

// configureLocalModel 把本地 Ollama 写进 .env（不联网、不启进程）。
// 这是「小白一键配置」落进配置文件的关键一步。
test('configureLocalModel 写入本地 Ollama 的 AI 配置', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ms-'));
  try {
    const r = await configureLocalModel({ rootDir });
    assert.equal(r.ok, true);

    const env = readEnvFile(path.join(rootDir, '.env'));
    assert.equal(env.AI_BASE_URL, 'http://127.0.0.1:11434/v1');
    assert.equal(env.AI_MODEL, DEFAULT_MODEL);
    assert.equal(env.AI_ENABLED, '1');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEFAULT_MODEL 是中文友好的小模型', () => {
  assert.match(DEFAULT_MODEL, /^[a-z0-9:\.\-]+$/);
});
