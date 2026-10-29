/**
 * 图形化配置器前端主程序。
 *
 * 职责边界：取数据、拼界面、绑事件；控件长什么样由 js/widgets.js 决定，
 * 业务判断由服务端的 src/tasks/ 决定。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards;
  const rules = g.aiRules || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const token = new URLSearchParams(location.search).get('token') || '';
  let state = null;
  let onboard = null;
  let diag = null;
  let modelSvc = null;
  let logs = null;
  let avail = null;
  let installLog = '';
  let modelStatus = { probed: false, state: 'untested' };

  /** 用户正在填的内容：重绘时回填，避免输入被冲掉。 */
  const form = {
    ai: { base: '', key: '', model: '', providerId: '', options: [], models: [], result: null, review: [], atNames: '', triggerPrefix: '' },
    chat: { results: [], picked: null, searchMsg: '', query: '', browse: false },
  };

  /** 折叠面板的展开状态：重绘会重建 DOM，这里记住哪些是打开的，避免自动收起。 */
  const openAdv = new Set();

  async function api(p, opts) {
    const sep = p.indexOf('?') >= 0 ? '&' : '?';
    const r = await fetch(p + sep + 'token=' + encodeURIComponent(token), Object.assign({
      headers: { 'Content-Type': 'application/json', 'X-AutoChat-Token': token },
    }, opts || {}));
    return r.json();
  }

  /** 界面控件的 bind 值 → .env 键。 */
  const ENV_KEY = {
    'ai.base': 'AI_BASE_URL',
    'ai.key': 'AI_API_KEY',
    'wechat.webhookToken': 'WX_WEBHOOK_TOKEN',
    'ai.model': 'AI_MODEL',
    'ai.visionModel': 'AI_VISION_MODEL',
    'ai.enabled': 'AI_ENABLED',
    'ai.groupReply': 'AI_GROUP_REPLY',
    'ai.replyMode': 'AI_REPLY_MODE',
    'ai.batchWindowMs': 'AI_BATCH_WINDOW_MS',
    'ai.batchMaxMessages': 'AI_BATCH_MAX_MESSAGES',
    'ai.batchFlushDelayMs': 'AI_BATCH_FLUSH_DELAY_MS',
    'ai.atNames': 'AI_GROUP_AT_NAMES',
    'ai.triggerPrefix': 'AI_TRIGGER_PREFIX',
    'ai.maxPerHour': 'AI_MAX_PER_HOUR',
    'ai.cooldownMs': 'AI_COOLDOWN_MS',
    'ai.maxConcurrent': 'AI_MAX_CONCURRENT',
    'ai.contextTurns': 'AI_CONTEXT_TURNS',
    'ai.contextMaxChars': 'AI_CONTEXT_MAX_CHARS',
    'ai.contextTtlMs': 'AI_CONTEXT_TTL_MS',
    'ai.reasoningEffort': 'AI_REASONING_EFFORT',
    'ai.reasoningFormat': 'AI_REASONING_FORMAT',
    'ai.reasoningBudget': 'AI_REASONING_BUDGET',
    'ai.personaFile': 'AI_PERSONA_FILE',
    'ai.personaName': 'AI_PERSONA_NAME',
    'wechat.selfId': 'WX_SELF_ID',
    'wechat.selfMode': 'WX_SELF_MODE',
    'wechat.pollExcludeSelf': 'WX_POLL_EXCLUDE_SELF',
    'wechat.receiveMode': 'WX_RECEIVE_MODE',
    'wechat.pollChats': 'WX_POLL_CHATS',
    'wechat.dllPath': 'WX_DLL_PATH',
    'ai.webSearch': 'AI_WEB_SEARCH',
    'ai.webSearchProvider': 'AI_WEB_SEARCH_PROVIDER',
    'ai.webSearchKey': 'AI_WEB_SEARCH_KEY',
    'ai.webSearchMode': 'AI_WEB_SEARCH_MODE',
    'ai.webSearchTrigger': 'AI_WEB_SEARCH_TRIGGER',
    'ai.webSearchMaxResults': 'AI_WEB_SEARCH_MAX_RESULTS',
    'ai.webSearchMaxChars': 'AI_WEB_SEARCH_MAX_CHARS',
    'ai.aiTools': 'AI_TOOLS',
    'ai.aiToolsAllow': 'AI_TOOLS_ALLOW',
    'ai.aiToolsMaxRounds': 'AI_TOOLS_MAX_ROUNDS',
    'ai.modelRouting': 'AI_MODEL_ROUTING',
    'ai.lightModel': 'AI_LIGHT_MODEL',
    'ai.lightBaseUrl': 'AI_LIGHT_BASE_URL',
    'ai.lightApiKey': 'AI_LIGHT_API_KEY',
    'ai.longTaskNotice': 'AI_LONG_TASK_NOTICE',
    'ai.docAnalysis': 'AI_DOC_ANALYSIS',
    'ai.docMaxChars': 'AI_DOC_MAX_CHARS',
    'ai.docOutDir': 'AI_DOC_OUT_DIR',
  };

  async function loadSources() {
    if (!state) return; // 状态还没就绪时不猜来源
    const p = await api('/api/ai/providers');
    const d = await api('/api/ai/discover');
    const groups = (p.groups || []).flatMap((x) => x.items || []);
    const options = [];
    for (const f of d.found || []) {
      options.push({ id: f.providerId, name: '本机 ' + f.name + '（已启动）', baseUrl: f.baseUrl, online: true, models: f.models || [] });
    }
    for (const it of groups) {
      if (options.some((o) => o.baseUrl === it.baseUrl)) continue;
      options.push({ id: it.id, name: it.name, baseUrl: it.baseUrl, model: it.model, needsKey: it.needsKey, keyUrl: it.keyUrl });
    }
    form.ai.options = options;
    if (!form.ai.providerId && options.length) {
      /**
       * 已配的地址不在预设表里（自建网关 / 中转 / 端口改过 / 带路径后缀）时，
       * 必须落到「自定义」，绝不能默认选第一个 —— 第一个往往就是本机 Ollama，
       * 界面上会显示成本机千问，一保存就把云端配置悄悄换掉。
       * 这正是「明明配了 DeepSeek 却跑千问」的另一半原因。
       */
      const cfgBase = String((state.config.ai && state.config.ai.baseUrl) || '').trim();
      form.ai.providerId = rules.pickProviderId
        ? rules.pickProviderId(options, cfgBase)
        : (cfgBase ? 'custom' : options[0].id);
    }
    const cur = options.find((o) => o.id === form.ai.providerId);
    if (cur) {
      if (Array.isArray(cur.models) && cur.models.length) form.ai.models = cur.models.slice();
      if (!form.ai.model && cur.model) form.ai.model = cur.model;
    }
  }

  async function refresh(force) {
    state = await api('/api/state');
    if (!form.ai.base && state.config.ai.baseUrl) form.ai.base = state.config.ai.baseUrl;
    if (!form.ai.model && state.config.ai.model) form.ai.model = state.config.ai.model;
    if (form.ai.visionModel === undefined) form.ai.visionModel = state.config.ai.visionModel || '';
    if (form.ai.atNames === '') form.ai.atNames = (state.config.ai.groupAtNames || []).join(',');
    if (form.ai.triggerPrefix === '') form.ai.triggerPrefix = state.config.ai.triggerPrefix || '';
    // 人设路径直接用已保存的值（上传后会立刻回填，别被旧表单值覆盖）
    form.ai.personaFile = state.config.ai.personaFile || '';
    form.ai.personaName = state.config.ai.personaName || '';
    // 密钥：默认就显示已保存的值（确认存在/不存在）；只有首次才从 state 种入，避免覆盖正在输入的内容
    if (form.ai.key === undefined) {
      form.ai.key = (state.secrets && state.secrets.aiApiKey && state.secrets.aiApiKey.value) || '';
    }
    if (force) {
      onboard = await api('/api/onboarding');
      diag = await api('/api/diagnose');
      avail = await api('/api/chat-availability');
      modelSvc = await api('/api/model-service');
    }
    // 日志尾部只是本地文件读尾部，很便宜 —— 放进常规刷新（4 秒轮询）。
    // 之前只在 force 时拉，日志卡永远停在「上次手动刷新」的快照，
    // 表现为「最上面的不是最新的」（用户实测踩坑）。拉不到就沿用上一次，不拖垮整个刷新。
    try {
      logs = await api('/api/logs?tail=200');
    } catch { /* keep last */ }
    // 本机服务里的模型直接作为可选列表：用户不用先去「拉取」才知道有哪些
    if (modelSvc && Array.isArray(modelSvc.models) && modelSvc.models.length &&
        /127\.0\.0\.1|localhost/i.test(form.ai.base || '')) {
      form.ai.models = modelSvc.models.slice();
      if (!form.ai.model) form.ai.model = form.ai.models[0];
    }
    render();
  }

  function render() {
    if (!state) return;
    const a = state.config.ai;
    const paused = state.gate.paused;
    const badge = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = 'badge ' + (cls || '');
    };
    badge('badgeService', state.running ? '服务运行中' : '服务未运行', state.running ? 'ok' : 'bad');
    const autoText = !a.enabled
      ? '自动回复未启用'
      : (!state.running ? '自动回复待启动' : (paused ? '自动回复已暂停' : '自动回复运行中'));
    badge('badgeAutoReply', autoText, a.enabled && state.running && !paused ? 'ok' : 'warn');
    badge('badgeModel', modelStatus.state === 'ok' ? '模型已连通' : (a.baseUrl ? '模型未测' : '模型未配置'),
      modelStatus.state === 'ok' ? 'ok' : 'warn');

    // 顶栏动作按钮：随状态切换文字与样式（和卡片一致，避免写死的 ghost 样式且不同步运行态）
    const svcBtn = document.getElementById('btnToggleService');
    if (svcBtn) {
      svcBtn.textContent = state.running ? '停止服务' : '启动服务';
      svcBtn.className = 'btn ' + (state.running ? 'danger' : '');
    }
    const gateBtn = document.getElementById('btnToggleGate');
    if (gateBtn) {
      gateBtn.textContent = paused ? '恢复自动回复' : '暂停自动回复';
      gateBtn.className = 'btn ' + (paused ? '' : 'danger');
    }

    const onboardHtml = cards.onboard(state, onboard);
    const wechat = cards.wechat(state);
    const modelSec = cards.ai(state, form, modelSvc) + cards.modelService(state, modelSvc);
    const startSec = cards.status(state);
    const advSec = cards.context(state) + cards.chats(state, form.chat) + cards.selfMessage(state);
    const chatAvailSec = cards.chatAvailability(state, avail);
    const sysSec = cards.install(state, installLog) + cards.logs(state, logs) + cards.diag(state, diag);

    $('#main').innerHTML =
      '<section class="sec" id="sec-onboard">' + (onboardHtml || '') + '</section>' +
      '<section class="sec" id="sec-wechat"><div class="sec-head"><h2>① 连接微信</h2><p>把 AI 接到你的微信上（必做）</p></div>' + wechat + '</section>' +
      '<section class="sec" id="sec-model"><div class="sec-head"><h2>② 选择模型</h2><p>让 AI 有脑子：本地 Ollama 或云端 API</p></div>' + modelSec + '</section>' +
      '<section class="sec" id="sec-start"><div class="sec-head"><h2>③ 启动助手</h2><p>注入 hook、开自动回复</p></div>' + startSec + '</section>' +
      '<section class="sec" id="sec-adv"><div class="sec-head"><h2>④ 高级设置</h2><p>上下文、按会话、安装 / 卸载、日志、体检</p></div>' + advSec + chatAvailSec + sysSec + '</section>';
    bind();
    bindNav();
    // 恢复折叠面板展开状态：重绘会重建 DOM，不恢复就会"自动收起"
    for (const d of $$('details.adv')) {
      const k = d.getAttribute('data-adv') || (d.querySelector('summary') ? d.querySelector('summary').textContent : '');
      d.open = openAdv.has(k);
      d.addEventListener('toggle', () => { if (d.open) openAdv.add(k); else openAdv.delete(k); });
    }
  }

  /** 侧栏导航：点击滚动到对应分区，并随滚动高亮当前分区。 */
  function bindNav() {
    const items = $$('#sidenav .navitem');
    const onClick = function () {
      const id = this.getAttribute('data-nav');
      const sec = document.getElementById(id);
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    for (const el of items) el.onclick = onClick;
    const secs = ['sec-onboard', 'sec-wechat', 'sec-model', 'sec-start', 'sec-adv']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const onScroll = () => {
      let cur = secs[0];
      const y = window.scrollY + 120;
      for (const s of secs) if (s.offsetTop <= y) cur = s;
      for (const el of items) el.classList.toggle('active', !!cur && el.getAttribute('data-nav') === cur.id);
    };
    window.removeEventListener('scroll', onScroll);
    window.addEventListener('scroll', onScroll);
    onScroll();
  }

  /** 敏感键：界面上永远拿不到真值，留空＝不改，不能被当成「清空」。 */
  const SECRET_ENV = ['AI_API_KEY', 'WX_WEBHOOK_TOKEN'];

  /**
   * 读一个绑定控件的当前值。
   * 不同控件取值方式不一样：分段选择看选中项、开关看 aria-checked、
   * 标签多选看选中标签、下拉看 select 本身、其余才看 el.value。
   * 取不到就返回 undefined —— 宁可不写，也不能写成空串把原配置抹掉。
   */
  function readBoundValue(el) {
    if (el.classList.contains('segrow')) {
      const on = el.querySelector('.seg-item.on');
      return on ? on.getAttribute('data-val') : undefined;
    }
    if (el.classList.contains('swrow')) {
      return el.getAttribute('aria-checked') === 'true' ? '1' : '0';
    }
    if (el.classList.contains('chiprow')) {
      const picked = Array.from(el.querySelectorAll('.chip.on'))
        .map((c) => c.getAttribute('data-val'))
        .filter(Boolean);
      return picked.join(',');
    }
    if (el.classList.contains('selectrow')) {
      const sel = el.querySelector('select');
      return sel ? sel.value : undefined;
    }
    if (typeof el.value === 'string') return el.value;
    return undefined;
  }

  /** 读表单里所有 [data-bind] 的值。 */
  function collectBinds() {
    const pairs = [];
    for (const el of $$('[data-bind]')) {
      const key = el.getAttribute('data-bind');
      if (!key || key.indexOf('chat.') === 0) continue;
      const envKey = ENV_KEY[key];
      if (!envKey) continue;
      pairs.push([envKey, readBoundValue(el)]);
    }
    // 密钥类字段在浏览器里是空的（不下发真值）：留空表示「保持原样」，
    // 直接写空会把 .env 里已配好的密钥抹掉，助手当场 401。
    return rules.collectEnvValues ? rules.collectEnvValues(pairs, SECRET_ENV) : Object.fromEntries(pairs);
  }

  /** 开关 / 分段 / 动作 的事件绑定。 */
  function bind() {
    for (const el of $$('[data-sw]')) {
      /** 设成指定状态：点行本身＝取反，点「关 / 开」＝照点的来。 */
      const setOn = async (on) => {
        el.setAttribute('aria-checked', on ? 'true' : 'false');
        for (const b of el.querySelectorAll('[data-sw-val]')) {
          b.classList.toggle('on', (b.getAttribute('data-sw-val') === '1') === on);
        }
        const bind2 = el.getAttribute('data-bind');
        const chatId = el.getAttribute('data-chat');
        if (bind2 === 'ai.enabled') {
          await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { AI_ENABLED: on ? '1' : '0' } }) });
        } else if (bind2 && ENV_KEY[bind2]) {
          await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { [ENV_KEY[bind2]]: on ? '1' : '0' } }) });
        } else if (chatId) {
          const chats = {};
          chats[chatId] = { enabled: on };
          await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
        }
        await refresh(true);
      };
      el.onclick = (ev) => {
        // 点的是分段按钮就交给它自己处理（否则会先取反、再被按钮设一次）
        if (ev && ev.target && ev.target.closest && ev.target.closest('[data-sw-val]')) return;
        setOn(el.getAttribute('aria-checked') !== 'true');
      };
      for (const b of el.querySelectorAll('[data-sw-val]')) {
        b.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setOn(b.getAttribute('data-sw-val') === '1');
        };
      }
      el.onkeydown = (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setOn(el.getAttribute('aria-checked') !== 'true');
        }
      };
    }

    const isReplyModeBind = (b) => b === 'ai.replyMode' || /^chat\.[^.]+\.replyMode$/.test(b || '');
    // 解析某 replyMode 绑定实际用的模型地址：会话覆盖优先，否则全局
    const baseForBind = (b) => {
      const ai = (state && state.config && state.config.ai) || {};
      if (b && b.indexOf('chat.') === 0) {
        const id = b.split('.')[1];
        const c = (state && state.chats && state.chats[id]) || {};
        if (c.baseUrl) return c.baseUrl;
      }
      return ai.baseUrl || '';
    };
    for (const el of $$('.seg-item')) {
      el.onclick = async () => {
        const val = el.getAttribute('data-val');
        const seg = el.closest('.seg');
        const row = el.closest('.segrow');
        const bind2 = row ? row.getAttribute('data-bind') : '';
        // 开启「多消息合批」且用的是云端模型：先确认（合批会把多人对话发给模型服务商）
        if (val === 'batch' && isReplyModeBind(bind2)) {
          const base = baseForBind(bind2);
          const local = /(^|\/\/)(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)(:|\/|$)/i.test(base);
          if (!local && !confirm('「多消息合批」会把多人对话一并发给你的模型服务商。\n当前用的是云端模型（' + base + '），确定开启合批？')) {
            return; // 不改 UI、不保存
          }
        }
        for (const x of seg.querySelectorAll('.seg-item')) x.classList.remove('on');
        el.classList.add('on');
        if (bind2 && bind2.indexOf('chat.') === 0) {
          // 通用化：chat.<id>.<field> → 写 chats[id][field]（原只支持 groupReply）
          const parts = bind2.split('.');
          const id = parts[1];
          const field = parts[2] || 'groupReply';
          const chats = {};
          chats[id] = { [field]: val };
          await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
        } else if (bind2 && ENV_KEY[bind2]) {
          await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { [ENV_KEY[bind2]]: val } }) });
        }
        await refresh(true);
      };
    }

    // 文件上传（目前用于人设）：选文件 → 文本上传 → 回填绝对路径 → 立刻写 .env
    for (const el of $$('[data-filebtn]')) {
      el.onclick = () => {
        const inp = document.getElementById(el.getAttribute('data-filebtn') + 'File');
        if (inp) inp.click();
      };
    }
    for (const el of $$('input[type=file]')) {
      el.onchange = async () => {
        const file = el.files && el.files[0];
        if (!file) return;
        el.disabled = true;
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
          const target = document.getElementById(String(el.id).replace(/File$/, ''));
          const bind2 = target ? target.getAttribute('data-bind') : '';
          if (target) target.value = r.path;
          // 上传即生效：直接把绝对路径写进 .env，不用再手动点保存
          if (bind2 && ENV_KEY[bind2]) {
            await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { [ENV_KEY[bind2]]: r.path } }) });
          }
          await refresh(true);
          alert('已上传：' + r.path + '\n\n注意：正在运行的助手还在用旧人设，重启助手后才会生效。');
        } catch (err) {
          alert('上传失败：' + (err && err.message ? err.message : err));
        } finally {
          el.disabled = false;
          el.value = '';
        }
      };
    }

    // 下拉选择：改完立刻存（和分段选择一个脾气），不用再点保存
    for (const el of $$('select[data-select]')) {
      el.onchange = async () => {
        const bind2 = el.getAttribute('data-select');
        if (bind2 && ENV_KEY[bind2]) {
          await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { [ENV_KEY[bind2]]: el.value } }) });
        }
        await refresh(true);
      };
    }

    // 密钥类字段：点「显示」切换明文；失焦自动保存（填了替换旧的、清空删除）
    for (const el of $$('[data-reveal]')) {
      el.onclick = () => {
        const inp = document.getElementById(el.getAttribute('data-reveal'));
        if (!inp) return;
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        el.textContent = show ? '隐藏' : '显示';
      };
    }
    for (const el of $$('input[data-secret]')) {
      let dirty = false;
      el.addEventListener('input', () => { dirty = true; });
      el.addEventListener('blur', async () => {
        if (!dirty) return;
        dirty = false;
        const bindKey = el.getAttribute('data-secret');
        const envKey = ENV_KEY[bindKey];
        if (!envKey) return;
        const val = el.value;
        const wasPresent = el.getAttribute('data-present') === '1';
        const box = el.closest('.secret-box');
        const setState = (ok, txt) => {
          if (!box) return;
          const h = box.querySelector('.secret-state');
          if (h) { h.textContent = txt; h.classList.toggle('ok', ok); }
        };
        if (!val) {
          // 清空：本来就有才删除（二次确认），否则啥也不做
          if (wasPresent && confirm('要清除已保存的密钥吗？')) {
            await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { [envKey]: null } }) });
            el.setAttribute('data-present', '0');
            setState(false, '○ 未配置（填了立即自动保存）');
          }
          if (bindKey === 'ai.key') form.ai.key = '';
          return;
        }
        // 填了：立即保存并替换旧的
        await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { [envKey]: val } }) });
        el.setAttribute('data-present', '1');
        setState(true, '✓ 已配置（已保存在 .env，点「显示」可查看；填新值＝替换，清空失焦＝删除）');
        if (bindKey === 'ai.key') form.ai.key = val;
      });
    }

    /**
     * 本地文件 / 目录选择弹窗：浏览器拿不到绝对路径，列目录必须由本机服务端做（/api/fs/list）。
     * @param {{mode?:'file'|'dir', exts?:string[], start?:string}} o
     * @returns {Promise<string|null>} 选中路径；取消返回 null
     */
    async function pickPath(o = {}) {
      const mode = o.mode === 'dir' ? 'dir' : 'file';
      const exts = Array.isArray(o.exts) ? o.exts : [];
      const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const joinp = (d, n) => (/[\\/]$/.test(d) ? d + n : d + '\\' + n);
      return new Promise((resolve) => {
        const mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;padding:14px;width:540px;max-width:92vw;max-height:76vh;display:flex;flex-direction:column;gap:8px;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif';
        box.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center"><b>选择' + (mode === 'dir' ? '目录' : '文件') + '</b>' +
          '<button type="button" class="btn ghost sm" data-x>取消</button></div>' +
          '<code data-cur style="display:block;padding:6px 8px;background:#f4f5f7;border-radius:6px;word-break:break-all">加载中…</code>' +
          '<div data-list style="overflow:auto;border:1px solid #e2e5ea;border-radius:8px;min-height:220px;max-height:340px;padding:4px"></div>' +
          '<div style="display:flex;justify-content:flex-end">' + (mode === 'dir' ? '<button type="button" class="btn" data-here>选择当前目录</button>' : '') + '</div>';
        mask.appendChild(box);
        document.body.appendChild(mask);
        const st = document.createElement('style');
        st.textContent = '.pickitem{padding:6px 8px;cursor:pointer;border-radius:6px}.pickitem:hover{background:#eef2ff}';
        mask.appendChild(st);
        const cur = box.querySelector('[data-cur]');
        const list = box.querySelector('[data-list]');
        const close = (v) => { mask.remove(); resolve(v); };
        box.querySelector('[data-x]').onclick = () => close(null);
        mask.onclick = (e) => { if (e.target === mask) close(null); };

        async function go(dir) {
          list.innerHTML = '<div class="dim" style="padding:6px 8px">加载中…</div>';
          const r = await api('/api/fs/list?dir=' + encodeURIComponent(dir || ''));
          if (r.error) { list.innerHTML = '<div class="dim" style="padding:6px 8px">' + r.error + '</div>'; return; }
          if (Array.isArray(r.roots)) {
            cur.textContent = '我的电脑（点盘符进入）';
            list.innerHTML = r.roots.map((d) => '<div class="pickitem" data-dir="' + escA(d) + '">' + d + '</div>').join('');
            return;
          }
          cur.textContent = r.dir;
          let html = r.parent ? '<div class="pickitem" data-dir="' + escA(r.parent) + '">↩ 上一级</div>' : '';
          html += r.dirs.map((d) => '<div class="pickitem" data-dir="' + escA(joinp(r.dir, d)) + '">▸ ' + d + '</div>').join('');
          if (mode === 'file') {
            const hit = r.files.filter((f) => !exts.length || exts.some((x) => f.toLowerCase().endsWith(x)));
            html += hit.map((f) => '<div class="pickitem" data-file="' + escA(joinp(r.dir, f)) + '">' + f + '</div>').join('');
            if (!hit.length) html += '<div class="dim" style="padding:6px 8px">（此目录没有匹配的文件）</div>';
          }
          list.innerHTML = html;
          const here = box.querySelector('[data-here]');
          if (here) here.onclick = () => close(r.dir);
        }
        list.onclick = (e) => {
          const it = e.target.closest('.pickitem');
          if (!it) return;
          if (it.dataset.dir) go(it.dataset.dir);
          else if (it.dataset.file) close(it.dataset.file);
        };
        go(o.start || '');
      });
    }

    for (const el of $$('[data-act]')) {
      el.onclick = async () => {
        const act = el.getAttribute('data-act');
        const payload = el.getAttribute('data-payload') || '';
        const actText = el.textContent;
        el.disabled = true;
        el.textContent = '处理中…';
        try {
          if (act === 'service-start') { await api('/api/service', { method: 'POST', body: JSON.stringify({ action: 'start' }) }); await refresh(true); }
          else if (act === 'service-stop') { await api('/api/service', { method: 'POST', body: JSON.stringify({ action: 'stop' }) }); await refresh(true); }
          else if (act === 'pause') await api('/api/gate', { method: 'POST', body: JSON.stringify({ paused: true, reason: '图形化配置器暂停' }) });
          else if (act === 'resume') await api('/api/gate', { method: 'POST', body: JSON.stringify({ paused: false }) });
          else if (act === 'lock') await api('/api/lock', { method: 'POST', body: '{}' });
          else if (act === 'autodll') await api('/api/autodll', { method: 'POST', body: JSON.stringify({ write: true }) });
          else if (act === 'dll-custom') {
            const inp = document.getElementById('dllCustomPath');
            const p = inp ? inp.value.trim() : '';
            const r = await api('/api/wechat/dll', { method: 'POST', body: JSON.stringify({ path: p }) });
            if (!r.ok) alert(r.message || '应用失败');
          } else if (act === 'wx-installer-run') {
            const inp = document.getElementById('wxInstallerPath');
            const p = inp ? inp.value.trim() : '';
            const r = await api('/api/wechat/installer', { method: 'POST', body: JSON.stringify({ path: p }) });
            if (!r.ok) alert(r.message || '启动安装包失败');
            else installLog = r.message || '已启动安装包';
          } else if (act === 'wx-installer-save') {
            const inp = document.getElementById('wxInstallerPath');
            const p = inp ? inp.value.trim() : '';
            const r = await api('/api/wechat/installer-save', { method: 'POST', body: JSON.stringify({ path: p }) });
            if (!r.ok) alert(r.message || '保存失败');
            else installLog = r.message || '已保存';
            await refresh(true);
          } else if (act === 'wx-installer-pick') {
            // 让用户在本地磁盘里点选安装包，而不是手敲路径（路径来自本机服务端列目录）
            const inp0 = document.getElementById('wxInstallerPath');
            const start = inp0 && inp0.value ? String(inp0.value).replace(/[^\\/]+$/, '') : '';
            const picked = await pickPath({ mode: 'file', exts: ['.exe'], start });
            if (picked) {
              const inp = document.getElementById('wxInstallerPath');
              if (inp) inp.value = picked;
            }
          } else if (act === 'github-releases') {
            window.open('https://github.com/yushichadao/AutoChat/releases', '_blank');
          } else if (act === 'deploy-dll') {
            const r = await api('/api/wechat/deploy', { method: 'POST', body: '{}' });
            installLog = r.message || '';
            if (r.ok) alert('已写入微信目录。\\n请完全退出微信（托盘也退出）再重新打开并登录，然后点「刷新」。');
            else alert(r.message || '写入失败');
          } else if (act === 'fix-dll') {
            // 先把 WX_DLL_PATH 换成该微信版本对应的内置 DLL，再写进微信目录
            const a = await api('/api/autodll', { method: 'POST', body: JSON.stringify({ write: true }) });
            if (!a.path) {
              alert('没找到与微信 ' + (a.version || '') + ' 匹配的内置 DLL');
            } else {
              const r = await api('/api/wechat/deploy', { method: 'POST', body: '{}' });
              installLog = r.message || '';
              alert(r.ok
                ? '已改用 ' + a.path + '\\n并写入微信目录。请完全退出微信（托盘也退出）后重新打开并登录。'
                : (r.message || '写入失败'));
            }
          }
          else if (act === 'auto-repair') {
            if (!confirm('一键修复会：① 微信版本不对就（引导/启动）重装对应版本；② DLL 不对就部署项目匹配的并重启微信；③ 校验登录态。\n确定继续？')) return;
            try {
              const r = await api('/api/wechat/auto-repair', { method: 'POST', body: '{}' });
              const steps = (r.steps || []).map((s) => '• ' + s).join('\n');
              const lines = [];
              lines.push((r.ok ? '[修复完成] ' : '[需要你操作] ') + (r.message || ''));
              if (steps) lines.push('', '已执行：', steps);
              if (r.envLine) lines.push('', '把下面这行填到 .env（然后点「重新修复」）：', r.envLine);
              if (r.releaseUrl) lines.push('', '获取安装包：' + r.releaseUrl);
              installLog = lines.join('\n');
              // 先重绘再弹窗：否则弹窗期间按钮还停在「处理中…」的禁用态（看着像个空按钮），
              // 而且下方「安装与卸载」卡还没更新，用户点了「确定」才看到结果。
              await refresh(true);
              if (r.ok) alert('修复完成：' + (r.message || '已全部就位') + '\n\n详细结果已显示在下方「安装与卸载」卡，可点「复制」。');
              else if (r.needsUser) alert((r.message || '已启动所需操作，但需要你完成安装/配置。') + '\n\n详见下方「安装与卸载」卡的结果（可点「复制」）。');
              else alert((r.message || '自动修复没有成功，也没有拿到具体原因（属程序缺陷）。') + '\n\n详见下方「安装与卸载」卡的执行记录，可点「复制」。');
            } catch (e) {
              alert('修复出错：' + (e && e.message || e));
            }
          } else if (act === 'copy-installlog') {
            const pre = document.querySelector('.ilog');
            const txt = pre ? pre.textContent : installLog;
            if (txt && navigator.clipboard) {
              navigator.clipboard.writeText(txt).then(() => alert('已复制')).catch(() => alert('复制失败，请手动选择文本复制'));
            } else if (txt) {
              alert('当前环境不支持自动复制，请手动选择下方文本复制');
            }
          }
          else if (act === 'model-service-start') {
            const r = await api('/api/model-service/start', { method: 'POST', body: '{}' });
            installLog = r.message || '';
          } else if (act === 'model-service-stop') {
            await api('/api/model-service/stop', { method: 'POST', body: '{}' });
          } else if (act === 'model-service-install') {
            const r = await api('/api/model-service/install', { method: 'POST', body: '{}' });
            installLog = r.message || '';
          } else if (act === 'model-service-pull') {
            const r = await api('/api/model-service/pull', { method: 'POST', body: '{}' });
            installLog = r.message || '';
          } else if (act === 'model-service-configure') {
            const r = await api('/api/model-service/configure', { method: 'POST', body: '{}' });
            installLog = r.message || '';
          } else if (act === 'model') {
            const sec = document.getElementById('sec-model');
            if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else if (act === 'uninstall') {
            // 「卸载服务」≠「卸载软件」：确认框必须说清这次到底动不动程序本体
            // 开关渲染的是 data-sw 属性（不是 id），用 getElementById 永远拿到 null，
            // 导致勾了「移入回收站」也总提示「程序本体仍留在磁盘上」（用户实测踩坑）。
            const recEl = document.querySelector('[data-sw="uninstallRecycle"]');
            const recycle = !!recEl && recEl.getAttribute('aria-checked') === 'true';
            const tip = recycle
              ? '这次会做两件事：\n' +
                '① 卸载服务：停服务、去自启、删快捷方式、还原微信目录里的 version.dll、解除更新阻断；\n' +
                '② 卸载软件：把整个程序目录移入回收站（可还原，但程序就没了，界面随后会打不开）。\n确定继续？'
              : '这次只「卸载服务」：停服务、去自启、删快捷方式、还原 version.dll、解除更新阻断。\n' +
                '程序本体仍留在磁盘上（想连程序一起处理，请先勾上面的「移入回收站」）。\n确定继续？';
            if (!confirm(tip)) return;
            await api('/api/uninstall', { method: 'POST', body: JSON.stringify({ recycle }) });
          } else if (act === 'install') {
            const body = { env: {}, chats: {} };
            if (payload === 'autostart') body.autostart = true;
            if (payload === 'shortcut') body.shortcut = true;
            const r = await api('/api/install', { method: 'POST', body: JSON.stringify(body) });
            installLog = (r.steps || []).map((s) => (s.ok ? '✓ ' : '✗ ') + s.name + (s.detail ? ' — ' + s.detail : '')).join('\n');
          } else if (act === 'save-selfmsg') {
            // 自消息识别卡片已改为自动识别当前账号，不再需要手动保存 wxid；保留分支以免旧缓存误触
          }
        } finally {
          el.disabled = false;
          el.textContent = actText;
        }
        await refresh(true);
        // 启停 / 安装 / 拉模型后重新探测来源与模型列表，否则界面还停在旧状态
        if ((act || '').indexOf('model-service-') === 0) {
          await loadSources().catch(() => {});
          render();
        }
      };
    }

    // 手动重新检测本机模型服务 + 可用模型
    const reBtn = $('#btnRediscover');
    if (reBtn) {
      reBtn.onclick = async () => {
        reBtn.disabled = true;
        const old = reBtn.textContent;
        reBtn.textContent = '检测中…';
        try {
          await loadSources();
          await refresh(true);
          render();
        } finally {
          reBtn.disabled = false;
          reBtn.textContent = old;
        }
      };
    }

    for (const el of $$('[data-src]')) {
      el.onclick = () => {
        const id = el.getAttribute('data-src');
        const opt = form.ai.options.find((o) => o.id === id);
        const live = (state && state.config && state.config.ai) || {};
        const nextBase = opt && opt.baseUrl ? opt.baseUrl : form.ai.base;
        const nextModel = (opt && (Array.isArray(opt.models) && opt.models.length ? opt.models[0] : opt.model)) || form.ai.model;
        // 换来源＝换地址＋换模型：先把「从什么换成什么」摆出来问一句。
        // 不问的话，一次误点就把云端 DeepSeek 换成本机千问，事后极难察觉。
        if (live.baseUrl && (live.baseUrl !== nextBase || live.model !== nextModel)) {
          const ok = confirm('切换模型来源会改掉这两项：\n\n' +
            '地址：' + live.baseUrl + '\n  → ' + (nextBase || '空') + '\n' +
            '模型：' + (live.model || '空') + '\n  → ' + (nextModel || '空') + '\n\n' +
            '保存后才会写进 .env，还要重启助手才生效。确定要换吗？');
          if (!ok) return;
        }
        form.ai.providerId = id;
        if (opt) {
          form.ai.base = opt.baseUrl ? opt.baseUrl : form.ai.base;
          if (Array.isArray(opt.models) && opt.models.length) {
            form.ai.models = opt.models.slice();
            if (!form.ai.model) form.ai.model = opt.models[0];
          } else if (opt.model) {
            form.ai.model = opt.model;
          }
        }
        render();
      };
    }

    // 点选已拉到的模型 → 直接改模型名
    for (const el of $$('[data-model]')) {
      el.onclick = () => {
        form.ai.model = el.getAttribute('data-model') || form.ai.model;
        render();
      };
    }

    // 自定义 UI 下拉：点击开关；点击页面其它地方关闭
    for (const el of $$('[data-dd-toggle]')) {
      el.onclick = (e) => {
        e.stopPropagation();
        const dd = el.closest('.dropdown');
        if (dd) dd.classList.toggle('open');
      };
    }
    document.onclick = () => {
      for (const dd of $$('.dropdown.open')) dd.classList.remove('open');
    };

    // 统一带「进行中」反馈：点下去立刻置灰 + 改文字，完成后恢复。
    // 否则启停服务 / 体检 / 一键修复要几秒才出结果，用户以为卡死（G30）。
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.onclick = async () => {
        const old = el.textContent;
        el.disabled = true;
        el.textContent = '处理中…';
        try {
          await fn();
        } finally {
          el.disabled = false;
          el.textContent = old;
        }
      };
    };

    on('btnTestAi', async () => {
      const base = $('#aiBaseUrl');
      const key = $('#aiApiKey');
      const model = $('#aiModel');
      if (base) form.ai.base = base.value;
      form.ai.key = (key && key.value) ? key.value : '';
      if (model) form.ai.model = model.value;
      const r = await api('/api/ai/test', {
        method: 'POST',
        body: JSON.stringify({
          base: form.ai.base,
          key: form.ai.key,
          model: form.ai.model,
          // 思考强度一起测：模型不支持这套参数时这里就会暴露出来
          reasoningEffort: (state && state.config && state.config.ai) ? state.config.ai.reasoningEffort : 'off',
          reasoningFormat: (state && state.config && state.config.ai) ? state.config.ai.reasoningFormat : 'standard',
          reasoningBudget: (state && state.config && state.config.ai) ? state.config.ai.reasoningBudget : 0,
        }),
      });
      modelStatus = { probed: true, state: r.ok ? 'ok' : 'bad' };
      form.ai.result = r;
      render();
    });

    on('btnPullModels', async () => {
      const base = $('#aiBaseUrl');
      const key = $('#aiApiKey');
      if (base) form.ai.base = base.value;
      form.ai.key = (key && key.value) ? key.value : '';
      const r = await api('/api/ai/models', {
        method: 'POST',
        body: JSON.stringify({ base: form.ai.base, key: form.ai.key }),
      });
      form.ai.models = (r.models || []).slice(0, 30);
      if (form.ai.models.length && !form.ai.model) form.ai.model = form.ai.models[0];
      if (!r.ok) form.ai.result = { ok: false, detail: r.reason || '拉取失败：模型服务可能没启动' };
      render();
    });

    on('btnSaveAi', async () => {
      const baseEl = document.getElementById('aiBaseUrl');
      if (baseEl) form.ai.base = baseEl.value;
      const modelEl = document.getElementById('aiModel');
      if (modelEl) form.ai.model = modelEl.value;
      const keyEl = document.getElementById('aiApiKey');
      form.ai.key = keyEl ? keyEl.value : '';
      const live = (state && state.config && state.config.ai) || {};
      const plan = rules.planAiSave
        ? rules.planAiSave({ live, base: form.ai.base, model: form.ai.model, key: form.ai.key })
        : { values: { AI_BASE_URL: form.ai.base, AI_MODEL: form.ai.model }, changed: false, needConfirm: false, from: live, to: { base: form.ai.base, model: form.ai.model } };
      // 保存 = 改写 .env 里真正生效的地址与模型。换之前先说清楚从什么换成什么。
      if (plan.needConfirm) {
        const ok = confirm('要把 AI 配置改成下面这样吗？\n\n' +
          '地址：' + (plan.from.base || '空') + '\n  → ' + (plan.to.base || '空') + '\n' +
          '模型：' + (plan.from.model || '空') + '\n  → ' + (plan.to.model || '空') + '\n\n' +
          '写进 .env 后还要重启助手才会生效。确定吗？');
        if (!ok) return;
      }
      const values = collectBinds();
      Object.assign(values, plan.values);
      await api('/api/env', { method: 'POST', body: JSON.stringify({ values }) });
      await refresh(true);
      alert('已保存到 .env。\n注意：正在运行的助手还在用旧配置，需要重启助手才会生效。');
    });

    on('btnSaveCtx', async () => {
      await api('/api/env', { method: 'POST', body: JSON.stringify({ values: collectBinds() }) });
      await refresh(true);
    });

    // 把当前人设（默认是内置那份）落成一份本地 .md，绝对路径写回 .env
    on('btnPreviewPersona', async () => {
      const box = document.getElementById('personaPreview');
      if (!box) return;
      box.style.display = 'block';
      const inp = document.getElementById('aiPersonaFile');
      const p = (state.config.ai.personaFileResolved || (inp && inp.value.trim()) || '');
      if (!p) { box.textContent = '（没有指定人设文件 —— 当前用内置默认人设，正文见上方「人设正文」）'; return; }
      box.textContent = '加载中…';
      const r = await api('/api/fs/read?path=' + encodeURIComponent(p));
      box.textContent = r.error
        ? ('预览失败：' + r.error)
        : ((r.text || '（文件是空的）') + (r.truncated ? '\n…（超过 64KB，已截断显示）' : ''));
    });

    on('btnExportPersona', async () => {
      const r = await api('/api/persona/export', { method: 'POST', body: JSON.stringify({ name: 'persona.txt' }) });
      if (!r.ok && r.error) {
        if (/已存在/.test(r.error) && !confirm(r.error + '\n\n覆盖了才能继续，要覆盖吗？')) return;
        const again = await api('/api/persona/export', { method: 'POST', body: JSON.stringify({ name: 'persona.txt', overwrite: true }) });
        if (!again.ok && again.error) { alert('导出失败：' + again.error); return; }
        await refresh(true);
        alert('已导出到：' + (again.path || '') + '\n\n直接用记事本改这个文件，重启助手后生效。');
        return;
      }
      await refresh(true);
      alert('已导出到：' + (r.path || '') + '\n\n直接用记事本改这个文件，重启助手后生效。');
    });

    on('btnResetPersona', async () => {
      if (!confirm('清空人设文件路径与内联人设，改用内置默认人设（会如实表明 AI 身份）？')) return;
      await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { AI_PERSONA_FILE: '', AI_SYSTEM_PROMPT: '' } }) });
      await refresh(true);
      alert('已恢复内置默认人设。重启助手后生效。');
    });

    on('btnSaveWechat', async () => {
      await api('/api/env', { method: 'POST', body: JSON.stringify({ values: collectBinds() }) });
      await refresh(true);
    });

    on('btnSaveChats', async () => {
      const chats = {};
      for (const row of $$('.chatrow')) {
        const id = row.getAttribute('data-chat');
        const sw = row.querySelector('[data-sw]');
        const persona = row.querySelector('input[id^="persona-"]');
        // 一行可能有多个分段（群策略 + 回复模式…）：逐个分段读它当前选中的值，
        // 按 data-bind 的 chat.<id>.<field> 还原到对应字段，避免只取第一个分段漏掉其余。
        const segFields = {};
        for (const segRow of row.querySelectorAll('.segrow')) {
          const b = segRow.getAttribute('data-bind') || '';
          if (b.indexOf('chat.') !== 0) continue;
          const field = b.split('.')[2];
          const on = segRow.querySelector('.seg-item.on');
          if (field && on) segFields[field] = on.getAttribute('data-val');
        }
        // 界面上没暴露的字段（单独模型、思考强度…）要原样保留，
        // 否则「保存全部会话」会把它们悄悄抹掉。
        const prev = (state.chats && state.chats[id]) || {};
        const keep = {};
        for (const k of ['model', 'baseUrl', 'systemPrompt', 'triggerPrefix', 'reasoningEffort', 'reasoningFormat']) {
          if (prev[k]) keep[k] = prev[k];
        }
        chats[id] = Object.assign(keep, {
          enabled: sw ? sw.getAttribute('aria-checked') === 'true' : true,
          groupReply: segFields.groupReply !== undefined ? segFields.groupReply : '',
          replyMode: segFields.replyMode !== undefined ? segFields.replyMode : '',
          personaFile: persona ? persona.value : '',
        });
      }
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
      form.chat.searchMsg = '已保存 ' + Object.keys(chats).length + ' 个会话，并自动同步到监听列表';
      await refresh(true);
    });

    // 搜索联系人：回车即搜；留空列出通讯录前 50 个（不知道怎么搜也能直接挑）
    async function runContactSearch() {
      const box = $('#newChatId');
      const q = (box ? box.value : '').trim();
      form.chat.query = q;
      form.chat.searchMsg = '正在搜索…';
      render(); // 先给个反馈，通讯录表探测可能要几秒
      // 本地已配置会话先匹配（不依赖 hook，保证搜索至少有反馈）
      const kw = q.toLowerCase();
      const local = q ? Object.keys(state.chats || {})
        .filter((id) => {
          const nm = String((state.chats[id] || {}).name || '').toLowerCase();
          return id.toLowerCase().includes(kw) || nm.includes(kw);
        })
        .map((id) => ({ id, name: (state.chats[id] || {}).name || '' })) : [];
      const r = await api('/api/contacts/search?q=' + encodeURIComponent(q) + '&force=1');
      const remote = (r.results || []).filter((x) => !local.some((l) => l.id === x.id));
      form.chat.results = local.concat(remote);
      form.chat.browse = Boolean(r.browse);
      if (r.ok) {
        if (form.chat.results.length) {
          form.chat.searchMsg = r.browse
            ? '通讯录前 ' + form.chat.results.length + ' 个联系人（输入关键字可缩小范围）'
            : '找到 ' + form.chat.results.length + ' 个，点「加入」即可';
        } else {
          form.chat.searchMsg = r.browse
            ? '通讯录是空的（或这个 DLL 不支持读通讯录）'
            : '没有匹配的联系人：换个关键字，或直接输入完整 wxid';
        }
      } else {
        form.chat.searchMsg = (r.reason || '搜索失败') +
          (local.length ? '（下面是本地已配置会话的匹配项）' : '');
      }
      render();
    }
    on('btnSearchContacts', runContactSearch);

    // 输入实时写回 form，避免 4 秒自动重绘把用户打的字冲掉；回车直接搜
    const chatBox = $('#newChatId');
    if (chatBox) {
      chatBox.oninput = () => { form.chat.query = chatBox.value; };
      chatBox.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          runContactSearch();
        }
      };
    }

    on('btnAddChat', async () => {
      const box = $('#newChatId');
      const id = box ? box.value.trim() : '';
      if (!id) {
        form.chat.searchMsg = '先输入完整 wxid / 群 id，或点「搜索联系人」挑一个';
        render();
        return;
      }
      const chats = {};
      chats[id] = { enabled: true };
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
      form.chat.query = '';
      form.chat.results = [];
      form.chat.searchMsg = '已加入 ' + id + '，并自动写入监听列表';
      await refresh(true);
    });

    on('btnClearAllCtx', async () => {
      if (!confirm('清空全部上下文记忆？')) return;
      await api('/api/context/clear', { method: 'POST', body: '{}' });
      await refresh(true);
    });

    on('btnReloadLogs', async () => {
      await refresh(true);
    });

    on('btnToggleGate', async () => {
      const paused = state.gate.paused;
      await api('/api/gate', { method: 'POST', body: JSON.stringify({ paused: !paused, reason: '图形化配置器暂停' }) });
      await refresh(true);
    });

    on('btnToggleService', async () => {
      const action = state.running ? 'stop' : 'start';
      await api('/api/service', { method: 'POST', body: JSON.stringify({ action }) });
      await refresh(true);
    });

    on('btnRefresh', async () => {
      await refresh(true);
    });


    for (const el of $$('[data-clear]')) {
      el.onclick = async () => {
        await api('/api/context/clear', { method: 'POST', body: JSON.stringify({ chatId: el.getAttribute('data-clear') }) });
        await refresh(true);
      };
    }

    for (const el of $$('[data-chatdel]')) {
      el.onclick = async () => {
        await api('/api/chats', { method: 'POST', body: JSON.stringify({ remove: [el.getAttribute('data-chatdel')] }) });
        await refresh(true);
      };
    }

    for (const el of $$('[data-add]')) {
      el.onclick = async () => {
        const id = el.getAttribute('data-add');
        const chats = {};
        chats[id] = { enabled: true };
        await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
        form.chat.results = (form.chat.results || []).filter((r) => r.id !== id);
        form.chat.searchMsg = '已加入 ' + id + '，并自动写入监听列表';
        await refresh(true);
      };
    }
  }

  async function main() {
    // 先取状态，再装载模型来源（loadSources 依赖 state.config 匹配当前来源）
    await refresh(true).catch(() => {});
    await loadSources().catch(() => {});
    render();
    // 4 秒自动刷新；用户正在输入时不重绘，避免抢焦点；
    // 下拉菜单展开时也不重绘 —— render() 会整体重建 DOM，把 .open 状态冲掉，
    // 表现为「点开选项还没看清就被 4 秒轮询收起」（用户实测踩坑）。
    setInterval(() => {
      const active = document.activeElement;
      const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      const ddOpen = !!document.querySelector('.dropdown.open');
      if (!typing && !ddOpen) refresh(false).catch(() => {});
    }, 4000);
  }

  g.main = main;
  document.addEventListener('DOMContentLoaded', main);
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
