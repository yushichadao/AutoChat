import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 界面控件规范检查。
 *
 * 硬规则：**界面上不允许出现浏览器默认的裸勾选框**。
 * 布尔设置一律用开关（.swrow / role="switch"），危险动作用按钮 + 二次确认。
 *
 * 这条规则用测试守住，避免以后有人又写回 `<input type="checkbox">`。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, '..', 'src', 'gui', 'ui');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|html)$/i.test(name)) out.push(full);
  }
  return out;
}

test('界面源码里没有裸勾选框（禁用原生 checkbox）', () => {
  const files = walk(UI_DIR);
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const isWidget = path.basename(f) === 'widgets.js';
    // widgets.js 里允许出现「代理用」的原生元素，但必须带豁免注释；
    // 其余任何文件都不允许写 type="checkbox"。
    const hits = text.split('\n').filter((line) => {
      if (!/type\s*=\s*["']checkbox["']/.test(line)) return false;
      if (isWidget && /豁免|allow-checkbox/.test(line)) return false;
      return true;
    });
    if (hits.length) bad.push(path.relative(UI_DIR, f) + ' → ' + hits.join(' | '));
  }
  assert.deepEqual(bad, [], '发现裸勾选框：' + bad.join(' ; '));
});

test('开关控件带无障碍属性与状态文字', () => {
  const w = fs.readFileSync(path.join(UI_DIR, 'js', 'widgets.js'), 'utf8');
  assert.match(w, /role="switch"/);
  assert.match(w, /aria-checked/);
  assert.match(w, /sw-state/);
  assert.match(w, /seg-item/);
  assert.match(w, /data-act/);
});
