/**
 * 卡片：状态与自动回复 / 首启向导 / 环境体检。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards ? g.cards : {};

  /** 状态卡：助手服务 + 自动回复开关 + 暂停状态（三个对象各归各的）。 */
  cards.status = function (state) {
    const a = state.config.ai;
    const paused = state.gate.paused;
    const rows = [];

    rows.push(W.actRow({
      title: '助手服务',
      desc: state.running
        ? '运行中（pid ' + state.pid + '）· 停止后不再收发消息'
        : '没有在运行 · 注入 hook DLL 需要管理员权限，启动时可自动提权',
      label: state.running ? '停止服务' : '启动服务',
      action: state.running ? 'service-stop' : 'service-start',
      danger: state.running,
    }));

    rows.push(W.switchRow({
      id: 'autoReply',
      bind: 'ai.enabled',
      title: '自动回复开关',
      desc: '关掉后只接收消息、不回复、不调用模型',
      value: a.enabled,
      effect: '重启后生效',
    }));

    rows.push(W.actRow({
      title: '暂停状态',
      desc: paused
        ? '已暂停自动回复（仍接收消息、仍记日志）· 崩溃重启后仍是暂停态'
        : '运行中 · 随时可暂停，命令是 autochat pause',
      label: paused ? '恢复自动回复' : '暂停自动回复',
      action: paused ? 'resume' : 'pause',
    }));

    const tip = !state.running
      ? '先启动助手服务，再验证一条消息有没有回。'
      : (paused ? '现在是暂停态，恢复后才会回消息。' : '都就绪了，去「按会话配置」确认要参与的群。');

    return W.card('状态与自动回复',
      '<div class="status-grid">' +
      '<div class="status-item ' + (state.running ? 'ok' : 'bad') + '"><b>助手服务</b><span>' +
      (state.running ? '运行中' : '未运行') + '</span></div>' +
      '<div class="status-item ' + (a.enabled ? (paused ? 'warn' : 'ok') : 'warn') + '"><b>自动回复</b><span>' +
      (!a.enabled ? '未启用' : (paused ? '已暂停' : '运行中')) + '</span></div>' +
      '<div class="status-item ' + (state.versionLocked ? 'ok' : 'warn') + '"><b>微信版本</b><span>' +
      (state.wechatVersion ? state.wechatVersion + (state.versionLocked ? '（已锁定）' : '（未锁定）') : '未检测到') +
      '</span></div></div>' + rows.join('') + W.nextHint(tip), '必须');
  };

  /** 首启向导卡：把每一步都列出来，缺什么点对应按钮即可（清晰入口）。 */
  cards.onboard = function (state, onboard) {
    if (!onboard || !onboard.steps || !onboard.steps.length) return '';
    const steps = onboard.steps;
    const rows = steps.map((s) => {
      const cls = s.level === 'ok' ? 'ok' : s.level === 'bad' ? 'bad' : s.level === 'warn' ? 'warn' : 'todo';
      const mark = s.level === 'ok' ? '✓' : s.level === 'bad' ? '✗' : s.level === 'warn' ? '!' : '○';
      const btn = s.action
        ? '<button type="button" class="btn primary sm" data-act="' + W.esc(s.action.kind) + '">' + W.esc(s.action.label) + '</button>'
        : '';
      return '<li class="ob-row ' + cls + '"><span class="ob-mark">' + mark + '</span>' +
        '<span class="ob-main"><b>' + W.esc(s.title) + '</b><span>' + W.esc(s.detail) +
        (s.next ? ' · ' + W.esc(s.next) : '') + '</span></span>' + btn + '</li>';
    }).join('');
    const sm = onboard.summary || {};
    const total = sm.total || steps.length;
    const head = '<p class="hint">还差 <b>' + ((sm.bad || 0) + (sm.warn || 0)) + '</b> 步没完成（共 ' + total + ' 步）。按下面按钮逐步搞定：</p>';
    return W.card('开始配置（向导）', head + '<ul class="ob-list">' + rows + '</ul>', '推荐');
  };

  /** 连接微信卡：把 hook DLL 自动匹配 / 锁版本 / 启动注入 做成显眼入口。 */
  cards.wechat = function (state) {
    const v = state.wechatVersion || '';
    const dllPath = (state.config && state.config.wechat && state.config.wechat.dllPath) || '';
    const builtin = state.builtinDll && state.builtinDll.path;
    const builtinVer = (state.builtinDll && state.builtinDll.version) || v;
    const locked = state.versionLocked;

    const rows = [];
    if (dllPath) {
      rows.push('<div class="actrow"><span class="swtext"><b>hook DLL</b><span>' + W.esc(dllPath) + '</span></span><span class="tag opt">已配置</span></div>');
    } else if (builtin) {
      rows.push(W.actRow({
        title: 'hook DLL',
        desc: '已匹配到内置 DLL（微信 ' + W.esc(builtinVer) + '），一键写入 WX_DLL_PATH',
        label: '自动匹配并写入',
        action: 'autodll',
      }));
    } else {
      rows.push('<div class="actrow"><span class="swtext"><b>hook DLL</b><span>未匹配本机微信（' + W.esc(v || '?') + '）的内置 DLL，需要自备匹配的 DLL</span></span><span class="tag warn">缺失</span></div>');
    }
    rows.push(W.actRow({
      title: '锁定微信版本',
      desc: locked ? '已锁定，微信不会自动升级（升级会让 DLL 失效）' : '锁定后微信无法自动升级，避免 hook DLL 失效',
      label: locked ? '已锁定' : '锁定',
      action: 'lock',
    }));
    rows.push(W.actRow({
      title: '注入并启动助手',
      desc: '启动服务会把 hook DLL 注入正在运行的微信（需管理员，会弹 UAC 提权）',
      label: '启动助手',
      action: 'service-start',
    }));

    const tip = !v
      ? '先装好并登录电脑版微信，刷新后这里会显示匹配结果。'
      : '配好 DLL 与版本锁定后，点「启动助手」即自动注入微信。';
    return W.card('连接微信（必做）',
      '<p class="hint">检测到微信版本：' + W.esc(v || '未检测到') + '</p>' + rows.join('') + W.nextHint(tip), '必须');
  };

  /** 环境体检卡：分级结果 + 每项下一步。 */
  cards.diag = function (state, diag) {
    if (!diag || !diag.items) return '';
    const rows = diag.items.map((it) => {
      const cls = it.level === 'ok' ? 'ok' : it.level === 'warn' ? 'warn' : 'bad';
      const mark = it.level === 'ok' ? '✓' : it.level === 'warn' ? '!' : '✗';
      return '<li class="dg-item ' + cls + '"><b>' + mark + ' ' + W.esc(it.name) + '</b>' +
        '<span>' + W.esc(it.detail) + '</span>' +
        (it.next ? '<i>' + W.esc(it.next) + '</i>' : '') + '</li>';
    }).join('');
    return W.card('环境体检', '<ul class="dg-list">' + rows + '</ul>', '可选');
  };

  g.cards = cards;
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
