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
      '<input id="' + esc(id) + '" type="number" value="' + esc(value) +
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

  /** 开关行：标题 + 说明 + 开关 + 状态文字 + 生效时机。 */
  function switchRow(o) {
    const on = Boolean(o.value);
    return '<div class="swrow" role="switch" tabindex="0" aria-checked="' + (on ? 'true' : 'false') +
      '" data-sw="' + esc(o.id) + '"' + (o.bind ? ' data-bind="' + esc(o.bind) + '"' : '') + '>' +
      '<span class="sw"><span class="sw-knob"></span></span>' +
      '<span class="swtext"><b>' + esc(o.title) + '</b><span>' + esc(o.desc) + '</span></span>' +
      '<span class="sw-state">' + (on ? '开启' : '关闭') + '</span>' +
      (o.effect ? '<span class="tag opt">' + esc(o.effect) + '</span>' : '') +
      '</div>';
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

  /** 动作按钮：危险动作走二次确认，不做成开关。 */
  function actRow(o) {
    return '<div class="actrow">' +
      '<span class="swtext"><b>' + esc(o.title) + '</b><span>' + esc(o.desc) + '</span></span>' +
      '<button type="button" class="btn' + (o.danger ? ' danger' : '') +
      '" data-act="' + esc(o.action) + '"' + (o.payload ? ' data-payload="' + esc(o.payload) + '"' : '') + '>' +
      esc(o.label) + '</button></div>';
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

  g.W = {
    esc: esc, card: card, group: group, field: field, numField: numField,
    filePickerRow: filePickerRow, switchRow: switchRow, segRow: segRow,
    actRow: actRow, chipMulti: chipMulti, nextHint: nextHint,
  };
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
