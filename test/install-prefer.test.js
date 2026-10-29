import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from '../src/tasks/install.js';
import { EDITABLE_ENV } from '../src/tasks/config.js';

/**
 * 回归：用户配置了自制 DLL 时，安装流程必须优先沿用，不能被内置 DLL 覆盖。
 * （此前 install() 只看传入的 opts.env，会把 .env 里已有的 WX_DLL_PATH 覆盖掉。）
 */
test('已配置的自制 DLL 优先，不会被内置 DLL 覆盖', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dll-pref-'));
  const dll = path.join(dir, 'my-selfmade.dll');
  fs.writeFileSync(dll, 'x');
  fs.writeFileSync(path.join(dir, '.env'), `WX_DLL_PATH=${dll}\n`);

  const r = await install({ rootDir: dir, env: {} });
  const kept = r.steps.find((s) => s.name.includes('沿用已配置的 DLL'));
  assert.ok(kept && kept.ok, '应报告「沿用已配置的 DLL（优先）」');

  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(env.includes(dll), '.env 里应保留自制 DLL 路径');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('WX_INSTALLER_PATH 允许被界面写入', () => {
  assert.ok(EDITABLE_ENV.has('WX_INSTALLER_PATH'));
});
