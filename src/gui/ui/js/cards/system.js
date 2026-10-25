/**
 * 卡片：安装与卸载 + 服务日志。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards ? g.cards : {};

  /** 安装与卸载卡。 */
  cards.install = function (state, installLog) {
    const installed = state.installed ? state.installed.installed : false;
    const rows = [];
    rows.push(W.actRow({
      title: '开机自启',
      desc: '开机后自动在后台跑助手服务（不弹终端窗口）',
      label: state.autoStart ? '已开启' : '开启',
      action: 'install',
      payload: 'autostart',
    }));
    rows.push(W.actRow({
      title: '桌面快捷方式',
      desc: '在桌面放一个「AutoChat 配置器」图标，双击直接打开界面',
      label: state.installed && state.installed.shortcut ? '已创建' : '创建',
      action: 'install',
      payload: 'shortcut',
    }));
    rows.push(W.actRow({
      title: '锁定微信版本',
      desc: '阻断微信自动更新（更新会让 hook DLL 失效）',
      label: state.versionLocked ? '已锁定' : '锁定',
      action: 'lock',
    }));
    rows.push(W.actRow({
      title: '卸载还原',
      desc: '停服务、去自启、删快捷方式、还原 version.dll、解除微信更新阻断',
      label: '卸载',
      action: 'uninstall',
      danger: true,
    }));

    const log = installLog ? '<pre class="ilog">' + W.esc(installLog) + '</pre>' : '';

    return W.card('安装与卸载',
      (installed ? '<p class="hint">已配置：' + W.esc(state.installed.envFile) + '</p>' : '<p class="hint">还没配置过。先跑一次安装。</p>') +
      rows.join('') + log +
      W.nextHint('卸载不会删你的微信聊天记录'), '可选');
  };

  /** 服务日志卡。 */
  cards.logs = function (state, logs) {
    if (!logs) return '';
    const head = '<div class="row end"><span class="dim">' +
      (logs.exists ? '显示最后 ' + logs.lines.length + ' 行' : '还没有日志') + '</span>' +
      '<button class="btn ghost" id="btnReloadLogs">刷新</button></div>';
    if (!logs.exists) {
      return W.card('服务日志', head + '<p class="hint">日志由「后台启动」产生（autochat start --background）；前台启动时日志直接打在终端里。</p>', '可选');
    }
    if (!logs.lines.length) {
      return W.card('服务日志', head + '<p class="hint">日志是空的。</p>', '可选');
    }
    const body = logs.lines.map((l) => {
      const bad = /ERROR|WARN/.test(l);
      return '<div class="logline' + (bad ? ' bad' : '') + '">' + W.esc(l) + '</div>';
    }).join('');
    return W.card('服务日志', head + '<div class="logbox">' + body + '</div>', '可选');
  };

  g.cards = cards;
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
