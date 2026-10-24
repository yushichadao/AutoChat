import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvFile, setEnvValues, getEnvValue, writeEnvFromTemplate } from '../src/cli/env-file.js';
import { ROOT } from './helpers.js';

function tmpFile(name = '.env') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-cli-'));
  return path.join(dir, name);
}

const SAMPLE = [
  '# 这是注释，不能被抹掉',
  'LOG_LEVEL=info',
  '',
  '# 模型地址',
  'AI_BASE_URL=http://127.0.0.1:11434/v1',
  'AI_MODEL=qwen2.5:7b',
].join('\n');

test('读 .env：忽略注释与空行', () => {
  const file = tmpFile();
  fs.writeFileSync(file, SAMPLE, 'utf8');
  const env = readEnvFile(file);
  assert.equal(env.LOG_LEVEL, 'info');
  assert.equal(env.AI_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal(env.AI_MODEL, 'qwen2.5:7b');
  assert.equal(env['# 这是注释，不能被抹掉'], undefined);
});

test('读 .env：文件不存在返回空对象', () => {
  const file = path.join(tmpFile(), 'nope.env');
  assert.deepEqual(readEnvFile(file), {});
});

test('改 .env：只替换那一行，注释与顺序原样保留', () => {
  const file = tmpFile();
  fs.writeFileSync(file, SAMPLE, 'utf8');
  const r = setEnvValues(file, { AI_MODEL: 'qwen3:8b' });
  assert.deepEqual(r.changed, ['AI_MODEL']);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# 这是注释，不能被抹掉/);
  assert.match(text, /# 模型地址/);
  assert.match(text, /^AI_MODEL=qwen3:8b$/m);
  assert.doesNotMatch(text, /qwen2\.5:7b/);
  // 顺序不变
  assert.ok(text.indexOf('LOG_LEVEL') < text.indexOf('AI_BASE_URL'));
  assert.ok(text.indexOf('AI_BASE_URL') < text.indexOf('AI_MODEL'));
});

test('改 .env：不存在的键追加到末尾', () => {
  const file = tmpFile();
  fs.writeFileSync(file, SAMPLE, 'utf8');
  setEnvValues(file, { AI_MASTER_SWITCH: '0' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^AI_MASTER_SWITCH=0$/m);
  assert.ok(text.indexOf('AI_MODEL') < text.indexOf('AI_MASTER_SWITCH'));
});

test('改 .env：值为 null 表示删除该行，其余不动', () => {
  const file = tmpFile();
  fs.writeFileSync(file, SAMPLE, 'utf8');
  setEnvValues(file, { AI_MODEL: null });
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /AI_MODEL/);
  assert.match(text, /# 模型地址/);
  assert.match(text, /AI_BASE_URL=http:\/\/127\.0\.0\.1:11434\/v1/);
});

test('改 .env：export 前缀也能命中', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'export FOO=1\nBAR=2\n', 'utf8');
  setEnvValues(file, { FOO: '9' });
  assert.match(fs.readFileSync(file, 'utf8'), /^FOO=9$/m);
});

test('改 .env：空更新不写盘', () => {
  const file = tmpFile();
  fs.writeFileSync(file, SAMPLE, 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  const r = setEnvValues(file, {});
  assert.deepEqual(r.changed, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('取值：存在返回原值，不存在返回兜底', () => {
  const file = tmpFile();
  fs.writeFileSync(file, SAMPLE, 'utf8');
  assert.equal(getEnvValue(file, 'LOG_LEVEL'), 'info');
  assert.equal(getEnvValue(file, 'NOT_THERE', 'fallback'), 'fallback');
});

test('从模板生成 .env：注释保留，覆盖项生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-tpl-'));
  const target = path.join(dir, '.env');
  const r = writeEnvFromTemplate(path.join(ROOT, '.env.example'), target, { AI_ENABLED: '1' });
  assert.deepEqual(r.changed, ['AI_ENABLED']);
  const env = readEnvFile(target);
  assert.equal(env.AI_ENABLED, '1');
  assert.equal(env.LOG_LEVEL, 'info');
  assert.match(fs.readFileSync(target, 'utf8'), /#\s*日志级别/);
});
