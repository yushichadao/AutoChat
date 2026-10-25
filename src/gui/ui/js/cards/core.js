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

  /** 首启向导卡：步骤条 + 当前步 + 一个动作按钮。 */
  cards.onboard = function (state, onboard) {
    if (!onboard || !onboard.steps || !onboard.steps.length) return '';
    const steps = onboard.steps;
    const active = steps.find((s) => s.level === 'bad') || steps.find((s) => s.level === 'warn') || steps[0];

    const dots = steps.map((s) => {
      const cls = s.level === 'ok' ? 'ok' : s.level === 'bad' ? 'bad' : s.level === 'warn' ? 'warn' : 'todo';
      return '<li class="ob-dot ' + cls + (s.id === active.id ? ' cur' : '') + '">' +
        '<span class="ob-pip"></span><span class="ob-lab">' + W.esc(s.title) + '</span></li>';
    }).join('');

    let action = '';
    if (active.action) {
      action = '<button type="button" class="btn primary" data-act="' + W.esc(active.action.kind) + '">' +
        W.esc(active.action.label) + '</button>';
    }

    const body = '<ol class="ob-steps">' + dots + '</ol>' +
      '<div class="ob-detail"><b>' + W.esc(active.title) + '</b><p>' + W.esc(active.detail) + '</p>' +
      (active.next ? '<p class="dim">' + W.esc(active.next) + '</p>' : '') + action + '</div>';

    return W.card('首启向导', body, '推荐');
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
