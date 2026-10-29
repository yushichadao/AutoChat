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
      desc: !state.running
        ? '服务未运行 · 启动助手后暂停/恢复才生效'
        : (paused
          ? '已暂停自动回复（仍接收消息、仍记日志）· 崩溃重启后仍是暂停态'
          : '运行中 · 随时可暂停，命令是 autochat pause'),
      label: paused ? '恢复自动回复' : '暂停自动回复',
      action: paused ? 'resume' : 'pause',
    }));

    const acct = state.account || {};
    const accInfo = state.accountsInfo || {};
    const known = Array.isArray(accInfo.known) ? accInfo.known : [];
    const acctChips = known
      .map((id) => '<button type="button" class="chip" data-act="account-pick" data-wxid="' + W.esc(id) + '">' + W.esc(id) + '</button>')
      .join('');
    // 「当前账号」控件：显示现在认的是哪个号，并提供手动覆盖（探测偶发拿不到 wxid 时用来兜底）。
    // 所有记忆 / 群 / 模型配置都按这个号隔离，避免换号后旧会话漏给新号。
    const acctInfo =
      '<div class="actrow"><span class="swtext"><b>当前账号（记忆 / 群 / 模型配置均按此隔离）</b><span>' +
      W.esc(acct.wxid || '（未检测到）') + (acct.nickname ? ' · ' + W.esc(acct.nickname) : '') + ' · 来源 ' + W.esc(acct.source || '-') +
      '</span></span><span class="tag ' + (acct.wxid ? 'rec' : 'warn') + '">' + (acct.wxid ? '已识别' : '未识别') + '</span></div>' +
      '<div class="row fieldrow">' +
      W.field('手动指定当前账号 wxid（覆盖自动探测；留空＝自动）', acct.wxid || '', 'acctWxid', 'text', 'wxid_xxxx') +
      '<button type="button" class="btn" data-act="account-set">设为当前账号</button>' +
      '<button type="button" class="btn ghost" data-act="account-clear">自动探测</button>' +
      '</div>' +
      (acctChips ? '<div class="chiprow" style="margin-top:6px">已知账号：' + acctChips + '</div>' : '');

    const tip = !state.running
      ? '先启动助手服务，再验证一条消息有没有回。'
      : (paused ? '现在是暂停态，恢复后才会回消息。' : '都就绪了，去「按会话配置」确认要参与的群。');

    return W.card('状态与自动回复',
      acctInfo +
      '<div class="status-grid">' +
      '<div class="status-item ' + (state.running ? 'ok' : 'bad') + '"><b>助手服务</b><span>' +
      (state.running ? '运行中' : '未运行') + '</span></div>' +
      '<div class="status-item ' + (a.enabled && state.running && !paused ? 'ok' : 'warn') + '"><b>自动回复</b><span>' +
      (!a.enabled ? '未启用' : (!state.running ? '已启用（服务未运行）' : (paused ? '已暂停' : '运行中'))) + '</span></div>' +
      '<div class="status-item ' + (state.versionLocked ? 'ok' : 'warn') + '"><b>微信版本</b><span>' +
      (state.wechatVersion ? state.wechatVersion + (state.versionLocked ? '（已锁定）' : '（未锁定）') : '未检测到') +
      '</span></div></div>' + rows.join('') + W.nextHint(tip), '必须');
  };

  /** 首启向导卡：把每一步都列出来，缺什么点对应按钮即可（清晰入口）。 */
  cards.onboard = function (state, onboard) {
    if (!onboard || !onboard.steps || !onboard.steps.length) return '';
    const steps = onboard.steps;
    const sm = onboard.summary || {};
    const bad = sm.bad || 0;
    const warn = sm.warn || 0;
    const total = sm.total || steps.length;
    const allOk = bad === 0 && warn === 0;

    // 已就绪就不再催“还差 N 步”：全绿给完成态，只剩可选优化就分开说
    let head;
    if (allOk) {
      head = '<p class="hint"><b>✓ 已全部配置完成，助手运行中。</b>以下是各步骤当前状态（都已就绪，无需再操作）：</p>';
    } else if (bad === 0) {
      head = '<p class="hint">配置已就绪、可正常运行；下面 <b>' + warn + '</b> 项是可选优化（不处理也不影响使用）：</p>';
    } else {
      head = '<p class="hint">还差 <b>' + (bad + warn) + '</b> 步没完成（共 ' + total + ' 步）。按下面按钮逐步搞定：</p>';
    }

    const rows = steps.map((s) => {
      const cls = s.level === 'ok' ? 'ok' : s.level === 'bad' ? 'bad' : s.level === 'warn' ? 'warn' : 'todo';
      const mark = s.level === 'ok' ? '✓' : s.level === 'bad' ? '✗' : s.level === 'warn' ? '!' : '○';
      // 已完成的步骤不再给操作按钮（已经 ok 无需再点）；只有 warn/bad 才给入口
      const btn = (s.action && s.level !== 'ok')
        ? '<button type="button" class="btn primary sm" data-act="' + W.esc(s.action.kind) + '">' + W.esc(s.action.label) + '</button>'
        : '';
      return '<li class="ob-row ' + cls + '"><span class="ob-mark">' + mark + '</span>' +
        '<span class="ob-main"><b>' + W.esc(s.title) + '</b><span>' + W.esc(s.detail) +
        (s.next ? ' · ' + W.esc(s.next) : '') + '</span></span>' + btn + '</li>';
    }).join('');

    const title = allOk ? '配置完成' : '开始配置（向导）';
    return W.card(title, head + '<ul class="ob-list">' + rows + '</ul>', allOk ? '' : '推荐');
  };

  /** 连接微信卡：把 hook DLL 自动匹配 / 风险告知 / 锁版本 / 启动注入 做成显眼入口。 */
  cards.wechat = function (state) {
    const v = state.wechatVersion || '';
    const dllPath = (state.config && state.config.wechat && state.config.wechat.dllPath) || '';
    const builtin = state.builtinDll && state.builtinDll.path;
    const builtinVer = (state.builtinDll && state.builtinDll.version) || v;
    const locked = state.versionLocked;

    const rows = [];
    const dep = state.deployedDll;
    if (dllPath) {
      if (dep && dep.matchesExpected === false) {
        const want = state.builtinDll && state.builtinDll.path
          ? String(state.builtinDll.path).split('\\').pop()
          : '内置适配版';
        rows.push(W.actRow({
          title: 'hook DLL（版本不匹配）',
          desc: '微信 ' + (v || '') + ' 应该用 ' + want + '，但微信目录里是另一份（' +
            (dep.size / 1048576).toFixed(1) + ' MB）—— 版本不对会导致登录态和数据库全都读不到',
          label: '改用匹配的 DLL',
          action: 'fix-dll',
        }));
      } else if (!dep) {
        rows.push(W.actRow({
          title: 'hook DLL（还没写进微信目录）',
          desc: '配置的是 ' + dllPath + '；微信只加载安装目录下的 version.dll，先写进去再重启微信',
          label: '写入微信目录',
          action: 'deploy-dll',
        }));
      } else if (!dep.matches) {
        rows.push(W.actRow({
          title: 'hook DLL（微信目录里是另一份）',
          desc: '配置 ' + dllPath + '；微信实际加载 ' + dep.path + '（' + (dep.size / 1048576).toFixed(1) +
            ' MB，内容不一致）—— 所以登录状态读不到、消息也收不到',
          label: '用配置的覆盖',
          action: 'deploy-dll',
        }));
      } else {
        rows.push('<div class="actrow"><span class="swtext"><b>hook DLL（已部署到微信目录）</b><span>' +
          W.esc(dep.path) + ' · ' + (dep.size / 1048576).toFixed(1) + ' MB · 与配置一致</span></span>' +
          '<span class="tag rec">已部署</span></div>');
      }
    } else if (builtin) {
      rows.push(W.actRow({
        title: 'hook DLL（推荐匹配）',
        desc: '检测到微信 ' + W.esc(builtinVer) + '，已内置严格匹配的 DLL，一键写入即可，无需自备',
        label: '自动匹配并写入',
        action: 'autodll',
      }));
    } else {
      rows.push('<div class="actrow"><span class="swtext"><b>hook DLL</b><span>发布包自带适配 DLL，但没匹配到你的微信 ' +
        W.esc(v || '?') + ' —— 先去 .env 填 WX_INSTALL_DIR（微信安装目录）刷新重试；仍不行说明这个微信版本暂无适配 DLL</span></span>' +
        '<span class="tag warn">待匹配</span></div>');
    }
    rows.push(W.actRow({
      title: '锁定微信版本',
      desc: locked ? '已锁定，微信不会自动升级（升级会让 DLL 失效）' : '锁定后微信无法自动升级，避免 hook DLL 失效',
      label: locked ? '已锁定' : '锁定',
      action: 'lock',
      disabled: Boolean(locked),
    }));
    rows.push(W.actRow({
      title: '助手服务',
      desc: state.running
        ? '运行中（pid ' + state.pid + '）· 停止后不再收发消息'
        : '启动服务会把 hook DLL 注入正在运行的微信（需管理员，会弹 UAC 提权）',
      label: state.running ? '停止服务' : '启动助手',
      action: state.running ? 'service-stop' : 'service-start',
      danger: state.running,
    }));

    // 其他自定义配置方式：手动指定自己的 / 第三方 DLL
    const custom = '<details class="adv" data-adv="dll-custom"><summary>其他自定义配置方式</summary>' +
      '<div class="adv-body"><p class="hint">如果你有自己的 / 第三方的 hook DLL（必须和本机微信版本严格一致），可手动指定路径：</p>' +
      '<div class="row fieldrow">' +
      W.field('自定义 hook DLL 路径', dllPath, 'dllCustomPath', 'text', 'D:\\path\\to\\your.dll', 'wechat.dllPath') +
      '<button type="button" class="btn" data-act="dll-custom">应用此路径</button>' +
      '</div></div></details>';

    // 微信安装包：逆版本安装（合规：不内置、不转发安装包，只运行用户指定的本地 exe）
    const instPath = (state.config && state.config.wechat && state.config.wechat.installerPath) || '';
    const installer = '<details class="adv" data-adv="wx-installer"><summary>微信安装包（逆版本安装）</summary>' +
      '<div class="adv-body">' +
      '<p class="hint">当前微信 <b>' + W.esc(v || '未检测到') + '</b>。微信电脑版支持安装指定旧版本：' +
      '先退出微信并备份聊天记录 → 运行目标版本安装包 → 装完再点上面「锁定微信版本」。</p>' +
      '<div class="row fieldrow">' +
      W.field('本地安装包路径（.exe）', instPath, 'wxInstallerPath', 'text', 'D:\\downloads\\WeChatSetup-4.1.10.27.exe') +
      '</div>' +
      '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">' +
      '<button type="button" class="btn" data-act="wx-installer-run">运行安装包</button>' +
      '<button type="button" class="btn ghost" data-act="wx-installer-save">保存路径</button>' +
      '<button type="button" class="btn ghost" data-act="wx-installer-pick">选择文件…</button>' +
      '<button type="button" class="btn ghost" data-act="github-releases">打开 GitHub Releases</button>' +
      '</div>' +
      '<p class="hint">合规说明：本工具不内置、不转发微信安装包；请从 <a href="https://github.com/yushichadao/AutoChat/releases" target="_blank" rel="noopener">GitHub Releases</a> 获取与 hook DLL 对应版本的便携发布包。</p>' +
      '</div></details>';

    const risk = '<div class="risk"><b>风险提示：</b>注入 hook 会修改微信进程内存，且内置 DLL 未做代码签名；' +
      '微信版本错配或更新可能让注入失效甚至触发风控。建议：① 先「锁定微信版本」；② 用不重要的小号先试；③ 只从可信来源获取 DLL。</div>';

    const tip = !v
      ? '先装好并登录电脑版微信，刷新后这里会显示匹配结果。'
      : '配好 DLL 与版本锁定后，点「启动助手」即自动注入微信。';
    // 未登录时能连上 hook，但所有库都读不到：必须先讲清楚，否则用户只看到“搜不到/收不到”
    const loginWarn = state.wechatLogin === false
      ? '<div class="svc-banner bad">微信还没登录（hook 已连上，但读不到数据库）—— 先在微信里登录，否则通讯录搜不到、消息也收不到</div>'
      : '';
    // DLL 与版本/配置不一致：这是“能 ping 通但什么都读不到”的头号原因
    let dllWarn = '';
    if (dllPath && dep) {
      if (dep.matchesExpected === false) {
        dllWarn = '<div class="svc-banner bad">微信目录里的 hook DLL 与 ' + W.esc(v || '当前微信版本') +
          ' 不匹配（版本不对），登录状态和数据库都读不到。点下面「改用匹配的 DLL」后重启微信。</div>';
      } else if (!dep.matches) {
        dllWarn = '<div class="svc-banner bad">微信加载的不是你配置的 DLL：安装目录里是另一份 ' +
          (dep.size / 1048576).toFixed(1) + ' MB 的文件。点下面「用配置的覆盖」后重启微信。</div>';
      }
    }
    // 一键修复：哪里不对补哪里（微信版本 / DLL / 登录态）
    const repairBtn = '<div class="repair-cta">' +
      '<button type="button" class="btn primary big" data-act="auto-repair">一键修复</button>' +
      '<span class="muted">微信版本不对就重装对应版本，DLL 不对就部署项目匹配的并重启，最后校验登录态</span>' +
      '</div>';

    return W.card('连接微信（必做）',
      '<p class="hint">检测到微信版本：' + W.esc(v || '未检测到') + '</p>' + repairBtn + dllWarn + loginWarn +
      rows.join('') + risk + custom + installer + W.nextHint(tip), '必须');
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
