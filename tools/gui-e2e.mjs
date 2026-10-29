/**
 * 无头浏览器 GUI E2E（临时验证脚本，非 node --test 用例）。
 *
 * 通过临时开关 AC_TEST_NOAUTH=1 跳过 GUI 配置器令牌校验，
 * 用本机 Edge 以无头方式打开配置器，验证方案 G 系列里能用 DOM/交互确认的项，并截图留档。
 * 不实际执行任何写盘/卸载/修复动作（危险操作一律 dismiss 确认框）。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGui } from '../src/gui/server.js';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = 8801;
const shotDir = path.join(ROOT, 'test', 'artifacts', 'gui');

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail: String(detail) });

process.env.AC_TEST_NOAUTH = '1';

// 1) 以纯服务方式启动 GUI（window:false 不会打开真实浏览器窗口）
let gui;
try {
  gui = await startGui({ port: PORT, window: false });
} catch (e) {
  console.log('启动 GUI 失败：' + e.message);
  process.exit(2);
}
const base = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });

// 危险操作二次确认框：一律 dismiss，不实际执行
let dialogText = '';
page.on('dialog', async (d) => { try { dialogText = d.message(); } finally { await d.dismiss(); } });

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('#sidenav .navitem', { timeout: 15000 });

// G1 五区导航存在且文案完整
const navLabels = await page.$$eval('#sidenav .navitem', (els) => els.map((e) => e.textContent.trim()));
ok('G1 五区导航数量=5', navLabels.length === 5, 'navCount=' + navLabels.length);
ok('G1 导航文案完整', /开始配置/.test(navLabels.join()) && /高级设置/.test(navLabels.join()), navLabels.join(' | '));

// 逐个点击导航，验证高亮切换 + 不报错
for (let i = 0; i < navLabels.length; i++) {
  const items = await page.$$('#sidenav .navitem');
  await items[i].click();
  await page.waitForTimeout(120);
}
const hasActive = await page.$$eval('#sidenav .navitem', (els) => els.some((e) => e.classList.contains('active')));
ok('G1 导航点击切换高亮', hasActive);

// G5 控件库：界面无「可见的原生勾选框」
const visibleCheckbox = await page.$$eval('input[type=checkbox]', (els) =>
  els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length
);
ok('G5 无可见原生checkbox', visibleCheckbox === 0, 'visible=' + visibleCheckbox);

// G2/G11 徽标配色区分：注入"运行中"态，使 ok / warn 徽标均存在且可比对（避免测试环境无 ok 态而误判）。
// 说明：style.css 已为 .badge.ok 定义绿色背景(--ok-bg:#eafaf0)、.badge.warn 定义琥珀底(--warn-bg)、
// .badge.bad 定义红底(--bad-bg)，配色本身正确；此处仅做确定性校验，不依赖真实助手是否在跑。
const realState = await page.evaluate(async () => (await fetch('/api/state')).json()).catch(() => null);
const runState = realState ? JSON.parse(JSON.stringify(realState)) : {};
runState.running = true;
runState.autoReply = true;
runState.autoPaused = false;
runState.config = Object.assign({}, runState.config, { ai: Object.assign({}, (runState.config && runState.config.ai) || {}, { enabled: true }) });
runState.gate = Object.assign({}, runState.gate, { paused: false });
runState.modelStatus = Object.assign({}, runState.modelStatus, { state: 'warn' }); // 模型未测→warn，与服务/自动回复的 ok 形成对比
runState.service = Object.assign({}, runState.service, { running: true });
await page.route('**/api/state*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(runState) }));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// G11 状态三态徽标存在（服务 ok / 自动回复 ok / 模型 warn，共 3 枚）
const badges = await page.$$eval('.badge', (els) => els.map((e) => ({ id: e.id, text: e.textContent.trim(), cls: e.className })));
ok('G11 三态徽标存在(3)', badges.length === 3, JSON.stringify(badges.map((b) => b.text + ':' + b.cls)));

// G10 危险操作二次确认框（卸载）：点击应弹出 confirm，且文案含关键风险提示
const hasUninstall = await page.$('[data-act="uninstall"]');
ok('G10 卸载按钮存在', !!hasUninstall);
if (hasUninstall) {
  try { await page.click('[data-act="uninstall"]', { timeout: 3000 }); } catch (e) { /* 自动刷新导致重绘时忽略 */ }
  await page.waitForTimeout(300);
}
ok('G10 卸载有二次确认框', !!hasUninstall && /卸载|自启|快捷方式|version\.dll/i.test(dialogText), dialogText.slice(0, 60));

// G2 徽标 ok 态应有专属绿色（非默认灰 softBg）；G11 徽标状态须可区分（ok≠warn）
const badgeOkEl = await page.$('.badge.ok');
const badgeOkBg = badgeOkEl ? await badgeOkEl.evaluate((e) => getComputedStyle(e).backgroundColor) : '';
const badgeWarnEl = await page.$('.badge.warn');
const badgeWarnBg = badgeWarnEl ? await badgeWarnEl.evaluate((e) => getComputedStyle(e).backgroundColor) : '';
// "默认灰"基准：用临时元素读取 --soft 变量值（运行时徽标必带状态类，不能直接取基类）
const softBg = await page.evaluate(() => {
  const d = document.createElement('div');
  d.style.background = 'var(--soft)';
  document.body.appendChild(d);
  const bg = getComputedStyle(d).backgroundColor;
  d.remove();
  return bg;
});
ok('G2 徽标ok态有高亮(非默认灰)', !!badgeOkEl && !!badgeOkBg && badgeOkBg !== softBg, `ok=${badgeOkBg} soft=${softBg}`);
ok('G11 徽标状态可区分', !!badgeOkEl && !!badgeWarnEl && badgeOkBg !== badgeWarnBg, `ok=${badgeOkBg} warn=${badgeWarnBg}`);

await page.unroute('**/api/state*');

// G3 间距/层级：卡片有正常内边距（不应拥挤/为 0）
const cardPad = await page.$eval('.card', (e) => parseFloat(getComputedStyle(e).paddingTop) || 0);
ok('G3 卡片有内边距', cardPad > 0, 'cardPad=' + cardPad + 'px');

// G7 模型卡"当前生效"常驻显示
const hasLiveLine = await page.$$eval('#sec-model *', (els) => els.some((e) => /当前生效/.test(e.textContent)));
ok('G7 模型卡常驻显示当前生效', hasLiveLine);

// G8 密钥相关提示存在（已配置/未配置状态文案）
const hasSecretHint = await page.$$eval('#sec-model *', (els) => els.some((e) => /密钥/.test(e.textContent)));
ok('G8 密钥状态提示存在', hasSecretHint);

// G9 会话开关文案（或空态提示）
const hasChatSwitch = await page.$$eval('#sec-adv *', (els) =>
  els.some((e) => /关掉后这个会话完全不参与/.test(e.textContent) || /还没有单独配置的会话/.test(e.textContent))
);
ok('G9 会话开关文案/空态', hasChatSwitch);

// G14 输入中不重绘（回归 U6）：聚焦输入框打字，跨过 4s 自动刷新周期，文字仍在
const probe = await page.$('#aiModel');
if (probe) {
  await probe.click();
  await probe.type('gpt-test-model', { delay: 10 });
  await page.waitForTimeout(4500); // 跨过 main.js 的 4s 自动刷新
  const val = await page.inputValue('#aiModel');
  ok('G14 输入中不重绘(文字保留)', val.includes('gpt-test-model'), 'val=' + val);
} else {
  ok('G14 输入中不重绘', false, '找不到 #aiModel');
}

// G16 无障碍：开关控件有 role=switch + tabindex + aria-checked
const sw = await page.$('.swrow');
const swA11y = sw
  ? await sw.evaluate((e) => e.getAttribute('role') === 'switch' && e.getAttribute('tabindex') === '0' && e.hasAttribute('aria-checked'))
  : false;
ok('G16 开关控件ARIA属性', swA11y);

// G19 数字输入隐藏步进箭头（避免误触改值）：appearance 应为 none
const numInput = await page.$('input[type=number]');
const noSpinner = numInput
  ? await numInput.evaluate((e) => {
      const s = getComputedStyle(e);
      return ['none'].includes(s.webkitAppearance) || ['none'].includes(s.appearance);
    })
  : false;
ok('G19 数字输入隐藏步进箭头', numInput ? noSpinner : false, 'found=' + !!numInput);

// G20 自定义下拉存在（展开箭头示意）
const dd = await page.$('.dropdown .dd-toggle');
ok('G20 自定义下拉组件存在', !!dd);

// G3/G4 390px 窄视口无横向溢出
await page.setViewportSize({ width: 390, height: 620 });
await page.waitForTimeout(250);
const overflow = await page.evaluate(() => {
  const de = document.documentElement;
  return { scrollW: de.scrollWidth, clientW: de.clientWidth };
});
ok('G4 390px无横向溢出', overflow.scrollW <= overflow.clientW + 1, JSON.stringify(overflow));

// 截图留档
fs.mkdirSync(shotDir, { recursive: true });
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shotDir, 'desktop.png'), fullPage: true });

// 逐区独立截图（视觉自检每个分区布局，避免整页一图看不清）
const secIds = ['sec-onboard', 'sec-wechat', 'sec-model', 'sec-start', 'sec-adv'];
for (const id of secIds) {
  const el = await page.$('#' + id);
  if (el) {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await el.screenshot({ path: path.join(shotDir, `${id}.png`) });
  }
}

// G21 自定义下拉展开：点击来源下拉，验证 .dropdown.open + 菜单可见，并截图展开态
const ddToggle = await page.$('[data-dd-toggle]');
if (ddToggle) {
  await ddToggle.click();
  await page.waitForTimeout(200);
}
const ddOpen = await page.$eval('.dropdown.open', (e) => e.classList.contains('open')).catch(() => false);
const ddMenuVisible = ddOpen
  ? await page.$eval('.dropdown.open .dd-menu', (e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0).catch(() => false)
  : false;
ok('G21 自定义下拉可展开', !!ddOpen && ddMenuVisible);
if (ddOpen) {
  await page.screenshot({ path: path.join(shotDir, 'dropdown-open.png') });
  await page.click('body');
  await page.waitForTimeout(150);
}

// 移动端截图
await page.setViewportSize({ width: 390, height: 620 });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shotDir, 'mobile-390.png'), fullPage: true });

// G17 动效：存在过渡动画（卡片/导航/按钮/下拉菜单任一有 transition）
const hasTransition = await page.evaluate(() => {
  for (const sel of ['.card', '.navitem', '.btn', '.dd-menu', '.badge']) {
    const el = document.querySelector(sel);
    if (el) {
      const t = getComputedStyle(el).transitionDuration;
      if (t && t !== '0s') return true;
    }
  }
  return false;
});
ok('G17 存在过渡动效', hasTransition);

// G18 按钮密度：各分区 button 计数（自检是否某区按钮过杂）
const perSec = {};
for (const id of secIds) {
  const el = await page.$('#' + id);
  if (el) {
    perSec[id] = await el.$$eval('button', (els) =>
      els.filter((b) => {
        // 排除控件库内部的选项/附属按钮，只统计独立操作按钮
        if (b.classList.contains('seg-item')) return false;
        if (b.classList.contains('chip')) return false;
        if (b.closest('.dropdown')) return false;
        if (b.classList.contains('secret-reveal')) return false;
        if (b.hasAttribute('data-filebtn')) return false;
        return true;
      }).length
    );
  }
}
const maxBtns = Math.max(0, ...Object.values(perSec));
ok('G18 各分区独立操作按钮密度合理(<=15)', maxBtns <= 15, JSON.stringify(perSec));

// G23 中文排版环境：lang + 字体
const lang = await page.$eval('html', (e) => e.getAttribute('lang') || '');
const font = await page.$eval('body', (e) => getComputedStyle(e).fontFamily);
ok('G23 中文排版环境', /zh/i.test(lang), `lang=${lang} font=${font.slice(0, 40)}`);

// ---- G6/G12/G15：用 route 注入构造态，覆盖空态/错误标红/降级渲染 ----
// 复用前面已抓取的 realState（G2/G11 段确认页面后、解除 state 路由前 fetch 的真实态）派生 fixture。

// G6 空态 + G15 降级渲染不崩：state.running=false、logs.exists=false
const emptyState = realState ? JSON.parse(JSON.stringify(realState)) : {};
emptyState.running = false;
emptyState.autoReply = false;
emptyState.autoPaused = false;
emptyState.config = Object.assign({}, emptyState.config, { ai: (emptyState.config && emptyState.config.ai) || {} });
if (emptyState.modelStatus) emptyState.modelStatus.state = 'unconfigured';
emptyState.service = Object.assign({}, emptyState.service, { running: false });

await page.route('**/api/state*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyState) }));
await page.route('**/api/logs*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: false }) }));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const emptyText = await page.$$eval('#main', (els) => els.some((e) => /未运行|未启用|未配置|未测试|还没有|尚未/.test(e.textContent)));
ok('G6 空态/未配置提示出现', emptyText);
const badgeNoRun = await page.$eval('.badge', (e) => e.textContent.trim()).catch(() => '');
ok('G6 未运行状态徽标', /未运行|未启用|未配置|未测试/.test(badgeNoRun), badgeNoRun);
const secsOk = await page.$$eval('.sec', (els) => els.length >= 4).catch(() => false);
ok('G15 空态下分区仍渲染不崩', secsOk);
await page.unroute('**/api/state*');
await page.unroute('**/api/logs*');

// G12 错误日志行标红：注入含 ERROR/WARN 的日志
await page.route('**/api/logs*', (r) =>
  r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      exists: true,
      lines: ['ERROR 连接模型失败 ECONNREFUSED 127.0.0.1:9999', 'WARN 模型响应缓慢，已自动重试', 'INFO 助手已启动'],
    }),
  })
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const reloadBtn = await page.$('#btnReloadLogs');
if (reloadBtn) {
  await reloadBtn.click();
  await page.waitForTimeout(300);
}
const g12 = await page
  .$eval('.logline.bad', (e) => ({ color: getComputedStyle(e).color, text: e.textContent }))
  .catch(() => null);
ok('G12 错误日志行标红', !!g12 && /rgb\(185, 28, 28\)/.test(g12.color), JSON.stringify(g12));
await page.unroute('**/api/logs*');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(200);

// G13（部分）：GUI→后端写配置契约正确（密钥失焦自动保存 /api/env，拦截避免真实改写 .env）。
// 该路径把"界面字段"映射到 env 键（CLI 也读同一份 .env），正是 G13「CLI↔GUI 同一份配置」一致性的核心。
let envBody = null;
let envRequested = false;
page.on('request', (req) => { if (/api\/env/.test(req.url())) envRequested = true; });
await page.route('**/api/env*', (r) => {
  if (r.request().method() === 'POST') {
    envBody = r.request().postData() || '';
    return r.fulfill({ contentType: 'application/json', body: '{}' });
  }
  return r.fallback();
});
const secLocator = page.locator('input[data-secret]').first();
let g13 = false;
let g13Detail = (await secLocator.count()) ? 'input-found' : 'no-secret-input';
if (await secLocator.count()) {
  await secLocator.fill('sk-dummytest-key123');
  await secLocator.blur();
  await page.waitForTimeout(600);
  try {
    const obj = JSON.parse(envBody || '{}');
    g13 = !!(obj.values && obj.values.AI_API_KEY !== undefined);
  } catch (e) {
    g13 = false;
  }
  g13Detail = envBody ? envBody.slice(0, 120) : (envRequested ? 'requested-but-not-captured' : 'no-request');
}
ok('G13 保存契约(GUI字段→env键映射)', g13, g13Detail);
await page.unroute('**/api/env');

// G24 高级设置：自消息识别（同号测试）卡片渲染 + 实时账号只读展示 + 分段契约
const advText = await page.$eval('#sec-adv', (e) => e.textContent).catch(() => '');
ok('G24 高级设置含自消息识别卡片', /自消息识别（同号测试）/.test(advText));
const hasModeSel = await page.$('select[data-select="wechat.selfMode"]');
ok('G24 识别模式下拉存在', !!hasModeSel);
const hasAccountBox = await page.$('#sec-adv .readbox');
ok('G24 当前登录账号只读展示存在', !!hasAccountBox);
const hasSeg = await page.$('.segrow[data-bind="wechat.pollExcludeSelf"]');
ok('G24 排除自己分段控件存在', !!hasSeg);
ok('G24 已移除手动输入selfId框', (await page.$('#selfIdInput')) === null);
// 分段契约：点击「不排除」应 POST WX_POLL_EXCLUDE_SELF=0
await page.unroute('**/api/env*').catch(() => {});
let envPosts = [];
await page.route('**/api/env*', (r) => {
  if (r.request().method() === 'POST') envPosts.push(r.request().postData() || '');
  return r.fulfill({ contentType: 'application/json', body: '{}' });
});
if (hasSeg) { const items = await hasSeg.$$('.seg-item'); if (items[1]) { await items[1].click(); await page.waitForTimeout(250); } }
await page.unroute('**/api/env*').catch(() => {});
const g24b = envPosts.some((p) => { try { return JSON.parse(p).values.WX_POLL_EXCLUDE_SELF === '0'; } catch (e) { return false; } });
ok('G24 分段契约(排除自己→WX_POLL_EXCLUDE_SELF=0)', g24b, envPosts.join(' | ').slice(0, 140));

// G29 禁用 / 进行中的按钮必须有可见的置灰样式（以前 disabled 完全没有视觉变化，用户以为还能点）
const disStyle = await page.evaluate(() => {
  const b = document.createElement('button');
  b.className = 'btn';
  b.disabled = true;
  b.textContent = 'x';
  document.body.appendChild(b);
  const s = getComputedStyle(b);
  const out = { bg: s.backgroundColor, color: s.color, cursor: s.cursor };
  b.remove();
  return out;
});
ok(
  'G29 禁用按钮有置灰样式',
  disStyle.bg !== 'rgb(255, 255, 255)' && disStyle.cursor !== 'pointer',
  JSON.stringify(disStyle)
);

// I12/I13 卸载语义：界面必须区分「卸载服务」与「卸载软件」，并提供移入回收站的勾选项
const bodyText = await page.evaluate(() => document.body.innerText);
ok('I13 卸载卡提供「移入回收站」选项', /移入回收站/.test(bodyText));
ok('I12 卸载卡声明「只卸载服务、程序仍在」', /程序本体|仍在磁盘上|才叫/.test(bodyText));

// JS 运行时错误汇总（G15 降级渲染不崩由全程 pageerror 监控覆盖）
ok('无JS运行时错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' || '));

// G31 覆盖提示：注入「某会话单独配了模型」，会话行要标出覆盖并给出「全局 → 此会话」对照。
// 放在 JS 错误汇总之后独立跑，避免污染上面的错误计数。
const ovrState = realState ? JSON.parse(JSON.stringify(realState)) : {};
ovrState.chats = { 'cov@chatroom': { name: '覆盖测试群', model: 'gpt-4o-mini' } };
ovrState.config = Object.assign({}, ovrState.config, {
  ai: Object.assign({}, (ovrState.config && ovrState.config.ai) || {}, { model: 'deepseek-flash', enabled: true }),
});
await page.route('**/api/state*', (r) =>
  r.fulfill({ contentType: 'application/json', body: JSON.stringify(ovrState) })
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const ovrTagEl = await page.$('.tag.ovr');
const ovrTip = ovrTagEl ? await ovrTagEl.getAttribute('title') : '';
ok('G31 会话行标出覆盖标记', !!ovrTagEl, 'title=' + String(ovrTip).slice(0, 80));
ok(
  'G31 覆盖提示含「全局→此会话」对照',
  /全局/.test(ovrTip || '') && /此会话/.test(ovrTip || ''),
  ovrTip || ''
);
const ovrPageText = await page.evaluate(() => document.body.innerText);
ok('G31 全局卡提示被覆盖的会话数', /个会话在「按会话配置」里单独配了/.test(ovrPageText));
await page.unroute('**/api/state*').catch(() => {});

// G33 多消息合批回复（全局 + 按会话覆盖）：开关存在，且切到 batch 时 UI 高亮「多消息合批」
const hasGlobalMode = await page.$('[data-bind="ai.replyMode"]');
ok('G33 全局回复模式开关存在', !!hasGlobalMode);
const chatRowsG33 = await page.$$('.chatrow');
if (chatRowsG33.length) {
  const anyOverride = await page.$$eval('.chatrow .segrow', (rows) =>
    rows.some((r) => (r.getAttribute('data-bind') || '').includes('.replyMode'))
  );
  ok('G33 会话行可覆盖回复模式', anyOverride);
} else {
  ok('G33 会话行可覆盖回复模式', true, '无会话行，跳过覆盖检查');
}
// 注入 batch 模式，确认全局段选中「多消息合批」
const rmState = realState ? JSON.parse(JSON.stringify(realState)) : {};
rmState.config = Object.assign({}, rmState.config, {
  ai: Object.assign({}, (rmState.config && rmState.config.ai) || {}, { replyMode: 'batch' }),
});
await page.route('**/api/state*', (r) =>
  r.fulfill({ contentType: 'application/json', body: JSON.stringify(rmState) })
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const rmOn = await page.$('[data-bind="ai.replyMode"] .seg-item.on');
const rmLabel = rmOn ? await rmOn.evaluate((e) => e.textContent.trim()) : '';
ok('G33 切到合批模式UI高亮多消息合批', rmLabel === '多消息合批', rmLabel);
await page.unroute('**/api/state*').catch(() => {});

const pass = results.filter((r) => r.ok).length;
console.log(`GUI-E2E ${pass}/${results.length} passed`);
for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
console.log('SHOTS=' + shotDir);

await browser.close();
if (gui && gui.server) gui.server.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
