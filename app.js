(function () {
"use strict";

/* ================= 基本工具 ================= */
const API = (window.YLM_CONFIG && window.YLM_CONFIG.api) || "";
const LS = {
  get(k, d) { try { const v = localStorage.getItem("ylm2." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("ylm2." + k, JSON.stringify(v)); } catch (e) {} }
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowIso = () => { const d = new Date(); return `${today()}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmt = s => String(s || "").replace("T", " ").slice(0, 16);
const day = s => String(s || "").slice(0, 10);
const TYPES = {
  receive: { label: "驗收", chip: "info", desc: "廠商到貨點收，對照訂購數" },
  transfer: { label: "調撥", chip: "warn", desc: "從一個地點送到另一個地點" },
  return: { label: "退貨", chip: "bad", desc: "退回廠商，從庫存扣除" },
  count: { label: "盤點", chip: "ok", desc: "盲盤，完成後和帳面比對" }
};
const TYPE_BY_LABEL = { "驗收": "receive", "調撥": "transfer", "退貨": "return", "盤點": "count" };
const ZONES = ["整區", "A 牆", "B 牆", "中島", "櫃檯", "後場收納", "倉庫層架"];
const ISSUE_KINDS = ["數量短少", "數量超收", "外箱或商品破損", "送錯款式或顏色", "缺條碼或吊牌（已補標）", "缺中文標示", "其他"];
const OTHER_KINDS = ISSUE_KINDS.slice(2); // 數量以外的問題
const ISSUE_STATUS = ["待處理", "已通知廠商", "已解決"];
const WITHDRAWN = "已撤回"; // 同一品項重新填寫後，舊的回報自動撤回

let device = LS.get("device", null);
if (!device) { device = "d" + Math.random().toString(36).slice(2, 8); LS.set("device", device); }
let person = LS.get("person", "");
let pin = LS.get("pin", "");

/* 商品主檔與基本資料（從試算表載入，離線時用上次的副本） */
let P = [], byCode = new Map(), byBar = new Map(), VENDORS = [], LOCS = [], RECEIVED = {};
function setMaster(products) {
  P = products || []; byCode = new Map(); byBar = new Map();
  P.forEach(p => { byCode.set(p.c, p); if (p.bc) byBar.set(String(p.bc), p); });
  VENDORS = [...new Set(P.map(p => p.v).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}
function lookup(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, "");
  if (!s) return null;
  if (byCode.has(s)) return byCode.get(s);
  if (byBar.has(s)) return byBar.get(s);
  const nz = s.replace(/^0+/, "");
  for (const [k, p] of byBar) if (k.replace(/^0+/, "") === nz) return p;
  if (s.length === 13 && byBar.has(s.slice(1))) return byBar.get(s.slice(1));
  return null;
}

/* ================= 本機狀態 ================= */
let sessions = LS.get("sessions", {});   // id -> session（含伺服器與本機新建）
let sheets = LS.get("sheets", {});       // key -> {sessionId, zone, person, device, counts, updatedAt}
let remote = LS.get("remote", {});       // id -> {sheets, issues, book}
let queue = LS.get("queue", []);         // 待上傳：[{op, key, body}]
const saveLocal = () => { LS.set("sessions", sessions); LS.set("sheets", sheets); LS.set("queue", queue); };
const sheetKey = (sid, zone) => `${sid}|${device}|${zone}`;
const hash = s => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0; return h.toString(36); };

/* ================= 連線 ================= */
let online = navigator.onLine, flushing = false, flushTimer = null, lastError = "";
async function apiGet(params) {
  const u = new URL(API);
  Object.entries(Object.assign({ pin }, params)).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString(), { method: "GET", redirect: "follow" });
  const j = await r.json();
  if (!j.ok) { const e = new Error(j.error || "讀取失敗"); e.code = j.code; throw e; }
  return j;
}
async function apiPost(body) {
  const r = await fetch(API, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(Object.assign({ pin, by: person, device }, body)) });
  const j = await r.json();
  if (!j.ok) { const e = new Error(j.error || "上傳失敗"); e.code = j.code; throw e; }
  return j;
}
function enqueue(op, key, body) {
  if (!body.by) body.by = person; // 記下當時的操作人，晚點上傳也不會變
  queue = queue.filter(q => !(q.op === op && q.key === key)); // 同一筆只留最新
  queue.push({ op, key, body });
  saveLocal(); scheduleFlush();
}
/* ---- 異常照片：先存手機（IndexedDB），上傳時一併送到試算表的 Drive 資料夾 ---- */
const PHOTO_REQUIRED = ["外箱或商品破損", "送錯款式或顏色", "缺中文標示"];
const MAX_PHOTOS = 3;
let photoUrls = LS.get("photoUrls", {}); // photoId -> Drive 網址
let idbP = null;
function idb() {
  if (!idbP) idbP = new Promise((res, rej) => {
    try {
      const r = indexedDB.open("ylm2", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("photos");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  return idbP;
}
async function idbOp(mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => { const t = d.transaction("photos", mode), st = t.objectStore("photos"), r = fn(st); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); });
}
const photoPut = (id, dataUrl) => idbOp("readwrite", st => st.put(dataUrl, id));
const photoGet = id => idbOp("readonly", st => st.get(id));
const photoDel = id => idbOp("readwrite", st => st.delete(id)).catch(() => {});
// 手機照片壓縮成長邊 1280px 的 JPEG（約 150–300KB）
async function compressPhoto(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { bmp = await createImageBitmap(file); }
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.72);
}
async function uploadPhotos(issue) {
  const urls = [];
  for (const id of issue.photoIds || []) {
    if (!photoUrls[id]) {
      const data = await photoGet(id);
      if (!data) continue; // 找不到就略過（例如手機資料被清掉）
      const j = await apiPost({ a: "savePhoto", photoId: id, data, desc: `${issue.vendor || ""} ${issue.name || ""} ${issue.kind || ""}` });
      photoUrls[id] = j.url; LS.set("photoUrls", photoUrls);
    }
    urls.push(photoUrls[id]);
  }
  return urls;
}
function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms ?? 1500); setSync(); }
async function flush() {
  if (flushing || !queue.length || !API) { setSync(); return; }
  flushing = true; setSync();
  try {
    while (queue.length) {
      const q = queue[0];
      if (q.op === "saveIssue" && q.body.issue && q.body.issue.photoIds && q.body.issue.photoIds.length) {
        const urls = await uploadPhotos(q.body.issue);
        q.body.issue.photos = [...new Set(String(q.body.issue.photos || "").split(/\s+/).filter(Boolean).concat(urls))].join(" ");
      }
      await apiPost(Object.assign({ a: q.op }, q.body));
      if (q.op === "saveIssue" && q.body.issue && q.body.issue.photos) {
        // 本機的異常紀錄也記上照片網址，之後重新填寫時才能沿用
        const iss = q.body.issue, rr = remote[iss.sessionId];
        const row = rr && (rr.issues || []).find(i => i["編號"] === iss.id);
        if (row) { row["照片"] = iss.photos; LS.set("remote", remote); }
      }
      if (q.op === "saveIssue" && q.body.issue && q.body.issue.photoIds) {
        const still = new Set(queue.slice(1).flatMap(x => (x.body.issue && x.body.issue.photoIds) || []));
        q.body.issue.photoIds.forEach(id => { if (!still.has(id)) photoDel(id); });
      }
      if (q.op === "saveSession" && sessions[q.key]) delete sessions[q.key]._local;
      queue.shift(); saveLocal();
    }
    lastError = ""; online = true;
  } catch (e) {
    if (e.code === "pin") { lastError = "密碼錯誤"; pin = ""; LS.set("pin", ""); render(); }
    else if (e instanceof TypeError) { online = false; scheduleFlush(15000); }
    else {
      // 伺服器拒絕（例如單已入帳）：丟掉這筆，避免卡住後面的資料
      lastError = e.message; toast("有一筆資料沒有上傳：" + e.message);
      queue.shift(); saveLocal();
      scheduleFlush(500);
    }
  } finally { flushing = false; setSync(); }
}
function setSync() {
  const el = document.getElementById("sync"), tx = document.getElementById("syncText");
  const n = queue.length;
  if (!API) { el.className = "chip bad"; tx.textContent = "尚未設定"; return; }
  if (!online || !navigator.onLine) { el.className = "chip warn"; tx.textContent = n ? `離線 · ${n} 筆待上傳` : "離線"; return; }
  if (n) { el.className = "chip info"; tx.textContent = flushing ? "上傳中…" : `${n} 筆待上傳`; return; }
  el.className = "chip ok"; tx.textContent = "已同步";
}
window.addEventListener("online", () => { online = true; scheduleFlush(300); });
window.addEventListener("offline", () => { online = false; setSync(); });

async function boot() {
  const cache = LS.get("master", null);
  if (cache) { setMaster(cache.products); LOCS = cache.locations || []; RECEIVED = cache.received || {}; }
  render();
  if (!API || !pin) return;
  try {
    const j = await apiGet({ a: "boot" });
    setMaster(j.products); LOCS = j.locations || []; RECEIVED = j.received || {};
    LS.set("master", { products: j.products, locations: LOCS, received: RECEIVED, at: nowIso() });
    const onServer = new Set((j.sessions || []).map(s => s["單號"]));
    const pendingIds = new Set(queue.map(q => q.body.sessionId || (q.body.session && q.body.session.id)));
    for (const id of Object.keys(sessions)) if (!onServer.has(id) && !sessions[id]._local && !pendingIds.has(id)) dropLocal(id);
    (j.sessions || []).forEach(s => { const loc = sessions[s["單號"]]; if (!loc || !loc._local) sessions[s["單號"]] = fromRow(s); });
    saveLocal(); online = true;
  } catch (e) {
    if (e.code === "pin") { pin = ""; LS.set("pin", ""); toast("密碼錯誤，請重新輸入"); }
    else online = false;
  }
  render(); flush();
}
function dropLocal(id) {
  delete sessions[id]; delete remote[id];
  for (const k of Object.keys(sheets)) if (sheets[k].sessionId === id) delete sheets[k];
  queue = queue.filter(q => (q.body.sessionId || (q.body.session && q.body.session.id)) !== id);
  LS.set("remote", remote); saveLocal();
}
function fromRow(s) {
  return { id: s["單號"], type: TYPE_BY_LABEL[s["類型"]] || "count", date: day(s["作業日期"]), poDate: day(s["進貨單日期"]), location: s["地點"], to: s["目的地"],
    vendor: s["廠商"], memo: s["備註"], createdBy: s["建立人"], createdAt: s["建立時間"], status: s["狀態"] || "進行中", confirmedBy: s["確認人"], confirmedAt: s["確認時間"] };
}
async function loadRemote(id) {
  if (!API || !pin) return;
  try {
    const j = await apiGet({ a: "session", id });
    remote[id] = { sheets: j.sheets || {}, issues: j.issues || [], book: j.book || null, breakdown: j.breakdown || null, lastCount: j.lastCount || null, doc: j.doc || null, at: nowIso() };
    if (j.session) { const s = fromRow(j.session); if (!sessions[id] || !sessions[id]._local) sessions[id] = s; else sessions[id].status = s.status; }
    LS.set("remote", remote); saveLocal(); online = true;
  } catch (e) { if (e instanceof TypeError) online = false; }
  setSync();
}

/* ================= 匯總 ================= */
function sheetsFor(id) {
  const m = Object.assign({}, (remote[id] && remote[id].sheets) || {});
  for (const [k, sh] of Object.entries(sheets)) if (sh.sessionId === id) m[k] = sh;
  return m;
}
function totals(id) {
  const t = new Map();
  for (const sh of Object.values(sheetsFor(id))) {
    for (const [code, q] of Object.entries(sh.counts || {})) {
      if (!q) continue;
      const r = t.get(code) || { qty: 0, zones: {}, people: new Set() };
      r.qty += q; r.zones[sh.zone] = (r.zones[sh.zone] || 0) + q; r.people.add(sh.person || "未具名");
      t.set(code, r);
    }
  }
  return t;
}

/* ================= 畫面 ================= */
let view = { name: "home" };
let expectFilter = "", lastHit = null, issueOpen = false, resultFilter = "all", confirmAsk = false, deleteAsk = false, issueFilter = "open";
const app = document.getElementById("app");
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2800); }
function go(v) {
  stopCamera();
  view = v; expectFilter = ""; lastHit = null; issueOpen = false; confirmAsk = false; deleteAsk = false; resultFilter = "all";
  render(); window.scrollTo(0, 0);
  if (v.name === "session") loadRemote(v.id).then(() => { if (view.name === "session" && view.id === v.id) render(true); });
  if (v.name === "issues") loadIssues();
}
function render(soft) {
  const hdr = document.getElementById("hdr");
  if (!API) { hdr.textContent = "棲蘭明池 點收盤點"; app.innerHTML = `<section class="panel"><h2>還沒連上試算表</h2><p class="muted" style="margin:0">管理者需要在 config.js 填入 Apps Script 網址。</p></section>`; setSync(); return; }
  if (!pin) { hdr.textContent = "棲蘭明池 點收盤點"; app.innerHTML = pinHTML(); bindPin(); setSync(); return; }
  if (view.name === "home") { hdr.textContent = "棲蘭明池 點收盤點"; app.innerHTML = homeHTML(); bindHome(); }
  else if (view.name === "new") { hdr.textContent = "新增" + TYPES[view.type].label; app.innerHTML = newHTML(); bindNew(); }
  else if (view.name === "issues") { hdr.textContent = "異常清單"; app.innerHTML = issuesHTML(); bindIssues(); }
  else if (view.name === "session") {
    const s = sessions[view.id]; if (!s) { view = { name: "home" }; render(); return; }
    hdr.textContent = `${TYPES[s.type].label} · ${s.location}${s.type === "transfer" ? " → " + (s.to || "") : ""}`;
    if (soft && view.tab === "scan") { refreshScanParts(); setSync(); return; }
    if (soft && view.tab === "res") { const r = document.getElementById("resultBox"); if (r) { r.innerHTML = resultInner(s); bindResult(s); setSync(); return; } }
    app.innerHTML = sessionHTML(s); bindSession(s);
  }
  setSync();
}

/* ---- 密碼 ---- */
function pinHTML() {
  return `<section class="panel">
    <h2>輸入存取密碼</h2>
    <p class="small muted" style="margin:0">密碼請向 Echo 索取，同一支手機只需要輸入一次。</p>
    <form id="pinForm" class="row" autocomplete="off">
      <input id="pinIn" inputmode="numeric" class="mono grow" placeholder="六位數密碼" style="flex:1;min-width:0">
      <button class="primary" type="submit">進入</button>
    </form></section>`;
}
function bindPin() {
  document.getElementById("pinForm").onsubmit = async e => {
    e.preventDefault();
    pin = document.getElementById("pinIn").value.trim();
    try { await apiGet({ a: "ping" }); LS.set("pin", pin); boot(); }
    catch (err) { pin = ""; toast(err.code === "pin" ? "密碼不對，請再確認" : "連不上試算表，請確認網路"); }
  };
}

/* ---- 首頁 ---- */
function homeHTML() {
  const list = Object.values(sessions).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 60);
  return `
  <section class="panel">
    <label>操作人<input id="person" value="${esc(person)}" placeholder="輸入你的名字" autocomplete="name"></label>
    <div class="modes">${Object.entries(TYPES).map(([k, t]) => `<button class="mode" data-new="${k}"><b>＋ ${t.label}</b><span class="small muted">${t.desc}</span></button>`).join("")}</div>
    <div class="row"><button class="grow" id="toIssues">異常清單</button><button id="reload">重新整理</button></div>
    <p class="small muted" style="margin:0">商品主檔 ${P.length} 項，直接讀取進貨料號表。${P.filter(p => !p.bc).length} 項沒有廠商條碼，請掃六福標籤。</p>
  </section>
  <section style="display:flex;flex-direction:column;gap:8px">
    <h3>最近的作業單</h3>
    ${list.length ? list.map(s => {
      const t = totals(s.id); let n = 0; t.forEach(r => n += r.qty);
      return `<button class="sess" data-id="${esc(s.id)}">
        <span class="chip ${TYPES[s.type].chip}">${TYPES[s.type].label}</span>
        <span class="grow"><b>${esc(s.location)}${s.type === "transfer" ? " → " + esc(s.to) : ""}</b>${s.vendor ? " · " + esc(s.vendor) : ""}<br>
        <span class="small muted">${esc(s.date)} · ${esc(s.createdBy || "")} · ${esc(s.status || "進行中")}</span></span>
        <span class="mono">${n} 件</span></button>`;
    }).join("") : `<div class="note">還沒有作業單。選上面的「驗收」「調撥」「退貨」或「盤點」開始。</div>`}
  </section>`;
}
function bindHome() {
  const pi = document.getElementById("person");
  pi.onchange = () => { person = pi.value.trim(); LS.set("person", person); };
  app.querySelectorAll("[data-new]").forEach(b => b.onclick = () => {
    person = pi.value.trim(); LS.set("person", person);
    if (!person) { toast("請先輸入操作人"); pi.focus(); return; }
    go({ name: "new", type: b.dataset.new });
  });
  document.getElementById("toIssues").onclick = () => go({ name: "issues" });
  document.getElementById("reload").onclick = () => boot();
  app.querySelectorAll(".sess").forEach(b => b.onclick = () => go({ name: "session", id: b.dataset.id, tab: "scan", zone: LS.get("zone." + b.dataset.id, "整區") }));
}

/* ---- 新增作業單 ---- */
function locOptions(sel) { return LOCS.map(l => `<option ${l === sel ? "selected" : ""}>${esc(l)}</option>`).join(""); }
function newHTML() {
  const t = view.type;
  return `<section class="panel">
    <h2>新增${TYPES[t].label}</h2>
    <div class="grid2">
      <label>作業日期<input id="date" type="date" value="${today()}"></label>
      ${t === "receive" ? `<label>進貨單日期<input id="poDate" type="date" value="${today()}"></label>` : ""}
      <label>${t === "transfer" ? "出貨地點" : "地點"}<select id="loc">${locOptions(t === "transfer" ? "明池倉" : t === "count" ? "" : "CY")}</select></label>
      ${t === "transfer" ? `<label>目的地<select id="to">${locOptions("神木園")}</select></label>` : ""}
      ${t === "receive" || t === "return" ? `<label>廠商<select id="vendor">${VENDORS.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>` : ""}
    </div>
    <label>備註<input id="memo" placeholder="${t === "receive" ? "例：第一批到貨" : t === "count" ? "例：10 月月底全盤" : "例：補貨"}"></label>
    <div class="row"><button id="back">取消</button><button class="primary grow" id="create">開始${TYPES[t].label}</button></div>
  </section>`;
}
function bindNew() {
  document.getElementById("back").onclick = () => go({ name: "home" });
  document.getElementById("create").onclick = () => {
    const t = view.type, v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
    if (t === "transfer" && v("loc") === v("to")) { toast("出貨地點和目的地不能相同"); return; }
    const d = v("date") || today();
    const id = { receive: "R", transfer: "T", return: "X", count: "C" }[t] + d.replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    const s = { id, type: t, date: d, poDate: v("poDate"), location: v("loc"), to: v("to"), vendor: v("vendor"), memo: v("memo"),
      createdBy: person, createdAt: nowIso(), status: "進行中", _local: true };
    sessions[id] = s; saveLocal();
    enqueue("saveSession", id, { session: strip(s) });
    go({ name: "session", id, tab: "scan", zone: "整區" });
  };
}
const strip = o => { const r = {}; for (const k in o) if (k[0] !== "_") r[k] = o[k]; return r; };

/* ---- 作業單 ---- */
function locked(s) { return s.status === "已確認"; }
function mySheet() {
  const k = sheetKey(view.id, view.zone);
  if (!sheets[k]) sheets[k] = { sessionId: view.id, zone: view.zone, person, device, counts: {}, updatedAt: nowIso() };
  return [k, sheets[k]];
}
// 操作人一定要填，否則不能修改、入帳或刪除
function whoFieldHTML(id) {
  return `<label style="min-width:0">操作人（必填）<input id="${id}" value="${esc(person)}" placeholder="輸入你的名字" autocomplete="name"></label>`;
}
function takeWho(id) {
  const el = document.getElementById(id);
  const v = el ? el.value.trim() : person;
  if (!v) { toast("請先填寫操作人姓名"); if (el) el.focus(); return false; }
  person = v; LS.set("person", person); return true;
}
function bump(code, delta, setTo) {
  if (!person) { toast("請先在上方填寫操作人"); const w = document.getElementById("who2"); if (w) w.focus(); return false; }
  const s = sessions[view.id];
  if (locked(s)) { toast("這張單已確認入帳，不能再修改"); return false; }
  const [k, sh] = mySheet();
  const cur = sh.counts[code] || 0;
  let next = setTo != null ? setTo : cur + delta;
  next = Math.max(0, Math.round(next));
  if (next === 0) delete sh.counts[code]; else sh.counts[code] = next;
  sh.person = person; sh.updatedAt = nowIso();
  saveLocal();
  enqueue("saveSheet", k, { sessionId: view.id, key: k, zone: sh.zone, person, device, counts: sh.counts });
  return true;
}
function sessionHTML(s) {
  return `
  <section class="panel" style="gap:8px">
    <div class="row"><span class="chip ${TYPES[s.type].chip}">${TYPES[s.type].label}${s.type === "count" ? "（盲盤）" : ""}</span>
      <span class="chip ${locked(s) ? "ok" : ""}">${esc(s.status || "進行中")}</span>
      <span class="grow small muted">${s.vendor ? esc(s.vendor) + " · " : ""}作業日 ${esc(s.date)}${s.poDate ? " · 進貨單 " + esc(s.poDate) : ""}${s.memo ? " · " + esc(s.memo) : ""}<br>${esc(s.id)} · ${esc(s.createdBy || "")}</span>
      <button class="ghost sm" id="home">返回</button></div>
    <div class="tabs" role="tablist">
      <button role="tab" id="tabScan" aria-selected="${view.tab === "scan"}">${s.type === "receive" ? "點收" : "清點"}</button>
      <button role="tab" id="tabRes" aria-selected="${view.tab === "res"}">結果與入帳</button>
    </div>
  </section>
  ${view.tab === "scan" ? scanHTML(s) : `<div id="resultBox" style="display:flex;flex-direction:column;gap:16px">${resultInner(s)}</div>`}`;
}
function scanHTML(s) {
  if (locked(s)) return `<div class="note">這張單已在 ${esc(fmt(s.confirmedAt))} 由 ${esc(s.confirmedBy || "")} 確認入帳。要修改請到「結果與入帳」按「重新開啟」。</div>`;
  return `
  <section class="panel">
    <div class="row">
      <label style="flex:2">區域<input id="zone" list="zonelist" value="${esc(view.zone)}"><datalist id="zonelist">${ZONES.map(z => `<option value="${z}">`).join("")}</datalist></label>
      <label>操作人（必填）<input id="who2" value="${esc(person)}" placeholder="你的名字"></label>
    </div>
    ${s.type === "receive" ? `
    <input id="flt" value="${esc(expectFilter)}" placeholder="找品項：品名、產品編號或廠商條碼" autocomplete="off">
    <span class="small muted">只會在 ${esc(s.vendor)} 的品項裡找。條碼打前幾碼或後幾碼都可以，品名可以打多個關鍵字。找到後直接按「相符 ✓」或「有問題」。</span>
  </section>` : `
    <form id="manual" class="row" autocomplete="off">
      <input id="code" class="grow" placeholder="搜尋品名、產品編號或廠商條碼" style="flex:1;min-width:0">
      <button type="submit">加入</button>
    </form>
    <span class="small muted">${s.type === "return" ? `只會在 ${esc(s.vendor)} 的品項裡找。` : ""}條碼打前幾碼或後幾碼都可以；品名可以打多個關鍵字，例如「抱枕套 鐵線蕨」。</span>
    <div id="sugg" class="list"></div>
    <div id="hit"></div>
  </section>`}
  ${s.type === "receive" ? `<section class="panel"><div class="row"><h3 class="grow">應收清單（${esc(s.vendor)}）</h3><span class="small muted mono" id="recvSum"></span></div><div id="expect" class="list"></div></section>
  <details class="panel"><summary style="cursor:pointer"><h3 id="mineTitle" style="display:inline"></h3></summary><div id="mine" class="list"></div></details>`
  : `<section class="panel">
    <h3 id="mineTitle"></h3>
    <div id="mine" class="list"></div>
  </section>`}`;
}
function hitHTML() {
  if (!lastHit) return "";
  if (lastHit.miss) return `<div class="card miss"><div class="nm">找不到這個條碼</div><div class="mono">${esc(lastHit.raw)}</div>
    <div class="small">商品主檔沒有這個號碼。請用品名搜尋，或先記下來之後再補資料。</div>
    <div class="row"><button class="sm" id="unk">記為未知條碼 +1</button></div></div>`;
  const p = lastHit.p, sh = sheets[sheetKey(view.id, view.zone)], mine = (sh && sh.counts[p.c]) || 0;
  return `<div class="card">
    <div class="small muted">${esc(p.b)} · ${esc(p.cat)}</div>
    <div class="nm">${esc(p.n)}</div>
    <div class="small mono muted">六福 ${p.c}${p.bc ? ` · 廠商 ${esc(p.bc)}` : " · 無廠商條碼"}${p.p ? " · $" + p.p : ""}</div>
    <div class="row"><span class="grow small">「${esc(view.zone)}」已記</span>
      <div class="qty"><button aria-label="減 1" data-d="-1">−</button><input id="hitQty" type="number" min="0" value="${mine}"><button aria-label="加 1" data-d="1">＋</button></div></div>
    ${issueOpen ? issueFormHTML(p) : `<div class="row"><button class="sm" id="openIssue">回報異常</button></div>`}
  </div>`;
}
// 拍照區塊：key 用來區分是哪個表單
const formPhotos = {}; // key -> [{id, dataUrl}]
function photoBoxHTML(key) {
  const list = formPhotos[key] || [];
  return `<div class="photoBox" data-pkey="${esc(key)}" style="display:flex;flex-direction:column;gap:6px">
    <span class="small muted">照片（破損、送錯款、缺中文標示必拍，最多 ${MAX_PHOTOS} 張）</span>
    <div class="row" style="gap:6px">
      ${list.map((x, i) => `<span style="position:relative;display:inline-block"><img src="${x.dataUrl}" alt="照片 ${i + 1}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--line)"><button class="sm" data-pdel="${i}" aria-label="刪除照片" style="position:absolute;top:-8px;right:-8px;padding:0 6px;border-radius:999px">×</button></span>`).join("")}
      ${list.length < MAX_PHOTOS ? `<button class="sm" data-padd="1">＋ 拍照</button>` : ""}
    </div>
  </div>`;
}
let photoTarget = null;
// 只重畫照片區塊，表單其他欄位（數量、勾選、說明）不會被清掉
function rerenderBox(key) {
  const box = [...document.querySelectorAll(".photoBox")].find(b => b.dataset.pkey === key); if (!box) return;
  const tmp = document.createElement("div"); tmp.innerHTML = photoBoxHTML(key);
  const nb = tmp.firstElementChild; box.replaceWith(nb); bindPhotoBoxes(nb.parentElement);
}
function bindPhotoBoxes(root) {
  (root || document).querySelectorAll(".photoBox").forEach(box => {
    const key = box.dataset.pkey;
    box.querySelectorAll("[data-pdel]").forEach(b => b.onclick = () => { (formPhotos[key] || []).splice(+b.dataset.pdel, 1); rerenderBox(key); });
    const add = box.querySelector("[data-padd]");
    if (add) add.onclick = () => {
      photoTarget = { key };
      let inp = document.getElementById("photoIn");
      if (!inp) { inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.capture = "environment"; inp.id = "photoIn"; inp.hidden = true; document.body.appendChild(inp); }
      inp.value = "";
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]; if (!f || !photoTarget) return;
        try {
          const dataUrl = await compressPhoto(f);
          const arr = formPhotos[photoTarget.key] = formPhotos[photoTarget.key] || [];
          if (arr.length < MAX_PHOTOS) arr.push({ id: "P" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), dataUrl });
          rerenderBox(photoTarget.key);
        } catch (e) { toast("照片讀取失敗，請再拍一次"); }
      };
      inp.click();
    };
  });
}
// 儲存時把照片寫進手機暫存，回傳照片編號
async function stashPhotos(key) {
  const arr = formPhotos[key] || [], ids = [];
  for (const x of arr) {
    try { await photoPut(x.id, x.dataUrl); ids.push(x.id); }
    catch (e) { toast("手機無法暫存照片，請確認不是無痕模式"); throw e; }
  }
  delete formPhotos[key];
  return ids;
}
function issueFormHTML(p) {
  return `<div class="panel" style="gap:8px">
    <label>異常類型<select id="iKind">${ISSUE_KINDS.map(k => `<option>${k}</option>`).join("")}</select></label>
    <div class="grid2"><label>數量<input id="iQty" type="number" min="0" value="1"></label><label>說明<input id="iNote" placeholder="例：外箱壓破，2 件玻璃杯裂"></label></div>
    ${photoBoxHTML("hit-" + p.c)}
    <div class="row"><button class="sm" id="cancelIssue">取消</button><button class="sm primary grow" id="sendIssue">送出回報</button></div>
  </div>`;
}
function mineHTML() {
  const sh = sheets[sheetKey(view.id, view.zone)];
  const entries = sh ? Object.entries(sh.counts) : [];
  const t = document.getElementById("mineTitle");
  if (t) t.textContent = `我在「${view.zone}」的紀錄 · ${entries.length} 項 · ${entries.reduce((a, [, q]) => a + q, 0)} 件`;
  if (!entries.length) return `<p class="small muted" style="margin:0">還沒有紀錄。</p>`;
  return entries.slice().reverse().map(([code, q]) => {
    const p = byCode.get(code);
    return `<div class="item"><span class="grow"><span class="name">${p ? esc(p.n) : "未知條碼"}</span><br><span class="small mono muted">${p ? p.c : esc(code.replace(/^\?/, ""))}</span></span>
      <div class="qty"><button data-c="${esc(code)}" data-d="-1" aria-label="減 1">−</button><input type="number" min="0" value="${q}" data-c="${esc(code)}"><button data-c="${esc(code)}" data-d="1" aria-label="加 1">＋</button></div></div>`;
  }).join("");
}
function remainingFor(s, code, got) {
  const p = byCode.get(code); if (!p) return 0;
  const before = (RECEIVED[code] || 0) - (locked(s) ? got : 0);
  return Math.max(0, p.q - before);
}
const editing = new Set(); // 應收清單裡正在填實收數的品項
function issuesFor(code) {
  const r = remote[view.id]; if (!r || !r.issues) return [];
  // 只標示還沒結案的問題；已解決、已撤回的不再掛在品項上
  return [...new Set(r.issues.filter(i => String(i["產品編號"]) === code && OPEN_ST.includes(i["處理狀態"])).map(i => i["異常類型"]))];
}
const OPEN_ST = ["待處理", "已通知廠商"]; // 還沒結案的回報
// 撤回這個品項目前還沒結案的回報（改成「相符」或重新填寫時用）
function withdrawOpen(code) {
  const r = remote[view.id]; let n = 0;
  ((r && r.issues) || []).forEach(i => {
    if (String(i["產品編號"]) === code && OPEN_ST.includes(i["處理狀態"])) {
      i["處理狀態"] = WITHDRAWN; n++;
      enqueue("saveIssue", i["編號"], { issue: { id: i["編號"], status: WITHDRAWN } });
    }
  });
  if (n) LS.set("remote", remote);
  return n;
}
function openIssuesFor(code) {
  const r = remote[view.id]; if (!r || !r.issues) return [];
  return r.issues.filter(i => String(i["產品編號"]) === code && OPEN_ST.includes(i["處理狀態"]));
}
// 之前回報的照片（已上傳的網址 + 還在手機等上傳的照片編號），重新填寫時沿用
function prevPhotos(code) {
  const prev = openIssuesFor(code), urls = new Set(), ids = new Set();
  prev.forEach(i => {
    String(i["照片"] || "").split(/\s+/).filter(Boolean).forEach(u => urls.add(u));
    const q = queue.find(x => x.op === "saveIssue" && x.key === i["編號"]);
    ((q && q.body.issue && q.body.issue.photoIds) || []).forEach(id => ids.add(id));
  });
  return { urls: [...urls], ids: [...ids] };
}
const shortKind = k => ({ "外箱或商品破損": "破損", "送錯款式或顏色": "送錯款", "缺條碼或吊牌（已補標）": "已補標", "缺中文標示": "缺中文標示" }[k] || k);
function expectHTML(s) {
  const t = totals(view.id);
  let gotSum = 0, needSum = 0;
  const pool = P.filter(p => p.v === s.vendor);
  const show = expectFilter.trim() ? new Set(suggest(expectFilter, pool, 9999).map(x => x.p.c)) : null;
  let shown = 0, total = 0;
  const rows = pool.map(p => {
    const g = (t.get(p.c) || { qty: 0 }).qty, need = remainingFor(s, p.c, g);
    gotSum += g; needSum += need;
    if (!need && !g) return "";
    total++;
    if (show && !show.has(p.c)) return "";
    shown++;
    const st = g === need ? ["ok", "相符"] : g === 0 ? ["", "未點"] : g < need ? ["warn", `短 ${need - g}`] : ["bad", `多 ${g - need}`];
    const head = `<span class="grow"><span class="name">${esc(p.n)}</span><br><span class="small mono muted">${p.c}${p.bc ? "" : " · 需貼六福標"}${need !== p.q ? ` · 訂 ${p.q}，先前已收 ${p.q - need}` : ""}</span></span>`;
    const kinds = issuesFor(p.c);
    const tags = kinds.filter(k => !k.startsWith("數量")).map(k => `<span class="chip bad">${esc(shortKind(k))}</span>`).join("");
    if (editing.has(p.c)) {
      const v = g || need, prev = openIssuesFor(p.c), prevKinds = new Set(prev.map(i => i["異常類型"]));
      const prevNote = (prev.find(i => i["說明"]) || {})["說明"] || "", pp = prevPhotos(p.c), prevN = pp.urls.length + pp.ids.length;
      return `<div class="item" style="flex-direction:column;align-items:stretch">
        <div class="row">${head}<span class="mono small">應收 ${need}</span></div>
        <label style="min-width:0">實收數量（實際收到的總數）<input type="number" min="0" inputmode="numeric" id="ed-${p.c}" value="${v}"></label>
        <div style="display:flex;flex-direction:column;gap:6px">
          <span class="small muted">其他問題（可複選；數量不對會自動回報，不用勾）</span>
          ${OTHER_KINDS.map((k, i) => `<label style="flex-direction:row;align-items:center;gap:8px;color:var(--fg);min-width:0"><input type="checkbox" id="k${i}-${p.c}" ${prevKinds.has(k) ? "checked" : ""} style="width:auto"> ${k}</label>`).join("")}
        </div>
        <div class="grid2">
          <label style="min-width:0">有問題的件數<input type="number" min="1" inputmode="numeric" id="kq-${p.c}" value="1"></label>
          <label style="min-width:0">說明（選填）<input id="note-${p.c}" value="${esc(prevNote)}" placeholder="例：外箱壓破，玻璃杯裂 1 件"></label>
        </div>
        ${prevN ? `<span class="small muted">之前已拍 ${prevN} 張照片，會一起保留。</span>` : ""}
        ${photoBoxHTML("row-" + p.c)}
        <div class="row"><button class="sm" data-cancel="${p.c}">取消</button><button class="sm primary grow" data-save="${p.c}" data-need="${need}" data-got="${g}">儲存</button></div>
      </div>`;
    }
    const hasOpen = openIssuesFor(p.c).length > 0;
    const actions = g === need && !hasOpen
      ? `<button class="sm ghost" data-edit="${p.c}">有問題</button>`
      : `<button class="sm" data-match="${p.c}" data-need="${need - g}">${hasOpen ? "改為相符" : "相符 ✓"}</button><button class="sm" data-edit="${p.c}">有問題</button>`;
    return `<div class="item">${head}<span class="mono small">${g}/${need}</span><span class="chip ${st[0]}">${st[1]}</span>${tags}${actions}</div>`;
  });
  const sum = document.getElementById("recvSum"); if (sum) sum.textContent = `${gotSum} / ${needSum}`;
  const head = show ? `<div class="row small" style="padding:6px 0"><span class="grow muted">找到 ${shown} / ${total} 項</span><button class="sm ghost" data-clearflt="1">顯示全部</button></div>` : "";
  if (show && !shown) return head + `<p class="small muted">${esc(s.vendor)} 沒有符合「${esc(expectFilter)}」的品項。</p>`;
  return head + (rows.join("") || `<p class="small muted">料號表裡沒有這家廠商的品項。</p>`);
}
function refreshScanParts() {
  const s = sessions[view.id];
  const h = document.getElementById("hit"); if (h) { h.innerHTML = hitHTML(); bindHit(s); bindPhotoBoxes(h); }
  const m = document.getElementById("mine"); if (m) { m.innerHTML = mineHTML(); bindMine(); }
  const e = document.getElementById("expect"); if (e) { e.innerHTML = expectHTML(s); bindExpect(); bindPhotoBoxes(e); }
}
function bindHit(s) {
  const h = document.getElementById("hit");
  h.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { bump(lastHit.p.c, +b.dataset.d); refreshScanParts(); });
  const qi = document.getElementById("hitQty"); if (qi) qi.onchange = () => { bump(lastHit.p.c, 0, +qi.value || 0); refreshScanParts(); };
  const u = document.getElementById("unk"); if (u) u.onclick = () => { bump("?" + lastHit.raw, 1); lastHit = null; toast("已記下未知條碼"); refreshScanParts(); };
  const oi = document.getElementById("openIssue"); if (oi) oi.onclick = () => { issueOpen = true; refreshScanParts(); };
  const ci = document.getElementById("cancelIssue"); if (ci) ci.onclick = () => { delete formPhotos["hit-" + lastHit.p.c]; issueOpen = false; refreshScanParts(); };
  const si = document.getElementById("sendIssue"); if (si) si.onclick = async () => {
    if (!person) { toast("請先在上方填寫操作人"); return; }
    const p = lastHit.p, pkey = "hit-" + p.c, kind = document.getElementById("iKind").value;
    if (PHOTO_REQUIRED.includes(kind) && !(formPhotos[pkey] || []).length) { toast(`「${shortKind(kind)}」需要拍照`); return; }
    let photoIds = [];
    try { photoIds = await stashPhotos(pkey); } catch (e) { return; }
    const issue = { id: "I" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), sessionId: view.id, location: s.location, vendor: p.v,
      code: p.c, name: p.n, kind: document.getElementById("iKind").value, qty: +document.getElementById("iQty").value || 0,
      note: document.getElementById("iNote").value.trim(), person, reportedAt: nowIso(), status: "待處理", photoIds };
    const r = remote[view.id] = remote[view.id] || { sheets: {}, issues: [] };
    r.issues = [toIssueRow(issue)].concat(r.issues || []); LS.set("remote", remote);
    enqueue("saveIssue", issue.id, { issue });
    issueOpen = false; toast("已回報，Echo 會在異常清單看到"); refreshScanParts();
  };
}
function toIssueRow(x) {
  return { "編號": x.id, "回報時間": x.reportedAt, "單號": x.sessionId, "地點": x.location, "廠商": x.vendor, "產品編號": x.code, "品名": x.name,
    "異常類型": x.kind, "數量": x.qty, "說明": x.note, "回報人": x.person, "處理狀態": x.status, "處理備註": "", "照片": x.photos || "", "_pending": (x.photoIds || []).length };
}
function bindMine() {
  const m = document.getElementById("mine");
  m.querySelectorAll("button[data-c]").forEach(b => b.onclick = () => { bump(b.dataset.c, +b.dataset.d); refreshScanParts(); });
  m.querySelectorAll("input[data-c]").forEach(i => i.onchange = () => { bump(i.dataset.c, 0, +i.value || 0); refreshScanParts(); });
}
function bindExpect() {
  const s = sessions[view.id];
  document.querySelectorAll("[data-clearflt]").forEach(b => b.onclick = () => { expectFilter = ""; const f = document.getElementById("flt"); if (f) f.value = ""; refreshScanParts(); });
  const myCount = code => { const sh = sheets[sheetKey(view.id, view.zone)]; return (sh && sh.counts[code]) || 0; };
  document.querySelectorAll("[data-match]").forEach(b => b.onclick = () => {
    const code = b.dataset.match, need = +b.dataset.need;
    const mine = myCount(code), target = mine + need;
    if (target < 0) { toast("其他人記的數量比應收還多，請到「有問題」調整"); return; }
    if (bump(code, 0, target)) {
      const p = byCode.get(code), n = withdrawOpen(code); lastHit = null;
      toast(`已標記相符：${p ? p.n : code}${n ? `，撤回 ${n} 筆回報` : ""}`);
    }
    refreshScanParts();
  });
  document.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => { editing.add(b.dataset.edit); refreshScanParts(); const i = document.getElementById("ed-" + b.dataset.edit); if (i) i.focus(); });
  document.querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => { delete formPhotos["row-" + b.dataset.cancel]; editing.delete(b.dataset.cancel); refreshScanParts(); });
  document.querySelectorAll("[data-save]").forEach(b => b.onclick = async () => {
    const code = b.dataset.save, need = +b.dataset.need, got = +b.dataset.got, pkey = "row-" + code;
    const needPhoto = OTHER_KINDS.filter((k, i) => document.getElementById(`k${i}-${code}`).checked && PHOTO_REQUIRED.includes(k));
    const pp = prevPhotos(code);
    if (needPhoto.length && !(formPhotos[pkey] || []).length && !(pp.urls.length + pp.ids.length)) { toast(`「${needPhoto.map(shortKind).join("、")}」需要拍照`); return; }
    const raw = document.getElementById("ed-" + code).value.trim();
    if (raw === "") { toast("請填實收數量"); return; }
    const qty = Math.max(0, Math.round(+raw || 0));
    const others = got - myCount(code); // 其他人或其他區域已記的數量
    if (qty < others) { toast(`其他人已記 ${others} 件，實收不能小於這個數字`); return; }
    let photoIds = [];
    try { photoIds = pp.ids.concat(await stashPhotos(pkey)); } catch (e) { return; }
    if (!bump(code, 0, qty - others)) return;
    const p = byCode.get(code), note = document.getElementById("note-" + code).value.trim();
    const kq = Math.max(1, Math.round(+document.getElementById("kq-" + code).value || 1));
    const list = [];
    if (qty !== need) list.push({ kind: qty < need ? "數量短少" : "數量超收", qty: Math.abs(need - qty) });
    OTHER_KINDS.forEach((k, i) => { if (document.getElementById(`k${i}-${code}`).checked) list.push({ kind: k, qty: kq }); });
    const r = remote[view.id] = remote[view.id] || { sheets: {}, issues: [] };
    // 這個品項之前的回報（還沒處理的）全部撤回，以這次填的為準，避免重複
    withdrawOpen(code);
    list.forEach((x, n) => {
      const issue = { id: "I" + Date.now().toString(36) + n + Math.random().toString(36).slice(2, 5), sessionId: view.id, location: s.location, vendor: p ? p.v : s.vendor,
        code, name: p ? p.n : code, kind: x.kind, qty: x.qty, note, person, reportedAt: nowIso(), status: "待處理",
        photoIds: x.kind.startsWith("數量") && list.length > 1 ? [] : photoIds,
        photos: x.kind.startsWith("數量") && list.length > 1 ? "" : pp.urls.join(" ") };
      r.issues = [toIssueRow(issue)].concat(r.issues || []);
      enqueue("saveIssue", issue.id, { issue });
    });
    LS.set("remote", remote);
    toast(list.length ? `已記錄實收 ${qty} 件，回報：${list.map(x => shortKind(x.kind) + " " + x.qty + " 件").join("、")}` : `已記錄實收 ${qty} 件`);
    editing.delete(code); lastHit = null; refreshScanParts();
  });
}

/* ---- 輸入比對：前幾碼、後幾碼都可以 ---- */
function suggest(raw, pool, limit) {
  pool = pool || P;
  const v = String(raw || "").trim().replace(/\s+/g, "");
  const terms = String(raw || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const isCode = /^\d+$/.test(v);
  if (isCode ? v.length < 3 : !terms.length) return [];
  const out = [];
  for (const p of pool) {
    if (!isCode) {
      // 只在同一家廠商裡找時不比對品牌（每個品項都一樣，會全部符合）
      const h = (p.n + " " + (pool === P ? p.b + " " : "") + p.c + " " + (p.bc || "")).toLowerCase();
      if (terms.every(t => h.includes(t))) out.push({ p, rank: 4, how: "品名相符" });
      continue;
    }
    const keys = [p.c, String(p.bc || "")].filter(Boolean);
    let rank = 9, how = "";
    for (const k of keys) {
      if (k === v) { rank = 0; how = "完全相符"; }
      else if (k.startsWith(v) && rank > 1) { rank = 1; how = "前幾碼相符"; }
      else if (k.endsWith(v) && rank > 2) { rank = 2; how = "後幾碼相符"; }
      else if (v.length >= 4 && k.includes(v) && rank > 3) { rank = 3; how = "中間相符"; }
    }
    if (rank < 9) out.push({ p, rank, how });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, limit || (isCode ? 8 : 20));
}
const hl = (k, v) => { v = String(v || "").trim(); const i = v ? String(k).indexOf(v) : -1; return i < 0 ? esc(k) : esc(k.slice(0, i)) + "<b>" + esc(k.slice(i, i + v.length)) + "</b>" + esc(k.slice(i + v.length)); };

/* ---- 掃描 ---- */
let scanner = null, camOn = false, actx = null;
const seen = new Map(); // code -> 最後一次在畫面上看到的時間
function handleCode(raw, src) {
  const s = String(raw || "").trim(); if (!s) return;
  if (/^https?:|^www\./i.test(s)) { if (src !== "cam") toast("這不是商品條碼，請輸入品名、產品編號或廠商條碼"); return; }
  if (!person) { toast("請先輸入操作人"); return; }
  const p = lookup(s);
  const key = p ? p.c : s;
  if (src === "cam") {
    const last = seen.get(key) || 0, now = Date.now();
    seen.set(key, now);
    if (now - last < 900) return; // 一直對著同一件時不重複加
  }
  if (!p) { lastHit = { miss: true, raw: s }; issueOpen = false; beep(false); refreshScanParts(); return; }
  lastHit = { p }; issueOpen = false;
  if (bump(p.c, 1)) beep(true);
  refreshScanParts();
}
function beep(ok) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = ok ? 1046 : 220; g.gain.value = .08; o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + (ok ? .08 : .25));
    if (navigator.vibrate) navigator.vibrate(ok ? 30 : [60, 40, 60]);
  } catch (e) {}
}
function formats() {
  const F = window.Html5QrcodeSupportedFormats;
  return F ? [F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_39, F.ITF] : undefined;
}
async function startCamera() {
  if (!window.Html5Qrcode) { toast("掃描元件沒有載入，請確認網路後重新整理"); return; }
  const box = document.getElementById("reader"); box.hidden = false;
  try {
    scanner = new window.Html5Qrcode("reader", { verbose: false, formatsToSupport: formats(), experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
    const cfg = { fps: 15, disableFlip: true,
      qrbox: (w, h) => ({ width: Math.floor(w * 0.92), height: Math.floor(Math.min(h * 0.45, w * 0.45)) }),
      videoConstraints: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
    try { await scanner.start({ facingMode: "environment" }, cfg, text => handleCode(text, "cam"), () => {}); }
    catch (e1) { delete cfg.videoConstraints; await scanner.start({ facingMode: "environment" }, cfg, text => handleCode(text, "cam"), () => {}); }
    camOn = true;
    setupZoom();
  } catch (e) {
    box.hidden = true; scanner = null; camOn = false;
    toast("無法開啟鏡頭。請在瀏覽器允許使用相機，或改用「拍照」。");
  }
  const b = document.getElementById("camBtn"); if (b) b.textContent = camOn ? "關閉鏡頭" : "開啟鏡頭掃描";
}
function setupZoom() {
  const row = document.getElementById("zoomRow"), box = document.getElementById("zoomBtns");
  if (!row || !scanner) return;
  try {
    const z = scanner.getRunningTrackCameraCapabilities().zoomFeature();
    if (!z.isSupported()) { row.hidden = true; return; }
    const min = z.min(), max = z.max();
    const levels = [1, 1.5, 2, 3].filter(v => v >= min && v <= max);
    if (levels.length < 2) { row.hidden = true; return; }
    box.innerHTML = levels.map(v => `<button aria-pressed="${v === 1}" data-z="${v}">${v}×</button>`).join("");
    box.querySelectorAll("[data-z]").forEach(b => b.onclick = async () => {
      try { await z.apply(+b.dataset.z); box.querySelectorAll("[data-z]").forEach(x => x.setAttribute("aria-pressed", x === b)); } catch (e) {}
    });
    row.hidden = false;
  } catch (e) { row.hidden = true; }
}
function stopCamera() {
  const zr = document.getElementById("zoomRow"); if (zr) zr.hidden = true;
  if (scanner && camOn) { try { scanner.stop().then(() => scanner.clear()).catch(() => {}); } catch (e) {} }
  camOn = false; scanner = null;
}
// 拍照辨識：整張圖讀不到時，切成多塊、縮放後逐塊再試（小條碼、反光時比較讀得到）
async function decodeImage(file) {
  let bmp = null;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { try { bmp = await createImageBitmap(file); } catch (e2) { return null; } }
  if ("BarcodeDetector" in window) {
    try {
      const det = new window.BarcodeDetector({ formats: ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39", "itf"] });
      const r = await det.detect(bmp);
      const hit = (r || []).map(x => x.rawValue).find(v => lookup(v)) || (r && r[0] && r[0].rawValue);
      if (hit) return hit;
    } catch (e) {}
  }
  const Z = window.ZXing;
  if (!Z) return null;
  const F = Z.BarcodeFormat, hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_39, F.ITF]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader(); reader.setHints(hints);
  const W = bmp.width, H = bmp.height, cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
  const tryRegion = (sx, sy, sw, sh, tw) => {
    tw = Math.min(tw, sw); const th = Math.round(sh * tw / sw);
    cv.width = tw; cv.height = th; cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, tw, th);
    const d = cx.getImageData(0, 0, tw, th).data, g = new Uint8ClampedArray(tw * th);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
    for (const B of [Z.HybridBinarizer, Z.GlobalHistogramBinarizer]) {
      try { return reader.decode(new Z.BinaryBitmap(new B(new Z.RGBLuminanceSource(g, tw, th)))).getText(); } catch (e) {}
    }
    return null;
  };
  const regions = [[0, 0, W, H, 1400]];
  for (const [fw, fh, nx, ny] of [[0.6, 0.3, 3, 5], [0.45, 0.2, 3, 7]]) {
    const cw = W * fw, ch = H * fh;
    for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++)
      regions.push([(W - cw) * gx / (nx - 1), (H - ch) * gy / (ny - 1), cw, ch, 900]);
  }
  let first = null;
  for (let i = 0; i < regions.length; i++) {
    const t = tryRegion(...regions[i]);
    if (t && !/^https?:|^www\./i.test(t)) { if (lookup(t)) return t; first = first || t; }
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0)); // 讓畫面有機會更新
  }
  return first;
}
function bindSession(s) {
  document.getElementById("home").onclick = () => go({ name: "home" });
  document.getElementById("tabScan").onclick = () => { stopCamera(); view.tab = "scan"; render(); };
  document.getElementById("tabRes").onclick = () => { stopCamera(); view.tab = "res"; confirmAsk = false; render(); loadRemote(view.id).then(() => render(true)); };
  if (view.tab === "res") { bindResult(s); return; }
  if (locked(s)) return;
  const z = document.getElementById("zone");
  z.onchange = () => { view.zone = z.value.trim() || "整區"; LS.set("zone." + view.id, view.zone); lastHit = null; refreshScanParts(); };
  const w = document.getElementById("who2"); w.onchange = () => { person = w.value.trim(); LS.set("person", person); };
  const flt = document.getElementById("flt");
  if (flt) {
    flt.oninput = () => { expectFilter = flt.value; const e = document.getElementById("expect"); if (e) { e.innerHTML = expectHTML(s); bindExpect(); bindPhotoBoxes(e); } };
    // 掃描槍刷完會送出 Enter：選取文字，下一次刷碼直接取代，不會黏在一起
    flt.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); flt.select(); } };
    refreshScanParts();
    return;
  }
  const pool = s.type === "return" && s.vendor ? P.filter(p => p.v === s.vendor) : P;
  const form = document.getElementById("manual"), ci = document.getElementById("code");
  const sugg = document.getElementById("sugg");
  const clearSugg = () => { sugg.innerHTML = ""; };
  ci.oninput = () => {
    const m = suggest(ci.value, pool);
    if (!m.length) { sugg.innerHTML = ci.value.trim().length >= 2 ? `<p class="small muted" style="margin:0">沒有符合的品項。</p>` : ""; return; }
    sugg.innerHTML = m.map(({ p, how }) => `<div class="item"><span class="grow"><span class="name">${esc(p.n)}</span><br><span class="small mono muted">${hl(p.c, ci.value)}${p.bc ? " · " + hl(p.bc, ci.value) : ""} · ${how}</span></span><button class="sm" data-pick="${p.c}">＋1</button></div>`).join("");
    sugg.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { handleCode(b.dataset.pick, "manual"); ci.value = ""; clearSugg(); ci.focus(); });
  };
  form.onsubmit = e => {
    e.preventDefault();
    const v = ci.value.trim(); if (!v) return;
    if (lookup(v)) { handleCode(v, "manual"); ci.value = ""; clearSugg(); ci.focus(); return; }
    const m = suggest(v, pool);
    if (m.length === 1) { handleCode(m[0].p.c, "manual"); ci.value = ""; clearSugg(); ci.focus(); return; }
    if (m.length > 1) { toast(`有 ${m.length} 個品項符合，請從下方選一個`); return; }
    handleCode(v, "manual"); ci.value = ""; clearSugg();
  };
  refreshScanParts();
}

/* ---- 結果與入帳 ---- */
const ST = { ok: ["ok", "相符"], short: ["warn", "短少"], over: ["bad", "多出"], none: ["", "未掃到"], counted: ["ok", "已記錄"], extra: ["info", "非應收品項"], unknown: ["bad", "未知條碼"], zero: ["", "已售完"] };
function resultRows(s) {
  const t = totals(view.id), rows = [], seenC = new Set();
  const book = remote[view.id] && remote[view.id].book;
  if (s.type === "receive") {
    for (const p of P.filter(p => p.v === s.vendor)) {
      const g = t.get(p.c); seenC.add(p.c);
      const qty = g ? g.qty : 0, ref = remainingFor(s, p.c, qty);
      if (!qty && !ref) continue;
      rows.push({ p, qty, ref, st: qty === ref ? "ok" : qty === 0 ? "none" : qty < ref ? "short" : "over", g });
    }
  } else if (s.type === "count" && book) {
    const bd = (remote[view.id] && remote[view.id].breakdown) || {};
    const codes = new Set(Object.keys(book).concat(Object.keys(bd).filter(c => Object.values(bd[c]).some(v => v))));
    for (const code of codes) {
      const g = t.get(code); seenC.add(code);
      const p = byCode.get(code) || { c: code, n: "（主檔已無此品項）", b: "", v: "" };
      const qty = g ? g.qty : 0, b = book[code] || 0;
      rows.push({ p, qty, ref: b, bd: bd[code], st: qty === b ? (b ? "ok" : "zero") : qty === 0 ? "none" : qty < b ? "short" : "over", g });
    }
  }
  for (const [code, g] of t) {
    if (seenC.has(code)) continue;
    const p = byCode.get(code);
    const unknown = !p;
    const ref = s.type === "count" && book ? 0 : null;
    rows.push({ p: p || { c: code.replace(/^\?/, ""), n: "未知條碼", b: "", v: "" }, qty: g.qty, ref, bd: null,
      st: unknown ? "unknown" : s.type === "receive" ? "extra" : (ref === 0 ? "over" : "counted"), g });
  }
  return rows.map(r => Object.assign(r, { zones: r.g ? r.g.zones : {}, people: r.g ? [...r.g.people] : [] }));
}
function autoWarnHTML(s, rows) {
  if (s.type !== "receive") return "";
  const none = rows.filter(r => r.st === "none").length, diff = rows.filter(r => r.st === "short" || r.st === "over").length;
  if (!none && !diff) return "";
  return `<span class="small" style="color:var(--bad)">${none ? `${none} 個品項沒有掃到，會自動標為「未到貨」異常。` : ""}${diff ? `${diff} 個品項數量不符，沒回報的會自動標為短少或超收。` : ""}有掃漏的請先取消、補掃。</span>`;
}
const BD_COLS = [["open", "上次盤點"], ["recv", "＋進貨"], ["tin", "＋調入"], ["tout", "−調出"], ["ret", "−退貨"], ["sales", "−銷售"]];
function resultInner(s) {
  const isCount = s.type === "count";
  const rows = resultRows(s), hasRef = s.type === "receive" || (s.type === "count" && remote[view.id] && remote[view.id].book);
  const total = rows.reduce((a, x) => a + x.qty, 0);
  const keys = [...new Set(rows.map(r => r.st))];
  const shown = rows.filter(x => resultFilter === "all" || x.st === resultFilter);
  const sh = Object.values(sheetsFor(view.id));
  const issues = (remote[view.id] && remote[view.id].issues) || [];
  const pending = queue.filter(q => (q.body.sessionId || (q.body.session && q.body.session.id)) === view.id).length;
  const autoWarn = autoWarnHTML(s, rows);
  const fin = {
    receive: "確認後，實收數量會記入「" + s.location + "」的庫存。",
    transfer: `確認後，會從「${s.location}」扣除並加到「${s.to}」。`,
    return: `確認後，會從「${s.location}」的庫存扣除。`,
    count: `確認後，差異會記為盤差，「${s.location}」的帳面數改成這次的盤點數。`
  }[s.type];
  return `
  <section class="stats">
    <div class="stat"><span class="small muted">本次件數</span><b>${total}</b></div>
    ${keys.map(k => `<div class="stat"><span class="small muted">${ST[k][1]}</span><b>${rows.filter(r => r.st === k).length}</b></div>`).join("")}
  </section>
  ${s.type === "count" && !(remote[view.id] && remote[view.id].book) ? `<div class="note">連上網路後會顯示帳面數並比對。</div>` : ""}
  ${s.type === "count" ? `<div class="note">應有 = 上次盤點 ＋ 進貨 ＋ 調入 − 調出 − 退貨 − POS 銷售。${(remote[view.id] && remote[view.id].lastCount) ? `上次盤點是 ${esc(remote[view.id].lastCount.date)}。` : "這個地點還沒有盤點過，從第一筆進貨開始算。"}POS 銷售要先貼到試算表「POS銷售」分頁，差異才會準。</div>` : ""}
  <section class="panel" style="gap:8px">
    <div class="row"><h3 class="grow">參與紀錄</h3><button class="ghost sm" id="refresh">重新整理</button></div>
    ${sh.length ? sh.map(x => `<div class="row small"><span class="grow">${esc(x.person || "未具名")} · ${esc(x.zone)}</span><span class="mono">${Object.values(x.counts || {}).reduce((a, b) => a + b, 0)} 件</span><span class="muted">${esc(fmt(x.updatedAt))}</span></div>`).join("") : `<p class="small muted" style="margin:0">還沒有人開始掃描。</p>`}
    ${issues.length ? `<p class="small" style="margin:0">異常回報 ${issues.length} 筆：${issues.map(i => esc(i["品名"]) + "（" + esc(i["異常類型"]) + "）").join("、")}</p>` : ""}
  </section>
  <div class="filters" role="group" aria-label="篩選">
    <button aria-pressed="${resultFilter === "all"}" data-f="all">全部 ${rows.length}</button>
    ${keys.map(k => `<button aria-pressed="${resultFilter === k}" data-f="${k}">${ST[k][1]} ${rows.filter(r => r.st === k).length}</button>`).join("")}
  </div>
  ${isCount && hasRef ? `<section class="panel" style="gap:0"><div class="list">${shown.map(x => {
      const b = x.bd || {}, d = x.qty - (x.ref || 0);
      const parts = BD_COLS.filter(([k]) => k === "open" || b[k]).map(([k, l]) => `${k === "open" ? "上次" : l} ${b[k] || 0}`).join("　");
      return `<div class="item" style="align-items:flex-start">
        <span class="grow"><span class="name">${esc(x.p.n)}</span><br><span class="small mono muted">${esc(x.p.c)}</span><br>
        <span class="small mono">${parts}　＝ 應有 <b>${x.ref ?? 0}</b></span></span>
        <span style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px"><span class="mono">實盤 <b>${x.qty}</b></span>
        <span class="mono small">${d > 0 ? "+" : ""}${d}</span><span class="chip ${ST[x.st][0]}">${ST[x.st][1]}</span></span></div>`;
    }).join("") || `<p class="muted">沒有品項。</p>`}</div></section>` : `<div class="tablewrap"><table>
    <thead><tr><th>品項</th>${isCount && hasRef ? BD_COLS.map(([, l]) => `<th class="num">${l}</th>`).join("") + `<th class="num">應有</th><th class="num">實盤</th>` : `<th>區域</th><th class="num">本次</th>`}${hasRef && !isCount ? `<th class="num">應收</th>` : ""}${hasRef ? `<th class="num">差異</th>` : ""}<th>狀態</th></tr></thead>
    <tbody>${shown.map(x => `<tr>
      <td><span class="name">${esc(x.p.n)}</span><br><span class="small mono muted">${esc(x.p.c)}</span></td>
      ${isCount && hasRef ? BD_COLS.map(([k]) => `<td class="num">${x.bd ? x.bd[k] || "" : ""}</td>`).join("") + `<td class="num"><b>${x.ref ?? 0}</b></td><td class="num">${x.qty}</td>`
        : `<td class="small">${Object.entries(x.zones).map(([z, q]) => `${esc(z)} ${q}`).join("<br>") || "—"}</td><td class="num">${x.qty}</td>`}
      ${hasRef && !isCount ? `<td class="num">${x.ref ?? "—"}</td>` : ""}
      ${hasRef ? `<td class="num">${x.ref == null ? "—" : (x.qty - x.ref > 0 ? "+" : "") + (x.qty - x.ref)}</td>` : ""}
      <td><span class="chip ${ST[x.st][0]}">${ST[x.st][1]}</span></td></tr>`).join("") || `<tr><td colspan="6" class="muted">沒有品項。</td></tr>`}</tbody>
  </table></div>`}
  <section class="row"><button class="grow" id="copy">複製表格</button></section>
  ${locked(s) ? `<section class="panel"><p style="margin:0">已在 ${esc(fmt(s.confirmedAt))} 由 ${esc(s.confirmedBy || "")} 確認入帳。</p>
      ${remote[view.id] && remote[view.id].doc ? `<a class="primary" href="${esc(remote[view.id].doc.url)}" target="_blank" rel="noopener" style="display:block;text-align:center;padding:12px;border-radius:8px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:700">開啟驗收單 PDF</a><p class="small muted" style="margin:0">PDF 存在 Drive「點收盤點_驗收單」資料夾，可以直接轉給財務。</p>` : ""}
      ${confirmAsk ? `<div class="confirm"><b>確定要重新開啟？</b><span class="small">這張單寫入的庫存異動會被撤回，可以繼續修改後再確認一次。</span>${whoFieldHTML("whoAct")}<div class="row"><button id="no">取消</button><button class="danger grow" id="yesReopen">重新開啟</button></div></div>` : `<button class="danger" id="reopen">重新開啟</button>`}</section>`
    : `<section class="panel">
      ${pending ? `<div class="note warn">還有 ${pending} 筆掃描沒有上傳，連上網路後再確認入帳。</div>` : ""}
      ${confirmAsk ? `<div class="confirm"><b>確定要確認入帳？</b><span class="small">${fin}所有人的掃描會以試算表上的最新紀錄為準。</span>${autoWarn}${whoFieldHTML("whoAct")}<div class="row"><button id="no">取消</button><button class="primary grow" id="yes">確認入帳</button></div></div>`
        : `<button class="primary big" id="finalize" ${pending ? "disabled" : ""}>確認入帳</button><p class="small muted" style="margin:0">${fin}</p>`}
    </section>
    <section class="panel">
      ${deleteAsk ? `<div class="confirm"><b>確定要刪除這張單？</b><span class="small">單號 ${esc(s.id)} 的所有掃描紀錄和異常回報都會一起刪除，無法復原。</span>${whoFieldHTML("whoAct")}<div class="row"><button id="noDel">取消</button><button class="danger grow" id="yesDel">刪除</button></div></div>`
        : `<button class="danger" id="del">刪除這張單</button><p class="small muted" style="margin:0">測試資料或建錯的單可以刪除。已確認入帳的單要先重新開啟。</p>`}
    </section>`}`;
}
function bindResult(s) {
  document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { resultFilter = b.dataset.f; render(true); });
  const rf = document.getElementById("refresh"); if (rf) rf.onclick = () => loadRemote(view.id).then(() => render(true));
  document.getElementById("copy").onclick = () => {
    const rows = resultRows(s);
    const head = ["單號", "類型", "地點", "產品編號", "廠商條碼", "品名", "廠商", "區域", "本次", "對照數", "狀態"];
    const lines = [head.join("\t")].concat(rows.map(x => [s.id, TYPES[s.type].label, s.location, x.p.c, x.p.bc || "", x.p.n, x.p.v || "",
      Object.entries(x.zones).map(([z, q]) => z + ":" + q).join(" / "), x.qty, x.ref ?? "", ST[x.st][1]].map(v => String(v).replace(/[\t\n]/g, " ")).join("\t")));
    navigator.clipboard.writeText(lines.join("\n")).then(() => toast("已複製，可以貼到試算表"), () => toast("這個瀏覽器不允許複製"));
  };
  const f = document.getElementById("finalize"); if (f) f.onclick = () => { confirmAsk = true; render(true); };
  const ro = document.getElementById("reopen"); if (ro) ro.onclick = () => { confirmAsk = true; render(true); };
  const no = document.getElementById("no"); if (no) no.onclick = () => { confirmAsk = false; render(true); };
  const yes = document.getElementById("yes"); if (yes) yes.onclick = async () => {
    if (!takeWho("whoAct")) return;
    yes.disabled = true; yes.textContent = "入帳中…";
    try {
      await flush();
      if (queue.length) throw new Error("還有資料沒有上傳");
      const j = await apiPost({ a: "finalize", id: s.id, person });
      s.status = "已確認"; s.confirmedBy = person; s.confirmedAt = nowIso(); delete s._local; saveLocal();
      toast(j.already ? "這張單之前已經入帳" : j.docError ? `已入帳，但${j.docError}` : `已入帳，寫入 ${j.written} 筆異動${j.autoIssues ? `，自動標示 ${j.autoIssues} 項數量異常` : ""}${j.doc ? "，驗收單 PDF 已產生" : ""}`);
      confirmAsk = false; await loadRemote(s.id); await refreshReceived(); render();
    } catch (e) { toast("入帳失敗：" + (e instanceof TypeError ? "沒有網路" : e.message)); yes.disabled = false; yes.textContent = "確認入帳"; }
  };
  const dl = document.getElementById("del"); if (dl) dl.onclick = () => { deleteAsk = true; render(true); };
  const nd = document.getElementById("noDel"); if (nd) nd.onclick = () => { deleteAsk = false; render(true); };
  const yd = document.getElementById("yesDel"); if (yd) yd.onclick = async () => {
    if (!takeWho("whoAct")) return;
    yd.disabled = true; yd.textContent = "刪除中…";
    const wasLocalOnly = !!s._local && queue.some(q => q.op === "saveSession" && q.key === s.id);
    try {
      if (!wasLocalOnly) await apiPost({ a: "deleteSession", id: s.id });
      dropLocal(s.id); toast("已刪除"); go({ name: "home" });
    } catch (e) { toast("刪除失敗：" + (e instanceof TypeError ? "沒有網路" : e.message)); yd.disabled = false; yd.textContent = "刪除"; }
  };
  const yr = document.getElementById("yesReopen"); if (yr) yr.onclick = async () => {
    if (!takeWho("whoAct")) return;
    yr.disabled = true;
    try {
      await apiPost({ a: "reopen", id: s.id });
      s.status = "進行中"; saveLocal(); toast("已重新開啟"); confirmAsk = false;
      await refreshReceived(); await loadRemote(s.id); render();
    } catch (e) { toast("無法重新開啟：" + (e instanceof TypeError ? "沒有網路" : e.message)); yr.disabled = false; }
  };
}
async function refreshReceived() {
  try { const j = await apiGet({ a: "boot" }); RECEIVED = j.received || {}; const m = LS.get("master", {}); m.received = RECEIVED; LS.set("master", m); } catch (e) {}
}

/* ---- 異常清單 ---- */
let ISSUES = LS.get("issues", []);
async function loadIssues() {
  try { const j = await apiGet({ a: "issues" }); ISSUES = j.issues || []; LS.set("issues", ISSUES); online = true; } catch (e) { if (e instanceof TypeError) online = false; }
  if (view.name === "issues") render();
}
// 同一張單、同一品項、同一類型只留最新一筆；已撤回的不顯示
function currentIssues() {
  const latest = new Map();
  for (const i of ISSUES) {
    if (i["處理狀態"] === WITHDRAWN) continue;
    const k = `${i["單號"]}|${i["產品編號"]}|${i["異常類型"]}`;
    const old = latest.get(k);
    if (!old || String(i["回報時間"]) > String(old["回報時間"])) latest.set(k, i);
  }
  return [...latest.values()];
}
function matchFilter(st) { return issueFilter === "all" || (issueFilter === "open" ? st !== "已解決" : st === issueFilter); }
// 依廠商 → 品項整理：一個品項一列，列出所有問題
function issueGroups() {
  const byVendor = {};
  for (const i of currentIssues()) {
    if (!matchFilter(i["處理狀態"])) continue;
    const v = i["廠商"] || "未指定廠商", key = `${i["單號"]}|${i["產品編號"]}`;
    const g = (byVendor[v] = byVendor[v] || {});
    const it = (g[key] = g[key] || { session: i["單號"], code: String(i["產品編號"]), name: i["品名"], loc: i["地點"], items: [], notes: new Set(), time: "", who: new Set() });
    it.items.push(i); if (i["說明"]) it.notes.add(i["說明"]); it.who.add(i["回報人"]);
    it.photos = it.photos || new Set();
    String(i["照片"] || "").split(/\s+/).filter(Boolean).forEach(u => it.photos.add(u));
    if (String(i["回報時間"]) > it.time) it.time = String(i["回報時間"]);
  }
  return byVendor;
}
const kindText = i => {
  const k = i["異常類型"], q = i["數量"];
  if (k === "數量短少") return `少 ${q} 件`;
  if (k === "數量超收") return `多 ${q} 件`;
  if (k === "未到貨") return `未到貨 ${q} 件`;
  return `${shortKind(k)} ${q} 件`;
};
function productStatus(it) {
  const st = [...new Set(it.items.map(i => i["處理狀態"]))];
  return st.length === 1 ? st[0] : "待處理";
}
function issuesHTML() {
  const groups = issueGroups();
  return `
  <section class="row"><button class="ghost sm" id="home">返回</button><span class="grow"></span><button class="sm" id="reloadIssues">重新整理</button></section>
  <section class="panel">${whoFieldHTML("whoIssue")}<span class="small muted">改處理狀態、標為已通知時，會記下操作人。</span></section>
  <div class="filters" role="group" aria-label="狀態">
    ${[["open", "未解決"], ["待處理", "待處理"], ["已通知廠商", "已通知廠商"], ["已解決", "已解決"], ["all", "全部"]].map(([k, l]) => `<button aria-pressed="${issueFilter === k}" data-if="${k}">${l}</button>`).join("")}
  </div>
  ${Object.keys(groups).length ? Object.entries(groups).map(([v, g]) => {
    const items = Object.values(g);
    return `<section class="panel">
      <div class="row"><h2 class="grow">${esc(v)}</h2><span class="small muted">${items.length} 個品項</span></div>
      <div class="list">${items.map(it => `<div class="item">
        <span class="grow"><span class="name">${esc(it.name)}</span><br>
        <span class="small mono muted">${esc(it.code)} · ${esc(it.loc)} · ${esc(fmt(it.time))} · ${esc([...it.who].join("、"))}</span><br>
        ${it.items.map(i => `<span class="chip ${i["異常類型"].startsWith("數量") ? "warn" : "bad"}">${esc(kindText(i))}</span>`).join(" ")}
        ${it.notes.size ? `<br><span class="small">說明：${esc([...it.notes].join("；"))}</span>` : ""}
        ${it.photos.size ? `<br><span class="row" style="gap:6px;margin-top:6px">${[...it.photos].map((u, k) => { const m = u.match(/\/d\/([\w-]+)/); return `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w160` : ""}" alt="照片 ${k + 1}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--line);background:var(--sunk)"></a>`; }).join("")}</span>` : ""}</span>
        <select data-pst="${esc(it.session + "|" + it.code)}" style="width:auto">${ISSUE_STATUS.map(st => `<option ${st === productStatus(it) ? "selected" : ""}>${st}</option>`).join("")}<option value="已撤回">誤報，撤回</option></select></div>`).join("")}</div>
      <div class="row"><button class="primary grow" data-copy="${esc(v)}">複製給廠商的通知</button><button data-notified="${esc(v)}">標為已通知</button></div>
    </section>`;
  }).join("") : `<div class="note">目前沒有${issueFilter === "all" ? "" : "符合條件的"}異常回報。</div>`}`;
}
function setStatus(list, st) {
  list.forEach(i => { i["處理狀態"] = st; enqueue("saveIssue", i["編號"], { issue: { id: i["編號"], status: st } }); });
  LS.set("issues", ISSUES);
}
function bindIssues() {
  document.getElementById("home").onclick = () => go({ name: "home" });
  document.getElementById("reloadIssues").onclick = loadIssues;
  document.querySelectorAll("[data-if]").forEach(b => b.onclick = () => { issueFilter = b.dataset.if; render(); });
  document.querySelectorAll("[data-pst]").forEach(sel => sel.onchange = () => {
    if (!takeWho("whoIssue")) { render(); return; }
    const [sid, code] = sel.dataset.pst.split("|");
    setStatus(currentIssues().filter(i => i["單號"] === sid && String(i["產品編號"]) === code), sel.value);
    toast(sel.value === WITHDRAWN ? "已撤回，這個品項的回報不會再出現在清單、彙總和之後產生的驗收單" : "已更新狀態"); render();
  });
  document.querySelectorAll("[data-notified]").forEach(b => b.onclick = () => {
    if (!takeWho("whoIssue")) return;
    const v = b.dataset.notified;
    setStatus(currentIssues().filter(i => (i["廠商"] || "未指定廠商") === v && i["處理狀態"] === "待處理"), "已通知廠商");
    toast("已標為已通知廠商"); render();
  });
  document.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => {
    const v = b.dataset.copy, items = Object.values(issueGroups()[v] || {});
    const lines = [`${v} 您好：`, "", "六福棲蘭明池驗收時發現以下狀況，麻煩協助確認與處理："];
    items.forEach((it, n) => {
      const p = byCode.get(it.code);
      lines.push(`${n + 1}. ${it.name}${p && p.bc ? `（條碼 ${p.bc}）` : ""}：${it.items.map(kindText).join("、")}${it.notes.size ? `。說明：${[...it.notes].join("；")}` : ""}`);
      if (it.photos.size) lines.push(`   照片：${[...it.photos].join(" ")}`);
    });
    lines.push("", `驗收日期：${day(items.reduce((a, it) => it.time > a ? it.time : a, ""))}`, "再麻煩回覆處理方式（補寄、換貨或退回），謝謝。", "六福集團 商品開發處");
    navigator.clipboard.writeText(lines.join("\n")).then(() => toast("已複製，可以貼到 Email 或 LINE"), () => toast("這個瀏覽器不允許複製"));
  });
}

boot();
})();
