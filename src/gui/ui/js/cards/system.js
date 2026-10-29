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
      disabled: Boolean(state.autoStart),
    }));
    rows.push(W.actRow({
      title: '桌面快捷方式',
      desc: '在桌面放一个「AutoChat 配置器」图标，双击直接打开界面',
      label: state.installed && state.installed.shortcut ? '已创建' : '创建',
      action: 'install',
      payload: 'shortcut',
      disabled: Boolean(state.installed && state.installed.shortcut),
    }));
    rows.push(W.actRow({
      title: '锁定微信版本',
      desc: '阻断微信自动更新（更新会让 hook DLL 失效）',
      label: state.versionLocked ? '已锁定' : '锁定',
      action: 'lock',
      disabled: Boolean(state.versionLocked),
    }));
    // 「卸载服务」≠「卸载软件」：默认只解除安装状态，程序本体仍在磁盘上。
    // 想要连程序一起处理，必须显式勾这个开关（回收站可还原，不是直接删除）。
    rows.push(W.switchRow({
      id: 'uninstallRecycle',
      title: '卸载后把程序目录移入回收站',
      desc: '默认只卸载服务（停服、去自启、删快捷方式、还原 DLL）——程序本体还在磁盘上。勾上才会把整个程序目录移入回收站（可还原）。',
      value: false,
      effect: '点下面的「卸载」时才生效',
    }));
    rows.push(W.actRow({
      title: '卸载还原',
      desc: '停服务、去自启、删快捷方式、还原 version.dll、解除微信更新阻断',
      label: '卸载',
      action: 'uninstall',
      danger: true,
    }));

    const log = installLog
      ? '<div class="ilog-wrap"><button type="button" class="btn ghost sm" data-act="copy-installlog">复制</button>' +
        '<pre class="ilog">' + W.esc(installLog) + '</pre></div>'
      : '';

    return W.card('安装与卸载',
      (installed ? '<p class="hint">已配置：' + W.esc(state.installed.envFile) + '</p>' : '<p class="hint">还没配置过。先跑一次安装。</p>') +
      rows.join('') + log +
      W.nextHint('卸载不会删你的微信聊天记录'), '可选');
  };

  /** 服务日志卡。 */
  cards.logs = function (state, logs) {
    if (!logs) return '';
    const count = logs.exists ? logs.lines.length : 0;
    const head = '<div class="loghead"><span class="dim">' +
      (logs.exists ? (count ? '最近 ' + count + ' 行（最新在上）' : '暂无日志行') : '还没有日志') + '</span>' +
      '<button class="btn sm" id="btnReloadLogs">刷新</button></div>';
    if (!logs.exists) {
      return W.card('服务日志', head + '<div class="emptybox">日志由「后台启动」产生（autochat start --background）；前台启动时日志直接打在终端里。</div>', '可选');
    }
    if (!count) {
      return W.card('服务日志', head + '<div class="emptybox">日志是空的。发一条消息或重启助手后回来刷新看看。</div>', '可选');
    }
    const body = logs.lines.slice().reverse().map((l) => {
      const bad = /ERROR|WARN/.test(l);
      return '<div class="logline' + (bad ? ' bad' : '') + '">' + W.esc(l) + '</div>';
    }).join('');
    return W.card('服务日志', head + '<div class="logbox">' + body + '</div>', '可选');
  };

  /** 自消息识别（同号测试用）：控制助手如何识别「自己发的消息」及是否回复。
   *  当前登录微信号由 hook 实时识别并展示，不再支持手动输入，避免换号时窜号。 */
  cards.selfMessage = function (state) {
    const w = (state.config && state.config.wechat) || {};
    const mode = w.selfMode || 'id';
    const excl = w.pollExcludeSelf === true || w.pollExcludeSelf === '1' || w.pollExcludeSelf === 1;
    const acc = state.account || {};
    const accText = acc.wxid
      ? (acc.nickname ? acc.nickname + '（' + acc.wxid + '）' : acc.wxid)
      : '（未能识别，请确认微信已登录且 hook 已连接）';
    const srcLabel = { hook: '微信实时', db: '本地库', env: '配置文件', unknown: '未配置' }[acc.source] || acc.source || '未知';
    const mismatch = Boolean(w.selfId) && Boolean(acc.wxid) && w.selfId !== acc.wxid;
    const body =
      '<p class="hint">当「测试号也是大号」（同号）时，控制助手如何识别自己发的消息、是否回复，避免同号自问自答死循环或漏回。</p>' +
      (mismatch
        ? '<div class="svc-banner bad">⚠ 配置里的 WX_SELF_ID=' + W.esc(w.selfId) +
          ' 与当前登录账号 ' + W.esc(acc.wxid) + ' 不一致，可能窜号。请更新 .env 的 WX_SELF_ID 或重启助手。</div>'
        : '') +
      '<div class="row fieldrow"><label>当前登录账号（自动识别）</label>' +
        '<div class="readbox">' + W.esc(accText) + ' <span class="tag opt">来源：' + W.esc(srcLabel) + '</span></div>' +
      '</div>' +
      '<div class="row fieldrow">' +
        '<label>识别回复模式</label>' +
        '<select data-select="wechat.selfMode">' +
          '<option value="id"' + (mode === 'id' ? ' selected' : '') + '>id（按助手发过的消息 id 精确过滤）</option>' +
          '<option value="sender"' + (mode === 'sender' ? ' selected' : '') + '>sender（按 wxid 过滤）</option>' +
        '</select>' +
      '</div>' +
      '<div class="row fieldrow">' +
        '<label>排除自己发的消息</label>' +
        '<div class="segrow" data-bind="wechat.pollExcludeSelf">' +
          '<div class="seg">' +
            '<button class="seg-item' + (excl ? ' on' : '') + '" data-val="1">排除</button>' +
            '<button class="seg-item' + (!excl ? ' on' : '') + '" data-val="0">不排除</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return W.card('自消息识别（同号测试）', body, '高级');
  };

  g.cards = cards;
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
