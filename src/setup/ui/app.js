/* AutoChat 图形化配置器（前端） */
const $ = (s, r = document) => r.querySelector(s);
const token = new URLSearchParams(location.search).get('token') || '';
let state = null;
/* 模型连接真实状态：未探测/已连上/未连上，徽标据此显示，避免“已启用”却连不上的错误状态 */
let modelStatus = { probed: false, state: 'untested', model: '' };

/* 服务商预设表（启动时拉一次） */
let providers = { groups: [] };
/* 本机扫到的模型服务 */
let discovered = [];
/* 安装/卸载步骤日志：存模块变量，重绘后保留；为空时不渲染（避免一根空灰条） */
let installLogText = '';
/* 用户正在填的内容：界面重绘时从这里回填，避免输入被冲掉 */
const form = {
  ai: { base: '', key: '', model: '', providerId: '', modelOptions: [], result: null, review: [] },
};

async function api(p, opts = {}) {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(`${p}${sep}token=${encodeURIComponent(token)}`, {
    headers: { 'Content-Type': 'application/json', 'X-AutoChat-Token': token },
    ...opts,
  });
  return r.json();
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function refresh() {
  state = await api('/api/state');
  const a = state.config.ai;
  // 只有用户还没动过的时候才用配置回填，避免覆盖正在输入的内容
  if (!form.ai.base && a.baseUrl) form.ai.base = a.baseUrl;
  if (!form.ai.model && a.model) form.ai.model = a.model;
  if (form.ai.atNames === undefined) form.ai.atNames = (a.groupAtNames || []).join(',');
  if (form.ai.triggerPrefix === undefined) form.ai.triggerPrefix = a.triggerPrefix || '';
  if (form.ai.personaFile === undefined) form.ai.personaFile = a.personaFile || '';
  if (!form.ai.providerId) {
    const all = (providers.groups || []).flatMap((g) => g.items);
    const hit = all.find((p) => p.baseUrl && a.baseUrl && p.baseUrl === a.baseUrl);
    form.ai.providerId = hit ? hit.id : 'custom';
  }
  // 模型连接徽标：仅当还没真正测过时，按配置开关给出“未测试/未启用”初始态
  if (!modelStatus.probed) {
    modelStatus.state = a.enabled ? 'untested' : 'disabled';
    modelStatus.model = '';
  }
  render();
}

/** 载入服务商预设与本机已启动的服务。 */
async function loadProviders() {
  providers = await api('/api/ai/providers');
  const d = await api('/api/ai/discover');
  discovered = d.found || [];
}

function card(title, inner, tag = '') {
  const map = { '必须': 'must', '推荐': 'rec', '可选': 'opt' };
  const tagHtml = tag ? `<span class="card-tag tag-${map[tag] || ''}">${esc(tag)}</span>` : '';
  return `<section class="card"><h2>${title}${tagHtml}</h2>${inner}</section>`;
}

function field(label, value, id, type = 'text', ph = '', bind = '', listId = '') {
  return `<label>${label}<input id="${id}" type="${type}" value="${esc(value ?? '')}" placeholder="${esc(ph)}" autocomplete="off"${bind ? ` data-bind="${esc(bind)}"` : ''}${listId ? ` list="${esc(listId)}"` : ''}></label>`;
}

function numField(label, value, id, bind = '') {
  return `<label>${label}<input id="${id}" type="number" value="${esc(value ?? 0)}"${bind ? ` data-bind="${esc(bind)}"` : ''}></label>`;
}

/** 文件路径输入 + 「浏览…」原生文件选择器：选好后由 bind() 里的上传逻辑存到工作区。 */
function filePickerRow(label, id, value, bind = '') {
  return `<label>${label}
    <div class="filepick">
      <input id="${id}" type="text" value="${esc(value ?? '')}" placeholder="./data/persona.md" data-bind="${esc(bind)}" autocomplete="off">
      <button type="button" class="btn" data-filebtn="${esc(id)}">浏览…</button>
      <input type="file" id="${id}File" accept=".md,.txt,.json" hidden>
    </div></label>`;
}

function gateCard() {
  const paused = state.gate.paused;
  const hardOff = state.config.ai.masterSwitch;
  return card(
    '自动回复控制',
    `<p class="hint">机器人要真正回消息，必须同时满足：① 服务在跑 ② 没被暂停 ③ 没硬关总开关。任一关掉都不回。</p>
     <div class="status-grid">
       <div class="status-item ${state.running ? 'ok' : 'bad'}"><b>服务</b><span>${state.running ? '运行中' : '未运行'}</span></div>
       <div class="status-item ${paused ? 'bad' : 'ok'}"><b>自动回复</b><span>${paused ? '已暂停（顶栏可恢复）' : '运行中'}</span></div>
       <div class="status-item ${hardOff ? 'bad' : 'ok'}"><b>硬总开关</b><span>${hardOff ? '已关（配置层，重启也不回）' : '开'}</span></div>
     </div>
     <p class="keyhint">暂停 / 恢复自动回复用顶栏的「暂停自动回复」按钮（运行层，不用重启）。硬总开关在下方 AI 卡片里（配置层）。</p>`,
    '可选'
  );
}

function acctCard() {
  const w = state.config.wechat;
  return card(
    '小号准备（重要）',
    `<p class="hint">电脑微信必须扫码登录，所以<b>电脑上登录的号 == 手机上的号</b>。如果就用这个号在群里提问，机器人分不清「你发的」和「它发的」，会把你的话当噪音丢掉 —— 表现就是「机器人装死」。</p>
     <ol class="steps">
       <li>手机上准备<b>另一个</b>微信号（小号即可，别用主号）</li>
       <li>电脑微信退出登录 → 扫码登录<b>这个小号</b>（主号在手机上照常用，不会被挤占）</li>
       <li>把小号拉进目标群；跑 <code>autochat doctor</code>，看「小号检查」是否变绿</li>
       <li>回到本页把「自消息判定」改成 <code>sender</code>（最稳），或保留 <code>id</code></li>
     </ol>
     <div class="grid">
       <label>自消息判定<select id="selfMode">
         <option value="sender"${w.selfMode === 'sender' ? ' selected' : ''}>sender（按 wxid 过滤，小号用）</option>
         <option value="id"${w.selfMode === 'id' ? ' selected' : ''}>id（按已发消息 id 过滤，同号用）</option>
       </select></label>
       ${field('本机 wxid', w.selfId, 'selfId', 'text', 'wxid_xxx')}
       ${field('监听会话', w.pollChats.join(','), 'pollChats', 'text', '123456@chatroom')}
     </div>
     <div class="row end"><button class="btn primary" id="btnSaveWechat">保存会话配置</button></div>`, '必须'
  );
}

function aiCard() {
  const a = state.config.ai;
  const f = form.ai;
  const p = currentProvider();
  const groups = providers.groups || [];
  const keySet = Boolean(state.env.AI_API_KEY);

  // 醒目引导：AutoChat 不启动模型，必须先让自己电脑上的模型服务跑起来
  const bootWarn = `<div class="guide-warn">⚠ <b>先让自己电脑上的模型服务跑起来</b>：AutoChat 不负责启动模型。本地模型（Ollama / LM Studio 等）请先在系统里把它跑起来并监听端口（11434 / 1234 等），再点「测试一下」。点「本机发现」能自动找到已经启动的服务。</div>`;

  const step1 = `
    <div class="wiz-step">
      <h3><span class="n">1</span>模型从哪来？</h3>
      <p class="hint">选一个就行，地址和模型名会自动填好。</p>
      ${discovered.length
        ? `<div class="picks">
            ${discovered
              .map(
                (d) => `<div class="pick${f.base === d.baseUrl ? ' sel' : ''}" data-pick-base="${esc(d.baseUrl)}" data-pick-model="${esc(d.models[0] || '')}" data-pick-id="${esc(d.providerId)}">
                  <div class="t">🖥 ${esc(d.name)} <span class="tag live">已启动</span></div>
                  <div class="d">${esc(d.baseUrl)}｜发现 ${d.models.length} 个模型：${esc(d.models.slice(0, 3).join('、'))}${d.models.length > 3 ? ' …' : ''}</div>
                </div>`
              )
              .join('')}
          </div>`
        : `<p class="hint">本机没扫到已启动的模型服务（Ollama / LM Studio 之类）。你也可以从下面选一个云端服务，或自己填地址。</p>`}
      ${groups
        .map(
          (g) => `<div class="picks-title">${esc(g.group)}</div>
          <div class="picks">
            ${g.items
              .map(
                (it) => `<div class="pick${f.providerId === it.id ? ' sel' : ''}" data-pick-id="${esc(it.id)}">
                  <div class="t">${esc(it.name)}</div>
                  <div class="d">${it.needsKey ? '需要密钥' : '不需要密钥'}｜${esc(it.baseUrl || '自己填地址')}</div>
                </div>`
              )
              .join('')}
          </div>`
        )
        .join('')}
    </div>`;

  const step2 = `
    <div class="wiz-step">
      <h3><span class="n">2</span>填好连接信息</h3>
      <div class="grid">
        ${field('接口地址（一般以 /v1 结尾）', f.base, 'aiBaseUrl', 'text', 'http://127.0.0.1:11434/v1', 'ai.base')}
        ${field(`密钥${keySet ? '（已配置，留空表示不改）' : '（本地模型不用填）'}`, '', 'aiApiKey', 'password', 'sk-…', 'ai.key')}
        <label>模型名（默认从下拉选；选「其他…」才可手输）
          <div class="combo" id="modelCombo">
            <input id="aiModel" type="text" value="${esc(f.model)}" placeholder="${esc('qwen2.5:7b')}" data-bind="ai.model" autocomplete="off" readonly>
            <button type="button" class="combo-toggle" id="btnModelToggle" aria-label="展开模型列表">▾</button>
            <div class="combo-panel" id="modelPanel" hidden></div>
          </div>
        </label>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn" id="btnPullModels">拉取模型列表</button>
        <button class="btn primary" id="btnTestAi">测试一下能不能用</button>
        ${f.review && f.review.length ? `<span class="keyhint">${f.review.map((t) => esc(t.text)).join(' ')}</span>` : ''}
      </div>
      ${f.result ? aiResult(f.result) : ''}
      ${p ? guideBox(p) : ''}
    </div>`;

  const step3 = `
    <div class="wiz-step">
      <h3><span class="n">3</span>要不要让它回消息？</h3>
      <div class="grid">
        <label class="chk"><input type="checkbox" id="aiEnabled"${a.enabled ? ' checked' : ''}>启用 AI 回复（关掉就只收消息不回复）</label>
        <label class="chk"><input type="checkbox" id="aiMaster"${a.masterSwitch ? ' checked' : ''}>硬总开关（配置层：关掉后重启服务也绝不自动回复）</label>
      </div>
    </div>`;

  const adv = `
    <details class="adv">
      <summary>高级设置（一般不用改）</summary>
      <div class="adv-body">
        <div class="grid">
          <label>群聊什么时候回<select id="aiGroupReply">
            <option value="mention"${a.groupReply === 'mention' ? ' selected' : ''}>群里 @ 我才回</option>
            <option value="always"${a.groupReply === 'always' ? ' selected' : ''}>群里说的话都回</option>
            <option value="never"${a.groupReply === 'never' ? ' selected' : ''}>群里一律不回</option>
          </select></label>
          ${field('群里 @ 我时认可的称呼（逗号分隔）', f.atNames ?? '', 'aiAtNames', 'text', '小助手,机器人', 'ai.atNames')}
          ${field('触发前缀（留空表示不需要）', f.triggerPrefix ?? '', 'aiTriggerPrefix', 'text', '小助手', 'ai.triggerPrefix')}
          ${numField('同一会话两次回复最少间隔(毫秒)', f.cooldown ?? a.cooldownMs, 'aiCooldown', 'ai.cooldown')}
          ${numField('每小时最多回复几条', f.maxPerHour ?? a.maxPerHour, 'aiMaxPerHour', 'ai.maxPerHour')}
          ${numField('同时最多处理几条', f.maxConcurrent ?? a.maxConcurrent, 'aiMaxConcurrent', 'ai.maxConcurrent')}
          ${numField('回答长度上限(字)', f.maxTokens ?? a.maxTokens, 'aiMaxTokens', 'ai.maxTokens')}
          ${numField('发挥程度 0~2', f.temperature ?? a.temperature, 'aiTemperature', 'ai.temperature')}
          ${numField('等待模型回答的超时(毫秒)', f.timeoutMs ?? a.timeoutMs, 'aiTimeout', 'ai.timeoutMs')}
          ${filePickerRow('人设文件（可选）', 'aiPersonaFile', f.personaFile ?? '', 'ai.personaFile')}
        </div>
      </div>
    </details>`;

  return card(
    'AI 助手（接模型）',
    `<p class="hint">三步：① 选模型从哪来 → ② 填地址/密钥 → ③ 点「测试一下」确认能用，再保存。</p>
     ${bootWarn}
     ${step1}${step2}${step3}${adv}
     <div class="row end"><button class="btn primary big" id="btnSaveAi">保存 AI 配置</button></div>
     <p class="keyhint">保存后要重启服务才生效（顶栏「停止服务」→ 再「启动服务」）。</p>`,
    '必须'
  );
}

/* ── 模型名下拉：自绘面板，分「本地已有 / 云端已拉取」两组 ── */
function comboItem(m) {
  return `<div class="combo-item" data-model="${esc(m)}">${esc(m)}</div>`;
}
function openModelPanel() {
  const panel = document.getElementById('modelPanel');
  if (!panel) return;
  const local = [...new Set((discovered || []).flatMap((d) => d.models || []))];
  const cloud = (form.ai.modelOptions || []).filter((m) => !local.includes(m));
  let html = '';
  if (local.length) html += `<div class="combo-grp"><div class="combo-grp-h">本地已有（本机已启动的模型服务）</div>${local.map(comboItem).join('')}</div>`;
  if (cloud.length) html += `<div class="combo-grp"><div class="combo-grp-h">云端已拉取</div>${cloud.map(comboItem).join('')}</div>`;
  html += `<div class="combo-grp"><div class="combo-grp-h">其他</div><div class="combo-item combo-other" data-other="1">手动输入模型名…</div></div>`;
  panel.innerHTML = html;
  panel.hidden = false;
  for (const el of panel.querySelectorAll('[data-model]')) {
    el.onclick = () => {
      const input = document.getElementById('aiModel');
      if (input) { input.value = el.dataset.model; form.ai.model = el.dataset.model; }
      closeModelPanel();
    };
  }
  const other = panel.querySelector('[data-other]');
  if (other) other.onclick = () => {
    const input = document.getElementById('aiModel');
    if (input) { input.removeAttribute('readonly'); input.focus(); input.select(); }
    closeModelPanel();
  };
}
function closeModelPanel() {
  const panel = document.getElementById('modelPanel');
  if (panel) panel.hidden = true;
}

/** 按当前填的地址找到对应的预设，用于显示「一步步怎么做」。 */
function currentProvider() {
  const id = form.ai.providerId;
  const all = (providers.groups || []).flatMap((g) => g.items);
  return all.find((p) => p.id === id) || null;
}

/** 服务商的图文指引。 */
function guideBox(p) {
  return `<div class="guide">
    <div class="g-title">怎么用「${esc(p.name)}」</div>
    <ol>${p.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    ${p.keyHint ? `<div class="keyhint">🔑 ${esc(p.keyHint)}${p.keyUrl ? ` <a href="${esc(p.keyUrl)}" target="_blank" rel="noreferrer">去申请</a>` : ''}</div>` : ''}
    ${p.tip ? `<div class="g-tip">⚠ ${esc(p.tip)}</div>` : ''}
  </div>`;
}

/** 测试结果面板：说人话。 */
function aiResult(r) {
  if (r.ok) {
    return `<div class="res ok">
      <div class="r-title">✅ 成功！模型能用（耗时 ${r.ms} 毫秒）</div>
      <div class="r-detail">接口地址 ${esc(r.base)}｜模型 ${esc(r.model || '')}</div>
      <div class="r-reply">模型回答：${esc(r.reply)}</div>
    </div>`;
  }
  return `<div class="res bad">
    <div class="r-title">❌ ${esc(r.title || '没成功')}</div>
    <div class="r-detail">${esc(r.detail || r.error || '')}</div>
    ${r.error && r.detail ? `<div class="keyhint">技术细节：${esc(r.error)}</div>` : ''}
  </div>`;
}


function ctxCard() {
  const a = state.config.ai;
  const rows = (state.memory || [])
    .map(
      (m) => `<tr>
      <td><b>${esc(m.name || m.chatId)}</b>${m.name ? ` <span class="dim">${esc(m.chatId)}</span>` : ''}</td><td>${m.messages}</td>
      <td>${m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '-'}</td>
      <td>${esc((m.last || []).map((x) => `${x.role === 'user' ? '›' : '‹'} ${x.content}`).join(' | '))}</td>
      <td><button class="btn ghost" data-clear="${esc(m.chatId)}">清空</button></td></tr>`
    )
    .join('');
  return card(
    '上下文记忆',
    `<p class="hint">按会话隔离、落盘保存（重启不丢）、闲置超时自动清空。轮数与字符预算同时生效，先到先裁。</p>
     <div class="grid">
       ${numField('保留轮数', a.contextTurns, 'ctxTurns')}
       ${numField('闲置清空(分钟)', Math.round(a.contextTtlMs / 60000), 'ctxTtl')}
       ${numField('字符预算', a.contextMaxChars, 'ctxChars')}
     </div>
     <div class="row end"><button class="btn primary" id="btnSaveCtx">保存记忆设置</button></div>
     <table class="tbl"><thead><tr><th>会话</th><th>条数</th><th>最后更新</th><th>最近内容</th><th></th></tr></thead>
       <tbody>${rows || '<tr><td colspan="5">还没有上下文记录</td></tr>'}</tbody></table>
     <div class="row end"><button class="btn danger ghost" id="btnClearAllCtx">清空全部上下文</button></div>`, '推荐'
  );
}

function chatsCard() {
  const rows = Object.entries(state.chats || {})
    .map(
      ([id, c]) => `<tr>
      <td><b>${esc(c.name || id)}</b>${c.name ? ` <span class="dim">${esc(id)}</span>` : ` <span class="dim">${id.endsWith('@chatroom') ? '群' : '友'}</span>`}</td>
      <td><input type="checkbox" data-chat-enabled="${esc(id)}"${c?.enabled === false ? '' : ' checked'}></td>
      <td><select data-chat-reply="${esc(id)}">
        <option value=""${!c?.groupReply ? ' selected' : ''}>继承全局</option>
        <option value="always"${c?.groupReply === 'always' ? ' selected' : ''}>always</option>
        <option value="mention"${c?.groupReply === 'mention' ? ' selected' : ''}>mention</option>
        <option value="never"${c?.groupReply === 'never' ? ' selected' : ''}>never</option>
      </select></td>
      <td><input data-chat-persona="${esc(id)}" value="${esc(c?.personaFile || '')}" placeholder="./persona.md"></td>
      <td><button class="btn ghost" data-chat-del="${esc(id)}">移除</button></td></tr>`
    )
    .join('');
  return card(
    '按会话差异化',
    `<p class="hint">每个群/好友可以单独开关、单独群策略、单独人设。</p>
     <table class="tbl"><thead><tr><th>会话</th><th>启用</th><th>群策略</th><th>人设文件</th><th></th></tr></thead>
       <tbody>${rows || '<tr><td colspan="5">还没有配置会话</td></tr>'}</tbody></table>
     <div class="row"><input id="newChatId" placeholder="新会话 wxid，或输入群名/昵称关键字搜索">
       <button class="btn ghost" id="btnAddChat">按 wxid 加入</button>
       <button class="btn primary" id="btnSearchContacts">搜索联系人</button>
       <button class="btn primary" id="btnSaveChats">保存会话表</button></div>
     <div id="chatSearchResults" class="search-results"></div>`, '推荐'
  );
}

function installCard() {
  const st = state.installed || {};
  const marks = [
    `已安装：${st.installed ? '是' : '否'}`,
    `开机自启：${st.autoStart ? '已注册' : '未注册'}`,
    `桌面快捷方式：${st.shortcut ? '已创建' : '未创建'}`,
    `服务：${st.running ? `运行中 (pid ${st.pid})` : '未运行'}`,
  ].join('｜');
  return card(
    '安装 / 卸载',
    `<p class="hint">${esc(marks)}</p>
     <div class="row wrap">
      <label class="chk"><input type="checkbox" id="optAutostart">开机自启</label>
      <label class="chk"><input type="checkbox" id="optShortcut">桌面快捷方式</label>
      <label class="chk"><input type="checkbox" id="optDeployDll">部署 hook DLL（需管理员）</label>
     </div>
     <div class="row">
      <button class="btn primary" id="btnInstall">安装 / 应用</button>
      <button class="btn danger ghost" id="btnUninstall">卸载（保留配置）</button>
      <button class="btn danger ghost" id="btnUninstallPurge">彻底卸载（删配置与数据）</button>
     </div>
     ${installLogText ? `<pre class="mono" id="installLog">${esc(installLogText)}</pre>` : ''}`, '可选'
  );
}

async function renderDiag() {
  const d = await api('/api/diagnose');
  const items = (d.items || [])
    .map(
      (i) =>
        `<div class="check ${i.level}"><span class="lv">${i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✗'}</span>
         <span><b>${esc(i.name)}</b> ${esc(i.detail)}</span></div>`
    )
    .join('');
  const el = document.getElementById('diagBody');
  if (el) el.innerHTML = items;
}

function renderBadges(s) {
  $('#badgeService').textContent = s.running ? `服务运行中 (pid ${s.pid})` : '服务未运行';
  $('#badgeService').className = 'badge ' + (s.running ? 'on' : 'off');
  $('#badgeGate').textContent = s.gate.paused ? '自动回复已暂停' : '自动回复运行中';
  $('#badgeGate').className = 'badge ' + (s.gate.paused ? 'warn' : 'on');
  // AI 徽标反映“真实连接状态”，而不是只看配置开关 —— 避免“已启用”却连不上的错误状态
  let aiText, aiCls;
  if (modelStatus.state === 'ok') { aiText = ('已连模型：' + (modelStatus.model || '')).trim(); aiCls = 'on'; }
  else if (modelStatus.state === 'fail') { aiText = '模型未连上'; aiCls = 'off'; }
  else if (modelStatus.state === 'disabled') { aiText = 'AI 未启用'; aiCls = 'off'; }
  else { aiText = 'AI 未测试'; aiCls = 'warn'; }
  $('#badgeAi').textContent = aiText;
  $('#badgeAi').className = 'badge ' + aiCls;
  $('#btnToggleGate').textContent = s.gate.paused ? '恢复自动回复' : '暂停自动回复';
  $('#btnToggleService').textContent = s.running ? '停止服务' : '启动服务';
}

function group(title, cards) {
  return `<div class="grp"><div class="grp-title">${esc(title)}</div>${cards.join('')}</div>`;
}

function render() {
  renderBadges(state);

  $('#main').innerHTML = [
    group('核心 · 配好才能跑', [aiCard(), acctCard()]),
    group('进阶 · 更好用', [ctxCard(), chatsCard()]),
    group('系统 · 高级', [gateCard(), installCard(), card('环境体检', '<div id="diagBody"></div>', '可选')]),
  ].join('');
  renderDiag();
  bind();
}

function bind() {
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  const val = (id) => (document.getElementById(id)?.value ?? '').trim();
  const checked = (id) => Boolean(document.getElementById(id)?.checked);

  // 暂停/恢复自动回复（运行层，顶栏唯一入口；卡片只展示状态，不再放按钮，避免重复与矛盾）
  on('btnToggleGate', async () => {
    await api('/api/gate', { method: 'POST', body: JSON.stringify({ paused: !state.gate.paused }) });
    refresh();
  });
  on('btnToggleService', async () => {
    await api('/api/service', { method: 'POST', body: JSON.stringify({ action: state.running ? 'stop' : 'start' }) });
    refresh();
  });
  on('btnRefresh', refresh);

  on('btnSaveAi', async () => {
    const values = {
      AI_ENABLED: checked('aiEnabled') ? '1' : '0',
      AI_MASTER_SWITCH: checked('aiMaster') ? '1' : '0',
      AI_BASE_URL: form.ai.base,
      AI_MODEL: form.ai.model,
      AI_GROUP_REPLY: val('aiGroupReply'),
      AI_MAX_PER_HOUR: form.ai.maxPerHour ?? val('aiMaxPerHour'),
      AI_COOLDOWN_MS: form.ai.cooldown ?? val('aiCooldown'),
      AI_MAX_CONCURRENT: form.ai.maxConcurrent ?? val('aiMaxConcurrent'),
      AI_MAX_TOKENS: form.ai.maxTokens ?? val('aiMaxTokens'),
      AI_TEMPERATURE: form.ai.temperature ?? val('aiTemperature'),
      AI_TIMEOUT_MS: form.ai.timeoutMs ?? val('aiTimeout'),
      AI_GROUP_AT_NAMES: form.ai.atNames ?? val('aiAtNames'),
      AI_TRIGGER_PREFIX: form.ai.triggerPrefix ?? val('aiTriggerPrefix'),
      AI_PERSONA_FILE: form.ai.personaFile ?? val('aiPersonaFile'),
    };
    // 密钥留空 = 不修改（避免把已配好的密钥清掉）
    const key = form.ai.key.trim();
    if (key) values.AI_API_KEY = key;
    const r = await api('/api/env', { method: 'POST', body: JSON.stringify({ values }) });
    form.ai.key = '';
    modelStatus.probed = false; // 保存后按新的启用状态刷新徽标（未测试/未启用）
    alert(
      (r.changed || []).length
        ? `已保存：${r.changed.join('、')}\n改动需要重启服务后生效（顶栏「停止服务」→「启动服务」）`
        : '没有变化'
    );
    refresh();
  });

  // ── AI 卡片：选服务商 / 拉模型 / 测试 ───────────────────────────────
  for (const el of document.querySelectorAll('[data-pick-id]')) {
    el.onclick = () => {
      const id = el.dataset.pickId;
      form.ai.providerId = id;
      const all = (providers.groups || []).flatMap((g) => g.items);
      const p = all.find((x) => x.id === id);
      const base = el.dataset.pickBase || (p ? p.baseUrl : '');
      if (base) form.ai.base = base;
      if (el.dataset.pickModel) {
        // 本机发现的服务：优先用预设里推荐的模型，没有就用第一个
        const d = discovered.find((x) => x.baseUrl === base);
        const prefer = p && p.model && d && d.models.includes(p.model) ? p.model : el.dataset.pickModel;
        form.ai.model = prefer;
        form.ai.modelOptions = d ? d.models : form.ai.modelOptions;
      } else if (p && p.model) {
        // 换了服务商：如果模型名还是上一个服务商的默认模型，就一起换成新的
        const wasPresetModel = all.some((x) => x.model && x.model === form.ai.model);
        if (wasPresetModel || !form.ai.model) form.ai.model = p.model;
      }
      form.ai.result = null;
      render();
    };
  }

  for (const el of document.querySelectorAll('[data-bind]')) {
    el.oninput = () => {
      const [grp, key] = el.dataset.bind.split('.');
      if (form[grp]) form[grp][key] = el.value;
    };
  }

  // ── 文件路径输入：原生文件选择器 + 上传到工作区 ──────────────────────
  for (const el of document.querySelectorAll('[data-filebtn]')) {
    el.onclick = () => {
      const f = document.getElementById(el.dataset.filebtn + 'File');
      if (f) f.click();
    };
  }
  for (const el of document.querySelectorAll('input[type=file]')) {
    el.onchange = async () => {
      const file = el.files && el.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const r = await api('/api/file/upload', {
          method: 'POST',
          body: JSON.stringify({ name: file.name, content: text }),
        });
        if (!r.ok) {
          alert('上传失败：' + (r.error || '未知错误'));
          return;
        }
        const inp = document.getElementById(el.id.replace(/File$/, ''));
        if (inp) {
          inp.value = r.path;
          form.ai.personaFile = r.path;
        }
      } catch (e) {
        alert('上传失败：' + e.message);
      }
      render();
    };
  }

  on('btnPullModels', async () => {
    const base = form.ai.base.trim();
    if (!base) {
      alert('先填一下接口地址（或先在上面选一个）');
      return;
    }
    const btn = document.getElementById('btnPullModels');
    btn.textContent = '正在拉取…';
    const r = await api('/api/ai/models', {
      method: 'POST',
      body: JSON.stringify({ base, key: form.ai.key.trim() }),
    });
    btn.textContent = '拉取模型列表';
    if (!r.ok) {
      alert(`没拉到：${r.error}\n\n地址可以先点上面的预设，或者检查是不是少了 /v1`);
      return;
    }
    if (!r.models.length) {
      alert('连上了，但这个服务没返回任何模型。可能地址填的是聊天接口而不是 /v1');
      return;
    }
    form.ai.modelOptions = r.models;
    if (!form.ai.model || !r.models.includes(form.ai.model)) form.ai.model = r.models[0];
    render();
  });

  on('btnTestAi', async () => {
    const base = form.ai.base.trim();
    if (!base) {
      alert('先填一下接口地址');
      return;
    }
    const btn = document.getElementById('btnTestAi');
    btn.textContent = '正在测试…';
    const r = await api('/api/ai/test', {
      method: 'POST',
      body: JSON.stringify({ base, key: form.ai.key.trim(), model: form.ai.model.trim() }),
    });
    btn.textContent = '测试一下能不能用';
    form.ai.result = r;
    modelStatus.probed = true;
    modelStatus.state = r.ok ? 'ok' : 'fail';
    modelStatus.model = r.ok ? (r.model || form.ai.model) : '';
    render();
  });

  on('btnSaveCtx', async () => {
    const values = {
      AI_CONTEXT_TURNS: val('ctxTurns'),
      AI_CONTEXT_TTL_MS: String(Number(val('ctxTtl') || 30) * 60000),
      AI_CONTEXT_MAX_CHARS: val('ctxChars'),
    };
    await api('/api/env', { method: 'POST', body: JSON.stringify({ values }) });
    alert('已保存，改动需要重启服务后生效');
    refresh();
  });

  on('btnSaveWechat', async () => {
    const values = {
      WX_SELF_MODE: val('selfMode'),
      WX_SELF_ID: val('selfId'),
      WX_POLL_CHATS: val('pollChats'),
    };
    await api('/api/env', { method: 'POST', body: JSON.stringify({ values }) });
    alert('已保存，改动需要重启服务后生效');
    refresh();
  });

  on('btnClearAllCtx', async () => {
    if (!confirm('确定清空全部会话的上下文记忆？')) return;
    await api('/api/context/clear', { method: 'POST', body: '{}' });
    refresh();
  });

  for (const el of document.querySelectorAll('[data-clear]')) {
    el.onclick = async () => {
      await api('/api/context/clear', { method: 'POST', body: JSON.stringify({ chatId: el.dataset.clear }) });
      refresh();
    };
  }

  const addChat = async (id) => {
    id = (id || '').trim();
    if (!id) return;
    await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats: { [id]: { enabled: true } } }) });
    const box = document.getElementById('chatSearchResults');
    if (box) box.innerHTML = '';
    refresh();
  };

  on('btnAddChat', async () => {
    await addChat(val('newChatId'));
  });

  on('btnSearchContacts', async () => {
    const q = val('newChatId').trim();
    const box = document.getElementById('chatSearchResults');
    if (!box) return;
    if (!q) {
      box.innerHTML = '<div class="hint">请输入群名、昵称或微信号关键字</div>';
      return;
    }
    box.innerHTML = '<div class="hint">搜索中…</div>';
    let r;
    try {
      r = await api('/api/contacts/search?q=' + encodeURIComponent(q));
    } catch {
      r = { ok: false, results: [] };
    }
    const results = (r && r.results) || [];
    if (!r || !r.ok || !results.length) {
      box.innerHTML =
        '<div class="hint">没找到匹配的联系人（需微信在运行且 DLL 已注入）。' +
        '也可直接粘贴完整 wxid 用「按 wxid 加入」。</div>';
      return;
    }
    box.innerHTML = results
      .map(
        (x) =>
          `<div class="sr-item"><span><b>${esc(x.name)}</b> <span class="dim">${esc(x.id)}</span></span>` +
          `<button class="btn ghost" data-add-id="${esc(x.id)}">加入</button></div>`
      )
      .join('');
    for (const el of document.querySelectorAll('[data-add-id]')) {
      el.onclick = async () => {
        await addChat(el.dataset.addId);
      };
    }
  });

  on('btnSaveChats', async () => {
    const chats = {};
    for (const el of document.querySelectorAll('[data-chat-enabled]')) {
      const id = el.dataset.chatEnabled;
      const reply = document.querySelector(`[data-chat-reply="${CSS.escape(id)}"]`)?.value || '';
      const persona = document.querySelector(`[data-chat-persona="${CSS.escape(id)}"]`)?.value || '';
      chats[id] = { enabled: el.checked, ...(reply ? { groupReply: reply } : {}), ...(persona ? { personaFile: persona } : {}) };
    }
    await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
    refresh();
  });

  for (const el of document.querySelectorAll('[data-chat-del]')) {
    el.onclick = async () => {
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ remove: [el.dataset.chatDel] }) });
      refresh();
    };
  }

  on('btnInstall', async () => {
    const r = await api('/api/install', {
      method: 'POST',
      body: JSON.stringify({
        autostart: checked('optAutostart'),
        shortcut: checked('optShortcut'),
        deployDll: checked('optDeployDll'),
      }),
    });
    showSteps(r);
    refresh(); // 安装状态（已安装/自启/pid）变了，状态行与徽标要跟上
  });
  on('btnUninstall', async () => {
    if (!confirm('卸载会停止服务并清理自启与快捷方式，配置保留。继续？')) return;
    const r = await api('/api/uninstall', { method: 'POST', body: JSON.stringify({ purge: false }) });
    showSteps(r);
    refresh();
  });
  on('btnUninstallPurge', async () => {
    if (!confirm('彻底卸载会删除 .env / config.json / data（含聊天上下文），不可恢复。继续？')) return;
    const r = await api('/api/uninstall', { method: 'POST', body: JSON.stringify({ purge: true }) });
    showSteps(r);
    refresh();
  });

  // ── 模型名下拉交互（自绘面板：本地已有 / 云端已拉取）──
  const mt = document.getElementById('btnModelToggle');
  const mi = document.getElementById('aiModel');
  if (mt) mt.onclick = (e) => {
    e.stopPropagation();
    const panel = document.getElementById('modelPanel');
    if (panel && !panel.hidden) closeModelPanel();
    else openModelPanel();
  };
  if (mi) {
    mi.onfocus = () => { if (mi.hasAttribute('readonly')) openModelPanel(); }; // 只读态（下拉模式）聚焦才展开；手输态不弹回面板
    mi.addEventListener('input', closeModelPanel); // 手输时收起（addEventListener 不覆盖 data-bind 的 oninput）
  }
  if (!window.__comboDocBound) {
    document.addEventListener('click', (e) => {
      const c = document.getElementById('modelCombo');
      const panel = document.getElementById('modelPanel');
      if (panel && !panel.hidden && c && !c.contains(e.target)) closeModelPanel();
    });
    window.__comboDocBound = true;
  }
}

function showSteps(r) {
  installLogText = (r.steps || []).map((s) => `${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ' — ' + s.detail : ''}`).join('\n');
  const el = document.getElementById('installLog');
  if (el) el.textContent = installLogText;
  else render(); // 首次出结果时卡片里还没有日志框，重绘补上
}

// 先拿到服务商预设和本机已启动的模型服务，再渲染
(async () => {
  try {
    await loadProviders();
  } catch {
    /* 拿不到就按空列表渲染 */
  }
  await refresh();
})();

// 轻量轮询：只刷新顶部状态徽标，不重绘卡片（重绘会把用户正在输入的内容冲掉）。
// 服务在别处被启停、或崩了又起，界面都能自己跟上。
setInterval(async () => {
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return; // 正在输入就别动
  try {
    state = await api('/api/state');
    renderBadges(state);
  } catch {
    /* 配置器可能正被关掉，忽略 */
  }
}, 4000);
