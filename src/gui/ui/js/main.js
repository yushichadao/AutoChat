/**
 * 图形化配置器前端主程序。
 *
 * 职责边界：取数据、拼界面、绑事件；控件长什么样由 js/widgets.js 决定，
 * 业务判断由服务端的 src/tasks/ 决定。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const token = new URLSearchParams(location.search).get('token') || '';
  let state = null;
  let onboard = null;
  let diag = null;
  let modelSvc = null;
  let logs = null;
  let installLog = '';
  let modelStatus = { probed: false, state: 'untested' };

  /** 用户正在填的内容：重绘时回填，避免输入被冲掉。 */
  const form = {
    ai: { base: '', key: '', model: '', providerId: '', options: [], result: null, review: [], atNames: '', triggerPrefix: '' },
    chat: { results: [], picked: null },
  };

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
    'ai.model': 'AI_MODEL',
    'ai.enabled': 'AI_ENABLED',
    'ai.groupReply': 'AI_GROUP_REPLY',
    'ai.atNames': 'AI_GROUP_AT_NAMES',
    'ai.triggerPrefix': 'AI_TRIGGER_PREFIX',
    'ai.maxPerHour': 'AI_MAX_PER_HOUR',
    'ai.cooldownMs': 'AI_COOLDOWN_MS',
    'ai.maxConcurrent': 'AI_MAX_CONCURRENT',
    'ai.contextTurns': 'AI_CONTEXT_TURNS',
    'ai.contextMaxChars': 'AI_CONTEXT_MAX_CHARS',
    'ai.contextTtlMs': 'AI_CONTEXT_TTL_MS',
    'wechat.selfId': 'WX_SELF_ID',
    'wechat.selfMode': 'WX_SELF_MODE',
    'wechat.receiveMode': 'WX_RECEIVE_MODE',
    'wechat.pollChats': 'WX_POLL_CHATS',
    'wechat.dllPath': 'WX_DLL_PATH',
  };

  async function loadSources() {
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
      const hit = options.find((o) => o.baseUrl && state.config.ai.baseUrl === o.baseUrl);
      form.ai.providerId = hit ? hit.id : options[0].id;
    }
  }

  async function refresh(force) {
    state = await api('/api/state');
    if (!form.ai.base && state.config.ai.baseUrl) form.ai.base = state.config.ai.baseUrl;
    if (!form.ai.model && state.config.ai.model) form.ai.model = state.config.ai.model;
    if (form.ai.atNames === '') form.ai.atNames = (state.config.ai.groupAtNames || []).join(',');
    if (form.ai.triggerPrefix === '') form.ai.triggerPrefix = state.config.ai.triggerPrefix || '';
    if (force) {
      onboard = await api('/api/onboarding');
      diag = await api('/api/diagnose');
      modelSvc = await api('/api/model-service');
      logs = await api('/api/logs?tail=200');
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
    badge('badgeAutoReply', !a.enabled ? '自动回复未启用' : (paused ? '自动回复已暂停' : '自动回复运行中'),
      !a.enabled ? 'warn' : (paused ? 'warn' : 'ok'));
    badge('badgeModel', modelStatus.state === 'ok' ? '模型已连通' : (a.baseUrl ? '模型未测' : '模型未配置'),
      modelStatus.state === 'ok' ? 'ok' : 'warn');

    const onboardHtml = cards.onboard(state, onboard);
    const wechat = cards.wechat(state);
    const modelSec = cards.ai(state, form) + cards.modelService(state, modelSvc);
    const startSec = cards.status(state);
    const advSec = cards.context(state) + cards.chats(state, form.chat);
    const sysSec = cards.install(state, installLog) + cards.logs(state, logs) + cards.diag(state, diag);

    $('#main').innerHTML =
      '<section class="sec" id="sec-onboard">' + (onboardHtml || '') + '</section>' +
      '<section class="sec" id="sec-wechat"><div class="sec-head"><h2>① 连接微信</h2><p>把 AI 接到你的微信上（必做）</p></div>' + wechat + '</section>' +
      '<section class="sec" id="sec-model"><div class="sec-head"><h2>② 选择模型</h2><p>让 AI 有脑子：本地 Ollama 或云端 API</p></div>' + modelSec + '</section>' +
      '<section class="sec" id="sec-start"><div class="sec-head"><h2>③ 启动助手</h2><p>注入 hook、开自动回复</p></div>' + startSec + '</section>' +
      '<section class="sec" id="sec-adv"><div class="sec-head"><h2>④ 高级设置</h2><p>上下文、按会话、安装 / 卸载、日志、体检</p></div>' + advSec + sysSec + '</section>';
    bind();
    bindNav();
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

  /** 读表单里所有 [data-bind] 的值。 */
  function collectBinds() {
    const out = {};
    for (const el of $$('[data-bind]')) {
      const key = el.getAttribute('data-bind');
      if (!key || key.indexOf('chat.') === 0) continue;
      if (ENV_KEY[key]) out[ENV_KEY[key]] = el.value;
    }
    return out;
  }

  /** 开关 / 分段 / 动作 的事件绑定。 */
  function bind() {
    for (const el of $$('[data-sw]')) {
      const toggle = async () => {
        const on = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', on ? 'true' : 'false');
        const st = el.querySelector('.sw-state');
        if (st) st.textContent = on ? '开启' : '关闭';
        const bind2 = el.getAttribute('data-bind');
        const chatId = el.getAttribute('data-chat');
        if (bind2 === 'ai.enabled') {
          await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { AI_ENABLED: on ? '1' : '0' } }) });
        } else if (chatId) {
          const chats = {};
          chats[chatId] = { enabled: on };
          await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
        }
        await refresh(true);
      };
      el.onclick = toggle;
      el.onkeydown = (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle();
        }
      };
    }

    for (const el of $$('.seg-item')) {
      el.onclick = async () => {
        const val = el.getAttribute('data-val');
        const seg = el.closest('.seg');
        for (const x of seg.querySelectorAll('.seg-item')) x.classList.remove('on');
        el.classList.add('on');
        const row = el.closest('.segrow');
        const bind2 = row ? row.getAttribute('data-bind') : '';
        if (bind2 && bind2.indexOf('chat.') === 0) {
          const id = bind2.split('.')[1];
          const chats = {};
          chats[id] = { groupReply: val };
          await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
        } else if (bind2 && ENV_KEY[bind2]) {
          await api('/api/env', { method: 'POST', body: JSON.stringify({ values: { [ENV_KEY[bind2]]: val } }) });
        }
        await refresh(true);
      };
    }

    for (const el of $$('[data-act]')) {
      el.onclick = async () => {
        const act = el.getAttribute('data-act');
        const payload = el.getAttribute('data-payload') || '';
        el.disabled = true;
        try {
          if (act === 'service-start') await api('/api/service', { method: 'POST', body: JSON.stringify({ action: 'start' }) });
          else if (act === 'service-stop') await api('/api/service', { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
          else if (act === 'pause') await api('/api/gate', { method: 'POST', body: JSON.stringify({ paused: true, reason: '图形化配置器暂停' }) });
          else if (act === 'resume') await api('/api/gate', { method: 'POST', body: JSON.stringify({ paused: false }) });
          else if (act === 'lock') await api('/api/lock', { method: 'POST', body: '{}' });
          else if (act === 'autodll') await api('/api/autodll', { method: 'POST', body: JSON.stringify({ write: true }) });
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
            if (!confirm('卸载会停服务、去自启、删快捷方式并还原微信目录里的 version.dll，确定？')) return;
            await api('/api/uninstall', { method: 'POST', body: '{}' });
          } else if (act === 'install') {
            const body = { env: {}, chats: {} };
            if (payload === 'autostart') body.autostart = true;
            if (payload === 'shortcut') body.shortcut = true;
            const r = await api('/api/install', { method: 'POST', body: JSON.stringify(body) });
            installLog = (r.steps || []).map((s) => (s.ok ? '✓ ' : '✗ ') + s.name + (s.detail ? ' — ' + s.detail : '')).join('\n');
          }
        } finally {
          el.disabled = false;
        }
        await refresh(true);
      };
    }

    for (const el of $$('[data-src]')) {
      el.onclick = () => {
        const id = el.getAttribute('data-src');
        form.ai.providerId = id;
        const opt = form.ai.options.find((o) => o.id === id);
        if (opt) {
          form.ai.base = opt.baseUrl ? opt.baseUrl : form.ai.base;
          if (opt.model) form.ai.model = opt.model;
        }
        render();
      };
    }

    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

    on('btnTestAi', async () => {
      const base = $('#aiBaseUrl');
      const key = $('#aiApiKey');
      const model = $('#aiModel');
      if (base) form.ai.base = base.value;
      if (key && key.value) form.ai.key = key.value;
      if (model) form.ai.model = model.value;
      const r = await api('/api/ai/test', {
        method: 'POST',
        body: JSON.stringify({ base: form.ai.base, key: form.ai.key, model: form.ai.model }),
      });
      modelStatus = { probed: true, state: r.ok ? 'ok' : 'bad' };
      form.ai.result = r;
      render();
    });

    on('btnPullModels', async () => {
      const base = $('#aiBaseUrl');
      const key = $('#aiApiKey');
      if (base) form.ai.base = base.value;
      if (key && key.value) form.ai.key = key.value;
      const r = await api('/api/ai/models', {
        method: 'POST',
        body: JSON.stringify({ base: form.ai.base, key: form.ai.key }),
      });
      form.ai.review = (r.models || []).slice(0, 6).map((m) => ({ text: m }));
      render();
    });

    on('btnSaveAi', async () => {
      const values = collectBinds();
      values.AI_BASE_URL = form.ai.base;
      values.AI_MODEL = form.ai.model;
      if (form.ai.key) values.AI_API_KEY = form.ai.key;
      await api('/api/env', { method: 'POST', body: JSON.stringify({ values }) });
      await refresh(true);
    });

    on('btnSaveCtx', async () => {
      await api('/api/env', { method: 'POST', body: JSON.stringify({ values: collectBinds() }) });
      await refresh(true);
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
        const seg = row.querySelector('.seg-item.on');
        const persona = row.querySelector('input[id^="persona-"]');
        chats[id] = {
          enabled: sw ? sw.getAttribute('aria-checked') === 'true' : true,
          groupReply: seg ? seg.getAttribute('data-val') : '',
          personaFile: persona ? persona.value : '',
        };
      }
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
      await refresh(true);
    });

    on('btnSearchContacts', async () => {
      const box = $('#newChatId');
      const q = box ? box.value : '';
      const r = await api('/api/contacts/search?q=' + encodeURIComponent(q));
      form.chat.results = r.results || [];
      render();
    });

    on('btnAddChat', async () => {
      const box = $('#newChatId');
      const id = box ? box.value : '';
      if (!id) return;
      const chats = {};
      chats[id] = { enabled: true };
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
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
        const chats = {};
        chats[el.getAttribute('data-add')] = { enabled: true };
        await api('/api/chats', { method: 'POST', body: JSON.stringify({ chats }) });
        await refresh(true);
      };
    }
  }

  async function main() {
    await loadSources().catch(() => {});
    await refresh(true);
    // 4 秒自动刷新；用户正在输入时不重绘，避免抢焦点
    setInterval(() => {
      const active = document.activeElement;
      const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (!typing) refresh(false).catch(() => {});
    }, 4000);
  }

  g.main = main;
  document.addEventListener('DOMContentLoaded', main);
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
