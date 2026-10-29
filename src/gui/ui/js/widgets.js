/**
 * 界面控件库（图形化配置器）。
 *
 * 硬规则：**界面上不允许出现浏览器默认的裸勾选框**。
 * 布尔设置一律用 switchRow（开关），互斥枚举用 segRow（分段选择），
 * 危险动作用 actRow（按钮 + 二次确认），多选用 chipMulti（标签多选）。
 * 外部文本（群名、昵称、消息内容）进 DOM 前一律转义。
 */
(function (g) {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  const TAG = { '必须': 'must', '推荐': 'rec', '可选': 'opt' };

  function card(title, inner, tag) {
    const tagHtml = tag ? '<span class="card-tag tag-' + (TAG[tag] ? TAG[tag] : '') + '">' + esc(tag) + '</span>' : '';
    return '<section class="card"><h2>' + esc(title) + tagHtml + '</h2>' + inner + '</section>';
  }

  function group(title, items) {
    return '<div class="card-group"><h3>' + esc(title) + '</h3>' + items.join('') + '</div>';
  }

  function field(label, value, id, type, ph, bind) {
    const t = type ? type : 'text';
    return '<label>' + esc(label) +
      '<input id="' + esc(id) + '" type="' + esc(t) + '" value="' + esc(value) +
      '" placeholder="' + esc(ph ? ph : '') + '" autocomplete="off"' +
      (bind ? ' data-bind="' + esc(bind) + '"' : '') + '></label>';
  }

  function numField(label, value, id, bind) {
    return '<label>' + esc(label) +
      '<input id="' + esc(id) + '" type="number" value="' + esc(value) + '"' +
      (bind ? ' data-bind="' + esc(bind) + '"' : '') + '></label>';
  }

  function filePickerRow(label, id, value, bind, accept) {
    return '<label>' + esc(label) +
      '<div class="filepick">' +
      '<input id="' + esc(id) + '" type="text" value="' + esc(value) +
      '" placeholder="./data/persona.md" data-bind="' + esc(bind) + '" autocomplete="off">' +
      '<button type="button" class="btn" data-filebtn="' + esc(id) + '">浏览…</button>' +
      '<input type="file" id="' + esc(id) + 'File" accept="' + esc(accept ? accept : '.md,.txt,.json') + '" hidden>' +
      '</div></label>';
  }

  /**
   * 布尔开关。
   * 形态是「分段切换」而不是药丸滑块：整页的互斥控件（群聊策略、思考强度）
   * 都是这一套描边 + 选中实心的语言，药丸滑块放进来会显得格格不入。
   *
   * 生效时机（effect）写在说明文字里，不再放到右侧：整行是可点的（点哪都能切），
   * 右侧再摆一个胶囊标签，既像按钮又会被误点。
   */
  function switchRow(o) {
    const on = Boolean(o.value);
    const seg = (v, label) =>
      '<button type="button" class="seg-item' + (on === v ? ' on' : '') +
      '" data-sw-val="' + (v ? '1' : '0') + '">' + esc(label) + '</button>';
    const desc = esc(o.desc) + (o.effect ? '<i class="sw-eff">' + esc(o.effect) + '</i>' : '');
    return '<div class="swrow" role="switch" tabindex="0" aria-checked="' + (on ? 'true' : 'false') +
      '" data-sw="' + esc(o.id) + '"' + (o.bind ? ' data-bind="' + esc(o.bind) + '"' : '') + '>' +
      '<span class="swtext"><b>' + esc(o.title) + '</b><span>' + desc + '</span></span>' +
      '<span class="seg seg-sw">' + seg(false, '关') + seg(true, '开') + '</span>' +
      '</div>';
  }

  /**
   * 文件上传行：文本框（可手填绝对路径）+「上传文件」按钮 + 隐藏的原生文件选择器。
   * 上传由 main.js 统一处理（读到文本后 POST /api/file/upload，回填绝对路径）。
   */
  function uploadRow(o) {
    return '<label>' + esc(o.label) +
      '<div class="filepick">' +
      '<input id="' + esc(o.id) + '" type="text" value="' + esc(o.value) +
      '" placeholder="' + esc(o.placeholder || '留空＝用内置默认人设') + '"' +
      (o.bind ? ' data-bind="' + esc(o.bind) + '"' : '') + ' autocomplete="off">' +
      '<button type="button" class="btn" data-filebtn="' + esc(o.id) + '">' +
      esc(o.button || '上传文件…') + '</button>' +
      '<input type="file" id="' + esc(o.id) + 'File" accept="' + esc(o.accept || '.md,.txt') + '" hidden>' +
      '</div></label>';
  }

  /** 分段选择：互斥枚举，显示中文、存英文值。 */
  function segRow(o) {
    const items = (o.options ? o.options : []).map((op) =>
      '<button type="button" class="seg-item' + (op.value === o.value ? ' on' : '') +
      '" data-seg="' + esc(o.id) + '" data-val="' + esc(op.value) + '">' + esc(op.label) + '</button>').join('');
    return '<div class="segrow"' + (o.bind ? ' data-bind="' + esc(o.bind) + '"' : '') + '>' +
      '<span class="swtext"><b>' + esc(o.title) + '</b><span>' + esc(o.desc) + '</span></span>' +
      '<span class="seg">' + items + '</span></div>';
  }

  /**
   * 动作按钮：危险动作走二次确认，不做成开关。
   * o.disabled：已经做完的事（已开启 / 已锁定）按钮置灰不可点——
   * 灰度只留给「真的不能点」，别让可用按钮也长成灰的。
   */
  function actRow(o) {
    return '<div class="actrow">' +
      '<span class="swtext"><b>' + esc(o.title) + '</b><span>' + esc(o.desc) + '</span></span>' +
      '<button type="button" class="btn' + (o.danger ? ' danger' : '') +
      '" data-act="' + esc(o.action) + '"' + (o.payload ? ' data-payload="' + esc(o.payload) + '"' : '') +
      (o.disabled ? ' disabled' : '') + '>' +
      esc(o.label) + '</button></div>';
  }

  /** 下拉选择：互斥枚举但选项多（分段选择放不下时用）。 */
  function selectRow(o) {
    const opts = (o.options ? o.options : []).map((op) =>
      '<option value="' + esc(op.value) + '"' + (op.value === o.value ? ' selected' : '') + '>' +
      esc(op.label) + '</option>').join('');
    return '<label class="selectrow"' + (o.bind ? ' data-bind="' + esc(o.bind) + '"' : '') + '>' +
      '<span class="swtext"><b>' + esc(o.title) + '</b><span>' + esc(o.desc) + '</span></span>' +
      '<select class="select" id="' + esc(o.id) + '"' + (o.bind ? ' data-select="' + esc(o.bind) + '"' : '') + '>' +
      opts + '</select></label>';
  }

  /** 标签多选：多选集合（允许 / 排除的会话）。 */
  function chipMulti(o) {
    const selected = o.values ? o.values : [];
    const chips = (o.items ? o.items : []).map((it) =>
      '<button type="button" class="chip' + (selected.indexOf(it.value) >= 0 ? ' on' : '') +
      '" data-chip="' + esc(o.id) + '" data-val="' + esc(it.value) + '">' +
      esc(it.label) + (it.hint ? '<i>' + esc(it.hint) + '</i>' : '') + '</button>').join('');
    return '<div class="chiprow"' + (o.bind ? ' data-bind="' + esc(o.bind) + '"' : '') + '>' +
      '<span class="swtext"><b>' + esc(o.title) + '</b><span>' + esc(o.desc) + '</span></span>' +
      '<div class="chips">' + chips + '</div></div>';
  }

  /** 卡片底部的「下一步建议」。 */
  function nextHint(text) {
    if (!text) return '';
    return '<div class="nexthint"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg><span>' + esc(text) + '</span></div>';
  }

  /**
   * 密钥类字段：默认就显示「当前有没有密钥」（presence），
   * 真值预填进 password 框（点「显示」可查看，账号是本人本机，不外发），
   * 填了立即自动保存并替换旧的、清空失焦可删除。
   * 用 autocomplete="new-password" 关掉浏览器自动填充。
   * @param {string} label
   * @param {string} value    已保存的真值（空＝未配置）
   * @param {string} id
   * @param {string} bind     data-bind / data-secret 用的键（如 'ai.key'）
   * @param {boolean} present 是否已配置
   */
  function secretField(label, value, id, bind, present, placeholder) {
    const v = value ? String(value) : '';
    const stateTxt = present
      ? '✓ 已配置（已保存在 .env，点「显示」可查看；填新值＝替换，清空失焦＝删除）'
      : '○ 未配置（填了立即自动保存）';
    return '<div class="secret-box">' +
      '<label>' + esc(label) +
      '<div class="secret-wrap">' +
      '<input id="' + esc(id) + '" type="password" class="secret-input" value="' + esc(v) +
      '" placeholder="' + esc(placeholder ? placeholder : '') + '" autocomplete="new-password"' +
      ' data-secret="' + esc(bind) + '" data-present="' + (present ? '1' : '0') + '"' +
      (bind ? ' data-bind="' + esc(bind) + '"' : '') + '>' +
      '<button type="button" class="btn ghost secret-reveal" data-reveal="' + esc(id) + '" tabindex="-1">显示</button>' +
      '</div></label>' +
      '<p class="hint secret-state' + (present ? ' ok' : '') + '">' + esc(stateTxt) + '</p>' +
      '</div>';
  }

  g.W = {
    esc: esc, card: card, group: group, field: field, numField: numField,
    filePickerRow: filePickerRow, uploadRow: uploadRow, switchRow: switchRow, segRow: segRow,
    selectRow: selectRow, actRow: actRow, chipMulti: chipMulti, nextHint: nextHint,
    secretField: secretField,
  };
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
