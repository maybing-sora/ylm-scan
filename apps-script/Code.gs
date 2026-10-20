/**
 * 棲蘭明池 點收盤點工具 — Google Apps Script 後端
 *
 * 放在「棲蘭明池 點收盤點資料」試算表的 擴充功能 → Apps Script。
 * 第一次使用：執行 setup()，再「部署 → 新增部署作業 → 網頁應用程式」
 *   執行身分：我；存取權：所有人。把網址交給 Claude 寫進網頁設定。
 *
 * 商品主檔直接讀取「728_棲蘭明池進貨料號表 + 廠商資料」試算表，不另外維護。
 */

var MASTER_SPREADSHEET_ID = '1xNHE6pyM5dWmG6YcsrTlRUW0IMPwgSTO2qMsHYGSUBg';

var TABS = {
  settings: '設定',
  sessions: '作業單',
  scans: '掃描紀錄',
  ledger: '異動明細',
  counts: '盤點紀錄',
  issues: '異常回報',
  sales: 'POS銷售',
  stock: '庫存彙總'
};

var HEADERS = {
  sessions: ['單號', '類型', '作業日期', '進貨單日期', '地點', '目的地', '廠商', '備註', '建立人', '建立時間', '狀態', '確認人', '確認時間', '更新時間'],
  scans: ['紀錄鍵', '單號', '區域', '人員', '裝置', '產品編號', '數量', '更新時間'],
  ledger: ['單號', '作業日期', '類型', '地點', '產品編號', '品名', '廠商', '數量', '人員', '寫入時間'],
  counts: ['單號', '盤點日期', '地點', '產品編號', '品名', '帳面數', '實盤數', '差異', '確認人', '確認時間'],
  issues: ['編號', '回報時間', '單號', '地點', '廠商', '產品編號', '品名', '異常類型', '數量', '說明', '回報人', '處理狀態', '處理備註', '更新時間'],
  sales: ['銷售日期', '地點', '產品編號或條碼', '數量', '備註'],
  stock: ['地點', '產品編號', '品名', '廠商', '帳面數']
};

var TYPE_LABEL = { receive: '驗收', transfer: '調撥', return: '退貨', count: '盤點' };

/* ============ setup ============ */

function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(HEADERS).forEach(function (k) { sheet_(k); });
  var st = ss.getSheetByName(TABS.settings) || ss.insertSheet(TABS.settings, 0);
  if (!st.getRange('A1').getValue()) {
    var pin = String(Math.floor(100000 + Math.random() * 900000));
    st.getRange('A1:B3').setValues([
      ['存取密碼', pin],
      ['說明', '現場人員第一次開啟網頁時輸入這組密碼。改密碼後，大家要重新輸入。'],
      ['', '']
    ]);
    st.getRange('A4').setValue('地點（一列一個，可自行增減）');
    var locs = ['CY', '明池倉', '神木園', '棲蘭餐廳', '明池湖', '棲蘭山莊大廳', '明池餐廳', '蔣公行館'];
    st.getRange(5, 1, locs.length, 1).setValues(locs.map(function (l) { return [l]; }));
    st.getRange('A1:A4').setFontWeight('bold');
    st.setColumnWidth(1, 220); st.setColumnWidth(2, 420);
  }
  var def = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  // 讀一次料號表，觸發授權並確認可以讀到
  var n = loadProducts_().length;
  var msg = '設定完成。存取密碼：' + st.getRange('B1').getValue() + '；已讀到 ' + n + ' 個商品。下一步：部署 → 新增部署作業 → 網頁應用程式。';
  st.getRange('A3:B3').setValues([['設定結果', msg]]);
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('點收盤點')
    .addItem('重新計算庫存彙總', 'refreshStockSheet')
    .addItem('初始設定（只需一次）', 'setup')
    .addToUi();
}

/* ============ web entry ============ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  return run_(p.pin, function () {
    switch (p.a) {
      case 'boot': return boot_();
      case 'session': return getSession_(p.id);
      case 'stock': return { stock: stockFor_(p.loc) };
      case 'issues': return { issues: listIssues_() };
      case 'ping': return { ok: true };
      default: throw new Error('未知的動作');
    }
  });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '資料格式錯誤' }); }
  return run_(body.pin, function () {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (body.a) {
        case 'saveSession': return saveSession_(body.session);
        case 'saveSheet': return saveSheet_(body);
        case 'saveIssue': return saveIssue_(body.issue);
        case 'finalize': return finalize_(body.id, body.person);
        case 'reopen': return reopen_(body.id);
        default: throw new Error('未知的動作');
      }
    } finally { lock.releaseLock(); }
  });
}

function run_(pin, fn) {
  try {
    if (String(pin || '') !== String(getPin_())) return json_({ ok: false, error: '密碼錯誤', code: 'pin' });
    var r = fn() || {};
    r.ok = true;
    return json_(r);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ============ helpers ============ */

function sheet_(key) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(TABS[key]);
  if (!sh) {
    sh = ss.insertSheet(TABS[key]);
    sh.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (key === 'scans' || key === 'ledger' || key === 'counts' || key === 'issues' || key === 'sales' || key === 'stock') {
      var col = HEADERS[key].indexOf(key === 'sales' ? '產品編號或條碼' : '產品編號') + 1;
      if (col > 0) sh.getRange(2, col, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    }
  }
  return sh;
}

function rows_(key) {
  var sh = sheet_(key);
  var n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, HEADERS[key].length).getValues();
}

function obj_(key, row) {
  var o = {};
  HEADERS[key].forEach(function (h, i) { o[h] = row[i] instanceof Date ? iso_(row[i]) : row[i]; });
  return o;
}

function iso_(d) { return Utilities.formatDate(d, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ss"); }
function day_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}
function nowIso_() { return iso_(new Date()); }

function getPin_() {
  var st = SpreadsheetApp.getActive().getSheetByName(TABS.settings);
  return st ? st.getRange('B1').getValue() : '';
}

function getLocations_() {
  var st = SpreadsheetApp.getActive().getSheetByName(TABS.settings);
  if (!st || st.getLastRow() < 5) return [];
  return st.getRange(5, 1, st.getLastRow() - 4, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); }).filter(String);
}

/* ============ 商品主檔（讀料號表） ============ */

var PRODUCTS_MEMO_ = null;
function loadProducts_() {
  if (PRODUCTS_MEMO_) return PRODUCTS_MEMO_;
  var ss = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
  var out = [], seen = {};
  ss.getSheets().forEach(function (sh) {
    var vals = sh.getDataRange().getDisplayValues();
    var hi = -1;
    for (var i = 0; i < Math.min(vals.length, 10); i++) {
      if (vals[i].join('|').indexOf('產品編號') >= 0 && vals[i].join('|').indexOf('產品條碼') >= 0) { hi = i; break; }
    }
    if (hi < 0) return;
    var H = vals[hi];
    var col = function (name) { for (var j = 0; j < H.length; j++) if (String(H[j]).indexOf(name) === 0) return j; return -1; };
    var c = { code: col('產品編號'), brand: col('品牌名稱'), loc: col('商品銷售點'), type: col('產品別'), cat: col('產品類別'),
      name: col('規格說明'), unit: col('單位'), price: col('商品定價'), vendor: col('供應商'), bar: col('產品條碼'), qty: col('數量') };
    for (var r = 0; r < vals.length; r++) {
      if (r === hi) continue;
      var code = String(vals[r][c.code] || '').trim();
      if (!/^\d{8,20}$/.test(code) || seen[code]) continue;
      seen[code] = true;
      var g = function (k) { return c[k] >= 0 ? String(vals[r][c[k]] || '').trim() : ''; };
      out.push({
        c: code, b: g('brand'), loc: g('loc'), t: g('type'), cat: g('cat'), n: g('name'), u: g('unit'),
        p: Number(g('price').replace(/[$,]/g, '')) || null, v: g('vendor'), bc: g('bar'),
        q: Number(g('qty').replace(/,/g, '')) || 0
      });
    }
  });
  PRODUCTS_MEMO_ = out;
  return out;
}

/* ============ boot / 讀取 ============ */

function boot_() {
  var sessions = rows_('sessions').map(function (r) { return obj_('sessions', r); })
    .sort(function (a, b) { return String(b['建立時間']).localeCompare(String(a['建立時間'])); })
    .slice(0, 150);
  return { products: loadProducts_(), locations: getLocations_(), sessions: sessions, received: receivedTotals_() };
}

// 已確認驗收的累計實收（依產品編號），用來算「還沒到的數量」
function receivedTotals_() {
  var m = {};
  rows_('ledger').forEach(function (r) {
    if (r[2] === '驗收') m[String(r[4])] = (m[String(r[4])] || 0) + Number(r[7] || 0);
  });
  return m;
}

function getSession_(id) {
  var s = null;
  rows_('sessions').forEach(function (r) { if (String(r[0]) === String(id)) s = obj_('sessions', r); });
  if (!s) throw new Error('找不到這張單');
  var sheets = {};
  rows_('scans').forEach(function (r) {
    if (String(r[1]) !== String(id)) return;
    var k = String(r[0]);
    if (!sheets[k]) sheets[k] = { zone: r[2], person: r[3], device: r[4], counts: {}, updatedAt: r[7] instanceof Date ? iso_(r[7]) : r[7] };
    sheets[k].counts[String(r[5])] = Number(r[6] || 0);
  });
  var issues = listIssues_().filter(function (x) { return String(x['單號']) === String(id); });
  var out = { session: s, sheets: sheets, issues: issues };
  if (s['類型'] === '盤點') out.book = stockFor_(s['地點']);
  return out;
}

function listIssues_() {
  return rows_('issues').map(function (r) { return obj_('issues', r); })
    .sort(function (a, b) { return String(b['回報時間']).localeCompare(String(a['回報時間'])); });
}

/* ============ 寫入 ============ */

function saveSession_(s) {
  if (!s || !s.id) throw new Error('缺少單號');
  var sh = sheet_('sessions'), data = rows_('sessions');
  var idx = -1;
  for (var i = 0; i < data.length; i++) if (String(data[i][0]) === String(s.id)) { idx = i; break; }
  if (idx >= 0 && data[idx][10] === '已確認') throw new Error('這張單已確認入帳，請先重新開啟');
  var row = [s.id, TYPE_LABEL[s.type] || s.type, s.date || '', s.poDate || '', s.location || '', s.to || '', s.vendor || '', s.memo || '',
    s.createdBy || '', s.createdAt || nowIso_(), idx >= 0 ? data[idx][10] : '進行中', idx >= 0 ? data[idx][11] : '', idx >= 0 ? data[idx][12] : '', nowIso_()];
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return {};
}

function saveSheet_(b) {
  if (!b.sessionId || !b.key) throw new Error('缺少紀錄鍵');
  var st = sessionStatus_(b.sessionId);
  if (st === '已確認') throw new Error('這張單已確認入帳，掃描結果不會再變更');
  // 同一支手機、同一區域的紀錄整批覆蓋（只會覆蓋自己的紀錄）
  var t = nowIso_(), rows = [];
  Object.keys(b.counts || {}).forEach(function (code) {
    var q = Number(b.counts[code] || 0);
    if (q) rows.push([b.key, b.sessionId, b.zone || '', b.person || '', b.device || '', code, q, t]);
  });
  replaceRows_('scans', function (r) { return String(r[0]) !== String(b.key); }, rows, 6);
  return { saved: rows.length };
}

// 保留 keep() 為真的列，再接上 newRows，整張表一次寫回（比逐列刪除快很多）
function replaceRows_(key, keep, newRows, textCol) {
  var sh = sheet_(key), w = HEADERS[key].length, old = rows_(key);
  var kept = old.filter(keep);
  if (kept.length === old.length && !newRows.length) return;
  var all = kept.concat(newRows);
  if (old.length) sh.getRange(2, 1, old.length, w).clearContent();
  if (all.length) {
    if (textCol) sh.getRange(2, textCol, all.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, all.length, w).setValues(all);
  }
}

function sessionStatus_(id) {
  var st = '';
  rows_('sessions').forEach(function (r) { if (String(r[0]) === String(id)) st = r[10]; });
  return st;
}

function saveIssue_(x) {
  if (!x || !x.id) throw new Error('缺少異常編號');
  var sh = sheet_('issues'), data = rows_('issues'), idx = -1;
  for (var i = 0; i < data.length; i++) if (String(data[i][0]) === String(x.id)) { idx = i; break; }
  var old = idx >= 0 ? obj_('issues', data[idx]) : {};
  var row = [x.id, old['回報時間'] || x.reportedAt || nowIso_(), x.sessionId || old['單號'] || '', x.location || old['地點'] || '',
    x.vendor || old['廠商'] || '', x.code || old['產品編號'] || '', x.name || old['品名'] || '', x.kind || old['異常類型'] || '',
    x.qty != null ? x.qty : (old['數量'] || ''), x.note != null ? x.note : (old['說明'] || ''), x.person || old['回報人'] || '',
    x.status || old['處理狀態'] || '待處理', x.resolution != null ? x.resolution : (old['處理備註'] || ''), nowIso_()];
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); sh.getRange(sh.getLastRow(), 6).setNumberFormat('@').setValue(row[5]); }
  return {};
}

/* ============ 入帳（確認完成） ============ */

function finalize_(id, person) {
  var data = rows_('sessions'), idx = -1;
  for (var i = 0; i < data.length; i++) if (String(data[i][0]) === String(id)) { idx = i; break; }
  if (idx < 0) throw new Error('找不到這張單');
  var s = obj_('sessions', data[idx]);
  if (s['狀態'] === '已確認') return { already: true };

  var totals = {};
  rows_('scans').forEach(function (r) {
    if (String(r[1]) !== String(id)) return;
    var c = String(r[5]);
    if (c.charAt(0) === '?') return; // 未知條碼不入帳
    totals[c] = (totals[c] || 0) + Number(r[6] || 0);
  });

  var P = {};
  loadProducts_().forEach(function (p) { P[p.c] = p; });
  var t = nowIso_(), date = day_(s['作業日期']) || t.slice(0, 10), out = [];
  var add = function (type, loc, code, q) {
    var p = P[code] || {};
    out.push([id, date, type, loc, code, p.n || '', p.v || '', q, person || '', t]);
  };
  var type = s['類型'];
  if (type === '驗收') Object.keys(totals).forEach(function (c) { add('驗收', s['地點'], c, totals[c]); });
  else if (type === '退貨') Object.keys(totals).forEach(function (c) { add('退貨', s['地點'], c, -totals[c]); });
  else if (type === '調撥') {
    if (!s['目的地']) throw new Error('調撥單缺少目的地');
    Object.keys(totals).forEach(function (c) { add('調撥出', s['地點'], c, -totals[c]); add('調撥入', s['目的地'], c, totals[c]); });
  } else if (type === '盤點') {
    var book = stockFor_(s['地點']);
    var codes = {};
    Object.keys(book).forEach(function (c) { codes[c] = 1; });
    Object.keys(totals).forEach(function (c) { codes[c] = 1; });
    var cr = [];
    Object.keys(codes).forEach(function (c) {
      var b = Number(book[c] || 0), n = Number(totals[c] || 0), d = n - b;
      if (b || n) cr.push([id, date, s['地點'], c, (P[c] || {}).n || '', b, n, d, person || '', t]);
      if (d) add('盤差', s['地點'], c, d);
    });
    if (cr.length) {
      var csh = sheet_('counts'), cs = csh.getLastRow() + 1;
      csh.getRange(cs, 4, cr.length, 1).setNumberFormat('@');
      csh.getRange(cs, 1, cr.length, cr[0].length).setValues(cr);
    }
  }
  if (out.length) {
    var lsh = sheet_('ledger'), ls = lsh.getLastRow() + 1;
    lsh.getRange(ls, 5, out.length, 1).setNumberFormat('@');
    lsh.getRange(ls, 1, out.length, out[0].length).setValues(out);
  }
  var sh = sheet_('sessions');
  sh.getRange(idx + 2, 11, 1, 4).setValues([['已確認', person || '', t, t]]);
  return { written: out.length };
}

function reopen_(id) {
  var data = rows_('sessions'), idx = -1;
  for (var i = 0; i < data.length; i++) if (String(data[i][0]) === String(id)) { idx = i; break; }
  if (idx < 0) throw new Error('找不到這張單');
  replaceRows_('ledger', function (r) { return String(r[0]) !== String(id); }, [], 5);
  replaceRows_('counts', function (r) { return String(r[0]) !== String(id); }, [], 4);
  sheet_('sessions').getRange(idx + 2, 11, 1, 4).setValues([['進行中', '', '', nowIso_()]]);
  return {};
}

/* ============ 庫存 ============ */

// 帳面數 = 異動明細加總 − POS 銷售
function stockAll_() {
  var m = {};
  var put = function (loc, code, q) {
    if (!loc || !code) return;
    m[loc] = m[loc] || {};
    m[loc][code] = (m[loc][code] || 0) + q;
  };
  rows_('ledger').forEach(function (r) { put(String(r[3]), String(r[4]), Number(r[7] || 0)); });
  var sales = rows_('sales');
  if (sales.length) {
    var byBar = {}, byCode = {};
    loadProducts_().forEach(function (p) { byCode[p.c] = p.c; if (p.bc) byBar[p.bc] = p.c; });
    sales.forEach(function (r) {
      var k = String(r[2]).trim();
      var code = byCode[k] || byBar[k] || byBar[k.replace(/^0+/, '')] || k;
      put(String(r[1]).trim(), code, -Number(r[3] || 0));
    });
  }
  return m;
}

function stockFor_(loc) {
  var all = stockAll_()[loc] || {}, out = {};
  Object.keys(all).forEach(function (c) { if (all[c]) out[c] = all[c]; });
  return out;
}

function refreshStockSheet() {
  var all = stockAll_(), P = {};
  loadProducts_().forEach(function (p) { P[p.c] = p; });
  var rows = [];
  Object.keys(all).sort().forEach(function (loc) {
    Object.keys(all[loc]).sort().forEach(function (c) {
      var q = all[loc][c];
      if (q) rows.push([loc, c, (P[c] || {}).n || '', (P[c] || {}).v || '', q]);
    });
  });
  var sh = sheet_('stock');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.stock.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 2, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  sh.getRange(1, 7).setValue('更新時間：' + nowIso_());
}
