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

test('开关控件带无障碍属性，且与分段切换同一套形态', () => {
  const w = fs.readFileSync(path.join(UI_DIR, 'js', 'widgets.js'), 'utf8');
  assert.match(w, /role="switch"/);
  assert.match(w, /aria-checked/);
  // 开关不再是药丸滑块（.sw / .sw-knob），改成「关 / 开」两段，和分段选择同一套语言
  assert.match(w, /data-sw-val/);
  assert.match(w, /seg-item/);
  assert.ok(!/class="sw"/.test(w), '不该再渲染药丸滑块');
  assert.match(w, /data-act/);
});

test('开关样式表里没有残留的药丸滑块规则', () => {
  const css = fs.readFileSync(path.join(UI_DIR, 'style.css'), 'utf8');
  assert.ok(!/\.sw-knob/.test(css), '旧的滑块圆点样式应删掉');
  assert.match(css, /\.seg-sw/, '开关应有自己的分段尺寸规则');
});

test('按钮文案只写动作，不写括号解释', () => {
  // 用户明确要求：按钮上不写「一键修复（哪里不对补哪里）」这类括号补充。
  // 解释放按钮旁边的说明文字里，别塞进可点区域。
  const bad = [];
  for (const f of walk(UI_DIR)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      // 只看「<button ...>文字<」这一行里的按钮文本
      const m = line.match(/<button\b[^>]*>([^<]*)</);
      if (!m) continue;
      // 按钮文本是动态拼进去的（W.esc(...) 之类）就不在这里判，只管写死的文案
      if (/[\w$]\s*\(/.test(m[1])) continue;
      if (/（[^）]*）|\([^)]*\)/.test(m[1])) bad.push(path.basename(f) + ' → ' + m[1].trim());
    }
  }
  assert.deepEqual(bad, [], '按钮文案里出现了括号解释：' + bad.join(' ; '));
});

test('次级按钮（ghost）必须有可见描边，且字色不能像 disabled', () => {
  const css = fs.readFileSync(path.join(UI_DIR, 'style.css'), 'utf8');
  const rule = css.match(/\.btn\.ghost\{([^}]*)\}/);
  assert.ok(rule, 'style.css 里应有 .btn.ghost 规则');
  assert.ok(!/border-color\s*:\s*transparent/.test(rule[1]), 'ghost 按钮不能是透明描边（会看起来像一段文字）');
  assert.match(rule[1], /border-color\s*:\s*var\(--line\)/, 'ghost 按钮应有浅色描边');
  assert.ok(!/color\s*:\s*var\(--dim\)/.test(rule[1]), 'ghost 按钮不要用灰字（和 disabled 态撞脸）');
});
