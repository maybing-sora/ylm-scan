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
  stock: '庫存彙總',
  receipts: '驗收對帳',
  docs: '單據'
};

var HEADERS = {
  sessions: ['單號', '類型', '作業日期', '進貨單日期', '地點', '目的地', '廠商', '備註', '建立人', '建立時間', '狀態', '確認人', '確認時間', '更新時間'],
  scans: ['紀錄鍵', '單號', '區域', '人員', '裝置', '產品編號', '數量', '更新時間'],
  ledger: ['單號', '作業日期', '類型', '地點', '產品編號', '品名', '廠商', '數量', '人員', '寫入時間'],
  counts: ['單號', '盤點日期', '地點', '產品編號', '品名', '帳面數', '實盤數', '差異', '確認人', '確認時間', '上次盤點', '進貨', '調入', '調出', '退貨', 'POS銷售'],
  receipts: ['單號', '驗收日期', '進貨單日期', '廠商', '產品編號', '品名', '產品別', '進貨單數量', '實收數量', '差異', '進貨單價', '應付金額', '異常', '照片', '驗收人', '確認入帳人', '確認時間'],
  docs: ['單號', '類型', '檔名', '網址', '檔案ID', '建立時間'],
  issues: ['編號', '回報時間', '單號', '地點', '廠商', '產品編號', '品名', '異常類型', '數量', '說明', '回報人', '處理狀態', '處理備註', '更新時間', '照片'],
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
        case 'savePhoto': return savePhoto_(body);
        case 'finalize': return finalize_(body.id, body.person);
        case 'reopen': return reopen_(body.id);
        case 'deleteSession': return deleteSession_(body.id);
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
    // 找標題列：同一列裡要有一格以「產品編號」開頭、一格以「產品條碼」開頭
    // （不能用整列文字比對，料號表第一列的說明文字也提到這兩個詞）
    var starts = function (row, name) { return row.some(function (x) { return String(x).trim().indexOf(name) === 0; }); };
    var hi = -1;
    for (var i = 0; i < Math.min(vals.length, 15); i++) {
      if (starts(vals[i], '產品編號') && starts(vals[i], '產品條碼')) { hi = i; break; }
    }
    if (hi < 0) return;
    var H = vals[hi];
    var col = function (name) { for (var j = 0; j < H.length; j++) if (String(H[j]).trim().indexOf(name) === 0) return j; return -1; };
    var c = { code: col('產品編號'), brand: col('品牌名稱'), loc: col('商品銷售點'), type: col('產品別'), cat: col('產品類別'),
      name: col('規格說明'), unit: col('單位'), price: col('商品定價'), cost: col('進貨金額'), vendor: col('供應商'), bar: col('產品條碼'), qty: col('數量') };
    for (var r = 0; r < vals.length; r++) {
      if (r === hi) continue;
      var code = String(vals[r][c.code] || '').trim();
      if (!/^\d{8,20}$/.test(code) || seen[code]) continue;
      seen[code] = true;
      var g = function (k) { return c[k] >= 0 ? String(vals[r][c[k]] || '').trim() : ''; };
      out.push({
        c: code, b: g('brand'), loc: g('loc'), t: g('type'), cat: g('cat'), n: g('name'), u: g('unit'),
        p: Number(g('price').replace(/[$,]/g, '')) || null, v: g('vendor'), bc: g('bar'),
        q: Number(g('qty').replace(/,/g, '')) || 0,
        pc: Number(g('cost').replace(/[$,]/g, '')) || 0  // 進貨單價：只在試算表與驗收單使用，不送到手機
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
  var products = loadProducts_().map(function (p) { var o = {}; for (var k in p) if (k !== 'pc') o[k] = p[k]; return o; });
  return { products: products, locations: getLocations_(), sessions: sessions, received: receivedTotals_() };
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
  if (s['類型'] === '盤點') {
    var bd = breakdown_(s['地點'], id);
    out.breakdown = bd.items; out.lastCount = bd.lastCount;
    out.book = {};
    Object.keys(bd.items).forEach(function (c) { if (bd.items[c].exp) out.book[c] = bd.items[c].exp; });
  }
  var d = docFor_(id); if (d) out.doc = d;
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
  ensureIssuePhotoHeader_();
  if (!x || !x.id) throw new Error('缺少異常編號');
  var sh = sheet_('issues'), data = rows_('issues'), idx = -1;
  for (var i = 0; i < data.length; i++) if (String(data[i][0]) === String(x.id)) { idx = i; break; }
  var old = idx >= 0 ? obj_('issues', data[idx]) : {};
  var row = [x.id, old['回報時間'] || x.reportedAt || nowIso_(), x.sessionId || old['單號'] || '', x.location || old['地點'] || '',
    x.vendor || old['廠商'] || '', x.code || old['產品編號'] || '', x.name || old['品名'] || '', x.kind || old['異常類型'] || '',
    x.qty != null ? x.qty : (old['數量'] || ''), x.note != null ? x.note : (old['說明'] || ''), x.person || old['回報人'] || '',
    x.status || old['處理狀態'] || '待處理', x.resolution != null ? x.resolution : (old['處理備註'] || ''), nowIso_(), x.photos != null ? x.photos : (old['照片'] || '')];
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); sh.getRange(sh.getLastRow(), 6).setNumberFormat('@').setValue(row[5]); }
  return {};
}

/* ============ 異常照片 ============ */

// 舊版建立的「異常回報」分頁沒有「照片」欄，補上標題
function ensureIssuePhotoHeader_() {
  var sh = sheet_('issues'), col = HEADERS.issues.length;
  if (sh.getRange(1, col).getValue() !== '照片') sh.getRange(1, col).setValue('照片').setFontWeight('bold');
}

function photoFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var parent;
  try { parent = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next(); } catch (e) { parent = DriveApp.getRootFolder(); }
  var f = parent.createFolder('點收盤點_異常照片');
  props.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}

// 照片：手機先壓縮成 JPEG，以 base64 傳上來；同一個照片編號只存一次（重送不會重複）
function savePhoto_(b) {
  if (!b.photoId || !b.data) throw new Error('缺少照片');
  var folder = photoFolder_(), name = b.photoId + '.jpg';
  var it = folder.getFilesByName(name), file;
  if (it.hasNext()) file = it.next();
  else {
    var bytes = Utilities.base64Decode(String(b.data).replace(/^data:image\/\w+;base64,/, ''));
    file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
    if (b.desc) file.setDescription(String(b.desc).slice(0, 500));
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  }
  return { fileId: file.getId(), url: 'https://drive.google.com/file/d/' + file.getId() + '/view' };
}

// 新功能上線後，在編輯器執行一次：授權 Drive 與 Google 文件，建立照片與驗收單資料夾
function authorizePhotos() {
  ensureIssuePhotoHeader_();
  ensureHeader_('counts'); sheet_('receipts'); sheet_('docs');
  var f = photoFolder_(), d = docsFolder_();
  var tmp = DocumentApp.create('授權測試（可刪除）'); DriveApp.getFileById(tmp.getId()).setTrashed(true);
  var msg = '照片資料夾：' + f.getUrl() + '；驗收單資料夾：' + d.getUrl();
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
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
    var bd = breakdown_(s['地點'], id).items;
    var codes = {};
    Object.keys(bd).forEach(function (c) { codes[c] = 1; });
    Object.keys(totals).forEach(function (c) { codes[c] = 1; });
    var cr = [];
    Object.keys(codes).forEach(function (c) {
      var x = bd[c] || { open: 0, recv: 0, tin: 0, tout: 0, ret: 0, sales: 0, exp: 0 };
      var b = Number(x.exp || 0), n = Number(totals[c] || 0), d = n - b;
      if (b || n || x.open || x.recv || x.tin || x.tout || x.ret || x.sales)
        cr.push([id, date, s['地點'], c, (P[c] || {}).n || '', b, n, d, person || '', t, x.open, x.recv, x.tin, x.tout, x.ret, x.sales]);
      if (d) add('盤差', s['地點'], c, d);
    });
    if (cr.length) {
      ensureHeader_('counts');
      var csh = sheet_('counts'), cs = csh.getLastRow() + 1;
      csh.getRange(cs, 4, cr.length, 1).setNumberFormat('@');
      csh.getRange(cs, 1, cr.length, cr[0].length).setValues(cr);
    }
  }
  var receipt = null;
  if (type === '驗收') receipt = receiptRows_(id, s, totals, P, person, t);
  if (out.length) {
    var lsh = sheet_('ledger'), ls = lsh.getLastRow() + 1;
    lsh.getRange(ls, 5, out.length, 1).setNumberFormat('@');
    lsh.getRange(ls, 1, out.length, out[0].length).setValues(out);
  }
  var sh = sheet_('sessions');
  sh.getRange(idx + 2, 11, 1, 4).setValues([['已確認', person || '', t, t]]);
  var res = { written: out.length };
  if (receipt) {
    var rsh = sheet_('receipts'), rs = rsh.getLastRow() + 1;
    if (receipt.rows.length) {
      rsh.getRange(rs, 5, receipt.rows.length, 1).setNumberFormat('@');
      rsh.getRange(rs, 1, receipt.rows.length, receipt.rows[0].length).setValues(receipt.rows);
    }
    try { res.doc = makeReceiptPdf_(id, s, receipt, person, t); }
    catch (e) { res.docError = '驗收單 PDF 沒有產生：' + (e && e.message || e); }
  }
  return res;
}

function reopen_(id) {
  var data = rows_('sessions'), idx = -1;
  for (var i = 0; i < data.length; i++) if (String(data[i][0]) === String(id)) { idx = i; break; }
  if (idx < 0) throw new Error('找不到這張單');
  replaceRows_('ledger', function (r) { return String(r[0]) !== String(id); }, [], 5);
  replaceRows_('counts', function (r) { return String(r[0]) !== String(id); }, [], 4);
  replaceRows_('receipts', function (r) { return String(r[0]) !== String(id); }, [], 5);
  rows_('docs').forEach(function (r) {
    if (String(r[0]) === String(id)) { try { DriveApp.getFileById(String(r[4])).setTrashed(true); } catch (e) {} }
  });
  replaceRows_('docs', function (r) { return String(r[0]) !== String(id); }, [], 0);
  sheet_('sessions').getRange(idx + 2, 11, 1, 4).setValues([['進行中', '', '', nowIso_()]]);
  return {};
}

// 刪除整張單（含掃描紀錄、異常回報）。已確認入帳的單要先重新開啟才能刪。
function deleteSession_(id) {
  var st = sessionStatus_(id);
  if (st === '已確認') throw new Error('這張單已確認入帳，請先重新開啟再刪除');
  replaceRows_('sessions', function (r) { return String(r[0]) !== String(id); }, [], 0);
  replaceRows_('scans', function (r) { return String(r[1]) !== String(id); }, [], 6);
  replaceRows_('issues', function (r) { return String(r[2]) !== String(id); }, [], 6);
  return { deleted: id };
}

/* ============ 驗收對帳單 ============ */

function ensureHeader_(key) {
  var sh = sheet_(key), H = HEADERS[key];
  var cur = sh.getRange(1, 1, 1, H.length).getValues()[0];
  for (var i = 0; i < H.length; i++) if (cur[i] !== H[i]) sh.getRange(1, i + 1).setValue(H[i]).setFontWeight('bold');
}

// 這張單目前有效的異常（同品項同類型只留最新、略過已撤回），依品項整理
function sessionIssues_(id) {
  var latest = {};
  listIssues_().forEach(function (x) {
    if (String(x['單號']) !== String(id) || x['處理狀態'] === '已撤回') return;
    var k = x['產品編號'] + '|' + x['異常類型'];
    if (!latest[k] || String(x['回報時間']) > String(latest[k]['回報時間'])) latest[k] = x;
  });
  var by = {};
  Object.keys(latest).forEach(function (k) {
    var x = latest[k], c = String(x['產品編號']);
    by[c] = by[c] || { text: [], photos: [], notes: [] };
    var kind = x['異常類型'], q = x['數量'];
    by[c].text.push(kind === '數量短少' ? '少 ' + q + ' 件' : kind === '數量超收' ? '多 ' + q + ' 件' : kind + ' ' + q + ' 件');
    if (x['說明'] && by[c].notes.indexOf(x['說明']) < 0) by[c].notes.push(x['說明']);
    String(x['照片'] || '').split(/\s+/).forEach(function (u) { if (u && by[c].photos.indexOf(u) < 0) by[c].photos.push(u); });
  });
  return by;
}

function receiptRows_(id, s, totals, P, person, t) {
  var before = receivedTotals_(), issues = sessionIssues_(id), vendor = s['廠商'];
  var who = {};
  rows_('scans').forEach(function (r) { if (String(r[1]) === String(id) && r[3]) who[r[3]] = 1; });
  var receivers = Object.keys(who).join('、') || s['建立人'] || person || '';
  var codes = [];
  Object.keys(P).forEach(function (c) {
    var p = P[c];
    if (p.v !== vendor) return;
    var ordered = Math.max(0, (p.q || 0) - (before[c] || 0));
    if (ordered || totals[c]) codes.push(c);
  });
  Object.keys(totals).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
  var rows = [], sum = { ordQty: 0, recQty: 0, ordAmt: 0, recAmt: 0, consignQty: 0, diffItems: 0 };
  codes.forEach(function (c) {
    var p = P[c] || { n: '（主檔無此品項）', t: '', q: 0, pc: 0 };
    var ordered = p.v === vendor ? Math.max(0, (p.q || 0) - (before[c] || 0)) : 0;
    var got = totals[c] || 0, diff = got - ordered, buyout = String(p.t).indexOf('買斷') >= 0;
    var iss = issues[c] || { text: [], photos: [], notes: [] };
    var issueText = iss.text.join('、') + (iss.notes.length ? '（' + iss.notes.join('；') + '）' : '');
    sum.ordQty += ordered; sum.recQty += got; if (diff) sum.diffItems++;
    if (buyout) { sum.ordAmt += ordered * p.pc; sum.recAmt += got * p.pc; } else sum.consignQty += got;
    rows.push([id, day_(s['作業日期']), day_(s['進貨單日期']), vendor, c, p.n, p.t || '', ordered, got, diff,
      p.pc || '', buyout ? got * p.pc : '寄售，月結', issueText, iss.photos.join(' '), receivers, person || '', t]);
  });
  return { rows: rows, sum: sum, receivers: receivers };
}

function docsFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('DOC_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var parent;
  try { parent = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next(); } catch (e) { parent = DriveApp.getRootFolder(); }
  var f = parent.createFolder('點收盤點_驗收單');
  props.setProperty('DOC_FOLDER_ID', f.getId());
  return f;
}

function docFor_(id) {
  var d = null;
  rows_('docs').forEach(function (r) { if (String(r[0]) === String(id)) d = { name: r[2], url: r[3] }; });
  return d;
}

var money_ = function (n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); };

// 用 Google 文件排版，再轉成 PDF 存到「點收盤點_驗收單」資料夾
function makeReceiptPdf_(id, s, receipt, person, t) {
  var vendor = s['廠商'], sum = receipt.sum, recDate = day_(s['作業日期']);
  var name = '驗收單_' + recDate.replace(/-/g, '') + '_' + vendor + '_' + id;
  var doc = DocumentApp.create(name), body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(36).setMarginRight(36);
  body.appendParagraph('六福棲蘭明池 商品驗收單').setHeading(DocumentApp.ParagraphHeading.HEADING1).setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  var info = body.appendTable([
    ['驗收單號', id, '廠商', vendor],
    ['驗收日期', recDate, '進貨單日期', day_(s['進貨單日期']) || '—'],
    ['驗收人', receipt.receivers, '驗收地點', s['地點'] || ''],
    ['確認入帳人', person || '', '確認入帳時間', String(t).replace('T', ' ').slice(0, 16)]
  ]);
  styleTable_(info, 10, false);
  var allMatch = sum.diffItems === 0;
  body.appendParagraph('驗收結論：' + (allMatch ? '實收數量與進貨單相符。' : '實收數量與進貨單不符，共 ' + sum.diffItems + ' 個品項有差異，請見下表。'))
    .setBold(true).setSpacingBefore(10);
  var head = ['產品編號', '品名', '產品別', '進貨單數量', '實收數量', '差異', '進貨單價', '應付金額', '異常'];
  var cells = [head].concat(receipt.rows.map(function (r) {
    return [r[4], r[5], r[6], String(r[7]), String(r[8]), r[9] > 0 ? '+' + r[9] : String(r[9]),
      r[10] === '' ? '' : money_(r[10]), typeof r[11] === 'number' ? money_(r[11]) : r[11], r[12] || ''];
  }));
  var items = body.appendTable(cells);
  styleTable_(items, 8, true);
  var tot = [['', '進貨單', '實收'], ['總數量（件）', String(sum.ordQty), String(sum.recQty)]];
  if (sum.ordAmt || sum.recAmt) tot.push(['買斷品金額（含稅）', money_(sum.ordAmt), money_(sum.recAmt)]);
  body.appendParagraph('').setSpacingBefore(4);
  styleTable_(body.appendTable(tot), 10, true);
  if (sum.recAmt) body.appendParagraph('買斷品應付金額（依實收數量）：' + money_(sum.recAmt)).setBold(true).setSpacingBefore(8);
  if (sum.consignQty) body.appendParagraph('寄售品 ' + sum.consignQty + ' 件：驗收時不付款，依每月銷售與廠商結算。').setSpacingBefore(4);
  var photos = receipt.rows.filter(function (r) { return r[13]; });
  if (photos.length) {
    body.appendParagraph('異常照片').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    photos.forEach(function (r) {
      var para = body.appendParagraph(r[5] + '：');
      String(r[13]).split(' ').forEach(function (u, k) {
        var tx = para.appendText(' 照片' + (k + 1)); tx.setLinkUrl(u);
      });
    });
  }
  body.appendParagraph('').setSpacingBefore(16);
  styleTable_(body.appendTable([['驗收人簽名', '商品開發簽名', '財務簽名'], ['\n\n', '\n\n', '\n\n']]), 10, true);
  body.appendParagraph('本單由點收盤點工具於確認入帳時產生。').setFontSize(8).setForegroundColor('#666666');
  doc.saveAndClose();
  var docFile = DriveApp.getFileById(doc.getId());
  var pdf = docsFolder_().createFile(docFile.getAs('application/pdf').setName(name + '.pdf'));
  docFile.setTrashed(true);
  var url = 'https://drive.google.com/file/d/' + pdf.getId() + '/view';
  sheet_('docs').appendRow([id, '驗收單', name + '.pdf', url, pdf.getId(), nowIso_()]);
  return { name: name + '.pdf', url: url };
}

function styleTable_(tb, size, header) {
  tb.setBorderColor('#999999');
  for (var r = 0; r < tb.getNumRows(); r++) {
    var row = tb.getRow(r);
    for (var c = 0; c < row.getNumCells(); c++) {
      var cell = row.getCell(c);
      cell.setPaddingTop(3).setPaddingBottom(3).setPaddingLeft(4).setPaddingRight(4);
      cell.editAsText().setFontSize(size);
      if (header && r === 0) { cell.setBackgroundColor('#e8ebe5'); cell.editAsText().setBold(true); }
    }
  }
}

// 盤點拆解：上次盤點之後，這個地點每個品項的進出
// 應有 = 上次盤點 + 進貨 + 調入 − 調出 − 退貨 − POS 銷售
function breakdown_(loc, excludeId) {
  var last = null;
  rows_('counts').forEach(function (r) {
    if (String(r[2]) !== String(loc) || String(r[0]) === String(excludeId)) return;
    var ct = r[9] instanceof Date ? iso_(r[9]) : String(r[9]);
    if (!last || ct > last.time) last = { id: String(r[0]), time: ct, date: day_(r[1]) };
  });
  var m = {};
  var get = function (c) { return m[c] = m[c] || { open: 0, recv: 0, tin: 0, tout: 0, ret: 0, sales: 0, exp: 0 }; };
  rows_('ledger').forEach(function (r) {
    if (String(r[3]) !== String(loc) || String(r[0]) === String(excludeId)) return;
    var c = String(r[4]), q = Number(r[7] || 0), wt = r[9] instanceof Date ? iso_(r[9]) : String(r[9]), x = get(c);
    if (last && wt <= last.time) { x.open += q; return; }
    var ty = r[2];
    if (ty === '驗收') x.recv += q; else if (ty === '調撥入') x.tin += q; else if (ty === '調撥出') x.tout += -q;
    else if (ty === '退貨') x.ret += -q; else x.open += q; // 盤差等其他調整
  });
  var sales = rows_('sales');
  if (sales.length) {
    var byBar = {}, byCode = {};
    loadProducts_().forEach(function (p) { byCode[p.c] = p.c; if (p.bc) byBar[p.bc] = p.c; });
    sales.forEach(function (r) {
      if (String(r[1]).trim() !== String(loc)) return;
      var k = String(r[2]).trim(), c = byCode[k] || byBar[k] || byBar[k.replace(/^0+/, '')] || k, q = Number(r[3] || 0), x = get(c);
      if (last && day_(r[0]) <= last.date) x.open -= q; else x.sales += q;
    });
  }
  Object.keys(m).forEach(function (c) { var x = m[c]; x.exp = x.open + x.recv + x.tin - x.tout - x.ret - x.sales; });
  return { items: m, lastCount: last };
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
