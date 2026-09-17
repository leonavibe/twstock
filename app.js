/* TW 盤手 v1.0 — GitHub Pages 靜態版（無後端） */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const main = $("#main");

const setHTML = (sel, html, gen) => {
  if (gen !== undefined && gen !== show.generation) return false;
  const el = $(sel);
  if (el) el.innerHTML = html;
  return !!el;
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escUrl = u => /^https?:\/\//i.test(u || "") ? esc(u) : "#";
const reportArtifactUrl = () => "";

/* ===== CORS Proxy 設定 ===== */
const WORKER_URL = localStorage.getItem("twpan-worker") || "https://twstock-proxy.miku4ocean.workers.dev";
const PROXY = url => WORKER_URL ? `${WORKER_URL}?url=${encodeURIComponent(url)}` : url;
const TWSE_MIS = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const TAIFEX_MIS = "https://mis.taifex.com.tw/futures/api/getQuoteList";
const FINMIND_API = "https://api.finmindtrade.com/api/v4/data";
const TWSE_WEB = "https://www.twse.com.tw";

/* ===== localStorage 資料層 ===== */
const LS = {
  _g(k, d) { try { return JSON.parse(localStorage.getItem(`twpan-${k}`)) ?? d; } catch { return d; } },
  _s(k, v) { try { localStorage.setItem(`twpan-${k}`, JSON.stringify(v)); } catch {} },
  watchlists() {
    let w = this._g("watchlists", null);
    if (!w || !Array.isArray(w) || !w.length) { w = [{ id: "default", name: "我的自選", symbols: [] }]; this._s("watchlists", w); }
    if (!w.find(l => l.id === "default")) { w.unshift({ id: "default", name: "我的自選", symbols: [] }); this._s("watchlists", w); }
    return w;
  },
  saveWL(w) { this._s("watchlists", w); },
  portfolio() { return this._g("portfolio", { rows: [] }); },
  savePF(p) { this._s("portfolio", p); },
  alerts() { return this._g("alerts", []); },
  saveAlerts(a) { this._s("alerts", a); },
  notifications() { return this._g("notifications", []); },
  saveNotifs(n) { this._s("notifications", n); },
  reports() { return this._g("reports", []); },
  saveReports(r) { this._s("reports", r); },
  settings() { return this._g("settings", { active_provider: "groq", auto_fallback: true, usd_twd: 32, finmind_token: "", providers: { groq: { api_key: "", model: "llama-3.3-70b-versatile", in_price: 0.59, out_price: 0.79, monthly_budget_twd: 0 } } }); },
  saveSettings(s) { this._s("settings", s); },
  screenerSaved() { return this._g("screener-saved", []); },
  saveScreener(s) { this._s("screener-saved", s); },
  events(sid) { return this._g(`events-${sid}`, []); },
  saveEvents(sid, e) { this._s(`events-${sid}`, e); },
};

/* ===== FinMind 快取（sessionStorage，開分頁自動清） ===== */
const _fmCache = {};
async function finmind(dataset, params = {}) {
  const qs = new URLSearchParams({ dataset, ...params }).toString();
  const key = `fm:${qs}`;
  if (_fmCache[key]) return _fmCache[key];
  const cached = sessionStorage.getItem(key);
  if (cached) { try { const d = JSON.parse(cached); _fmCache[key] = d; return d; } catch {} }
  const r = await fetch(PROXY(`${FINMIND_API}?${qs}`));
  if (!r.ok) throw new Error("FinMind API 回應錯誤");
  const j = await r.json();
  const data = j.data || [];
  _fmCache[key] = data;
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
  return data;
}

let _stockInfoCache = null;
async function stockInfo() {
  if (_stockInfoCache) return _stockInfoCache;
  const cached = sessionStorage.getItem("twpan-stockinfo");
  if (cached) { try { _stockInfoCache = JSON.parse(cached); return _stockInfoCache; } catch {} }
  const data = await finmind("TaiwanStockInfo");
  const info = {};
  for (const r of data) info[r.stock_id] = r;
  _stockInfoCache = info;
  try { sessionStorage.setItem("twpan-stockinfo", JSON.stringify(info)); } catch {}
  return info;
}

/* ===== MIS 即時行情 ===== */
async function misRealtime(sids) {
  const exCh = sids.flatMap(s => [`tse_${s.toLowerCase()}.tw`, `otc_${s.toLowerCase()}.tw`]).join("|");
  const r = await fetch(PROXY(`${TWSE_MIS}?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`));
  const j = await r.json();
  const arr = (j.msgArray || []).filter(it => it && typeof it === "object" && it.c);
  const out = {};
  for (const it of arr) {
    const code = (it.c || "").toUpperCase();
    if (!code) continue;
    const z = it.z, y = it.y;
    if ((z === undefined || z === "-" || z === "") && (y === undefined || y === "-" || y === "")) continue;
    out[code] = {
      name: it.n, price: it.z, prev_close: it.y, open: it.o, high: it.h, low: it.l,
      limit_up: it.u, limit_down: it.w, time: it.t, volume: it.v,
    };
  }
  return out;
}

/* ===== 台指期 ===== */
async function taifexFutures() {
  try {
    const r = await fetch(PROXY(TAIFEX_MIS), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json();
    const rows = j.RtData?.QuoteList || [];
    let best = null;
    for (const row of rows) {
      const sid = row.SymbolID || "";
      if (!sid.startsWith("TXF") || !sid.endsWith("-F") || sid === "TXF-P" || sid === "TXF-S") continue;
      const vol = parseInt(row.CTotalVolume || 0) || 0;
      if (!best || vol > best[1]) best = [row, vol];
    }
    if (!best) return null;
    const row = best[0], t = row.CTime || "";
    return {
      name: row.DispCName || "台指期", price: row.CLastPrice, prev_close: row.CRefPrice,
      change: row.CDiff, change_pct: row.CDiffRate,
      time: t.length >= 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : t,
    };
  } catch { return null; }
}

/* ===== 加權歷史 ===== */
async function taiexHistory(months = 12) {
  const rows = [];
  const today = new Date();
  for (let m = 0; m < months; m++) {
    const d = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}01`;
    try {
      const r = await fetch(PROXY(`${TWSE_WEB}/rwd/zh/afterTrading/FMTQIK?date=${ym}&response=json`));
      const j = await r.json();
      if (j.stat !== "OK" || !j.data) continue;
      for (const row of j.data) {
        const [yy, mm, dd] = row[0].split("/");
        const iso = `${parseInt(yy) + 1911}-${mm}-${dd}`;
        try { rows.push({ date: iso, close: parseFloat(row[4].replace(/,/g, "")), change: parseFloat(row[5].replace(/,/g, "")), volume: parseInt(parseFloat(row[1].replace(/,/g, ""))) }); } catch {}
      }
    } catch {}
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set();
  return rows.filter(r => { if (seen.has(r.date)) return false; seen.add(r.date); return true; });
}

/* ===== Google News ===== */
async function fetchNews(query, limit = 20) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + " when:7d")}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const r = await fetch(PROXY(url));
  const text = await r.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/xml");
  const items = [], seen = new Set();
  for (const it of doc.querySelectorAll("item")) {
    const title = it.querySelector("title")?.textContent?.trim() || "";
    const key = title.slice(0, 20);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title, link: it.querySelector("link")?.textContent || "", pubDate: it.querySelector("pubDate")?.textContent || "", source: it.querySelector("source")?.textContent || "" });
    if (items.length >= limit) break;
  }
  return items;
}

/* ===== TWSE 全市場日行情（免費、免金鑰） ===== */
let _twseAllCache = null, _twseAllTime = 0;
async function twseAllStocks() {
  if (_twseAllCache && Date.now() - _twseAllTime < 300000) return _twseAllCache;
  const url = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
  const r = await fetch(PROXY(url));
  if (!r.ok) throw new Error("TWSE API error");
  const raw = await r.json();
  const rows = [];
  for (const d of raw) {
    const close = parseFloat(d.ClosingPrice);
    const change = parseFloat(d.Change);
    const volume = parseInt(d.TradeVolume) || 0;
    if (!close || isNaN(close)) continue;
    const prev = close - change;
    rows.push({
      id: d.Code, name: d.Name || "",
      close, change, pct: prev ? (change / prev) * 100 : 0,
      volume, market: "上市", time: "",
    });
  }
  _twseAllCache = rows;
  _twseAllTime = Date.now();
  return rows;
}

/* ===== 排行榜 ===== */
async function rankingsLimits() {
  try {
    const rows = await twseAllStocks();
    const up = rows.filter(r => r.pct >= 9.4).sort((a, b) => b.pct - a.pct);
    const down = rows.filter(r => r.pct <= -9.4).sort((a, b) => a.pct - b.pct);
    return { limit_up: up.slice(0, 50), limit_down: down.slice(0, 50) };
  } catch { return { limit_up: [], limit_down: [] }; }
}

async function rankingsMovers(kind = "gainers", limit = 30) {
  try {
    let rows = await twseAllStocks();
    rows = rows.filter(r => !r.id.startsWith("00"));
    if (kind === "gainers") rows.sort((a, b) => b.pct - a.pct);
    else if (kind === "losers") rows.sort((a, b) => a.pct - b.pct);
    else rows.sort((a, b) => b.volume - a.volume);
    return rows.slice(0, limit);
  } catch { return []; }
}

/* ===== 三大法人 ===== */
const INST_LABELS = {
  "Foreign_Investor": "外資", "Dealer_self": "自營商(自行)", "Dealer_Hedging": "自營商(避險)",
  "Investment_Trust": "投信", "Foreign_Dealer_Self": "外資(自營)", "total": "合計",
};
async function institutional() {
  const start = localDateISO(new Date(Date.now() - 7 * 86400000));
  try {
    const data = await finmind("TaiwanStockTotalInstitutionalInvestors", { start_date: start });
    if (!data.length) return { items: [], total_buy: 0, total_sell: 0, inst_net: 0, date: "" };
    const latestDate = data.at(-1)?.date || "";
    const today = data.filter(d => d.date === latestDate);
    const items = today.map(d => ({ label: INST_LABELS[d.name] || d.name, buy: d.buy || 0, sell: d.sell || 0, net: (d.buy || 0) - (d.sell || 0) }));
    const totalBuy = items.reduce((s, i) => s + i.buy, 0);
    const totalSell = items.reduce((s, i) => s + i.sell, 0);
    return { items, total_buy: totalBuy, total_sell: totalSell, inst_net: totalBuy - totalSell, date: latestDate };
  } catch { return { items: [], total_buy: 0, total_sell: 0, inst_net: 0, date: "" }; }
}

/* ===== 股東會 ===== */
async function shareholderMeetings() {
  const year = new Date().getFullYear() - 1911;
  try {
    const r = await fetch(PROXY(`${TWSE_WEB}/rwd/zh/company/shareholdMeeting?year=${year}&response=json`));
    const j = await r.json();
    if (!j.data) return [];
    return j.data.map(d => ({
      stock_id: d[1], name: d[2], date: `${parseInt(d[3]?.split("/")[0] || 0) + 1911}-${(d[3] || "").split("/").slice(1).join("-")}`,
      label: d[4] || "股東會", time: d[5] || "", location: d[6] || "", market: "上市",
    }));
  } catch { return []; }
}

/* ===== 庫存計算 ===== */
function computePortfolio(pf, quotes) {
  let totalCost = 0, totalValue = 0;
  for (const r of pf.rows) {
    r.price = parseFloat(quotes[r.symbol]?.price) || r.cost || 0;
    r.name = quotes[r.symbol]?.name || r.name || "";
    r.pnl = (r.price - r.cost) * r.shares;
    r.pnl_pct = r.cost ? ((r.price - r.cost) / r.cost) * 100 : 0;
    totalCost += r.cost * r.shares;
    totalValue += r.price * r.shares;
  }
  pf.total_cost = totalCost;
  pf.total_value = totalValue;
  pf.total_pnl = totalValue - totalCost;
  pf.total_pnl_pct = totalCost ? ((totalValue - totalCost) / totalCost) * 100 : 0;
  return pf;
}

/* ===== API 路由層 ===== */
/* 保持與原版相同的 api(path) 介面，路由到 localStorage 或 CORS proxy */
let appToken = "", tokenPrompt = null, tokenModal = null;
function ensureTokenModal() { return null; }
function askToken() { return Promise.resolve(""); }

let actionDialogSeq = 0;
function openActionDialog({ title, detail = "", input = false, value = "", confirmLabel = "確認", choices = [] }) {
  return new Promise(resolve => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = `action-dialog-${++actionDialogSeq}`;
    const host = document.createElement("div");
    host.className = "action-modal";
    const hasChoices = Array.isArray(choices) && choices.length > 0;
    const choiceMarkup = hasChoices
      ? choices.map((choice, i) => `<button type="button" class="btn action-choice${choice.danger ? " danger" : ""}" data-choice="${i}">${esc(choice.label)}</button>`).join("")
      : `<button type="button" class="btn gold action-confirm" data-action="confirm">${esc(confirmLabel)}</button>`;
    host.innerHTML = `<section class="action-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-detail">
      <div class="token-dialog-head"><h2 id="${id}-title">${esc(title || "確認操作")}</h2><button type="button" class="iconbtn action-cancel" aria-label="取消操作">×</button></div>
      <p id="${id}-detail" class="muted small">${esc(detail)}</p>
      ${input ? `<label class="action-field">名稱<input type="text" class="action-input" maxlength="30" value="${esc(value)}" /></label>` : ""}
      <div class="row token-actions"><button type="button" class="btn action-cancel">取消</button>${choiceMarkup}</div>
    </section>`;
    document.body.appendChild(host);
    document.body.classList.add("modal-open");
    const inputEl = $(".action-input", host);
    const finish = result => {
      host.removeEventListener("keydown", onKeydown);
      host.remove();
      document.body.classList.remove("modal-open");
      if (restoreFocus?.isConnected) requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
      resolve(result);
    };
    const onKeydown = e => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); return; }
      if (e.key === "Enter" && inputEl && e.target === inputEl) { e.preventDefault(); finish(inputEl.value.trim()); return; }
      if (e.key !== "Tab") return;
      const focusable = $$('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])', host)
        .filter(el => !el.disabled && !el.hidden && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    host.addEventListener("keydown", onKeydown);
    $$(".action-cancel", host).forEach(button => { button.onclick = () => finish(null); });
    const confirmButton = $(".action-confirm", host);
    if (confirmButton) confirmButton.onclick = () => finish(inputEl ? inputEl.value.trim() : true);
    $$("[data-choice]", host).forEach(button => {
      button.onclick = () => finish(choices[Number(button.dataset.choice)]?.value ?? null);
    });
    requestAnimationFrame(() => (inputEl || $(".action-choice, .action-confirm", host))?.focus());
  });
}

let multiSelectSeq = 0;
function openMultiSelectDialog({ title, detail = "", items = [] }) {
  return new Promise(resolve => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = `multi-sel-${++multiSelectSeq}`;
    const host = document.createElement("div");
    host.className = "action-modal";
    host.innerHTML = `<section class="action-dialog" role="dialog" aria-modal="true" style="max-height:80vh;overflow:auto">
      <div class="token-dialog-head"><h2>${esc(title)}</h2><button type="button" class="iconbtn action-cancel" aria-label="取消">×</button></div>
      <p class="muted small">${esc(detail)}</p>
      <div style="max-height:50vh;overflow-y:auto;margin:8px 0">
        ${items.map((it, i) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--panel2);cursor:pointer">
          <input type="checkbox" value="${esc(it.value)}" data-idx="${i}" />
          <span>${esc(it.label)}</span>
        </label>`).join("")}
      </div>
      <div class="row" style="justify-content:space-between;margin-top:8px">
        <label style="font-size:12px"><input type="checkbox" id="${id}-all" /> 全選</label>
        <div class="row"><button type="button" class="btn action-cancel">取消</button>
        <button type="button" class="btn gold" id="${id}-ok">加入所選</button></div>
      </div>
    </section>`;
    document.body.appendChild(host);
    document.body.classList.add("modal-open");
    const finish = result => {
      host.remove();
      document.body.classList.remove("modal-open");
      if (restoreFocus?.isConnected) requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
      resolve(result);
    };
    host.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); finish(null); } });
    $$(".action-cancel", host).forEach(b => { b.onclick = () => finish(null); });
    $(`#${id}-all`).onchange = e => { $$("input[type=checkbox][data-idx]", host).forEach(cb => { cb.checked = e.target.checked; }); };
    $(`#${id}-ok`).onclick = () => {
      const selected = $$("input[type=checkbox][data-idx]:checked", host).map(cb => cb.value);
      finish(selected.length ? selected : null);
    };
  });
}

async function request(path, opt = {}) {
  const r = await fetch(path, opt);
  return r;
}

/* 主 API 路由器：攔截 /api/ 路徑，路由到 localStorage 或 CORS proxy */
const api = async (path, opt) => {
  const method = opt?.method?.toUpperCase() || "GET";
  const body = opt?.body ? JSON.parse(opt.body) : null;

  // ===== 自選清單 =====
  if (path === "/api/watchlists" && method === "GET") return LS.watchlists();
  if (path === "/api/watchlists" && method === "POST") {
    const wls = LS.watchlists();
    const wl = { id: Date.now().toString(36), name: (body.name || "新清單").slice(0, 30), symbols: (body.symbols || []).map(s => s.toUpperCase()).slice(0, 200) };
    wls.push(wl); LS.saveWL(wls);
    return wl;
  }
  if (path === "/api/watchlists/export" && method === "GET") return LS.watchlists();
  if (path === "/api/watchlists/import" && method === "POST") {
    const wls = LS.watchlists();
    for (const imported of (body.lists || [])) {
      const existing = wls.find(w => w.id === imported.id);
      if (existing) {
        const merged = [...new Set([...existing.symbols, ...(imported.symbols || [])])];
        existing.symbols = merged.slice(0, 200);
      } else {
        wls.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: (imported.name || "匯入").slice(0, 30), symbols: (imported.symbols || []).slice(0, 200) });
      }
    }
    LS.saveWL(wls); return { ok: true };
  }
  const wlMatch = path.match(/^\/api\/watchlists\/([^/?]+)$/);
  if (wlMatch) {
    const wid = wlMatch[1];
    if (method === "PUT") {
      const wls = LS.watchlists();
      const wl = wls.find(w => w.id === wid);
      if (wl) {
        if (body.name !== undefined && wid !== "default") wl.name = body.name.slice(0, 30);
        if (body.symbols !== undefined) wl.symbols = body.symbols.map(s => s.toUpperCase()).slice(0, 200);
        LS.saveWL(wls);
      }
      return { ok: true };
    }
    if (method === "DELETE") {
      if (wid === "default") throw new Error("不可刪除主清單");
      const wls = LS.watchlists().filter(w => w.id !== wid);
      LS.saveWL(wls); return { ok: true };
    }
  }

  // ===== 庫存 =====
  if (path === "/api/portfolio" && method === "GET") {
    const pf = LS.portfolio();
    const syms = [...new Set(pf.rows.map(r => r.symbol))];
    if (syms.length) { try { const q = await misRealtime(syms); return computePortfolio(pf, q); } catch {} }
    return { ...pf, total_cost: 0, total_value: 0, total_pnl: 0, total_pnl_pct: 0 };
  }
  if (path === "/api/portfolio" && method === "POST") {
    const pf = LS.portfolio();
    pf.rows.push({ id: Date.now().toString(36), symbol: body.symbol.toUpperCase(), shares: body.shares, cost: body.cost, name: "" });
    LS.savePF(pf); return pf;
  }
  const pfMatch = path.match(/^\/api\/portfolio\/(.+)$/);
  if (pfMatch && method === "DELETE") {
    const pf = LS.portfolio();
    pf.rows = pf.rows.filter(r => r.id !== pfMatch[1]);
    LS.savePF(pf); return { ok: true };
  }

  // ===== 到價提醒 =====
  if (path === "/api/alerts" && method === "GET") return LS.alerts();
  if (path === "/api/alerts" && method === "POST") {
    const alerts = LS.alerts();
    alerts.push({ id: Date.now().toString(36), ...body, enabled: true, triggered_at: null });
    LS.saveAlerts(alerts); return alerts.at(-1);
  }
  const alMatch = path.match(/^\/api\/alerts\/(.+)$/);
  if (alMatch && method === "PUT") {
    const alerts = LS.alerts();
    const a = alerts.find(x => x.id === alMatch[1]);
    if (a) Object.assign(a, body);
    LS.saveAlerts(alerts); return { ok: true };
  }
  if (alMatch && method === "DELETE") {
    LS.saveAlerts(LS.alerts().filter(x => x.id !== alMatch[1])); return { ok: true };
  }

  // ===== 通知 =====
  if (path.startsWith("/api/notifications")) {
    if (method === "DELETE") { LS.saveNotifs([]); return { ok: true }; }
    if (method === "POST") { return { ok: true }; }
    const items = LS.notifications();
    return { items: items.slice(0, 60), unread: items.filter(n => !n.read).length };
  }

  // ===== 盤後總結 =====
  if (path === "/api/reports" && method === "GET") return LS.reports();
  if (path === "/api/reports/run" && method === "POST") {
    return { date: localDateISO(), time: new Date().toLocaleTimeString("zh-TW"), provider: "local", model: "rules-v1", text: "靜態版暫不支援自動盤後總結。請在設定頁填入 Groq API Key 後使用 AI 持股健檢功能。", artifacts: [] };
  }

  // ===== AI =====
  if (path === "/api/ai/ask" && method === "POST") {
    const settings = LS.settings();
    const provider = settings.providers?.[settings.active_provider || "groq"];
    if (!provider?.api_key) throw new Error("請先在設定頁填入 AI API Key");
    const apiUrl = settings.active_provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : `https://api.openai.com/v1/chat/completions`;
    const r = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${provider.api_key}` },
      body: JSON.stringify({ model: provider.model || "llama-3.3-70b-versatile", messages: [{ role: "user", content: body.prompt }], max_tokens: 1024 }),
    });
    if (!r.ok) throw new Error("AI 回應錯誤：" + r.status);
    const j = await r.json();
    return { text: j.choices?.[0]?.message?.content || "無回應", provider: settings.active_provider, model: provider.model };
  }
  if (path === "/api/ai/usage" && method === "GET") {
    const s = LS.settings();
    const providers = {};
    for (const [k, v] of Object.entries(s.providers || {})) {
      providers[k] = { in: 0, out: 0, cost_twd: 0, budget_twd: v.monthly_budget_twd || 0, has_key: !!v.api_key, over_budget: false };
    }
    return { month: localDateISO().slice(0, 7), total_input: 0, total_output: 0, total_cost_ntd: 0, providers, calls: [] };
  }

  // ===== 設定 =====
  if (path === "/api/settings/llm" && method === "GET") return LS.settings();
  if (path === "/api/settings/llm" && method === "PUT") {
    const s = LS.settings();
    if (body.active_provider !== undefined) s.active_provider = body.active_provider;
    if (body.auto_fallback !== undefined) s.auto_fallback = body.auto_fallback;
    if (body.providers) {
      for (const [k, v] of Object.entries(body.providers)) {
        s.providers = s.providers || {};
        s.providers[k] = { ...(s.providers[k] || {}), ...v };
      }
    }
    LS.saveSettings(s); return { ok: true };
  }
  if (path === "/api/settings/scheduler") return { enabled: false, poll_seconds: 10, full_scan: false, status: { tracked: 0, last_tick: null, errors: [] }, market_open: false, etf_autofetch: [], etf_fetch_hour: 18, daily_report: false, report_hour: 15 };

  // ===== 選股器 =====
  if (path === "/api/screener/saved" && method === "GET") return LS.screenerSaved();
  if (path === "/api/screener/saved" && method === "POST") {
    const saved = LS.screenerSaved();
    saved.push({ id: Date.now().toString(36), ...body });
    LS.saveScreener(saved); return { ok: true };
  }
  if (path === "/api/screener/run" && method === "POST") return { rows: [], scanned: 0, notes: ["靜態版選股器功能有限"] };
  const scrDelMatch = path.match(/^\/api\/screener\/saved\/(.+)$/);
  if (scrDelMatch && method === "DELETE") {
    LS.saveScreener(LS.screenerSaved().filter(s => s.id !== scrDelMatch[1])); return { ok: true };
  }

  // ===== 市場數據（CORS proxy）=====
  if (path === "/api/market/index") {
    const out = {};
    try {
      const q = await misRealtime(["t00", "o00"]);
      if (q.T00) out.taiex = { name: q.T00.name, price: q.T00.price, prev_close: q.T00.prev_close, time: q.T00.time };
      if (q.O00) out.otc = { name: q.O00.name, price: q.O00.price, prev_close: q.O00.prev_close, time: q.O00.time };
    } catch {}
    const fx = await taifexFutures();
    if (fx) out.futures = fx;
    return out;
  }

  if (path.startsWith("/api/market/history")) {
    const m = path.match(/months=(\d+)/);
    return taiexHistory(m ? parseInt(m[1]) : 12);
  }

  if (path.startsWith("/api/market/news")) return { items: await fetchNews("台股 股市 產業", 20) };

  if (path === "/api/market/institutional") return institutional();

  // ===== 個股 =====
  const stockOvMatch = path.match(/^\/api\/stock\/([^/]+)\/overview$/);
  if (stockOvMatch) {
    const sid = stockOvMatch[1].toUpperCase();
    const [rt, info] = await Promise.all([misRealtime([sid]).catch(() => ({})), stockInfo().catch(() => ({}))]);
    return { id: sid, info: info[sid] || {}, realtime: rt[sid] || {} };
  }

  const stockPxMatch = path.match(/^\/api\/stock\/([^/]+)\/prices/);
  if (stockPxMatch) {
    const sid = stockPxMatch[1].toUpperCase();
    const start = localDateISO(new Date(Date.now() - 400 * 86400000));
    const data = await finmind("TaiwanStockPrice", { data_id: sid, start_date: start });
    return data.map(d => ({ date: d.date, open: d.open, max: d.max, min: d.min, close: d.close, spread: d.spread, Trading_Volume: d.Trading_Volume }));
  }

  const stockIntraMatch = path.match(/^\/api\/stock\/([^/]+)\/intraday$/);
  if (stockIntraMatch) return { date: localDateISO(), points: [] };

  const stockChipsMatch = path.match(/^\/api\/stock\/([^/]+)\/chips/);
  if (stockChipsMatch) {
    const sid = stockChipsMatch[1].toUpperCase();
    const start = localDateISO(new Date(Date.now() - 30 * 86400000));
    try {
      const data = await finmind("TaiwanStockInstitutionalInvestorsBuySell", { data_id: sid, start_date: start });
      const byDate = {};
      for (const d of data) {
        byDate[d.date] = byDate[d.date] || { date: d.date, foreign: 0, trust: 0, dealer: 0 };
        const net = (d.buy || 0) - (d.sell || 0);
        if (d.name?.includes("外")) byDate[d.date].foreign += net;
        else if (d.name?.includes("投信")) byDate[d.date].trust += net;
        else if (d.name?.includes("自營")) byDate[d.date].dealer += net;
      }
      const rows = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-10);
      return { rows, retail: rows.map(r => ({ date: r.date, net: -(r.foreign + r.trust + r.dealer) })) };
    } catch { return { rows: [], retail: [] }; }
  }

  const stockEvMatch = path.match(/^\/api\/stock\/([^/]+)\/events$/);
  if (stockEvMatch) {
    const sid = stockEvMatch[1].toUpperCase();
    if (method === "GET") return LS.events(sid);
    if (method === "POST") {
      const evs = LS.events(sid);
      evs.push({ id: Date.now().toString(36), ...body });
      LS.saveEvents(sid, evs); return evs;
    }
  }
  const evDelMatch = path.match(/^\/api\/stock\/([^/]+)\/events\/(.+)$/);
  if (evDelMatch && method === "DELETE") {
    const sid = evDelMatch[1].toUpperCase();
    LS.saveEvents(sid, LS.events(sid).filter(e => e.id !== evDelMatch[2]));
    return { ok: true };
  }

  const stockFillMatch = path.match(/^\/api\/stock\/([^/]+)\/fill$/);
  if (stockFillMatch) return { summary: { count: 0, fill_rate: 0, avg_days: null, fastest: null, slowest: null }, events: [] };

  const stockNewsMatch = path.match(/^\/api\/stock\/([^/]+)\/news$/);
  if (stockNewsMatch) {
    const sid = stockNewsMatch[1].toUpperCase();
    const info = await stockInfo().catch(() => ({}));
    const name = info[sid]?.stock_name || sid;
    return { items: await fetchNews(`${sid} ${name}`, 10) };
  }

  const stockValMatch = path.match(/^\/api\/stock\/([^/]+)\/valuation$/);
  if (stockValMatch) {
    const sid = stockValMatch[1].toUpperCase();
    const start = localDateISO(new Date(Date.now() - 14 * 86400000));
    try {
      const data = await finmind("TaiwanStockPER", { data_id: sid, start_date: start });
      return data.at(-1) || {};
    } catch { return {}; }
  }

  const stockHoldersMatch = path.match(/^\/api\/stock\/([^/]+)\/holders$/);
  if (stockHoldersMatch) return { latest: null, trend: [] };

  // ===== ETF =====
  const etfHoldingsMatch = path.match(/^\/api\/etf\/([^/]+)\/holdings$/);
  if (etfHoldingsMatch) return { latest: null };

  const etfMetricsMatch = path.match(/^\/api\/etf\/([^/]+)\/metrics$/);
  if (etfMetricsMatch) return {};

  // ===== 報價 =====
  if (path.startsWith("/api/quotes")) {
    const m = path.match(/symbols=([^&]+)/);
    if (!m) return {};
    const sids = m[1].split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const rt = await misRealtime(sids);
    const info = await stockInfo().catch(() => ({}));
    for (const sid of sids) {
      if (!rt[sid]) {
        const si = info[sid];
        if (si) rt[sid] = { name: si.stock_name || "", price: null, prev_close: null };
      } else if (!rt[sid].name) {
        const si = info[sid];
        if (si) rt[sid].name = si.stock_name || "";
      }
    }
    return rt;
  }

  // ===== 搜尋 =====
  if (path.startsWith("/api/search")) {
    const m = path.match(/q=([^&]+)/);
    if (!m) return [];
    const q = decodeURIComponent(m[1]).toLowerCase();
    const info = await stockInfo();
    const results = [];
    for (const [id, v] of Object.entries(info)) {
      if (id.toLowerCase().includes(q) || (v.stock_name || "").toLowerCase().includes(q)) {
        results.push({ id, name: v.stock_name || "", industry: v.industry_category || "" });
        if (results.length >= 12) break;
      }
    }
    return results;
  }

  // ===== 迷你走勢 =====
  if (path.startsWith("/api/sparklines")) {
    const sm = path.match(/symbols=([^&]+)/);
    const km = path.match(/kind=([^&]+)/);
    const kind = km?.[1] || "30d";
    const sids = sm?.[1]?.split(",") || [];
    if (kind === "day") {
      const out = {};
      for (const sid of sids) out[sid] = { closes: [], base: null };
      return out;
    }
    const start = localDateISO(new Date(Date.now() - 35 * 86400000));
    const out = {};
    for (let i = 0; i < sids.length; i += 5) {
      const batch = sids.slice(i, i + 5);
      await Promise.all(batch.map(async sid => {
        try {
          const data = await finmind("TaiwanStockPrice", { data_id: sid, start_date: start });
          out[sid] = { closes: data.slice(-30).map(d => d.close), base: null };
        } catch { out[sid] = { closes: [], base: null }; }
      }));
    }
    return out;
  }

  // ===== 比較 =====
  if (path.startsWith("/api/compare")) {
    const sm = path.match(/symbols=([^&]+)/);
    const dm = path.match(/days=(\d+)/);
    const sids = sm?.[1]?.split(",") || [];
    const days = parseInt(dm?.[1] || "93");
    const start = localDateISO(new Date(Date.now() - (days + 5) * 86400000));
    const results = [];
    for (const sid of sids) {
      try {
        const data = await finmind("TaiwanStockPrice", { data_id: sid, start_date: start });
        const series = data.slice(-days);
        if (!series.length) continue;
        const base = series[0].close;
        const info = await stockInfo().catch(() => ({}));
        results.push({ id: sid, name: info[sid]?.stock_name || "", series: series.map(d => ({ date: d.date, pct: base ? ((d.close - base) / base) * 100 : 0 })) });
      } catch {}
    }
    return results;
  }

  // ===== 排行榜 =====
  if (path.startsWith("/api/rankings/limits")) return rankingsLimits();
  if (path.startsWith("/api/rankings/movers")) {
    const km = path.match(/kind=(\w+)/);
    const lm = path.match(/limit=(\d+)/);
    return rankingsMovers(km?.[1] || "gainers", parseInt(lm?.[1] || "30"));
  }
  if (path.startsWith("/api/rankings/trust")) {
    return { rows: [], note: "投信連買資料需要 FinMind 付費方案" };
  }
  if (path.startsWith("/api/rankings/etf")) {
    const km = path.match(/kind=(\w+)/);
    const lm = path.match(/limit=(\d+)/);
    const kind = km?.[1] || "volume";
    const limit = parseInt(lm?.[1] || "15");
    try {
      let arr = (await twseAllStocks()).filter(r => r.id.startsWith("00") && r.id.length >= 4);
      if (kind === "gainers") arr.sort((a, b) => b.pct - a.pct);
      else if (kind === "losers") arr.sort((a, b) => a.pct - b.pct);
      else arr.sort((a, b) => b.volume - a.volume);
      return arr.slice(0, limit);
    } catch { return []; }
  }

  // ===== 股東會 =====
  if (path.startsWith("/api/shareholder-meetings")) {
    const items = await shareholderMeetings();
    return { items };
  }

  // ===== 總覽 =====
  if (path.startsWith("/api/overview/today")) {
    const wls = LS.watchlists();
    const allSyms = [...new Set(wls.flatMap(w => w.symbols))];
    let up = 0, down = 0;
    try {
      if (allSyms.length) {
        const q = await misRealtime(allSyms.slice(0, 40));
        for (const [, r] of Object.entries(q)) {
          const px = parseFloat(r.price), pv = parseFloat(r.prev_close);
          if (px && pv) { if (px > pv) up++; else if (px < pv) down++; }
        }
      }
    } catch {}
    return { market_open: true, quote_status: "ok", up, down, watch_total: allSyms.length, events: [], observed_at: new Date().toISOString(), quote_latest_time: "", data_note: "靜態版（GitHub Pages）" };
  }

  throw new Error(`未知的 API 路徑：${path}`);
};

const post = (p, b) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const put = (p, b) => api(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const del = p => api(p, { method: "DELETE" });


const fmt = (n, d = 2) => (n === null || n === undefined || isNaN(n)) ? "—" : Number(n).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d });
const bestPx = r => F(r?.price) || F(r?.open) || F(r?.prev_close) || null;
const lots = n => fmt(n / 1000, 0);
const cls = n => n > 0 ? "up" : n < 0 ? "down" : "flat";
const sign = (n, d = 2) => (n > 0 ? "+" : "") + fmt(n, d);
const skel = (n = 3) => Array(n).fill('<div class="skel"></div>').join("");
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const F = x => { const v = parseFloat(x); return isNaN(v) ? null : v; };
/* 「今天／本月」一律用瀏覽器本地日期：toISOString() 是 UTC，台北 00:00–08:00 會差一天，
   股東會日曆的「今天」標記會標錯格、月初凌晨連預設月份都會變成上個月。 */
const pad2 = n => String(n).padStart(2, "0");
const localDateISO = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/* ---------- toast ---------- */
const toasts = document.createElement("div");
toasts.className = "toasts";
toasts.setAttribute("aria-live", "polite");
toasts.setAttribute("aria-relevant", "additions");
document.body.appendChild(toasts);
function toast(msg, isErr = false, ms = 5500) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.setAttribute("role", isErr ? "alert" : "status");
  t.textContent = msg; toasts.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------- 主題 ---------- */
function applyTheme(t) {
  const theme = t === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("twpan-theme", theme); } catch {}
}
let savedTheme = "dark";
try { savedTheme = localStorage.getItem("twpan-theme") || "light"; } catch {}
applyTheme(savedTheme);
$("#theme").onclick = () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  document.dispatchEvent(new CustomEvent("twpan:visualchange"));
};

/* ---------- 路由 ---------- */
const pages = {};
let lastStock = "2330";

function _routeHash(page, arg) {
  if (page === "stock" && arg) return `#/stock/${arg}`;
  if (page === "home") return "#/";
  return `#/${page}`;
}
function _parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  if (!h) return { page: "home" };
  const parts = h.split("/");
  const page = parts[0];
  const arg = parts.slice(1).join("/") || undefined;
  return { page: pages[page] ? page : "home", arg };
}

function show(page, arg, _fromPop) {
  if (show.cleanup) { show.cleanup(); show.cleanup = null; }
  const gen = ++show.generation;
  show.page = page;
  show.arg = arg;
  main.dataset.page = page;
  $$("#nav button").forEach(b => {
    const on = b.dataset.page === page;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  if (!_fromPop) {
    const hash = _routeHash(page, arg);
    if (location.hash !== hash) history.pushState({ page, arg }, "", hash);
  }
  window.scrollTo(0, 0);
  main.innerHTML = `<div class="card">${skel(4)}</div>`;
  clearInterval(show.timer);
  Promise.resolve(pages[page](arg, gen)).catch(e => {
    if (gen === show.generation) main.innerHTML = `<div class='empty' role='alert'>載入失敗：${esc(e.message)}</div>`;
  });
}
show.generation = 0;
show.page = "";
const navAlive = gen => gen === show.generation;
$$("#nav button").forEach(b => b.onclick = () => show(b.dataset.page));
window.addEventListener("popstate", () => { const r = _parseHash(); show(r.page, r.arg, true); });

function bindClickable(el, onClick) {
  el.onclick = onClick;
  if (!/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
    el.tabIndex = 0;
    el.setAttribute("role", el.getAttribute("role") || "button");
    el.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); }
    };
  }
}

function drawXAxis(ctx, rows, X, W, H, pad, muted) {
  const days = rows.length;
  ctx.save(); ctx.fillStyle = muted; ctx.strokeStyle = muted; ctx.lineWidth = 1;
  if (days <= 10) {
    rows.forEach((r, i) => {
      const x = X(i);
      ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      const label = r.date.slice(5).replace("-", "/");
      ctx.fillText(label, Math.min(x - 15, W - pad.r - 35), H - 6);
    });
  } else if (days <= 45) {
    const step = 5;
    for (let i = 0; i < days; i += step) {
      const x = X(i);
      ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillText(rows[i].date.slice(5).replace("-", "/"), Math.min(x - 15, W - pad.r - 35), H - 6);
    }
  } else {
    let lastMonth = "";
    rows.forEach((r, i) => {
      const m = r.date.slice(0, 7);
      if (m !== lastMonth) {
        lastMonth = m;
        const x = X(i);
        ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillText(r.date.slice(5).replace("-", "/"), x - 15, H - 6);
      }
    });
  }
  ctx.restore();
}

const _t2m = t => { const p = (t || "").split(":"); return (parseInt(p[0]) - 9) * 60 + parseInt(p[1] || 0); };
const _TOTAL_MIN = 270;

function drawIntradayXAxis(ctx, W, H, pad, muted) {
  ctx.save(); ctx.fillStyle = muted; ctx.strokeStyle = muted; ctx.lineWidth = 1;
  const xAt = min => pad.l + (W - pad.l - pad.r) * (min / _TOTAL_MIN);
  for (let h = 9; h <= 13; h++) {
    const x = xAt((h - 9) * 60);
    ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillText(h < 10 ? `0${h}:00` : `${h}:00`, x - 14, H - 6);
    if (h < 13) {
      const xh = xAt((h - 9) * 60 + 30);
      ctx.globalAlpha = 0.4;
      ctx.setLineDash([1, 4]); ctx.beginPath(); ctx.moveTo(xh, pad.t); ctx.lineTo(xh, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }
  const x1330 = xAt(270);
  ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x1330, pad.t); ctx.lineTo(x1330, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillText("13:30", x1330 - 14, H - 6);
  ctx.restore();
}

function clearCanvas(canvas, tipEl, message) {
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.setAttribute("aria-label", message);
  }
  if (tipEl) tipEl.innerHTML = esc(message);
}

/* ---------- 搜尋 ---------- */
let searchTimer, searchSeq = 0;
$("#q").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  const v = e.target.value.trim();
  if (!v) { $("#q-list").innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    try {
      const hits = await api(`/api/search?q=${encodeURIComponent(v)}`);
      if (seq === searchSeq && $("#q").value.trim() === v)
        $("#q-list").innerHTML = hits.map(h => `<option value="${esc(h.id)}">${esc(h.name)}｜${esc(h.industry)}</option>`).join("");
    } catch {}
  }, 250);
});
async function goSearch() {
  let v = $("#q").value.trim();
  if (!v) return;
  if (!/^[0-9]{4,6}[A-Z]{0,2}$/i.test(v)) {
    try { const hits = await api(`/api/search?q=${encodeURIComponent(v)}`); if (hits[0]) v = hits[0].id; } catch {}
  }
  $("#q").blur(); show("stock", v.toUpperCase());
}
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") goSearch(); });
document.addEventListener("keydown", e => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("#q").focus(); }
});

/* ---------- 通知中心 ---------- */
let notifPanel = null;
async function refreshBell() {
  try {
    const r = await api("/api/notifications?unread_only=true");
    $("#bell-n").style.display = r.unread ? "block" : "none";
    $("#bell-n").textContent = r.unread > 99 ? "99+" : r.unread;
  } catch {}
}
$("#bell").onclick = async () => {
  if (notifPanel) { notifPanel.remove(); notifPanel = null; return; }
  let r;
  try { r = await api("/api/notifications"); }
  catch (e) { toast("通知載入失敗：" + e.message, true); return; }
  notifPanel = document.createElement("div");
  notifPanel.className = "notif-panel";
  notifPanel.setAttribute("role", "region");
  notifPanel.setAttribute("aria-label", "通知中心");
  notifPanel.innerHTML = `<h3>通知中心<span><a href="#" id="nf-clear">清空</a></span></h3>` +
    (r.items.length ? r.items.map(n => `<div class="notif">${esc(n.text)}<time>${esc(n.time)}</time></div>`).join("")
      : "<div class='empty'>目前沒有通知</div>");
  document.body.appendChild(notifPanel);
  $("#nf-clear").onclick = async e => {
    e.preventDefault();
    try { await del("/api/notifications"); notifPanel.remove(); notifPanel = null; refreshBell(); }
    catch (err) { toast("通知清除失敗：" + err.message, true); }
  };
  post("/api/notifications/read", {}).then(refreshBell).catch(() => {});
};
setInterval(refreshBell, 30000); refreshBell();

/* ============================================================
   圖表引擎
============================================================ */
const EV_STYLE = { div: ["除", "#f0b545"], meet: ["法", "#6ab3ff"], shareholder: ["會", "#e58cff"], buy: ["買", "#ff5252"], sell: ["賣", "#26bd7e"], note: ["註", "#c792ea"] };

function bindCross(canvas, handler, reset, pointCount = 50, plot = { left: 0, right: 0 }) {
  let keyboardIndex = Math.max(0, pointCount - 1);
  const indexFromX = (x, width) => Math.round(
    (x - plot.left) / Math.max(1, width - plot.left - plot.right) * (pointCount - 1)
  );
  const xFromIndex = (index, width) => pointCount <= 1
    ? plot.left + (width - plot.left - plot.right) / 2
    : plot.left + index / (pointCount - 1) * (width - plot.left - plot.right);
  canvas.tabIndex = 0;
  canvas.onpointermove = e => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left;
    keyboardIndex = Math.max(0, Math.min(pointCount - 1, indexFromX(x, r.width)));
    handler(x);
  };
  canvas.onpointerdown = e => { canvas.focus({ preventScroll: true }); canvas.onpointermove(e); };
  canvas.onpointerleave = reset;
  canvas.onblur = reset;
  canvas.onkeydown = e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "ArrowLeft") keyboardIndex = Math.max(0, keyboardIndex - 1);
    if (e.key === "ArrowRight") keyboardIndex = Math.min(pointCount - 1, keyboardIndex + 1);
    if (e.key === "Home") keyboardIndex = 0;
    if (e.key === "End") keyboardIndex = Math.max(0, pointCount - 1);
    handler(xFromIndex(keyboardIndex, canvas.clientWidth));
  };
}

function sparkline(canvas, closes, base = null) {
  if (!closes || closes.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  let hi = Math.max(...closes), lo = Math.min(...closes);
  if (base !== null) { hi = Math.max(hi, base); lo = Math.min(lo, base); }
  const span = (hi - lo) || 1;
  const X = i => 1 + (W - 2) * i / (closes.length - 1);
  const Y = v => 2 + (H - 4) * (1 - (v - lo) / span);
  const ref = base !== null ? base : closes[0];
  const color = closes.at(-1) >= ref ? cssVar("--up") : cssVar("--down");
  if (base !== null) {                                  // 昨收基準虛線
    ctx.strokeStyle = cssVar("--muted"); ctx.globalAlpha = .55; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(1, Y(base)); ctx.lineTo(W - 1, Y(base)); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
  closes.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
  ctx.stroke();
  ctx.globalAlpha = .12; ctx.fillStyle = color;
  ctx.lineTo(X(closes.length - 1), H); ctx.lineTo(X(0), H); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
}

function calcMA(rows, n) {
  const out = []; let sum = 0;
  rows.forEach((r, i) => { sum += r.close; if (i >= n) sum -= rows[i - n].close; out.push(i >= n - 1 ? sum / n : null); });
  return out;
}

/* KD(9,3,3)：RSV=9日內位置，K/D 各 1/3 平滑 */
function calcKD(rows, n = 9) {
  const K = [], D = []; let k = 50, d = 50;
  rows.forEach((r, i) => {
    const win = rows.slice(Math.max(0, i - n + 1), i + 1);
    const hi = Math.max(...win.map(x => x.max)), lo = Math.min(...win.map(x => x.min));
    const rsv = hi === lo ? 50 : (r.close - lo) / (hi - lo) * 100;
    k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3;
    K.push(k); D.push(d);
  });
  return { K, D };
}

/* MACD(12,26,9)：DIF=EMA12−EMA26、DEA=DIF 的 EMA9、柱=(DIF−DEA)×2 */
function calcMACD(rows, fast = 12, slow = 26, sig = 9) {
  const ema = (arr, n) => { const a = 2 / (n + 1); let e = null; return arr.map(v => e = e === null ? v : v * a + e * (1 - a)); };
  const closes = rows.map(r => r.close);
  const dif = ema(closes, fast).map((v, i) => v - ema(closes, slow)[i]);
  const dea = ema(dif, sig);
  return { dif, dea, hist: dif.map((v, i) => (v - dea[i]) * 2) };
}

/* RSI(14)：Wilder's smoothing。前 n 根無足夠漲跌樣本回 null；第 n 根＝前 n 次漲跌的簡單平均，
   之後每根用 Wilder 遞迴平滑 (avg*(n-1)+新值)/n。與 app/screener.py::_calc_rsi 公式完全相同，已交叉驗證。 */
function calcRSI(rows, n = 14) {
  const closes = rows.map(r => r.close);
  const out = new Array(rows.length).fill(null);
  if (closes.length <= n) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / n, avgLoss = lossSum / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0, loss = diff >= 0 ? 0 : -diff;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/* 乖離率 BIAS(20)：(收盤 − MA20) / MA20 × 100，單位 %。
   與 app/screener.py::_calc_bias 同公式（AGENTS.md 禁區：技術指標公式前後端必須同步）。
   MA 為 0 時回 null，不產生 Infinity 汙染 Y 軸縮放。 */
function calcBIAS(rows, n = 20) {
  const ma = calcMA(rows, n);
  return rows.map((r, i) => (ma[i] === null || ma[i] === 0) ? null : (r.close - ma[i]) / ma[i] * 100);
}

/* 布林(20, 2σ) */
function calcBOLL(rows, n = 20, mult = 2) {
  const mid = calcMA(rows, n), up = [], dn = [];
  rows.forEach((r, i) => {
    if (i < n - 1) { up.push(null); dn.push(null); return; }
    const win = rows.slice(i - n + 1, i + 1).map(x => x.close);
    const m = mid[i], sd = Math.sqrt(win.reduce((a, v) => a + (v - m) ** 2, 0) / n);
    up.push(m + mult * sd); dn.push(m - mult * sd);
  });
  return { mid, up, dn };
}

function drawChart(canvas, tipEl, rows, mode = "line", events = [], opts = {}) {
  const sub = opts.sub || "vol", useBoll = !!opts.boll;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const pad = { l: 50, r: 10, t: 40, b: 20 }, volH = Math.round(H * (sub === "vol" ? 0.14 : 0.22));
  const priceB = H - pad.b - volH - 6, subT = H - pad.b - volH;
  const boll = useBoll ? calcBOLL(rows) : null;
  const priceHi = Math.max(...rows.map(r => r.max)), priceLo = Math.min(...rows.map(r => r.min));
  let scaleHi = priceHi, scaleLo = priceLo;
  if (boll) {
    scaleHi = Math.max(scaleHi, ...boll.up.filter(v => v !== null));
    scaleLo = Math.min(scaleLo, ...boll.dn.filter(v => v !== null));
  }
  const span = (scaleHi - scaleLo) || 1;
  const maxV = Math.max(1, ...rows.map(r => r.Trading_Volume || 0));
  const X = i => pad.l + (W - pad.l - pad.r) * (rows.length === 1 ? .5 : i / (rows.length - 1));
  const Y = v => pad.t + (priceB - pad.t) * (1 - (v - scaleLo) / span);
  const up = cssVar("--up"), down = cssVar("--down"), muted = cssVar("--muted"),
        line = cssVar("--line"), accent = cssVar("--accent"), linkC = cssVar("--link"), purple = "#c792ea";
  const ma5 = calcMA(rows, 5), ma20 = calcMA(rows, 20);
  const kd = sub === "kd" ? calcKD(rows) : null;
  const macd = sub === "macd" ? calcMACD(rows) : null;
  const rsi = sub === "rsi" ? calcRSI(rows) : null;
  const bias = sub === "bias" ? calcBIAS(rows) : null;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${rows[0].date} 至 ${rows.at(-1).date} 走勢圖；區間最高 ${fmt(priceHi)}，最低 ${fmt(priceLo)}，可用左右方向鍵讀取每日數值`);
  const bw = Math.max(1.5, Math.min(9, (W - pad.l - pad.r) / rows.length * .62));
  // 事件對齊到最近的交易日索引
  const dateIdx = Object.fromEntries(rows.map((r, i) => [r.date, i]));
  const evAt = {};
  for (const ev of events) {
    let i = dateIdx[ev.date];
    if (i === undefined) {
      i = rows.findIndex(r => r.date >= ev.date);
      if (i < 0 || rows.length < 2) continue;
    }
    (evAt[i] ??= []).push(ev);
  }

  function base() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.font = "10.5px monospace"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const v = scaleLo + span * g / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillText(fmt(v, v >= 1000 ? 0 : 2), 3, y + 4);
    }
    if (sub === "vol") {
      rows.forEach((r, i) => {                                      // 量
        const h = (r.Trading_Volume || 0) / maxV * volH;
        ctx.fillStyle = r.close >= r.open ? up : down; ctx.globalAlpha = .5;
        ctx.fillRect(X(i) - bw / 2, H - pad.b - h, bw, h); ctx.globalAlpha = 1;
      });
    } else if (sub === "kd") {                                      // KD 副圖
      const sy = v => subT + volH * (1 - v / 100);
      ctx.strokeStyle = line; ctx.setLineDash([2, 4]);
      for (const g of [20, 80]) { ctx.beginPath(); ctx.moveTo(pad.l, sy(g)); ctx.lineTo(W - pad.r, sy(g)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = muted; ctx.fillText("80", 3, sy(80) + 4); ctx.fillText("20", 3, sy(20) + 4);
      [[kd.K, accent], [kd.D, linkC]].forEach(([arr, c]) => {
        ctx.strokeStyle = c; ctx.beginPath();
        arr.forEach((v, i) => i ? ctx.lineTo(X(i), sy(v)) : ctx.moveTo(X(i), sy(v))); ctx.stroke();
      });
    } else if (sub === "macd") {                                    // MACD 副圖
      const vals = [...macd.dif, ...macd.dea, ...macd.hist];
      const mHi = Math.max(...vals, 0), mLo = Math.min(...vals, 0), mSpan = (mHi - mLo) || 1;
      const sy = v => subT + volH * (1 - (v - mLo) / mSpan);
      ctx.strokeStyle = line; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, sy(0)); ctx.lineTo(W - pad.r, sy(0)); ctx.stroke(); ctx.setLineDash([]);
      macd.hist.forEach((v, i) => {                                 // 柱狀
        ctx.fillStyle = v >= 0 ? up : down; ctx.globalAlpha = .55;
        const y0 = sy(0), y1 = sy(v);
        ctx.fillRect(X(i) - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0))); ctx.globalAlpha = 1;
      });
      [[macd.dif, accent], [macd.dea, linkC]].forEach(([arr, c]) => {
        ctx.strokeStyle = c; ctx.beginPath();
        arr.forEach((v, i) => i ? ctx.lineTo(X(i), sy(v)) : ctx.moveTo(X(i), sy(v))); ctx.stroke();
      });
    } else if (sub === "rsi") {                                     // RSI 副圖
      const sy = v => subT + volH * (1 - v / 100);
      ctx.strokeStyle = line; ctx.setLineDash([2, 4]);
      for (const g of [30, 70]) { ctx.beginPath(); ctx.moveTo(pad.l, sy(g)); ctx.lineTo(W - pad.r, sy(g)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = muted; ctx.fillText("70", 3, sy(70) + 4); ctx.fillText("30", 3, sy(30) + 4);
      ctx.strokeStyle = accent; ctx.beginPath(); let rSt = false;
      rsi.forEach((v, i) => { if (v === null) return; rSt ? ctx.lineTo(X(i), sy(v)) : ctx.moveTo(X(i), sy(v)); rSt = true; });
      ctx.stroke();
    } else if (sub === "bias") {                                    // 乖離率副圖
      // BIAS 有正有負，以 0 為中軸；上下界取「實際極值」與門檻 8% 的較大者，
      // 平盤時才不會把幾乎為 0 的線放大成劇烈波動。
      const vals = bias.filter(v => v !== null);
      const peak = Math.max(8, ...vals.map(v => Math.abs(v)));
      const sy = v => subT + volH * (1 - (v + peak) / (peak * 2));
      ctx.strokeStyle = line; ctx.setLineDash([2, 4]);
      for (const g of [8, 0, -8]) { ctx.beginPath(); ctx.moveTo(pad.l, sy(g)); ctx.lineTo(W - pad.r, sy(g)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = muted;
      ctx.fillText("+8%", 3, sy(8) + 4); ctx.fillText("0", 3, sy(0) + 4); ctx.fillText("-8%", 3, sy(-8) + 4);
      ctx.strokeStyle = accent; ctx.beginPath(); let bSt = false;
      bias.forEach((v, i) => { if (v === null) return; bSt ? ctx.lineTo(X(i), sy(v)) : ctx.moveTo(X(i), sy(v)); bSt = true; });
      ctx.stroke();
    }
    if (boll) {                                                     // 布林帶
      ctx.globalAlpha = .10; ctx.fillStyle = purple; ctx.beginPath();
      let started = false;
      boll.up.forEach((v, i) => { if (v === null) return; started ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); started = true; });
      for (let i = boll.dn.length - 1; i >= 0; i--) if (boll.dn[i] !== null) ctx.lineTo(X(i), Y(boll.dn[i]));
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      [[boll.up], [boll.dn]].forEach(([arr]) => {
        ctx.strokeStyle = purple; ctx.globalAlpha = .7; ctx.beginPath(); let st = false;
        arr.forEach((v, i) => { if (v === null) return; st ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); st = true; });
        ctx.stroke(); ctx.globalAlpha = 1;
      });
    }
    if (mode === "candle") {
      rows.forEach((r, i) => {
        const c = r.close >= r.open ? up : down;
        ctx.strokeStyle = c; ctx.fillStyle = c;
        ctx.beginPath(); ctx.moveTo(X(i), Y(r.max)); ctx.lineTo(X(i), Y(r.min)); ctx.stroke();
        const top = Y(Math.max(r.open, r.close)), bot = Y(Math.min(r.open, r.close));
        ctx.fillRect(X(i) - bw / 2, top, bw, Math.max(1, bot - top));
      });
    } else {
      ctx.strokeStyle = rows.at(-1).close >= rows[0].close ? up : down; ctx.lineWidth = 1.8;
      ctx.beginPath(); rows.forEach((r, i) => i ? ctx.lineTo(X(i), Y(r.close)) : ctx.moveTo(X(i), Y(r.close))); ctx.stroke();
      ctx.lineWidth = 1;
    }
    [[ma5, accent], [ma20, linkC]].forEach(([arr, color]) => {       // 均線
      ctx.strokeStyle = color; ctx.beginPath(); let st = false;
      arr.forEach((v, i) => { if (v === null) return; st ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); st = true; });
      ctx.stroke();
    });
    // 事件旗標：相鄰太近時分兩列錯開，避免互相蓋住
    const flagXs = Object.keys(evAt).map(Number).sort((a, b) => a - b);
    let prevX = -Infinity, rowToggle = 0;
    const flagRow = {};
    for (const i of flagXs) {
      const x = X(i);
      rowToggle = (x - prevX < 20) ? 1 - rowToggle : 0;
      flagRow[i] = rowToggle; prevX = x;
    }
    for (const i of flagXs) {
      const evs = evAt[i];
      const [glyph, color] = EV_STYLE[evs[0].type] || EV_STYLE.note;
      const x = X(i), fy = 3 + flagRow[i] * 17;
      ctx.strokeStyle = color; ctx.globalAlpha = .55; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(x, fy + 15); ctx.lineTo(x, priceB); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = color; ctx.fillRect(x - 8, fy, 16, 15);
      ctx.fillStyle = "#10131a"; ctx.font = "10.5px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(evs.length > 1 ? String(evs.length) : glyph, x, fy + 11);
      ctx.textAlign = "left"; ctx.font = "10.5px monospace";
    }
    const hiI = rows.findIndex(r => r.max === priceHi), loI = rows.findIndex(r => r.min === priceLo);
    ctx.fillStyle = up; ctx.beginPath(); ctx.arc(X(hiI), Y(priceHi), 3.2, 0, 7); ctx.fill();
    ctx.fillText(`高 ${fmt(priceHi)}`, Math.min(X(hiI) + 5, W - 78), Y(priceHi) - 5);
    ctx.fillStyle = down; ctx.beginPath(); ctx.arc(X(loI), Y(priceLo), 3.2, 0, 7); ctx.fill();
    ctx.fillText(`低 ${fmt(priceLo)}`, Math.min(X(loI) + 5, W - 78), Y(priceLo) + 13);
    drawXAxis(ctx, rows, X, W, H, pad, muted);
  }
  base();
  bindCross(canvas, x => {
    let i = Math.round((x - pad.l) / (W - pad.l - pad.r) * (rows.length - 1));
    i = Math.max(0, Math.min(rows.length - 1, i));
    const r = rows[i];
    base();
    ctx.strokeStyle = muted; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(i), pad.t); ctx.lineTo(X(i), H - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(X(i), Y(r.close), 4, 0, 7); ctx.fill();
    const evTxt = (evAt[i] || []).map(e => `📍${e.label}`).join(" ");
    let indTxt = "";
    if (kd) indTxt = `　K ${fmt(kd.K[i], 1)} D ${fmt(kd.D[i], 1)}`;
    if (macd) indTxt = `　DIF ${fmt(macd.dif[i])} DEA ${fmt(macd.dea[i])} 柱 ${fmt(macd.hist[i])}`;
    if (rsi) indTxt = rsi[i] === null ? "　RSI 資料不足" : `　RSI ${fmt(rsi[i], 1)}`;
    if (bias) indTxt = bias[i] === null ? "　乖離 資料不足" : `　乖離 ${fmt(bias[i], 2)}%`;
    if (boll && boll.up[i] !== null) indTxt += `　布林 ${fmt(boll.dn[i])}~${fmt(boll.up[i])}`;
    const html = `<b>${esc(r.date)}</b><br>開 ${fmt(r.open)}　高 ${fmt(r.max)}<br>低 ${fmt(r.min)}　收 ${fmt(r.close)}<br>量 ${lots(r.Trading_Volume)} 張` +
      (ma5[i] ? `<br>MA5 ${fmt(ma5[i])}` : "") + (ma20[i] ? `　MA20 ${fmt(ma20[i])}` : "") +
      (indTxt ? `<br>${esc(indTxt.trim())}` : "") + (evTxt ? `<br>${esc(evTxt)}` : "");
    const ft = $(opts.floatId || "#float-tip");
    if (ft) {
      ft.style.display = "block";
      ft.innerHTML = html;
      ft.style.left = Math.min(x + 15, canvas.clientWidth - ft.offsetWidth - 10) + "px";
      ft.style.top = Math.max(0, Y(r.close) - ft.offsetHeight / 2) + "px";
    }
  }, () => { base(); const ft = $(opts.floatId || "#float-tip"); if (ft) ft.style.display = "none"; }, rows.length, { left: pad.l, right: pad.r });
}

function drawIntraday(canvas, tipEl, pts, prevClose, floatEl) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const volH = Math.round(H * 0.14);
  const pad = { l: 50, r: 30, t: 12, b: 26 };
  const priceB = H - pad.b - volH - 4;
  const vwap = []; let cumPV = 0, cumV = 0, lastV = 0;
  for (const p of pts) {
    const dv = Math.max(0, (p.v || 0) - lastV); lastV = p.v || lastV;
    cumPV += p.p * dv; cumV += dv;
    vwap.push(cumV ? cumPV / cumV : p.p);
  }
  const ps = pts.map(p => p.p);
  let hi = Math.max(...ps, prevClose || -Infinity), lo = Math.min(...ps, prevClose || Infinity);
  const span = (hi - lo) || 1;
  const Xt = t => pad.l + (W - pad.l - pad.r) * (Math.max(0, Math.min(_TOTAL_MIN, _t2m(t))) / _TOTAL_MIN);
  const X = i => Xt(pts[Math.max(0, Math.min(pts.length - 1, i))].t);
  const Y = v => pad.t + (priceB - pad.t) * (1 - (v - lo) / span);
  const maxVol = Math.max(1, ...pts.map(p => p.v || 0));
  const up = cssVar("--up"), down = cssVar("--down"), muted = cssVar("--muted"), line = cssVar("--line"), accent = cssVar("--accent");
  const ft = floatEl || null;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${pts[0].t} 至 ${pts.at(-1).t} 當日分時圖；最高 ${fmt(Math.max(...ps))}，最低 ${fmt(Math.min(...ps))}`);
  function base() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.font = "10.5px monospace";
    for (let g = 0; g <= 4; g++) {
      const v = lo + span * g / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillText(fmt(v), 3, y + 4);
    }
    if (prevClose) {
      const ypc = Y(prevClose);
      ctx.strokeStyle = muted; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, ypc); ctx.lineTo(W - pad.r, ypc); ctx.stroke(); ctx.setLineDash([]);
      // area fill between price line and prevClose
      if (pts.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(X(0), ypc);
        pts.forEach((p, i) => ctx.lineTo(X(i), Y(p.p)));
        ctx.lineTo(X(pts.length - 1), ypc);
        ctx.closePath();
        ctx.clip();
        // above prevClose = up color
        ctx.fillStyle = up; ctx.globalAlpha = 0.15;
        ctx.fillRect(pad.l, pad.t, W - pad.l - pad.r, ypc - pad.t);
        // below prevClose = down color
        ctx.fillStyle = down;
        ctx.fillRect(pad.l, ypc, W - pad.l - pad.r, priceB - ypc);
        ctx.restore();
      }
    }
    ctx.strokeStyle = accent; ctx.globalAlpha = .8;
    ctx.beginPath(); vwap.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.8;
    if (prevClose) {
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i].p, p1 = pts[i + 1].p, x0 = X(i), x1 = X(i + 1), y0 = Y(p0), y1 = Y(p1);
        if ((p0 >= prevClose) !== (p1 >= prevClose)) {
          const ratio = (prevClose - p0) / (p1 - p0);
          const xm = x0 + (x1 - x0) * ratio, ym = Y(prevClose);
          ctx.strokeStyle = p0 >= prevClose ? up : down;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(xm, ym); ctx.stroke();
          ctx.strokeStyle = p1 >= prevClose ? up : down;
          ctx.beginPath(); ctx.moveTo(xm, ym); ctx.lineTo(x1, y1); ctx.stroke();
        } else {
          ctx.strokeStyle = p0 >= prevClose ? up : down;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
      }
    } else {
      ctx.strokeStyle = accent;
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.p)) : ctx.moveTo(X(i), Y(p.p))); ctx.stroke();
    }
    ctx.lineWidth = 1;
    const hiI = ps.indexOf(Math.max(...ps)), loI = ps.indexOf(Math.min(...ps));
    ctx.fillStyle = up; ctx.beginPath(); ctx.arc(X(hiI), Y(ps[hiI]), 3.2, 0, 7); ctx.fill();
    ctx.fillText(`高 ${fmt(ps[hiI])} ${pts[hiI].t.slice(0, 5)}`, Math.min(X(hiI) + 5, W - 130), Y(ps[hiI]) - 5);
    ctx.fillStyle = down; ctx.beginPath(); ctx.arc(X(loI), Y(ps[loI]), 3.2, 0, 7); ctx.fill();
    ctx.globalAlpha = 0.5;
    let prevVol2 = 0;
    pts.forEach((p, i) => {
      const dv = Math.max(0, (p.v || 0) - prevVol2); prevVol2 = p.v || prevVol2;
      const bh = (dv / (maxVol * 0.05 || 1)) * volH;
      const bx = X(i);
      ctx.fillStyle = i > 0 && p.p >= pts[i-1].p ? up : down;
      ctx.fillRect(bx - 1.5, H - pad.b - Math.min(bh, volH), 3, Math.min(bh, volH));
    });
    ctx.globalAlpha = 1;
    ctx.fillText(`低 ${fmt(ps[loI])} ${pts[loI].t.slice(0, 5)}`, Math.min(X(loI) + 5, W - 130), Y(ps[loI]) + 13);
    drawIntradayXAxis(ctx, W, H, pad, muted);
  }
  base();
  if (tipEl) tipEl.innerHTML = "";
  bindCross(canvas, (x, y) => {
    const minFromX = (x - pad.l) / (W - pad.l - pad.r) * _TOTAL_MIN;
    let best = 0;
    for (let j = 1; j < pts.length; j++) { if (Math.abs(_t2m(pts[j].t) - minFromX) < Math.abs(_t2m(pts[best].t) - minFromX)) best = j; }
    const i = best;
    base();
    ctx.strokeStyle = muted; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(i), pad.t); ctx.lineTo(X(i), H - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(X(i), Y(pts[i].p), 4, 0, 7); ctx.fill();
    const chg = prevClose ? pts[i].p - prevClose : null;
    const html = `<b>${esc(pts[i].t)}</b>　價 ${fmt(pts[i].p)}` +
      (chg !== null ? `<br>漲跌 ${sign(chg)}（${sign(chg / prevClose * 100)}%）` : "") +
      `<br>均價 ${fmt(vwap[i])}　量 ${fmt(pts[i].v, 0)} 張`;
    if (ft) {
      ft.style.display = "block";
      ft.innerHTML = html;
      ft.style.left = Math.min(x + 15, canvas.clientWidth - ft.offsetWidth - 10) + "px";
      ft.style.top = Math.max(0, Y(pts[i].p) - ft.offsetHeight / 2) + "px";
    }
  }, () => { base(); if (ft) ft.style.display = "none"; }, pts.length, { left: pad.l, right: pad.r });
}

function drawMulti(canvas, tipEl, seriesList) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const pad = { l: 46, r: 10, t: 10, b: 18 };
  const dates = seriesList.reduce((a, s) => s.series.length > a.length ? s.series : a, []).map(p => p.date);
  const all = seriesList.flatMap(s => s.series.map(p => p.pct));
  const hi = Math.max(...all, 0), lo = Math.min(...all, 0), span = (hi - lo) || 1;
  const X = i => pad.l + (W - pad.l - pad.r) * (dates.length === 1 ? .5 : i / (dates.length - 1));
  const Y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / span);
  const palette = ["#f0b545", "#6ab3ff", "#ff5252", "#26bd7e", "#c792ea", "#ff9e64"];
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `績效比較圖：${seriesList.map(s => `${s.id} ${s.name} ${sign(s.series.at(-1)?.pct ?? 0)}%`).join("；")}`);
  ctx.strokeStyle = cssVar("--line"); ctx.fillStyle = cssVar("--muted"); ctx.font = "10.5px monospace";
  for (let g = 0; g <= 4; g++) {
    const v = lo + span * g / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(sign(v, 0) + "%", 2, y + 4);
  }
  seriesList.forEach((s, k) => {
    ctx.strokeStyle = palette[k % palette.length]; ctx.lineWidth = 1.8; ctx.beginPath();
    const idx = Object.fromEntries(s.series.map(p => [p.date, p.pct]));
    let st = false;
    dates.forEach((d, i) => { const v = idx[d]; if (v === undefined) return; st ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); st = true; });
    ctx.stroke();
  });
  drawXAxis(ctx, dates.map(d => ({ date: d })), i => pad.l + (W - pad.l - pad.r) * (dates.length === 1 ? 0.5 : i / (dates.length - 1)), W, H, pad, muted);
  tipEl.innerHTML = seriesList.map((s, k) => {
    const last = s.series.at(-1)?.pct ?? 0;
    return `<span class="legend"><i style="background:${palette[k % palette.length]}"></i>${esc(s.id)} ${esc(s.name)} <b class="${cls(last)}">${sign(last)}%</b></span>`;
  }).join("　");
}

/* ---------- 到價提醒（前端輔助檢查） ---------- */
async function checkAlerts(quotes) {
  let alerts;
  try { alerts = await api("/api/alerts"); } catch { return; }
  for (const a of alerts) {
    if (!a.enabled || a.triggered_at) continue;
    const px = bestPx(quotes[a.symbol]);
    if (px === null) continue;
    if (a.op === ">=" ? px >= a.price : px <= a.price) {
      const msg = `🔔 ${a.symbol} 已${a.op === ">=" ? "漲到" : "跌到"} ${fmt(px)}（條件 ${a.op} ${fmt(a.price)}）`;
      toast(msg, false, 12000);
      if (window.Notification && Notification.permission === "granted") { try { new Notification("到價提醒", { body: msg }); } catch {} }
      put(`/api/alerts/${a.id}`, { triggered_at: new Date().toISOString() }).catch(() => {});
    }
  }
}

/* ============================================================
   總覽
============================================================ */
pages.home = async (_arg, gen) => {
  main.innerHTML = `
    <div class="dashboard-page">
      <div class="card"><h3>📊 加權指數走勢</h3>
        <div class="ranges" id="home-idx-ranges"><button data-r="當日" class="on">當日</button><button data-r="3天">3天</button><button data-r="1週">1週</button>
          <button data-r="1月">1月</button><button data-r="3月">3月</button><button data-r="半年">半年</button><button data-r="1年">1年</button></div>
        <div style="position:relative"><canvas class="chart" id="home-idx-chart"></canvas><div class="chart-float" id="home-idx-float"></div></div>
        <div class="chart-tip" id="home-idx-tip"></div>
      </div>
      <div class="grid3" id="home-idx-cards" style="margin-top:12px">
        <div class="card idx-card"><h4>加權指數</h4><div id="idx-taiex" class="idx-val">—</div></div>
        <div class="card idx-card"><h4>櫃買指數</h4><div id="idx-otc" class="idx-val">—</div></div>
        <div class="card idx-card"><h4 id="idx-futures-title">台指期貨</h4><div id="idx-futures" class="idx-val">${skel(1)}</div></div>
      </div>
      <div class="card" style="margin-top:12px"><h3>🏛️ 三大法人 vs 散戶（當日彙總）</h3><div id="home-inst">${skel(4)}</div></div>
      <div class="card" style="margin-top:12px"><h3>📅 近 14 天關鍵事件（自選股）</h3><div id="evs">${skel(3)}</div></div>
      <div class="card" style="margin-top:12px"><h3>📰 產業新聞</h3><div id="mkt-news">${skel(6)}</div></div>
      <div class="card" style="margin-top:12px"><h3>📝 盤後總結</h3><div id="rep">${skel(2)}</div>
        <div class="row" style="margin-top:8px"><button class="btn sm gold" id="rep-run">立即產生今日總結</button>
        <span class="muted small">可在「設定」開啟收盤後自動產生</span></div></div>
    </div>`;

  renderMarketIndex(gen, "#home-idx-chart", "#home-idx-tip", "#home-idx-float", "#home-idx-ranges");
  renderInstitutional("#home-inst", gen, "all");

  // 指數卡片
  api("/api/market/index").then(idx => {
    if (!navAlive(gen)) return;
    const renderCard = (elId, data, titleEl) => {
      const el = $(elId); if (!el) return;
      if (titleEl && data?.name) { const h = $(titleEl); if (h) h.textContent = data.name; }
      const px = F(data?.price) || bestPx(data), pv = F(data?.prev_close);
      const ch = px && pv ? px - pv : null;
      const pct = ch !== null && pv ? ch / pv * 100 : null;
      const arrow = ch !== null ? (ch >= 0 ? "▲" : "▼") : "";
      el.innerHTML = `<div class="${cls(ch)}" style="font-size:1.5rem;font-weight:700">${px ? fmt(px, 2) : "—"}</div>` +
        (ch !== null ? `<div class="${cls(ch)}" style="font-size:.9rem">${arrow} ${fmt(Math.abs(ch), 2)}（${sign(pct)}%）</div>` : "") +
        (data?.time ? `<div class="muted small">${esc(data.time)}</div>` : "");
    };
    renderCard("#idx-taiex", idx.taiex);
    renderCard("#idx-otc", idx.otc);
    renderCard("#idx-futures", idx.futures, "#idx-futures-title");
  }).catch(() => {});

  // 事件
  api("/api/overview/today").then(ov => {
    if (!navAlive(gen) || !$("#evs")) return;
    $("#evs").innerHTML = ov && ov.events.length ? ov.events.map(e => {
      const [g, c] = EV_STYLE[e.type] || EV_STYLE.note;
      return `<div class="ev click" data-s="${esc(e.symbol)}" style="cursor:pointer"><span class="dot" style="background:${c}"></span>
        <time>${esc(e.date.slice(5))}</time><b class="num">${esc(e.symbol)}</b> ${esc(e.name)}｜${esc(e.label)}</div>`;
    }).join("") : "<div class='empty'>近兩週自選股沒有已知的除息／法說／股東會事件</div>";
    $$("#evs .ev").forEach(el => bindClickable(el, () => show("stock", el.dataset.s)));
  }).catch(() => {});

  // 產業新聞
  api("/api/market/news?limit=20").then(r => {
    if (!navAlive(gen) || !$("#mkt-news")) return;
    const items = r.items || [];
    $("#mkt-news").innerHTML = items.length ? items.map(n => {
      const d = n.pubDate ? new Date(n.pubDate) : null;
      const ts = d ? d.toLocaleDateString("zh-TW", { month: "2-digit", day: "2-digit" }) + " " + d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="news-row"><a href="${escUrl(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><div class="muted small">${esc(ts)}${n.source ? "｜" + esc(n.source) : ""}</div></div>`;
    }).join("") : "<div class='empty'>暫無產業新聞</div>";
  }).catch(() => { setHTML("#mkt-news", "<div class='empty'>產業新聞載入失敗</div>", gen); });

  // 盤後總結
  function renderReport(list) {
    const r = list[0];
    const artifact = r?.artifacts?.find(a => a.kind === "movers_svg");
    const artifactUrl = reportArtifactUrl(artifact?.url);
    if (!setHTML("#rep", r
      ? `<div class="muted small">${esc(r.date)} ${esc(r.time || "")}｜${esc(r.provider)}／${esc(r.model)}</div>
         <div class="ai-out" style="margin-top:6px;max-height:260px;overflow:auto">${esc(r.text)}</div>
         ${artifactUrl ? '<button class="btn sm" id="rep-chart" style="margin-top:8px">下載漲跌圖 SVG</button>' : ""}`
      : "<div class='empty'>還沒有總結；收盤後自動產生，或按下方按鈕立即產生（無 AI key 時使用本機規則）</div>", gen)) return;
    const chartButton = $("#rep-chart");
    if (chartButton) chartButton.onclick = async () => {
      try {
        const response = await request(artifactUrl);
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || "圖表下載失敗");
        const objectUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = objectUrl;
        const safeDate = artifactUrl.split("/")[3];
        link.download = /^[A-Za-z0-9._-]+$/.test(artifact.name || "") ? artifact.name : `twstock-${safeDate}-movers.svg`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } catch (e) { toast("圖表下載失敗：" + e.message, true); }
    };
  }
  api("/api/reports").then(renderReport).catch(() => { setHTML("#rep", "<div class='empty' role='alert'>載入失敗</div>", gen); });
  $("#rep-run").onclick = async () => {
    $("#rep").innerHTML = "<div class='empty'>日報產生中…</div>";
    try { const r = await post("/api/reports/run", {}); renderReport([r]); toast("盤後總結已產生"); }
    catch (e) { $("#rep").innerHTML = `<div class='empty'>產生失敗：${esc(e.message)}</div>`; }
  };

};

/* ============================================================
   股東會日曆：官方日期／地點／電子投票資訊
============================================================ */
pages.calendar = async (_arg, gen) => {
  const currentMonth = localDateISO().slice(0, 7);
  main.innerHTML = `<div class="calendar-page">
    <div class="card"><h1 style="margin:0 0 6px">📅 股東會日曆</h1>
      <p class="muted small">整理 TWSE／TPEx 官方開放資料的股東常會與臨時會日期。這是公司公告資訊，不是出席或交易指示。</p>
      <div class="row" style="margin-top:10px">
        <label>月份 <input id="cal-month" type="month" value="${currentMonth}" /></label>
        <label>範圍 <select id="cal-scope"><option value="all">全部上市</option><option value="watch">只看我的自選</option></select></label>
        <button class="btn sm" id="cal-refresh">重新整理</button>
      </div>
      <div class="muted small" id="cal-status" role="status" aria-live="polite" style="margin-top:8px">資料載入中…</div>
    </div>
    <div class="card"><h2 id="cal-title" style="margin-top:0">本月股東會</h2><div id="cal-grid" class="calendar-grid" aria-label="股東會月曆"></div></div>
    <div class="card"><h2 style="margin-top:0">日期清單</h2><div id="cal-list" class="calendar-list"></div></div>
  </div>`;
  let rows = [], watchSymbols = new Set();
  const render = () => {
    if (!navAlive(gen)) return;
    const month = $("#cal-month")?.value || currentMonth;
    const scope = $("#cal-scope")?.value || "all";
    const visible = rows.filter(item => item.date?.startsWith(month) && item.market !== "上櫃" && (scope !== "watch" || watchSymbols.has(item.stock_id)));
    const [year, mon] = month.split("-").map(Number);
    const first = new Date(year, mon - 1, 1).getDay();
    const days = new Date(year, mon, 0).getDate();
    const today = localDateISO();
    const byDate = {};
    visible.forEach(item => (byDate[item.date] ??= []).push(item));
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<div class="cal-day empty" aria-hidden="true"></div>');
    for (let day = 1; day <= days; day++) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      const items = byDate[date] || [];
      cells.push(`<div class="cal-day${date === today ? " today" : ""}"><div class="cal-date">${day}日</div>${items.map(item =>
        `<button type="button" class="cal-event" data-s="${esc(item.stock_id)}" title="${esc([item.label, item.time, item.location].filter(Boolean).join("｜"))}"><b>${esc(item.stock_id)}</b> ${esc(item.name || "")}<br>${esc(item.label || "股東會")}</button>`
      ).join("")}</div>`);
    }
    $("#cal-grid").innerHTML = ["日", "一", "二", "三", "四", "五", "六"].map(d => `<div class="cal-head">${d}</div>`).join("") + cells.join("");
    $("#cal-title").textContent = `${year} 年 ${mon} 月股東會（${visible.length} 場）`;
    $("#cal-list").innerHTML = visible.length ? visible.map(item => {
      const details = [item.time && `時間 ${item.time}`, item.location && `地點 ${item.location}`, item.electronic_voting && `電子投票 ${item.electronic_voting}`].filter(Boolean).join("｜");
      return `<div class="cal-row"><time class="num">${esc(item.date)}</time><button type="button" class="btn sm" data-s="${esc(item.stock_id)}">${esc(item.stock_id)} ${esc(item.name || "")}</button><span class="cal-detail"><b>${esc(item.label || "股東會")}</b>${details ? `｜${esc(details)}` : ""}</span><a href="https://tw.stock.yahoo.com/quote/${esc(item.stock_id)}.${item.market === '上櫃' ? 'TWO' : 'TW'}" target="_blank" rel="noopener" class="btn sm muted">📎 公開資訊</a><span class="muted small">${esc(item.market || item.source || "官方")}</span></div>`;
    }).join("") : `<div class="empty">${scope === "watch" ? "這個月份的自選股沒有已知股東會" : "這個月份沒有可用股東會資料"}</div>`;
    $$("#cal-grid [data-s], #cal-list [data-s]").forEach(button => button.onclick = () => show("stock", button.dataset.s));
    $("#cal-status").textContent = rows.length ? `共載入 ${rows.length} 筆；資料可能因公司公告而更新，請以來源公告為準。` : "官方來源目前沒有回傳資料，稍後可重新整理。";
  };
  try {
    const [calendar, lists] = await Promise.all([api("/api/shareholder-meetings?limit=5000"), api("/api/watchlists").catch(() => [])]);
    rows = Array.isArray(calendar?.items) ? calendar.items : [];
    watchSymbols = new Set((Array.isArray(lists) ? lists : []).flatMap(list => Array.isArray(list.symbols) ? list.symbols : []));
  } catch (e) {
    $("#cal-status").textContent = `股東會資料載入失敗：${e.message}`;
  }
  $("#cal-month").onchange = render;
  $("#cal-scope").onchange = render;
  $("#cal-refresh").onclick = () => show("calendar");
  render();
};

/* ============================================================
   自選：卡片牆
============================================================ */
pages.watch = async (_arg, gen) => {
  const lists = await api("/api/watchlists");
  if (!navAlive(gen)) return;
  if (!lists.length) {
    main.innerHTML = `<div class="card"><div class="empty">還沒有任何清單</div>
      <div class="row" style="justify-content:center"><button class="btn gold" id="wl-first">＋建立第一個清單</button></div></div>`;
    $("#wl-first").onclick = async () => {
      const name = await openActionDialog({ title: "建立自選清單", detail: "輸入清單名稱（最多 30 字）", input: true, value: "我的自選", confirmLabel: "建立" });
      if (!name) return;
      try { const w = await post("/api/watchlists", { name }); pages.watch.cur = w.id; show("watch"); }
      catch (e) { toast("建立失敗：" + e.message, true); }
    };
    return;
  }
  const cur = pages.watch.cur && lists.find(w => w.id === pages.watch.cur) ? pages.watch.cur : lists[0]?.id;
  pages.watch.cur = cur;
  const wl = lists.find(w => w.id === cur);
  let mode = "normal";   // normal / edit / compare
  main.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <select id="wl-sel" class="grow">${lists.map(w => `<option value="${esc(w.id)}" ${w.id === cur ? "selected" : ""}>${esc(w.name)}（${w.symbols.length}）</option>`).join("")}</select>
      <span class="mode-toggle"><button id="sp-30">30日</button><button id="sp-day">當日</button></span>
      <button class="btn sm" id="wl-refresh" style="margin-left:auto">🔄 重新整理</button>
      <button class="btn" id="wl-edit">編輯</button>
      <button class="btn" id="wl-cmp">比較</button>
    </div>
    <div class="row" style="margin-bottom:10px">
      <input id="wl-add" placeholder="加入代號或名稱" class="grow" />
      <button class="btn gold" id="wl-addbtn">加入</button>
      <button class="btn" id="wl-new">＋清單</button>
      <button class="btn" id="wl-more">⋯</button>
    </div>
    <div class="qgrid" id="cards">${Array(Math.max(wl?.symbols.length || 0, 2)).fill('<div class="qcard">' + skel(3) + "</div>").join("")}</div>
    <div class="card" id="cmp-box" style="display:none;margin-top:12px">
      <h3>📈 績效比較（各自以區間首日為 0%）</h3>
      <div class="ranges" id="cmp-ranges"></div>
      <canvas class="chart" id="cmp-chart" style="height:230px"></canvas>
      <div class="chart-tip" id="cmp-tip"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn gold" id="hc-btn">🤖 AI 持股健檢</button>
      <span class="muted small">卡片點一下進個股；「編輯」可移除、「比較」可挑 2–6 檔疊圖。</span>
    </div>
    <div class="ai-out" id="hc-out" style="display:none;margin-top:10px"></div>`;

  $("#wl-sel").onchange = e => { pages.watch.cur = e.target.value; show("watch"); };
  $("#wl-new").onclick = async () => {
    const name = await openActionDialog({ title: "建立自選清單", detail: "輸入清單名稱（最多 30 字）", input: true, value: "科技股", confirmLabel: "建立" });
    if (!name) return;
    try { const w = await post("/api/watchlists", { name }); pages.watch.cur = w.id; show("watch"); }
    catch (e) { toast("建立清單失敗：" + e.message, true); }
  };
  const isMaster = wl.id === "default";
  $("#wl-more").onclick = async () => {
    const act = await openActionDialog({
      title: `管理清單「${wl.name}」`, detail: "選擇要進行的操作",
      choices: [
        !isMaster && { value: "rename", label: "重新命名" },
        { value: "editlist", label: "編輯清單" },
        { value: "addstock", label: "新增標的" },
        { value: "clear", label: "清空標的", danger: true },
        !isMaster && { value: "delete", label: "刪除清單", danger: true },
        { value: "export", label: "匯出清單" },
        { value: "import", label: "匯入清單" },
      ].filter(Boolean),
    });
    try {
      if (act === "rename") {
        const name = await openActionDialog({ title: "重新命名清單", detail: "輸入新的清單名稱（最多 30 字）", input: true, value: wl.name, confirmLabel: "儲存" });
        if (name) { await put(`/api/watchlists/${cur}`, { name }); show("watch"); }
      } else if (act === "editlist") {
        setMode("edit");
      } else if (act === "addstock") {
        if (isMaster) { $("#wl-add").focus(); return; }
        const master = lists.find(w => w.id === "default") || lists[0];
        const available = master.symbols.filter(s => !wl.symbols.includes(s));
        if (!available.length) { toast("所有自選標的都已在此清單中"); return; }
        const q = await api(`/api/quotes?symbols=${available.join(",")}`).catch(() => ({}));
        const items = available.map(s => ({ value: s, label: `${s}　${q[s]?.name || ""}` }));
        const selected = await openMultiSelectDialog({ title: `加入標的到「${wl.name}」`, detail: "從我的自選中選擇要加入的標的", items });
        if (selected && selected.length) {
          await put(`/api/watchlists/${cur}`, { symbols: [...wl.symbols, ...selected] });
          show("watch");
        }
      } else if (act === "clear") {
        const ok1 = await openActionDialog({ title: "清空自選標的？", detail: `將從「${wl.name}」移除所有 ${wl.symbols.length} 檔標的。`, confirmLabel: "確認清空" });
        if (ok1 === null) return;
        const ok2 = await openActionDialog({ title: "再次確認", detail: "此操作不可復原，確定要清空所有標的？", confirmLabel: "確定清空" });
        if (ok2 === null) return;
        await put(`/api/watchlists/${cur}`, { symbols: [] }); show("watch");
      } else if (act === "delete") {
        const ok1 = await openActionDialog({ title: `刪除「${wl.name}」？`, detail: "清單與其中的標的將一併移除。", confirmLabel: "確認刪除" });
        if (ok1 === null) return;
        const ok2 = await openActionDialog({ title: "再次確認", detail: `確定要永久刪除「${wl.name}」？此動作不可復原。`, confirmLabel: "確定刪除" });
        if (ok2 === null) return;
        await del(`/api/watchlists/${cur}`); pages.watch.cur = null; show("watch");
      } else if (act === "export") {
        const data = await api("/api/watchlists");
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url;
        a.download = `twstock-watchlists-${localDateISO()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast("清單已匯出");
      } else if (act === "import") {
        const input = document.createElement("input");
        input.type = "file"; input.accept = ".json";
        input.onchange = async () => {
          const file = input.files[0]; if (!file) return;
          try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!Array.isArray(data)) throw new Error("格式不正確：需要 JSON 陣列");
            await post("/api/watchlists/import", { lists: data });
            toast("清單已匯入"); show("watch");
          } catch (e) { toast("匯入失敗：" + e.message, true); }
        };
        input.click();
      }
    } catch (e) { toast("清單操作失敗：" + e.message, true); }
  };
  $("#wl-addbtn").onclick = async () => {
    let s = $("#wl-add").value.trim().toUpperCase(); if (!s) return;
    if (!/^[0-9]{4,6}[A-Z]{0,2}$/.test(s)) {
      try { const hits = await api(`/api/search?q=${encodeURIComponent(s)}`); if (hits[0]) s = hits[0].id; } catch {}
    }
    try { await put(`/api/watchlists/${cur}`, { symbols: [...new Set([...wl.symbols, s])] }); show("watch"); }
    catch (e) { toast("加入失敗：" + e.message, true); }
  };
  $("#wl-add").onkeydown = e => { if (e.key === "Enter") $("#wl-addbtn").click(); };
  const setMode = m => {
    mode = mode === m ? "normal" : m;
    $("#cards").classList.toggle("editing", mode === "edit");
    $("#wl-edit").classList.toggle("gold", mode === "edit");
    $("#wl-cmp").classList.toggle("gold", mode === "compare");
    $("#cmp-box").style.display = mode === "compare" ? "block" : "none";
    if (mode !== "compare") { picked.clear(); paintPicked(); clearCanvas($("#cmp-chart"), $("#cmp-tip"), "點卡片挑 2–6 檔"); }
    else if (picked.size < 2) clearCanvas($("#cmp-chart"), $("#cmp-tip"), "點卡片挑 2–6 檔");
    if (mode === "normal") refresh().catch(() => {});
  };
  $("#wl-edit").onclick = () => setMode("edit");
  $("#wl-cmp").onclick = () => setMode("compare");

  const picked = new Set();
  const paintPicked = () => $$(".qcard").forEach(c => c.style.borderColor = picked.has(c.dataset.s) ? cssVar("--accent") : "");

  // 迷你走勢：30日 / 當日 切換（記憶偏好；當日=排程器盤中累積的分時）
  let sparkKind = localStorage.getItem("twpan-spark") || "30d";
  let sparkData = {}, sparkError = "", held = new Set();
  let refreshSeq = 0;
  api("/api/portfolio").then(p => { if (navAlive(gen)) held = new Set(p.rows.map(r => r.symbol)); }).catch(() => {});
  async function loadSparks(thenRefresh = true) {
    if (!wl?.symbols.length) return;
    try {
      sparkData = await api(`/api/sparklines?symbols=${wl.symbols.join(",")}&kind=${sparkKind === "day" ? "day" : "30d"}`);
      sparkError = "";
      if (thenRefresh && navAlive(gen)) refresh();
    } catch (e) {
      sparkData = {}; sparkError = e.message;
      if (thenRefresh && navAlive(gen)) refresh().catch(() => {});
    }
  }
  const paintSparkBtns = () => {
    $("#sp-30")?.classList.toggle("on", sparkKind !== "day");
    $("#sp-day")?.classList.toggle("on", sparkKind === "day");
  };
  $("#sp-30").onclick = () => { sparkKind = "30d"; localStorage.setItem("twpan-spark", sparkKind); paintSparkBtns(); loadSparks(); };
  $("#sp-day").onclick = () => { sparkKind = "day"; localStorage.setItem("twpan-spark", sparkKind); paintSparkBtns(); loadSparks(); };
  if ($("#wl-refresh")) $("#wl-refresh").onclick = () => show("watch");
  paintSparkBtns();
  loadSparks();

  async function refresh() {
    const seq = ++refreshSeq;
    if (mode !== "normal") return; // 編輯／比較時保留穩定的卡片與鍵盤焦點
    if (!wl || !wl.symbols.length) { setHTML("#cards", "<div class='empty'>清單是空的，上方輸入框加入第一檔吧</div>", gen); return; }
    const q = await api(`/api/quotes?symbols=${wl.symbols.join(",")}`);
    checkAlerts(q);
    if (seq !== refreshSeq || mode !== "normal" || !navAlive(gen) || !$("#cards")) return; // 只讓最新請求重繪卡片
    $("#cards").innerHTML = wl.symbols.map(s => {
      const r = q[s] || {};
      const px = bestPx(r), pv = F(r.prev_close);
      const ch = px && pv ? px - pv : null, pct = ch !== null ? ch / pv * 100 : null;
      return `<div class="qcard" data-s="${esc(s)}" role="button" tabindex="0" aria-label="查看 ${esc(s)} ${esc(r.name || "")}">
        ${held.has(s) ? '<span class="held">庫存</span>' : ""}
        <button type="button" class="rm" data-rm="${esc(s)}" aria-label="從清單移除 ${esc(s)}">✕</button>
        <span class="sort-btns"><button type="button" class="sort-up" data-up="${esc(s)}" aria-label="上移">▲</button><button type="button" class="sort-dn" data-dn="${esc(s)}" aria-label="下移">▼</button></span>
        <div class="hd"><span class="nm">${esc(r.name || "—")}</span><span class="cd">${esc(s)}</span></div>
        <div class="px ${cls(ch)}">${fmt(px)}</div>
        <div class="chg ${cls(ch)}">${ch === null ? "" : sign(ch) + "　" + sign(pct) + "%"}</div>
        <canvas data-spark="${esc(s)}" aria-hidden="true"></canvas>
        <div class="ft"><span>量 ${r.volume ? fmt(+r.volume, 0) : "—"} 張</span><span>${esc((r.time || "").slice(0, 5))}</span></div>
      </div>`;
    }).join("");
    $$(".qcard").forEach(card => {
      const s = card.dataset.s;
      card.onclick = e => {
        if (e.target.dataset.rm) return;
        if (mode === "compare") { picked.has(s) ? picked.delete(s) : picked.size < 6 && picked.add(s); paintPicked(); runCompare(); }
        else if (mode !== "edit") show("stock", s);
      };
      card.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); card.click(); } };
      const cv = $("canvas", card);
      const sd = sparkData[s];
      if (sd?.closes?.length >= 2) sparkline(cv, sd.closes, sd.base ?? null);
      else if (sparkKind === "day" && sd) {
        const c2 = cv.getContext("2d");
        cv.width = cv.clientWidth; cv.height = cv.clientHeight;
        c2.fillStyle = cssVar("--muted"); c2.font = "10px sans-serif";
        c2.fillText("尚無當日分時", 4, cv.clientHeight / 2 + 3);
      } else if (sparkError) {
        const c2 = cv.getContext("2d");
        cv.width = cv.clientWidth; cv.height = cv.clientHeight;
        c2.fillStyle = cssVar("--muted"); c2.font = "10px sans-serif";
        c2.fillText("走勢載入失敗", 4, cv.clientHeight / 2 + 3);
      }
    });
    $$("[data-rm]").forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const ok = await openActionDialog({ title: `移除 ${b.dataset.rm}？`, detail: `將從「${wl.name}」移除此標的。`, confirmLabel: "移除" });
      if (ok === null) return;
      try { await put(`/api/watchlists/${cur}`, { symbols: wl.symbols.filter(x => x !== b.dataset.rm) }); show("watch"); }
      catch (err) { toast("移除失敗：" + err.message, true); }
    });
    paintPicked();
    $$("[data-up]").forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const idx = wl.symbols.indexOf(b.dataset.up);
      if (idx > 0) { [wl.symbols[idx-1], wl.symbols[idx]] = [wl.symbols[idx], wl.symbols[idx-1]]; await put(`/api/watchlists/${cur}`, { symbols: wl.symbols }); show("watch"); }
    });
    $$("[data-dn]").forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const idx = wl.symbols.indexOf(b.dataset.dn);
      if (idx >= 0 && idx < wl.symbols.length - 1) { [wl.symbols[idx], wl.symbols[idx+1]] = [wl.symbols[idx+1], wl.symbols[idx]]; await put(`/api/watchlists/${cur}`, { symbols: wl.symbols }); show("watch"); }
    });
  }
  await refresh();
  if (!navAlive(gen)) return;
  show.timer = setInterval(() => {
    if (!$("#cards")) return;
    if (mode !== "normal") return;
    (sparkKind === "day" ? loadSparks(false) : Promise.resolve()).finally(() => refresh().catch(() => {}));
  }, 10000);
  if (window.Notification && Notification.permission === "default") { try { Notification.requestPermission(); } catch {} }

  const cmpRanges = { "1月": 31, "3月": 93, "6月": 186, "1年": 366 };
  let cmpDays = 93;
  $("#cmp-ranges").innerHTML = Object.entries(cmpRanges).map(([k, v], i) => `<button data-d="${v}" class="${i === 1 ? "on" : ""}">${k}</button>`).join("");
  $$("#cmp-ranges button").forEach(b => b.onclick = () => {
    $$("#cmp-ranges button").forEach(x => x.classList.remove("on")); b.classList.add("on");
    cmpDays = +b.dataset.d; runCompare();
  });
  async function runCompare() {
    if (picked.size < 2) { clearCanvas($("#cmp-chart"), $("#cmp-tip"), "點卡片挑 2–6 檔"); return; }
    try {
      const data = await api(`/api/compare?symbols=${[...picked].join(",")}&days=${cmpDays}`);
      if (!navAlive(gen) || !$("#cmp-chart")) return;
      if (data.length) drawMulti($("#cmp-chart"), $("#cmp-tip"), data);
      else clearCanvas($("#cmp-chart"), $("#cmp-tip"), "此區間沒有足夠的比較資料");
    } catch (e) { clearCanvas($("#cmp-chart"), $("#cmp-tip"), "比較載入失敗：" + e.message); toast(e.message, true); }
  }

  $("#hc-btn").onclick = async () => {
    const out = $("#hc-out"); out.style.display = "block"; out.textContent = "AI 健檢中…";
    try {
      const q = await api(`/api/quotes?symbols=${wl.symbols.join(",")}`);
      const lines = wl.symbols.map(s => {
        const r = q[s] || {}; const px = bestPx(r), pv = F(r.prev_close);
        return `${s} ${r.name || ""}：現價 ${r.price || "—"}，今日 ${px && pv ? ((px - pv) / pv * 100).toFixed(2) : "—"}%`;
      }).join("\n");
      const r = await post("/api/ai/ask", { prompt: `這是我的自選清單「${wl.name}」今日狀況：\n${lines}\n\n請做持股健檢：1) 一句總評 2) 最需要留意的 2 檔與原因 3) 集中度風險提醒。` });
      out.textContent = (r.warnings.length ? "⚠ " + r.warnings.join("\n⚠ ") + "\n\n" : "") + `【${r.provider}／${r.model}】\n` + r.text;
    } catch (e) { out.textContent = "AI 呼叫失敗：" + e.message; }
  };

  let visualTimer;
  const redraw = () => {
    clearTimeout(visualTimer);
    visualTimer = setTimeout(() => {
      if (!navAlive(gen)) return;
      refresh().catch(() => {});
      if (mode === "compare" && picked.size >= 2) runCompare();
    }, 120);
  };
  window.addEventListener("resize", redraw);
  document.addEventListener("twpan:visualchange", redraw);
  show.cleanup = () => {
    clearTimeout(visualTimer);
    window.removeEventListener("resize", redraw);
    document.removeEventListener("twpan:visualchange", redraw);
  };
};

/* ============================================================
   個股 / ETF 詳細頁
============================================================ */
const RANGES = { "3天": 4, "1週": 8, "1月": 32, "3月": 94, "半年": 187, "1年": 367 };

async function renderMarketIndex(gen, chartId, tipId, floatId, rangesId) {
  try {
    const [hist, intradayRes] = await Promise.all([
      api("/api/market/history?months=14"),
      api("/api/stock/T00/intraday").catch(() => ({ points: [] }))
    ]);
    if (!navAlive(gen) || !$(chartId)) return;
    const TAIEX_RANGES = { "3天": 4, "1週": 8, "1月": 32, "3月": 94, "半年": 187, "1年": 367 };
    const intraPts = (intradayRes.points || []);
    function drawIdx(key) {
      if (!$(chartId)) return;
      if (key === "當日") {
        if (intraPts.length >= 2) {
          const ov = hist.length ? hist.at(-1) : {};
          drawIntraday($(chartId), $(tipId), intraPts, ov.close ? ov.close - (ov.change || 0) : null, $(floatId));
        } else {
          clearCanvas($(chartId), $(tipId), "大盤分時數據收集中（排程器每 10 秒更新）");
        }
        return;
      }
      const days = TAIEX_RANGES[key] || 32;
      const cutoff = localDateISO(new Date(Date.now() - days * 86400000));
      const rows = hist.filter(r => r.date >= cutoff).map(r => ({ date: r.date, close: r.close, open: r.close - (r.change || 0), max: r.close, min: r.close - Math.abs(r.change || 0), Trading_Volume: r.volume || 0, spread: r.change }));
      if (!rows.length) { clearCanvas($(chartId), $(tipId), "暫無大盤歷史數據"); return; }
      drawChart($(chartId), $(tipId), rows, "line", [], { sub: "vol", bollOn: false, floatId });
    }
    drawIdx("當日");
    const defBtn = $(rangesId + " button[data-r='當日']"); if (defBtn) defBtn.classList.add("on");
    $$(rangesId + " button").forEach(b => b.onclick = () => {
      $$(rangesId + " button").forEach(x => x.classList.remove("on")); b.classList.add("on");
      drawIdx(b.dataset.r);
    });
  } catch { if ($(chartId)) clearCanvas($(chartId), $(tipId), "大盤資料載入失敗"); }
}

function renderLimits(data, upId, downId, gen) {
  const limitRow = r => `<tr class="click" data-s="${esc(r.id)}"><td class="num">${esc(r.id)}</td><td>${esc(r.name)}</td>
    <td class="num-td">${fmt(r.close)}</td><td class="num-td ${cls(r.pct)}">${sign(r.pct)}%</td>
    <td class="num-td">${fmt(r.volume / 1000, 0)}</td></tr>`;
  const tbl = rows => rows.length ? `<div class="twrap" style="max-height:320px;overflow-y:auto"><table><tr><th>代號</th><th>名稱</th><th class="num-td">價格</th><th class="num-td">漲跌%</th><th class="num-td">量(張)</th></tr>` + rows.slice(0, 50).map(limitRow).join("") + "</table></div>" : "<div class='empty'>暫無資料</div>";
  setHTML(upId, tbl(data.limit_up || []), gen);
  setHTML(downId, tbl(data.limit_down || []), gen);
  $$(`${upId} tr.click, ${downId} tr.click`).forEach(tr => bindClickable(tr, () => show("stock", tr.dataset.s)));
}

function renderInstitutional(targetId, gen, pageType) {
  api("/api/market/institutional").then(d => {
    if (!navAlive(gen) || !$(targetId)) return;
    const all = d.items || [];
    const items = all.filter(it => it.label !== "散戶推估");
    const retail = all.find(it => it.label === "散戶推估") || { buy: 0, sell: 0, net: 0 };
    const allWithRetail = [...items, retail];
    const B = v => fmt(v / 1e8, 1);
    const L = v => fmt(v / 1000, 0);
    const splitLabel = pageType === "etf" ? "ETF" : pageType === "all" ? "全市場" : "個股";
    const maxAbs = Math.max(1, ...allWithRetail.map(it => Math.abs(it.net)));
    const cats = pageType === "all" ? [] : [
      ["外資", pageType === "etf" ? d.foreign_etf : d.foreign_stock],
      ["投信", pageType === "etf" ? d.trust_etf : d.trust_stock],
      ["自營商", pageType === "etf" ? d.dealer_etf : d.dealer_stock]
    ].filter(([_, v]) => v);

    // Section 1: Page-specific buy/sell for all three categories
    const sec1 = cats.length ? (() => {
      const maxBuy = Math.max(1, ...cats.map(([_, v]) => v.buy));
      const maxSell = Math.max(1, ...cats.map(([_, v]) => v.sell));
      return `<div class="grid2" style="gap:8px;margin-bottom:12px">
        <div><h4 style="margin:0 0 6px;color:var(--up)">🟢 ${esc(splitLabel)}買進（張）</h4>
          <div class="twrap"><table><tr><th>類別</th><th class="num-td">張數</th><th style="width:35%"></th></tr>
          ${cats.map(([name, v]) => `<tr><td>${esc(name)}</td><td class="num-td">${L(v.buy)}</td>
            <td><div style="height:10px;border-radius:3px;background:var(--up);opacity:.5;width:${v.buy/maxBuy*100}%"></div></td></tr>`).join("")}
          </table></div></div>
        <div><h4 style="margin:0 0 6px;color:var(--down)">🔴 ${esc(splitLabel)}賣出（張）</h4>
          <div class="twrap"><table><tr><th>類別</th><th class="num-td">張數</th><th style="width:35%"></th></tr>
          ${cats.map(([name, v]) => `<tr><td>${esc(name)}</td><td class="num-td">${L(v.sell)}</td>
            <td><div style="height:10px;border-radius:3px;background:var(--down);opacity:.5;width:${v.sell/maxSell*100}%"></div></td></tr>`).join("")}
          </table></div></div>
      </div>
      <div class="twrap" style="margin-bottom:12px"><table><tr><th>類別</th><th class="num-td">買進(張)</th><th class="num-td">賣出(張)</th><th class="num-td">${esc(splitLabel)}淨額(張)</th></tr>
      ${cats.map(([name, v]) => `<tr><td>${esc(name)}</td><td class="num-td">${L(v.buy)}</td><td class="num-td">${L(v.sell)}</td>
        <td class="num-td ${cls(v.net)}" style="font-weight:600">${v.net>=0?"+":""}${L(v.net)}</td></tr>`).join("")}
      </table></div>`;
    })() : "";

    // Section 2: Page-specific institutional summary table
    const sec2 = `<h4 style="margin:0 0 6px">📊 ${esc(splitLabel)}買賣超彙總（全市場金額）</h4>
      <div class="twrap"><table><tr><th>類別</th><th class="num-td">買進(億)</th><th class="num-td">賣出(億)</th><th class="num-td">買賣超(億)</th></tr>
      ${allWithRetail.map(it => `<tr><td>${esc(it.label)}</td><td class="num-td">${it.buy ? B(it.buy) : "—"}</td><td class="num-td">${it.sell ? B(it.sell) : "—"}</td>
        <td class="num-td ${cls(it.net)}" style="font-weight:600">${it.net >= 0 ? "+" : ""}${B(it.net)}</td></tr>`).join("")}
      <tr style="border-top:2px solid var(--border)"><td><b>三大法人合計</b></td><td class="num-td"><b>${B(d.total_buy)}</b></td><td class="num-td"><b>${B(d.total_sell)}</b></td>
        <td class="num-td ${cls(d.inst_net)}" style="font-weight:700">${d.inst_net >= 0 ? "+" : ""}${B(d.inst_net)}</td></tr>
      </table></div>`;

    // Section 3: Total bar chart
    const sec3 = `<h4 style="margin:12px 0 6px">🏛️ 三大法人 vs 散戶（當日彙總）</h4>` +
      allWithRetail.map(it => `<div style="margin-bottom:8px">
        <div class="row" style="justify-content:space-between">
          <b>${esc(it.label)}</b>
          <span class="num ${cls(it.net)}" style="font-weight:600">${it.net >= 0 ? "買超" : "賣超"} ${B(Math.abs(it.net))} 億</span>
        </div>
        <div style="height:8px;border-radius:4px;background:var(--border)">
          <div style="width:${Math.abs(it.net)/maxAbs*100}%;height:100%;background:var(${it.net >= 0 ? "--up" : "--down"});border-radius:4px"></div>
        </div></div>`).join("") +
      `<div class="muted small" style="margin-top:8px">三大法人合計：<b class="${cls(d.inst_net)}">${d.inst_net >= 0 ? "買超" : "賣超"} ${B(Math.abs(d.inst_net || 0))} 億</b></div>`;

    $(targetId).innerHTML = `<div class="muted small" style="margin-bottom:8px">日期：${esc(d.date || "—")}</div>${sec1}${sec2}<div style="margin-top:12px">${sec3}</div>`;
  }).catch(() => setHTML(targetId, "<div class='empty'>法人資料載入失敗</div>", gen));
}

function renderMovers(containerId, gen) {
  let kind = "gainers";
  const btns = [["mv-g", "gainers", "漲幅%"], ["mv-l", "losers", "跌幅%"], ["mv-v", "volume", "成交量"]];
  async function load() {
    try {
      const data = await api(`/api/rankings/movers?kind=${kind}&limit=30`);
      if (!navAlive(gen) || !$(containerId)) return;
      $(`${containerId}-tbl`).innerHTML = data.length ? `<div class="twrap"><table><tr><th>代號</th><th>名稱</th><th class="num-td">價格</th><th class="num-td">漲跌%</th><th class="num-td">量(張)</th></tr>` +
        data.map(r => `<tr class="click" data-s="${esc(r.id)}"><td class="num">${esc(r.id)}</td><td>${esc(r.name)}</td>
          <td class="num-td">${fmt(r.close)}</td><td class="num-td ${cls(r.pct)}">${sign(r.pct)}%</td>
          <td class="num-td">${fmt(r.volume / 1000, 0)}</td></tr>`).join("") + "</table></div>" : "<div class='empty'>暫無資料</div>";
      $$(`${containerId}-tbl tr.click`).forEach(tr => bindClickable(tr, () => show("stock", tr.dataset.s)));
    } catch (e) { setHTML(`${containerId}-tbl`, `<div class='empty'>${esc(e.message)}</div>`, gen); }
  }
  btns.forEach(([id, k, label]) => {
    const el = $(`#${id}`);
    if (el) el.onclick = () => { kind = k; btns.forEach(([bid]) => $(`#${bid}`)?.classList.remove("on")); el.classList.add("on"); load(); };
  });
  load();
}

async function renderStockIndex(gen) {
  if (!navAlive(gen)) return;
  const idx = await api("/api/market/index").catch(() => ({}));
  const tai = idx.taiex || {};
  const tPx = F(tai.price), tPv = F(tai.prev_close), tCh = tPx && tPv ? tPx - tPv : null;
  main.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center"><h1 style="margin:0">📈 個股總覽</h1><button class="btn sm" onclick="show('stock')">🔄 重新整理</button></div>
      <div class="vchips">
        <span class="vchip">加權指數<b class="${cls(tCh)}">${fmt(tPx, 2)}</b></span>
        ${tCh !== null ? `<span class="vchip ${cls(tCh)}">${sign(tCh, 2)}（${sign(tCh / tPv * 100)}%）</span>` : ""}
        ${tai.time ? `<span class="muted small">${esc(tai.time)}</span>` : ""}
      </div>
      <div class="row" style="margin-top:10px">
        <input id="stock-search" placeholder="輸入代號或名稱搜尋個股..." style="flex:1" autocomplete="off" />
        <button class="btn sm gold" id="stock-go">前往</button>
      </div>
    </div>
    <div class="grid2">
      <div class="card"><h3>🔺 漲停</h3><div id="lim-up">${skel(4)}</div></div>
      <div class="card"><h3>🔻 跌停</h3><div id="lim-down">${skel(4)}</div></div>
    </div>
    <div class="card"><h3>📊 漲跌幅排行</h3>
      <div class="row" style="margin-bottom:8px" id="mv-wrap">
        <button class="btn sm on" id="mv-g">漲幅%</button><button class="btn sm" id="mv-l">跌幅%</button><button class="btn sm" id="mv-v">成交量</button>
      </div><div id="mv-wrap-tbl">${skel(6)}</div>
    </div>
`;
  const goStock = async () => {
    let q = $("#stock-search").value.trim().toUpperCase();
    if (!q) return;
    if (!/^[0-9]{4,6}[A-Z]{0,2}$/.test(q)) {
      try { const hits = await api(`/api/search?q=${encodeURIComponent(q)}`); if (hits[0]) q = hits[0].id; } catch {}
    }
    show("stock", q);
  };
  $("#stock-go").onclick = goStock;
  $("#stock-search").onkeydown = e => { if (e.key === "Enter") goStock(); };
  api("/api/rankings/limits").then(d => { if (navAlive(gen)) renderLimits(d, "#lim-up", "#lim-down", gen); }).catch(() => {});
  renderMovers("#mv-wrap", gen);
}

pages.stock = async (sid, gen) => {
  sid = (sid || "").trim().toUpperCase();
  if (!sid) return renderStockIndex(gen);
  lastStock = sid;
  const isETF = sid.startsWith("00");
  const [ov, prices, _wls] = await Promise.all([api(`/api/stock/${sid}/overview`), api(`/api/stock/${sid}/prices?days=400`), api("/api/watchlists").catch(() => [])]);
  if (!navAlive(gen)) return;
  const rt = ov.realtime || {}, info = ov.info || {};
  const isInWatch = (Array.isArray(_wls) ? _wls : []).some(w => (w.symbols || []).includes(sid));
  const defaultRange = isInWatch ? "當日" : "1月";
  const px = bestPx(rt), pv = F(rt.prev_close);
  const lastRow = prices.at(-1) || {};
  const showPx = px || lastRow.close, ch = (showPx && pv) ? showPx - pv : (lastRow.spread ?? null);
  main.innerHTML = `
    <div class="card">
      <div class="stock-head">
        <span class="nm">${esc(rt.name || info.stock_name || sid)}</span>
        <span class="muted num">${esc(sid)}</span>
        <span class="tag">${esc(info.industry_category || (isETF ? "ETF" : ""))}</span>
        <span id="held-tag"></span>
      </div>
      <div class="stock-head">
        <span class="px ${cls(ch)}" id="st-px">${fmt(showPx)}</span>
        <span class="num ${cls(ch)}" id="st-chg">${ch === null ? "" : sign(ch) + "（" + sign(ch / (showPx - ch) * 100) + "%）"}</span>
        <span class="muted small" id="st-time">${rt.time ? "成交 " + esc(rt.time) : "盤後"}</span>
        <span class="grow"></span>
        <button class="btn sm" id="fav">☆ 自選</button>
        <a class="btn sm" href="https://tw.stock.yahoo.com/quote/${esc(sid)}.${info.type === 'tpex' ? 'TWO' : 'TW'}" target="_blank" rel="noopener noreferrer">📎 公開資訊</a>
      </div>
      ${rt.limit_up ? `<div class="muted small num">漲停 ${esc(rt.limit_up)}｜跌停 ${esc(rt.limit_down)}</div>` : ""}
      <div class="vchips" id="val"></div>
      <div class="ranges" id="ranges"><button data-r="當日"${defaultRange === "當日" ? ' class="on"' : ""}>當日</button>${Object.keys(RANGES).map(k => `<button data-r="${k}"${defaultRange === k ? ' class="on"' : ""}>${k}</button>`).join("")}</div>
      <div class="row"><span class="mode-toggle"><button id="m-line" class="on">線圖</button><button id="m-candle">K線</button></span>
        <span class="mode-toggle" id="sub-sel"><button data-sub="vol">量</button><button data-sub="kd">KD</button><button data-sub="macd">MACD</button><button data-sub="rsi">RSI</button><button data-sub="bias">乖離</button></span>
        <label class="small"><input type="checkbox" id="boll-on" /> 布林</label>
        <label class="small"><input type="checkbox" id="ev-on" checked /> 事件標註</label>
        <span class="muted small" id="chart-mode-note" role="status"></span></div>
      <div style="position:relative">
        <canvas class="chart" id="chart" role="img" tabindex="0" aria-describedby="tip">此瀏覽器無法顯示走勢圖，請參考下方文字讀值。</canvas>
        <div class="chart-float" id="float-tip"></div>
      </div>
      <div class="chart-tip" id="tip" role="status" aria-live="polite"></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>MA5/均價</span><span><i style="background:var(--link)"></i>MA20</span>
        <span><i style="background:#f0b545"></i>除息</span><span><i style="background:#6ab3ff"></i>法說</span><span><i style="background:#c792ea"></i>自訂</span></div>
      <div class="row" style="margin-top:8px">
        <span class="muted small">🔔 到價：</span>
        <select id="al-op"><option value=">=">≥</option><option value="<=">≤</option></select>
        <input id="al-px" placeholder="價格" inputmode="decimal" style="width:92px" />
        <button class="btn sm" id="al-add">設定</button>
        <span id="al-list" class="small"></span>
      </div>
    </div>
    <div class="grid2">
      ${isETF ? `<div class="card"><h3>📦 ETF 成分股持股比例</h3><div id="etf">${skel(3)}</div></div>` : `<div class="card"><h3>⚖️ 五檔報價</h3><div id="depth">${skel(3)}</div></div>`}
      <div class="card"><h3>📅 近期股東會</h3><div id="meetings">${skel(2)}</div>
        ${!isETF ? `<h3 style="margin-top:14px">⚖️ 五檔報價</h3><div id="depth">${skel(3)}</div>` : ""}
      </div>
      ${isETF ? `<div class="card"><h3>🏭 行業比重</h3><div id="etf-ind">${skel(2)}</div></div>` : ""}
      ${isETF ? `<div class="card"><h3>📊 區間績效</h3><div id="etf-perf">${skel(2)}</div></div>` : ""}
      <div class="card"><h3>📰 近期新聞</h3><ul class="news" id="news">${skel(3)}</ul></div>
      <div class="card"><h3>🏦 三大法人買賣超（張）與散戶推估</h3><div id="chips">${skel(4)}</div></div>
      <div class="card"><h3>💧 除權息與填息統計</h3><div id="fill">${skel(3)}</div></div>
      <div class="card"><h3>📍 事件時間軸（除息／法說／自訂標註）</h3>
        <div id="ev-list">${skel(2)}</div>
        <div class="row" style="margin-top:8px">
          <input id="ev-date" type="date" style="flex:1;min-width:130px" />
          <select id="ev-type"><option value="note">備註</option><option value="buy">買進</option><option value="sell">賣出</option><option value="meet">法說</option></select>
          <input id="ev-label" placeholder="說明（如：開始建倉）" class="grow" style="min-width:120px" />
          <button class="btn sm gold" id="ev-add">標註</button>
        </div></div>
    </div>`;

  api("/api/portfolio").then(p => {
    if (!navAlive(gen)) return;
    const mine = p.rows.filter(r => r.symbol === sid);
    if (mine.length && $("#held-tag")) {
      const pnl = mine.reduce((a, r) => a + (r.pnl || 0), 0);
      $("#held-tag").innerHTML = `<span class="pill" style="border-color:var(--accent)">庫存 ${fmt(mine.reduce((a, r) => a + r.shares, 0), 0)} 股｜損益 <b class="${cls(pnl)}">${sign(pnl, 0)}</b></span>`;
    }
  }).catch(() => {});

  $("#fav").onclick = async () => {
    try {
      const lists = await api("/api/watchlists");
      const target = lists[0];
      if (!target) {
        const name = await openActionDialog({ title: "建立自選清單", detail: "目前沒有清單，請輸入名稱後加入此標的。", input: true, value: "我的自選", confirmLabel: "建立並加入" });
        if (!name) return toast("尚未加入：需要先建立自選清單", true);
        const created = await post("/api/watchlists", { name, symbols: [sid] });
        return toast(`已建立並加入「${created.name}」`);
      }
      await put(`/api/watchlists/${target.id}`, { symbols: [...new Set([...target.symbols, sid])] });
      toast(`已加入「${target.name}」`);
    } catch (e) { toast("加入自選失敗：" + e.message, true); }
  };

  // ---- 走勢圖（含事件與技術指標）----
  let mode = "line", intraCache = null, events = [];
  let subKind = localStorage.getItem("twpan-sub") || "vol";
  let bollOn = localStorage.getItem("twpan-boll") === "1";
  const chart = $("#chart"), tip = $("#tip");
  function paintChartControls() {
    const intraday = $("#ranges .on")?.dataset.r === "當日";
    [$("#m-line"), $("#m-candle"), ...$$("#sub-sel button"), $("#boll-on"), $("#ev-on")].forEach(el => {
      el.disabled = intraday;
      el.setAttribute("aria-disabled", intraday ? "true" : "false");
    });
    $("#m-line").classList.toggle("on", intraday || mode === "line");
    $("#m-candle").classList.toggle("on", !intraday && mode === "candle");
    $("#chart-mode-note").textContent = intraday ? "當日分時僅提供線圖與均價；日 K 指標暫不適用" : "";
  }
  const paintSub = () => {
    $$("#sub-sel button").forEach(b => b.classList.toggle("on", b.dataset.sub === subKind));
    $("#boll-on").checked = bollOn;
    paintChartControls();
  };
  $$("#sub-sel button").forEach(b => b.onclick = () => {
    subKind = b.dataset.sub; localStorage.setItem("twpan-sub", subKind); paintSub(); render();
  });
  $("#boll-on").onchange = e => { bollOn = e.target.checked; localStorage.setItem("twpan-boll", bollOn ? "1" : "0"); render(); };
  paintSub();
  async function render() {
    if (!navAlive(gen)) return;
    const key = $("#ranges .on")?.dataset.r;
    if (!key) return;
    paintChartControls();
    if (key === "當日") {
      if (!intraCache) { try { intraCache = await api(`/api/stock/${sid}/intraday`); } catch { intraCache = { points: [] }; } }
      if (!navAlive(gen)) return;
      if (intraCache.points.length >= 2) drawIntraday(chart, tip, intraCache.points, pv || lastRow.close, $("#float-tip"));
      else clearCanvas(chart, tip, "尚無當日分時：需排程器盤中運行且此標的在監控名單內");
      return;
    }
    const cutoff = localDateISO(new Date(Date.now() - RANGES[key] * 86400000));
    const rows = prices.filter(r => r.date >= cutoff);
    const evs = $("#ev-on").checked ? events.filter(e => e.date >= cutoff && e.date <= rows.at(-1)?.date) : [];
    if (rows.length) drawChart(chart, tip, rows, mode, evs, { sub: subKind, boll: bollOn });
    else clearCanvas(chart, tip, "此區間無資料");
  }
  $$("#ranges button").forEach(b => b.onclick = () => { $$("#ranges button").forEach(x => x.classList.remove("on")); b.classList.add("on"); paintChartControls(); render(); });
  $("#m-line").onclick = () => { mode = "line"; $("#m-line").classList.add("on"); $("#m-candle").classList.remove("on"); render(); };
  $("#m-candle").onclick = () => { mode = "candle"; $("#m-candle").classList.add("on"); $("#m-line").classList.remove("on"); render(); };
  $("#ev-on").onchange = render;
  render();

  let visualTimer;
  const redraw = () => {
    clearTimeout(visualTimer);
    visualTimer = setTimeout(() => { if (navAlive(gen) && $("#chart")) render(); }, 120);
  };
  window.addEventListener("resize", redraw);
  document.addEventListener("twpan:visualchange", redraw);
  show.cleanup = () => {
    clearTimeout(visualTimer);
    window.removeEventListener("resize", redraw);
    document.removeEventListener("twpan:visualchange", redraw);
  };

  // ---- 事件 ----
  async function loadEvents() {
    try { events = await api(`/api/stock/${sid}/events`); } catch { events = []; }
    if (!navAlive(gen) || !$("#ev-list")) return;
    const recent = [...events].reverse().slice(0, 10);
    $("#ev-list").innerHTML = recent.length ? recent.map(e => {
      const [g, c] = EV_STYLE[e.type] || EV_STYLE.note;
      return `<div class="ev"><span class="dot" style="background:${c}"></span><time>${esc(e.date)}</time>
        <span class="grow"><b>${esc(e.label)}</b>${e.detail ? `<small class="muted">｜${esc(e.detail)}</small>` : ""}</span>${e.auto ? '<span class="tag">自動</span>' : `<a href="#" data-ev="${esc(e.id)}">刪除</a>`}</div>`;
    }).join("") : "<div class='empty'>尚無事件；下方可自訂標註（會畫在走勢圖上）</div>";
    $$("#ev-list [data-ev]").forEach(a => a.onclick = async e => {
      e.preventDefault();
      try { await del(`/api/stock/${sid}/events/${a.dataset.ev}`); await loadEvents(); render(); toast("事件已刪除"); }
      catch (err) { toast("事件刪除失敗：" + err.message, true); }
    });
    render();
  }
  loadEvents();
  $("#ev-add").onclick = async () => {
    try {
      await post(`/api/stock/${sid}/events`, { date: $("#ev-date").value, label: $("#ev-label").value, type: $("#ev-type").value });
      $("#ev-label").value = ""; toast("已標註"); loadEvents();
    } catch (e) { toast(e.message, true); }
  };

  // ---- 估值 ----
  api(`/api/stock/${sid}/valuation`).then(v => {
    if (navAlive(gen) && v && v.date && $("#val")) $("#val").innerHTML = `
      ${v.PER ? `<span class="vchip">本益比<b>${fmt(v.PER)}</b></span>` : ""}
      ${v.PBR ? `<span class="vchip">淨值比<b>${fmt(v.PBR)}</b></span>` : ""}
      <span class="vchip">殖利率<b>${fmt(v.dividend_yield)}%</b></span>` + ($("#val").dataset.extra || "");
  }).catch(() => {});
  if (isETF) {
    api(`/api/etf/${sid}/metrics`).then(mx => {
      if (!navAlive(gen) || !$("#val")) return;
      const prem = mx.premium_pct;
      const extra = `
        ${mx.nav ? `<span class="vchip">預估淨值<b>${fmt(mx.nav)}</b></span>` : ""}
        ${prem !== null && prem !== undefined ? `<span class="vchip">折溢價<b class="${cls(prem)}">${sign(prem)}%</b>${prem > 0 ? "溢價" : prem < 0 ? "折價" : ""}</span>` : ""}
        ${mx.holders ? `<span class="vchip">受益人數<b>${fmt(mx.holders, 0)}</b>${esc(mx.holders_date || "")}</span>` : ""}`;
      $("#val").dataset.extra = extra;
      $("#val").innerHTML += extra;
      if (prem !== null && prem !== undefined && Math.abs(prem) >= 1)
        toast(`⚠ ${sid} 目前${prem > 0 ? "溢價" : "折價"} ${fmt(Math.abs(prem))}%，${prem > 0 ? "買在溢價可能買貴" : "折價通常會收斂"}`, false, 8000);
    }).catch(() => {});
  } else {
    api(`/api/stock/${sid}/holders`).then(h => {
      if (!navAlive(gen) || !$("#val") || !h.holders) return;
      const extra = `<span class="vchip">股東人數<b>${fmt(h.holders, 0)}</b>${esc(h.date || "")}</span>`;
      $("#val").dataset.extra = extra;
      $("#val").innerHTML += extra;
    }).catch(() => {});
  }

  // ---- 到價提醒 ----
  async function renderAlerts() {
    const all = (await api("/api/alerts")).filter(a => a.symbol === sid);
    if (!navAlive(gen) || !$("#al-list")) return;
    $("#al-list").innerHTML = all.map(a =>
      `<span class="pill">${a.op} ${fmt(a.price)}${a.triggered_at ? "✓" : ""} <a href="#" data-del="${esc(a.id)}">✕</a></span>`).join(" ") || "";
    $$("#al-list [data-del]").forEach(x => x.onclick = async e => {
      e.preventDefault();
      try { await del(`/api/alerts/${x.dataset.del}`); await renderAlerts(); toast("提醒已刪除"); }
      catch (err) { toast("提醒刪除失敗：" + err.message, true); }
    });
  }
  renderAlerts().catch(e => { setHTML("#al-list", `<span class='warn' role='alert'>提醒載入失敗：${esc(e.message)}</span>`, gen); });
  $("#al-add").onclick = async () => {
    const price = F($("#al-px").value);
    if (!price) return toast("請輸入有效價格", true);
    try { await post("/api/alerts", { symbol: sid, op: $("#al-op").value, price }); $("#al-px").value = ""; renderAlerts(); toast("提醒已設定"); }
    catch (e) { toast(e.message, true); }
  };

  // ---- 五檔（抽成函式以便盤中更新）----
  function renderDepth(r) {
    if (!navAlive(gen) || !$("#depth")) return;
    const bids = r.bids || [], asks = r.asks || [];
    const maxD = Math.max(1, ...bids.map(b => b.v), ...asks.map(a => a.v));
    $("#depth").innerHTML = (bids.length || asks.length) ? `<div class="depth">
        <div><div class="muted small" style="text-align:right">委買</div>${bids.map(b => `
          <div class="drow bid"><span class="bar" style="width:${b.v / maxD * 100}%"></span>
            <span class="num" style="text-align:right;color:var(--up)">${fmt(b.p)}</span><span class="num muted">${fmt(b.v, 0)}</span></div>`).join("")}</div>
        <div><div class="muted small">委賣</div>${asks.map(a => `
          <div class="drow ask"><span class="bar" style="width:${a.v / maxD * 100}%"></span>
            <span class="num" style="color:var(--down)">${fmt(a.p)}</span><span class="num muted" style="text-align:right">${fmt(a.v, 0)}</span></div>`).join("")}</div>
      </div><div class="muted small" style="margin-top:6px">盤中約 15–20 秒更新；委買總量大於委賣通常偏多方。</div>`
      : "<div class='empty'>目前無五檔資料（收盤後或資料源未提供）</div>";
  }
  renderDepth(rt);

  // ---- 盤中自動更新：價格頭部 + 五檔 +（當日分時圖）----
  async function liveTick() {
    try {
      const q = (await api(`/api/quotes?symbols=${sid}`))[sid];
      if (!navAlive(gen) || !q || !$("#st-px")) return;
      const npx = bestPx(q), npv = F(q.prev_close);
      if (npx && npv) {
        const nch = npx - npv;
        $("#st-px").textContent = fmt(npx);
        $("#st-chg").textContent = `${sign(nch)}（${sign(nch / npv * 100)}%）`;
        ["st-px", "st-chg"].forEach(id => { const el = $("#" + id); el.className = el.className.replace(/\b(up|down|flat)\b/g, "").trim() + " " + cls(nch); });
      }
      if (q.time) $("#st-time").textContent = "成交 " + q.time;
      renderDepth(q);
      if ($("#ranges .on")?.dataset.r === "當日") { intraCache = null; render(); }
    } catch {}
  }
  show.timer = setInterval(() => { if ($("#st-px")) liveTick(); }, 10000);

  // ---- 籌碼 ----
  api(`/api/stock/${sid}/chips?days=10`).then(c => {
    const byDate = {};
    for (const r of c.institutional) {
      const d = byDate[r.date] ??= { 外資: 0, 投信: 0, 自營: 0 };
      const net = (r.buy - r.sell) / 1000;
      if (r.name.startsWith("Foreign")) d.外資 += net;
      else if (r.name.startsWith("Investment")) d.投信 += net;
      else if (r.name.startsWith("Dealer")) d.自營 += net;
    }
    const dates = Object.keys(byDate).sort().reverse();
    if (!navAlive(gen) || !$("#chips")) return;
    if (!dates.length) { $("#chips").innerHTML = "<div class='empty'>無法人資料</div>"; return; }
    const streak = who => { let n = 0; for (const d of dates) { if (byDate[d][who] > 0) n++; else break; } return n; };
    const sF = streak("外資"), sT = streak("投信");
    const view = dates.slice(0, 7);
    const maxAbs = Math.max(1, ...view.flatMap(d => Object.values(byDate[d]).map(Math.abs)));
    $("#chips").innerHTML =
      (sF >= 2 || sT >= 2 ? `<div style="margin-bottom:8px">${sF >= 2 ? `<span class="streak">外資連買 ${sF} 日</span> ` : ""}${sT >= 2 ? `<span class="streak">投信連買 ${sT} 日</span>` : ""}</div>` : "") +
      view.map(d => {
        const g = byDate[d], retail = -(g.外資 + g.投信 + g.自營);
        const bar = (label, v) => `<div class="barrow"><span class="muted">${label}</span>
          <span><span class="bar" style="width:${Math.min(100, Math.abs(v) / maxAbs * 100)}%;background:var(${v >= 0 ? "--up" : "--down"})"></span></span>
          <span class="num ${cls(v)}" style="text-align:right">${sign(v, 0)} 張</span></div>`;
        return `<div style="margin-bottom:9px"><b class="small num">${esc(d)}</b>${bar("外資", g.外資)}${bar("投信", g.投信)}${bar("自營", g.自營)}${bar("散戶推估", retail)}</div>`;
      }).join("") + "<div class='muted small'>散戶推估 = −(三大法人合計)，僅供參考。</div>";
  }).catch(() => setHTML("#chips", "<div class='empty' role='alert'>籌碼資料載入失敗</div>", gen));

  // ---- 近期股東會 ----
  api(`/api/shareholder-meetings?limit=5000`).then(m => {
    if (!navAlive(gen) || !$("#meetings")) return;
    const items = (m.items || []).filter(x => x.stock_id === sid).sort((a, b) => b.date.localeCompare(a.date));
    $("#meetings").innerHTML = items.length
      ? `<div class="twrap"><table><tr><th>日期</th><th>類型</th><th>時間</th><th>地點</th><th></th></tr>` +
        items.slice(0, 5).map(e => `<tr><td class="num">${esc(e.date)}</td><td>${esc(e.label || "股東會")}</td>
          <td>${esc(e.time || "—")}</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(e.location || "—")}</td>
          <td><a href="https://tw.stock.yahoo.com/quote/${esc(sid)}.TW" target="_blank" rel="noopener" class="btn sm muted" style="white-space:nowrap">📎 公開資訊</a></td></tr>`).join("") + "</table></div>"
      : "<div class='empty'>無股東會紀錄</div>";
  }).catch(() => setHTML("#meetings", "<div class='empty' role='alert'>股東會資料載入失敗</div>", gen));

  // ---- 填息 ----
  api(`/api/stock/${sid}/fill`).then(f => {
    if (!navAlive(gen) || !$("#fill")) return;
    const s = f.summary;
    if (!s.count) { $("#fill").innerHTML = "<div class='empty'>無除權息紀錄</div>"; return; }
    $("#fill").innerHTML = `
      <div class="vchips">
        <span class="vchip">填息機率<b>${fmt(s.fill_rate, 1)}%</b></span>
        <span class="vchip">平均<b>${s.avg_days ?? "—"} 天</b></span>
        <span class="vchip">最快<b>${s.fastest ?? "—"} 天</b></span>
        <span class="vchip">最慢<b>${s.slowest ?? "—"} 天</b></span>
      </div>
      <div class="twrap"><table><tr><th>除息日</th><th class="num-td">息前價</th><th class="num-td">配發</th><th class="num-td">填息</th><th class="num-td">填息日</th></tr>` +
      f.events.slice(0, 8).map(e => `<tr><td class="num">${esc(e.date)}</td><td class="num-td">${fmt(e.before_price)}</td>
        <td class="num-td">${fmt(e.dividend)}</td><td class="num-td ${e.filled ? "up" : "muted"}">${e.filled ? e.fill_days + " 天" : "未填息"}</td>
        <td class="num-td">${e.fill_date ? esc(e.fill_date) : "—"}</td></tr>`).join("") + "</table></div>";
  }).catch(() => setHTML("#fill", "<div class='empty' role='alert'>填息資料載入失敗</div>", gen));

  // ---- 近期新聞 ----
  api(`/api/stock/${sid}/news`).then(n => {
    if (!navAlive(gen) || !$("#news")) return;
    const items = (n.items || []).sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));
    $("#news").innerHTML = items.slice(0, 10).map(i =>
      `<li><a href="${escUrl(i.link)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a><br><span class="muted small">${esc(i.source)}｜${esc(i.pubDate)}</span></li>`).join("") || "<li class='muted'>近一週無相關新聞</li>";
  }).catch(e => { setHTML("#news", `<li class='muted small' role='alert'>新聞載入失敗：${esc(e.message)}</li>`, gen); });

  if (isETF) loadETF(sid, gen);
};

async function loadETF(sid, gen) {
  const [hResult, mxResult] = await Promise.allSettled([api(`/api/etf/${sid}/holdings`), api(`/api/etf/${sid}/metrics`)]);
  const box = $("#etf"), perfBox = $("#etf-perf"), indBox = $("#etf-ind");
  if (!navAlive(gen) || !box) return;
  const h = hResult.status === "fulfilled" ? hResult.value : { latest: null };
  const mx = mxResult.status === "fulfilled" ? mxResult.value : {};
  const latest = h.latest;

  // 📦 成分股持股比例
  box.innerHTML = `
    ${mx.nav ? `<div class="vchips" style="margin-bottom:10px">
      <span class="vchip">預估淨值<b>${fmt(mx.nav)}</b></span>
      ${mx.premium_pct != null ? `<span class="vchip">折溢價<b class="${cls(mx.premium_pct)}">${sign(mx.premium_pct)}%</b></span>` : ""}
      ${mx.holders ? `<span class="vchip">受益人數<b>${fmt(mx.holders, 0)}</b></span>` : ""}
      ${mx.nav_time ? `<span class="muted small">淨值時間 ${esc(mx.nav_time)}</span>` : ""}
    </div>` : ""}
    ${latest && latest.holdings.length ? `<div class="small muted">成分股快照：${esc(latest.date)}（${latest.holdings.length} 檔）</div>
      <div class="twrap"><table><tr><th>代號</th><th>名稱</th><th class="num-td">權重%</th></tr>
      ${latest.holdings.slice(0, 20).map(x => `<tr class="click" data-s="${esc(x.stock_id)}"><td class="num">${esc(x.stock_id)}</td><td>${esc(x.name)}</td><td class="num-td">${fmt(x.weight)}</td></tr>`).join("")}
      ${latest.holdings.length > 20 ? `<tr><td colspan="3" class="muted small">…共 ${latest.holdings.length} 檔</td></tr>` : ""}
      </table></div>` : "<div class='empty'>尚無成分股資料，按下方按鈕抓取</div>"}
    <div class="row" style="margin:10px 0">
      <button class="btn gold sm" id="etf-auto">⚡ 立即抓取成分股</button>
      <input type="file" id="etf-csv" accept=".csv" style="min-height:0;flex:1" />
      <button class="btn sm" id="etf-up">匯入 CSV</button>
    </div>`;

  // 📊 區間績效
  if (perfBox) {
    perfBox.innerHTML = mx.performance
      ? `<div class="twrap"><table><tr><th>期間</th><th class="num-td">績效</th></tr>
        ${Object.entries(mx.performance).map(([k, v]) =>
          `<tr><td>${esc(k)}</td><td class="num-td ${v > 0 ? "up" : v < 0 ? "down" : ""}">${v != null ? (v > 0 ? "▲ " : "▼ ") + fmt(Math.abs(v)) + "%" : "—"}</td></tr>`
        ).join("")}</table></div>`
      : "<div class='empty'>無績效資料</div>";
  }

  // 🏭 行業比重
  if (indBox) {
    indBox.innerHTML = mx.industry && mx.industry.length
      ? `<div class="twrap"><table><tr><th>行業類別</th><th class="num-td">比重</th></tr>
        ${mx.industry.slice(0, 10).map(([cat, w]) =>
          `<tr><td>${esc(cat)}</td><td class="num-td">${fmt(w)}%</td></tr>`
        ).join("")}</table></div>`
      : "<div class='empty'>需先抓取成分股才能計算行業比重</div>";
  }

  $$("#etf tr.click").forEach(tr => bindClickable(tr, () => show("stock", tr.dataset.s)));
  $("#etf-auto").onclick = async () => {
    toast("抓取中…");
    try { const r = await post(`/api/etf/${sid}/fetch_now`, {}); toast(`已更新（${r.count} 檔）`); show("stock", sid); }
    catch (e) { toast(e.message, true, 9000); }
  };
  $("#etf-up").onclick = async () => {
    const f = $("#etf-csv").files[0]; if (!f) return toast("先選擇 CSV", true);
    const fd = new FormData(); fd.append("file", f);
    try {
      const r = await request(`/api/etf/${sid}/holdings/csv`, { method: "POST", body: fd });
      if (!r.ok) return toast("匯入失敗：" + ((await r.json().catch(() => ({}))).detail || r.statusText), true);
      toast("快照已匯入"); show("stock", sid);
    } catch (e) { toast("匯入失敗：" + e.message, true); }
  };
}

/* ============================================================
   排行榜（個股 / ETF 雙頁籤）
============================================================ */
pages.rank = async (_arg, gen) => {
  const sub = pages.rank.sub || "stock";
  main.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <span class="mode-toggle">
        <button id="rk-stock" class="${sub === "stock" ? "on" : ""}">📈 台股排行</button>
        <button id="rk-refresh" class="btn sm" style="margin-left:auto">🔄</button><button id="rk-etf" class="${sub === "etf" ? "on" : ""}">📦 ETF 排行</button>
        <button id="rk-scr" class="${sub === "screen" ? "on" : ""}">🔍 選股</button>
      </span>
    </div>
    <div id="rk-body"></div>`;
  $("#rk-stock").onclick = () => { pages.rank.sub = "stock"; show("rank"); };
  $("#rk-etf").onclick = () => { pages.rank.sub = "etf"; show("rank"); };
  if ($("#rk-refresh")) $("#rk-refresh").onclick = () => show("rank");
  $("#rk-scr").onclick = () => { pages.rank.sub = "screen"; show("rank"); };

  const tbl = (rows, withTime) => rows.length ? `<div class="twrap"><table><tr><th>標的</th><th class="num-td">收盤</th><th class="num-td">幅度</th><th class="num-td">量(張)</th>${withTime ? "<th>觸及/成交</th>" : ""}</tr>` +
    rows.map(r => `<tr class="click" data-s="${esc(r.id)}"><td class="wrap"><b class="num">${esc(r.id)}</b> ${esc(r.name)} <span class="tag">${esc(r.market)}</span></td>
      <td class="num-td ${cls(r.change)}">${fmt(r.close)}</td><td class="num-td ${cls(r.pct)}">${sign(r.pct)}%</td>
      <td class="num-td">${lots(r.volume)}</td>${withTime ? `<td class="small ${r.touch_time ? "up" : "muted"}">${r.touch_time ? "⚡" + esc(r.touch_time) : esc(r.time || "")}</td>` : ""}</tr>`).join("") + "</table></div>"
    : "<div class='empty'>目前沒有符合的標的</div>";
  const bind = () => $$("#rk-body tr.click").forEach(tr => bindClickable(tr, () => show("stock", tr.dataset.s)));

  if (sub === "screen") {
    const TECH = { above_ma5: "站上5日線", above_ma20: "站上20日線", kd_golden: "KD黃金交叉",
      kd_low: "KD低檔(K<20)", macd_turn_red: "MACD柱翻紅", high_20d: "創20日新高", vol_surge: "爆量(>5日均量×2)",
      rsi_oversold: "RSI超賣(<30)", rsi_overbought: "RSI超買(>70)",
      bias_high: "乖離過大(20日>+8%)", bias_low: "乖離超跌(20日<-8%)",
      ma20_streak_5: "站穩20日線5天以上", vol_mild: "溫和放量(量比1.5–2)" };
    let cond = {};
    try { cond = JSON.parse(localStorage.getItem("twpan-screen") || "{}"); } catch {}
    const V = (k, d = "") => cond[k] ?? d;
    $("#rk-body").innerHTML = `
      <div class="card"><h3>📌 已儲存條件</h3><div class="row" id="scr-saved"><span class="muted small">載入中…</span></div></div>
      <div class="card"><h3>🔍 篩選條件（留白＝不限）</h3>
        <div class="frm">
          <label>範圍<select id="f-uni"><option value="all">全部</option><option value="stock">只看個股</option><option value="etf">只看 ETF</option></select></label>
          <label>排序<select id="f-sort"><option value="pct">漲幅高→低</option><option value="-pct">跌幅深→淺</option>
            <option value="volume">量大→小</option><option value="trust_net">投信買超多</option><option value="foreign_net">外資買超多</option></select></label>
          <label>漲跌幅 ≥ %<input id="f-pmin" inputmode="decimal" value="${esc(V("pct_min"))}" placeholder="例 3" /></label>
          <label>漲跌幅 ≤ %<input id="f-pmax" inputmode="decimal" value="${esc(V("pct_max"))}" /></label>
          <label>價格 ≥<input id="f-prmin" inputmode="decimal" value="${esc(V("price_min"))}" /></label>
          <label>價格 ≤<input id="f-prmax" inputmode="decimal" value="${esc(V("price_max"))}" placeholder="例 200" /></label>
          <label>本益比 ≥<input id="f-pemin" inputmode="decimal" value="${esc(V("pe_min"))}" placeholder="例 5" /></label>
          <label>本益比 ≤<input id="f-pemax" inputmode="decimal" value="${esc(V("pe_max"))}" placeholder="例 20" /></label>
          <label>成交量 ≥ 張<input id="f-vol" inputmode="numeric" value="${esc(V("volume_min_lots"))}" placeholder="例 5000" /></label>
          <label>外資買超 ≥ 張<input id="f-fn" inputmode="numeric" value="${esc(V("foreign_net_min"))}" /></label>
          <label>投信買超 ≥ 張<input id="f-tn" inputmode="numeric" value="${esc(V("trust_net_min"))}" placeholder="例 500" /></label>
          <label>外資連買 ≥ 天<input id="f-fs" inputmode="numeric" value="${esc(V("foreign_streak_min"))}" /></label>
          <label>投信連買 ≥ 天<input id="f-ts" inputmode="numeric" value="${esc(V("trust_streak_min"))}" placeholder="例 3" /></label>
        </div>
        <div class="row" style="margin-top:10px">${Object.entries(TECH).map(([k, t]) =>
          `<label class="small"><input type="checkbox" data-tech="${k}" ${(V("tech", []) || []).includes(k) ? "checked" : ""}/> ${t}</label>`).join("")}</div>
        <div class="row" style="margin-top:12px">
          <button class="btn gold" id="scr-run">執行選股</button>
          <input id="scr-name" placeholder="條件名稱" style="width:130px" />
          <button class="btn" id="scr-save">儲存條件</button>
          <span class="muted small">技術條件只檢查初篩前 40 檔（保護免費資料源）</span>
        </div></div>
      <div class="card"><h3>結果</h3><div id="scr-out"><div class="empty">設定條件後按「執行選股」</div></div></div>`;

    const readCond = () => {
      const num = id => { const v = $(id).value.trim(); return v === "" ? null : +v; };
      return { universe: $("#f-uni").value, sort: $("#f-sort").value,
        pct_min: num("#f-pmin"), pct_max: num("#f-pmax"),
        price_min: num("#f-prmin"), price_max: num("#f-prmax"),
        pe_min: num("#f-pemin"), pe_max: num("#f-pemax"),
        volume_min_lots: num("#f-vol"),
        foreign_net_min: num("#f-fn"), trust_net_min: num("#f-tn"),
        foreign_streak_min: num("#f-fs"), trust_streak_min: num("#f-ts"),
        tech: $$("[data-tech]:checked").map(x => x.dataset.tech), limit: 30 };
    };
    $("#f-uni").value = V("universe", "all"); $("#f-sort").value = V("sort", "pct");

    async function runScreen() {
      const out = $("#scr-out");
      if (!navAlive(gen) || !out) return;
      out.innerHTML = "<div class='empty'>篩選中…（含技術條件時會多花幾秒）</div>";
      const c = readCond();
      localStorage.setItem("twpan-screen", JSON.stringify(c));
      try {
        const r = await post("/api/screener/run", { cond: c });
        if (!navAlive(gen) || !$("#scr-out")) return;
        const noteHtml = (r.notes || []).map(x => `<div class="warn small">⚠ ${esc(x)}</div>`).join("");
        $("#scr-out").innerHTML = noteHtml + (r.rows.length
          ? `<div class="muted small" style="margin:4px 0 8px">全市場掃描 ${fmt(r.scanned, 0)} 檔${r.stage2_checked ? `，技術條件檢查 ${r.stage2_checked} 檔` : ""}，命中 ${r.rows.length} 檔</div>
             <div class="twrap"><table><tr><th>標的</th><th class="num-td">收盤</th><th class="num-td">幅度</th><th class="num-td">量(張)</th><th class="num-td">外資</th><th class="num-td">投信</th></tr>` +
            r.rows.map(x => `<tr class="click" data-s="${esc(x.id)}">
              <td class="wrap"><b class="num">${esc(x.id)}</b> ${esc(x.name)} <span class="tag">${esc(x.market)}</span>
                ${(x.tech_hit || []).map(t => `<span class="tag" style="color:var(--accent)">${esc(t)}</span>`).join("")}
                ${x.trust_streak >= 2 ? `<span class="streak">投信連買${x.trust_streak}日</span>` : ""}</td>
              <td class="num-td ${cls(x.change)}">${fmt(x.close)}</td>
              <td class="num-td ${cls(x.pct)}">${sign(x.pct)}%</td>
              <td class="num-td">${lots(x.volume)}</td>
              <td class="num-td ${cls(x.foreign_net)}">${sign(x.foreign_net, 0)}</td>
              <td class="num-td ${cls(x.trust_net)}">${sign(x.trust_net, 0)}</td></tr>`).join("") + "</table></div>"
          : "<div class='empty'>沒有符合全部條件的標的；放寬幾項再試</div>");
        $$("#scr-out tr.click").forEach(tr => bindClickable(tr, () => show("stock", tr.dataset.s)));
      } catch (e) {
        if (navAlive(gen) && $("#scr-out")) $("#scr-out").innerHTML = `<div class='empty' role='alert'>選股失敗：${esc(e.message)}</div>`;
      }
    }
    $("#scr-run").onclick = runScreen;

    async function renderSaved() {
      try {
        const list = await api("/api/screener/saved");
        if (!navAlive(gen) || !$("#scr-saved")) return;
        $("#scr-saved").innerHTML = list.length ? list.map(s =>
          `<span class="pill"><a href="#" data-load="${esc(s.id)}">${esc(s.name)}</a> <a href="#" data-del="${esc(s.id)}">✕</a></span>`).join(" ")
          : "<span class='muted small'>還沒有儲存的條件；設好條件命名後按「儲存條件」</span>";
        $$("#scr-saved [data-load]").forEach(a => a.onclick = async e => {
          e.preventDefault();
          const s = list.find(x => x.id === a.dataset.load);
          localStorage.setItem("twpan-screen", JSON.stringify(s.cond));
          pages.rank.sub = "screen"; show("rank");
          const nextGen = show.generation;
          setTimeout(() => { if (navAlive(nextGen)) $("#scr-run")?.click(); }, 350);
        });
        $$("#scr-saved [data-del]").forEach(a => a.onclick = async e => {
          e.preventDefault(); await del(`/api/screener/saved/${a.dataset.del}`); renderSaved();
        });
      } catch { setHTML("#scr-saved", "<span class='muted small' role='alert'>載入失敗</span>", gen); }
    }
    renderSaved();
    $("#scr-save").onclick = async () => {
      const name = $("#scr-name").value.trim();
      if (!name) return toast("先給條件取個名字", true);
      try { await post("/api/screener/saved", { name, cond: readCond() }); $("#scr-name").value = ""; toast("條件已儲存"); renderSaved(); }
      catch (e) { toast(e.message, true); }
    };
    return;
  }

  if (sub === "stock") {
    $("#rk-body").innerHTML = `<div class="grid2">
      ${["🔴 漲停（依 % 排序，⚡＝首次觸及時間）", "🟢 跌停（依 % 排序）", "漲幅 TOP", "跌幅 TOP", "成交量 TOP", "投信連買（≥2 日）"]
        .map((t, i) => `<div class="card"><h3>${t}</h3><div id="rk-${i}">${skel(4)}</div></div>`).join("")}</div>`;
    api("/api/rankings/limits").then(l => { if (!setHTML("#rk-0", tbl(l.limit_up, true), gen)) return; setHTML("#rk-1", tbl(l.limit_down, true), gen); bind(); })
      .catch(e => { const m = `<div class='empty' role='alert'>載入失敗：${esc(e.message)}</div>`; setHTML("#rk-0", m, gen); setHTML("#rk-1", m, gen); });
    ["gainers", "losers", "volume"].forEach((k, i) =>
      api(`/api/rankings/movers?kind=${k}&limit=15`).then(r => { if (setHTML(`#rk-${i + 2}`, tbl(r), gen)) bind(); })
        .catch(e => { setHTML(`#rk-${i + 2}`, `<div class='empty' role='alert'>載入失敗：${esc(e.message)}</div>`, gen); }));
    api("/api/rankings/trust").then(t => {
      if (!navAlive(gen) || !$("#rk-5")) return;
      $("#rk-5").innerHTML = t.rows.length ? `<div class="twrap"><table><tr><th>標的</th><th class="num-td">連買</th><th class="num-td">累計(張)</th></tr>` +
        t.rows.slice(0, 15).map(r => `<tr class="click" data-s="${esc(r.id)}"><td class="wrap"><b class="num">${esc(r.id)}</b> ${esc(r.name)}</td>
          <td class="num-td up">${r.streak} 日</td><td class="num-td">${fmt(r.total_lots, 0)}</td></tr>`).join("") + "</table></div>"
        : "<div class='empty'>近日資料不足（首次載入較慢屬正常）</div>";
      bind();
    }).catch(e => { setHTML("#rk-5", `<div class='empty' role='alert'>載入失敗：${esc(e.message)}</div>`, gen); });
  } else {
    const hot = ["0050", "0056", "00878", "00929", "00940", "006208"];
    $("#rk-body").innerHTML = `
      <div class="card"><h3>⭐ 熱門 ETF 快速前往（點入看成分股、換股紀錄、重疊比對）</h3>
        <div class="row">${hot.map(s => `<button class="btn sm" data-s="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>
      <div class="grid2">
        ${["🔥 ETF 人氣（成交量）", "ETF 漲幅 TOP", "ETF 跌幅 TOP", "💰 溢價最高（買貴風險）", "🏷 折價最深（可能收斂）"]
          .map((t, i) => `<div class="card"><h3>${t}</h3><div id="rke-${i}">${skel(4)}</div></div>`).join("")}</div>
      <div class="muted small">提示：進入任一 ETF 詳細頁最上方就是成分股與歷次換股（誰進誰出）；「重疊比對」可同時比 2 檔以上的持股重疊。</div>`;
    $$("#rk-body [data-s]").forEach(b => b.onclick = () => show("stock", b.dataset.s));
    const premTbl = rows => rows.length ? `<div class="twrap"><table><tr><th>標的</th><th class="num-td">市價</th><th class="num-td">淨值</th><th class="num-td">折溢價</th></tr>` +
      rows.map(r => `<tr class="click" data-s="${esc(r.id)}"><td class="wrap"><b class="num">${esc(r.id)}</b> ${esc(r.name)}</td>
        <td class="num-td">${fmt(r.close)}</td><td class="num-td">${fmt(r.nav)}</td>
        <td class="num-td ${cls(r.premium_pct)}">${sign(r.premium_pct)}%</td></tr>`).join("") + "</table></div>"
      : "<div class='empty'>暫無淨值資料（來源盤中提供）</div>";
    [["volume", 0], ["gainers", 1], ["losers", 2]].forEach(([k, i]) =>
      api(`/api/rankings/etf?kind=${k}&limit=15`).then(r => { if (setHTML(`#rke-${i}`, tbl(r), gen)) bind(); })
        .catch(e => { setHTML(`#rke-${i}`, `<div class='empty' role='alert'>載入失敗：${esc(e.message)}</div>`, gen); }));
    [["premium", 3], ["discount", 4]].forEach(([k, i]) =>
      api(`/api/rankings/etf?kind=${k}&limit=10`).then(r => { if (setHTML(`#rke-${i}`, premTbl(r), gen)) bind(); })
        .catch(e => { setHTML(`#rke-${i}`, `<div class='empty' role='alert'>載入失敗：${esc(e.message)}</div>`, gen); }));
  }
};

/* ============================================================
   ETF 專區
============================================================ */
pages.etf = async (_arg, gen) => {
  if (!navAlive(gen)) return;
  const popular = ["0050", "0056", "00878", "00919", "00929", "00940", "006208", "00713", "00692", "00881", "00891", "00900"];
  const idx = await api("/api/market/index").catch(() => ({}));
  const tai = idx.taiex || {};
  const tPx = F(tai.price), tPv = F(tai.prev_close), tCh = tPx && tPv ? tPx - tPv : null;
  main.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center"><h1 style="margin:0">💹 ETF 專區</h1><button class="btn sm" onclick="show('etf')">🔄 重新整理</button></div>
      <div class="vchips">
        <span class="vchip">加權指數<b class="${cls(tCh)}">${fmt(tPx, 2)}</b></span>
        ${tCh !== null ? `<span class="vchip ${cls(tCh)}">${sign(tCh, 2)}（${sign(tCh / tPv * 100)}%）</span>` : ""}
      </div>
      <div class="row" style="margin-top:10px">
        <input id="etf-search" placeholder="輸入 ETF 代號或名稱搜尋..." style="flex:1" autocomplete="off" />
        <button class="btn sm gold" id="etf-go">前往</button>
      </div>
    </div>
    <div class="grid2">
      <div class="card"><h3>🔺 ETF 漲停</h3><div id="etf-lup">${skel(3)}</div></div>
      <div class="card"><h3>🔻 ETF 跌停</h3><div id="etf-ldn">${skel(3)}</div></div>
    </div>
    <div class="card"><h3>🔥 熱門 ETF（近期成交量 TOP 12）</h3><div id="etf-grid" class="qgrid">${Array(12).fill('<div class="qcard">' + skel(2) + "</div>").join("")}</div></div>
    <div class="card"><h3>📊 ETF 漲跌幅排行</h3>
      <div class="row" style="margin-bottom:8px" id="emv-wrap">
        <button class="btn sm on" id="emv-g">漲幅%</button><button class="btn sm" id="emv-l">跌幅%</button><button class="btn sm" id="emv-v">成交量</button>
      </div><div id="emv-wrap-tbl">${skel(6)}</div>
    </div>
`;
  const goETF = async () => {
    let q = $("#etf-search").value.trim().toUpperCase();
    if (!q) return;
    if (!/^[0-9]{4,6}[A-Z]{0,2}$/.test(q)) {
      try { const hits = await api(`/api/search?q=${encodeURIComponent(q)}`); if (hits[0]) q = hits[0].id; } catch {}
    }
    show("stock", q);
  };
  $("#etf-go").onclick = goETF;
  $("#etf-search").onkeydown = e => { if (e.key === "Enter") goETF(); };
  // ETF limit up/down
  try {
    const limits = await api("/api/rankings/limits");
    if (navAlive(gen)) {
      const isETF = r => r.id && r.id.startsWith("00") && r.id.length >= 4;
      const etfUp = (limits.limit_up || []).filter(isETF).slice(0, 10);
      const etfDn = (limits.limit_down || []).filter(isETF).slice(0, 10);
      const limTbl = rows => rows.length ? `<div class="twrap"><table><tr><th>代號</th><th>名稱</th><th class="num-td">價格</th><th class="num-td">漲跌%</th></tr>` +
        rows.map(r => `<tr class="click" data-s="${esc(r.id)}"><td class="num">${esc(r.id)}</td><td>${esc(r.name)}</td><td class="num-td">${fmt(r.close)}</td><td class="num-td ${cls(r.pct)}">${sign(r.pct)}%</td></tr>`).join("") + "</table></div>" : "<div class='empty'>今日無 ETF 漲跌停</div>";
      setHTML("#etf-lup", limTbl(etfUp), gen);
      setHTML("#etf-ldn", limTbl(etfDn), gen);
      $$("#etf-lup tr.click, #etf-ldn tr.click").forEach(tr => bindClickable(tr, () => show("stock", tr.dataset.s)));
    }
  } catch {}

  // Popular ETF by volume (dynamic, not hardcoded)
  try {
    const topVol = await api("/api/rankings/etf?kind=volume&limit=12");
    if (!navAlive(gen)) return;
    const symbols = topVol.map(r => r.id);
    const q = symbols.length ? await api(`/api/quotes?symbols=${symbols.join(",")}`) : {};
    $("#etf-grid").innerHTML = topVol.map(r => {
      const qt = q[r.id] || {};
      const px = bestPx(qt) || r.close, pv = F(qt.prev_close) || (r.close - r.change);
      const ch = r.change, pct = r.pct;
      return `<div class="qcard" data-s="${esc(r.id)}" role="button" tabindex="0">
        <div class="hd"><span class="nm">${esc(r.name || r.id)}</span><span class="cd">${esc(r.id)}</span></div>
        <div class="px ${cls(ch)}">${fmt(px)}</div>
        <div class="chg ${cls(ch)}">${ch === null ? "" : sign(ch) + "　" + sign(pct) + "%"}</div>
        <div class="ft"><span>量 ${fmt(r.volume / 1000, 0)} 張</span></div>
      </div>`;
    }).join("") || "<div class='empty'>暫無資料</div>";
    $$(".qcard[data-s]").forEach(c => c.onclick = () => show("stock", c.dataset.s));
  } catch (e) { setHTML("#etf-grid", `<div class='empty'>${esc(e.message)}</div>`, gen); }
  // ETF movers
  let eKind = "gainers";
  async function loadETFMovers() {
    try {
      const data = await api(`/api/rankings/etf?kind=${eKind === "gainers" ? "gainers" : eKind === "losers" ? "losers" : "volume"}&limit=30`);
      if (!navAlive(gen) || !$("#emv-wrap-tbl")) return;
      $("#emv-wrap-tbl").innerHTML = data.length ? `<div class="twrap"><table><tr><th>代號</th><th>名稱</th><th class="num-td">價格</th><th class="num-td">漲跌%</th><th class="num-td">量(張)</th></tr>` +
        data.map(r => `<tr class="click" data-s="${esc(r.id)}"><td class="num">${esc(r.id)}</td><td>${esc(r.name)}</td>
          <td class="num-td">${fmt(r.close)}</td><td class="num-td ${cls(r.pct)}">${sign(r.pct)}%</td>
          <td class="num-td">${fmt(r.volume / 1000, 0)}</td></tr>`).join("") + "</table></div>" : "<div class='empty'>暫無資料</div>";
      $$("#emv-wrap-tbl tr.click").forEach(tr => bindClickable(tr, () => show("stock", tr.dataset.s)));
    } catch (e) { setHTML("#emv-wrap-tbl", `<div class='empty'>${esc(e.message)}</div>`, gen); }
  }
  [["emv-g", "gainers"], ["emv-l", "losers"], ["emv-v", "volume"]].forEach(([id, k]) => {
    const el = $(`#${id}`);
    if (el) el.onclick = () => { eKind = k; [["emv-g"], ["emv-l"], ["emv-v"]].forEach(([bid]) => $(`#${bid}`)?.classList.remove("on")); el.classList.add("on"); loadETFMovers(); };
  });
  loadETFMovers();
};

/* ============================================================
   使用說明（唯讀資訊儀表板的新手與進階指南）
============================================================ */
pages.help = async (_arg, gen) => {
  if (!navAlive(gen)) return;
  const title = s => esc(s);
  main.innerHTML = `
    <div class="help-page" id="help">
      <section class="card help-hero" aria-labelledby="help-title">
        <h1 id="help-title">${title("使用說明｜從第一次開啟到每日看盤")}</h1>
        <p>這個網站是唯讀的台股／ETF 資訊搜集與儀表板：把行情、技術指標、法人、事件、新聞與社群整理在同一個地方，協助你提出研究問題。系統沒有券商下單或交易執行功能；畫面上的紅綠與「偏多／中性／風險」是資料解讀提示，不是買賣指令，也不是投資建議。</p>
        <div class="help-nav" aria-label="說明章節導覽">
          <a href="#help-start">5 分鐘開始</a><a href="#help-pages">功能地圖</a><a href="#help-concepts">指標白話解釋</a>
          <a href="#help-examples">判讀範例</a><a href="#help-details">功能邊界</a><a href="#help-quality">資料與安全</a><a href="#help-routine">進階流程</a>
        </div>
      </section>

      <section class="help-section" id="help-start" aria-labelledby="help-start-title">
        <h2 id="help-start-title">5 分鐘新手設定 <small>第一次使用照著做即可</small></h2>
        <div class="grid2">
          <div class="card help-card">
            <h3>第一次開啟的 5 步驟</h3>
            <div class="help-step"><span class="num">1</span><div><b>先確認資料狀態</b><span class="muted small">總覽最上方會寫「盤中／收盤」、行情完整度與來源時間。先看這一行，再解讀數字。</span></div></div>
            <div class="help-step"><span class="num">2</span><div><b>建立一個自選清單</b><span class="muted small">到「自選」→「＋清單」，例如命名「入門觀察」。加入 2330、0050 或你想研究的代號；也可以直接輸入公司名稱。</span></div></div>
            <div class="help-step"><span class="num">3</span><div><b>先看個股，不急著看 AI</b><span class="muted small">點自選卡片進個股頁，先看區間、成交量、法人與事件，再決定要不要使用 AI 摘要。</span></div></div>
            <div class="help-step"><span class="num">4</span><div><b>設定提醒與（選填）庫存</b><span class="muted small">個股頁可設「漲到／跌到」提醒；總覽的庫存欄位只是本機損益紀錄，沒有下單功能。</span></div></div>
            <div class="help-step"><span class="num">5</span><div><b>最後才調整設定</b><span class="muted small">設定頁可開啟排程、填 FinMind token 或 AI key。全部都是選填，沒有 key 也能看基本資料。</span></div></div>
          </div>
          <div class="card help-card">
            <h3>畫面速覽（示意，不含真實個人資料）</h3>
            <figure class="help-figure">
              <div class="help-screen" role="img" aria-label="總覽頁示意：左側導覽、四張指標卡與事件、通知卡片">
                <div class="side"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
                <div class="screen-main"><div class="tile"><b></b><span class="spark"></span></div><div class="tile"><b></b><span class="spark"></span></div><div class="tile wide"><b></b><span class="spark"></span></div><div class="tile"><b></b><span class="spark"></span></div><div class="tile"><b></b><span class="spark"></span></div></div>
              </div>
              <figcaption>示意 1：總覽把「市場、事件、日報、通知」放在一起；實際數字會隨來源更新。</figcaption>
            </figure>
            <figure class="help-figure" style="margin-top:10px">
              <div class="help-screen" role="img" aria-label="個股頁示意：主圖、指標切換、估值與輿情區塊">
                <div class="side"><i></i><i></i><i></i><i></i><i></i><i></i></div>
                <div class="screen-main"><div class="tile wide"><b></b><span class="spark"></span></div><div class="tile"><b></b><span class="spark"></span></div><div class="tile"><b></b><span class="spark"></span></div></div>
              </div>
              <figcaption>示意 2：個股頁先看主圖與量，再用下方資料交叉確認；圖表可用手指滑動十字線。</figcaption>
            </figure>
          </div>
        </div>
        <div class="card help-card help-note"><b>台股顏色先記住：</b>本系統沿用台灣市場慣例，<span class="help-badge good">紅色／偏上漲</span>、<span class="help-badge risk">綠色／偏下跌</span>；不同國家或券商介面可能相反。顏色只表示方向，不代表「好」或「壞」。</div>
      </section>

      <section class="help-section" id="help-pages" aria-labelledby="help-pages-title">
        <h2 id="help-pages-title">功能地圖 <small>每個頁面要看什麼、何時使用</small></h2>
        <div class="help-grid three">
          <div class="card help-card"><h3>📊 總覽</h3><p>適合開盤前、盤中快速巡檢、收盤後回顧。</p><ul><li>加權／櫃買指數：先確認大盤環境。</li><li>行情狀態列：辨識盤中、收盤、來源時間與完整度。</li><li>自選漲跌、庫存損益：只做觀察，不會送出交易。</li><li>近 14 天事件、盤後總結、通知中心與快速前往。</li></ul><button class="btn sm" data-go="home">前往總覽</button></div>
          <div class="card help-card"><h3>⭐ 自選</h3><p>把研究標的分組，減少每天重複搜尋。</p><ul><li>可建立多組清單，例如「長期觀察」「ETF」「事件追蹤」。</li><li>卡片可切換 30 日／當日迷你走勢。</li><li>編輯模式移除；比較模式挑 2–6 檔疊圖。</li><li>AI 持股健檢是摘要工具，先確認資料日期與來源。</li></ul><button class="btn sm" data-go="watch">前往自選</button></div>
          <div class="card help-card"><h3>📈 個股</h3><p>用一檔標的的完整資料做交叉檢查。</p><ul><li>3 天到 1 年區間、K 線／線圖、成交量與均線。</li><li>副圖可切換 KD、MACD、RSI、乖離率；主圖可疊布林通道。</li><li>五檔、法人、零股、除息填息、估值、事件與新聞／PTT／Dcard。</li><li>可設定到價提醒與新增自訂事件。</li></ul><button class="btn sm" data-go="stock">查看個股範例</button></div>
          <div class="card help-card"><h3>📅 股東會</h3><p>用月曆查看上市／上櫃公司已公告的股東常會與臨時會。</p><ul><li>可切換月份、全部市場或只看自選股。</li><li>點擊代號可回到個股頁，事件也會出現在個股走勢與總覽近 14 天事件。</li><li>顯示日期、會議性質、時間、地點與電子投票（來源有提供時）。</li><li>資料來自 TWSE／TPEx 官方開放資料；改期或尚未公告時請以公司公告為準。</li></ul><button class="btn sm" data-go="calendar">開啟股東會日曆</button></div>
          <div class="card help-card"><h3>📦 ETF</h3><p>ETF 沿用個股頁入口，輸入 0050、0056 等即可看到 ETF 專區。</p><ul><li>成分股快照、權重與歷次換股（誰進／誰出）。</li><li>可自動抓取，或匯入 <code>stock_id,name,weight</code> CSV。</li><li>多檔 ETF 可做成分股重疊比對。</li><li>顯示預估淨值、折溢價與受益人數；來源沒有資料時會明確降級。</li></ul><button class="btn sm" data-go="stock">查看 ETF 入口</button></div>
          <div class="card help-card"><h3>🏆 排行／選股</h3><p>先用排行找線索，再用選股器縮小研究範圍。</p><ul><li>台股：漲停、跌停、漲跌幅、成交量、投信連買。</li><li>ETF：人氣、漲跌、溢價最高、折價最深。</li><li>選股條件：價量、PE、法人連買、均線、KD、MACD、RSI、20 日新高、爆量、乖離率與量比。</li><li>選股是初篩，不是自動買進名單；結果會標示檢查範圍。</li></ul><button class="btn sm" data-go="rank">前往排行榜</button></div>
          <div class="card help-card"><h3>⚙️ 設定</h3><p>管理資料額度、AI 成本與背景排程。</p><ul><li>AI：選供應商、模型、價格、月預算與自動備援。</li><li>FinMind token：選填，主要用來提高資料來源額度。</li><li>排程：盤中輪詢、ETF 自動抓取、盤後總結、全市場輪掃。</li><li>區網模式才需要 <code>TWSTOCK_TOKEN</code>；權杖只存在目前分頁。</li></ul><button class="btn sm" data-go="ai">前往設定</button></div>
          <div class="card help-card"><h3>📝 日報與 🔔 通知</h3><p>把「今天發生什麼事」留下可回看的摘要。</p><ul><li>日報可由本機規則產生；有 AI key 時才會加強文字摘要。</li><li>站內通知先落地，瀏覽器通知是額外提醒。</li><li>通知包含漲跌停首次觸及、到價提醒、ETF 更新等。</li><li>外部 LINE／Telegram 預設停用，不會自行把資料送出去。</li></ul><button class="btn sm" data-go="home">回到日報區</button></div>
        </div>
      </section>

      <section class="help-section" id="help-concepts" aria-labelledby="help-concepts-title">
        <h2 id="help-concepts-title">指標與資料的白話解釋 <small>先理解「它在回答什麼問題」</small></h2>
        <div class="card help-card help-table">
          <table><thead><tr><th>畫面項目</th><th>它在回答什麼</th><th>常見讀法</th><th>不要怎麼用</th></tr></thead><tbody>
            <tr><td>MA5／MA20</td><td>近期平均價格方向？</td><td>價格在均線上方且均線上彎，通常代表近期動能較強；跌破不等於必跌。</td><td>不要只因「黃金交叉」就忽略成交量、事件與大盤。</td></tr>
            <tr><td>KD（9,3,3）</td><td>收盤在近期區間的相對位置？</td><td>K、D 高檔可能偏熱，低檔可能偏弱；交叉是轉折線索，不是保證。</td><td>超買可以很久，超賣也可能繼續下跌。</td></tr>
            <tr><td>MACD（12,26,9）</td><td>短中期動能正在變強或變弱？</td><td>柱體翻紅／放大代表動能改善；跌破零軸或柱體縮短代表動能轉弱。</td><td>不把單日柱體當成趨勢確定訊號。</td></tr>
            <tr><td>RSI（14）</td><td>最近上漲與下跌的力道比例？</td><td>常見 70 以上偏熱、30 以下偏弱；趨勢盤可能長時間維持極端。</td><td>不把 70 直接當賣出、30 直接當買入。</td></tr>
            <tr><td>BIAS／乖離率</td><td>價格離均線太遠嗎？</td><td>正乖離過大表示短線遠離平均；負乖離過大表示跌深，兩者都要看背景。</td><td>不把「跌深」等同於「一定反彈」。</td></tr>
            <tr><td>BOLL（20,2σ）</td><td>波動範圍正在收斂或擴大？</td><td>帶寬收窄常代表等待方向；沿上軌可能是強勢，也可能是過熱。</td><td>碰上軌不必然反轉，碰下軌不必然止跌。</td></tr>
            <tr><td>成交量／量比</td><td>這次價格變化有多少參與者？</td><td>上漲放量通常比無量上漲更有確認度；下跌放量代表風險需提高。</td><td>不只看量大就追價，先確認是不是消息或換股造成。</td></tr>
            <tr><td>三大法人</td><td>外資、投信、自營商近期偏買還是偏賣？</td><td>連買天數與累計張數是「行為紀錄」；散戶推估只是三大法人合計的反向估算。</td><td>不把法人單日買超當成未來保證。</td></tr>
            <tr><td>估值／本益比 PE</td><td>市場價格相對每股盈餘高不高？</td><td>PE 要和同產業、成長率、景氣循環及公司自身歷史比較。</td><td>低 PE 可能是便宜，也可能是獲利即將下修。</td></tr>
            <tr><td>ETF 折溢價</td><td>市價和估計淨值差多少？</td><td>溢價表示市場買得比淨值高，折價表示低於淨值；絕對值大時先查流動性與來源時間。</td><td>不把折價直接當「撿便宜」，也不把估計 NAV 當即時保證。</td></tr>
            <tr><td>事件／填息</td><td>除息、法說、股東會等日期會不會改變解讀？</td><td>事件前後的價格與量要分開比較；填息統計是歷史紀錄，不是這次預測。</td><td>不把股東會日期當成股價方向，也不把除息當免費報酬。</td></tr>
            <tr><td>新聞／PTT／Dcard 熱度</td><td>市場正在談什麼、情緒是否突然升溫？</td><td>看來源數量、互動與媒體／散戶溫差；熱度飆升先查原文與日期。</td><td>輿情是注意力訊號，不是事實查證，也不是買賣訊號。</td></tr>
          </tbody></table>
        </div>
        <div class="card help-card"><h3>簡化公式小抄</h3><div class="help-formula">漲跌幅 ≈（現價 − 昨收）÷ 昨收 × 100%　｜　折溢價 ≈（市價 − 估計淨值）÷ 估計淨值 × 100%　｜　散戶推估 = −（外資＋投信＋自營）</div><p class="muted small">公式是幫你理解欄位，不代表資料源一定能在每個時點提供完整值；缺值時請看畫面上的來源提示。</p></div>
      </section>

      <section class="help-section" id="help-examples" aria-labelledby="help-examples-title">
        <h2 id="help-examples-title">「偏多／中性／風險」判讀卡與合成範例 <small>示範怎麼組合證據，不是投資建議</small></h2>
        <div class="help-grid three">
          <div class="card help-card"><h3><span class="help-badge good">偏多線索</span>至少要有多項互相支持</h3><ul><li>價格在 MA20 上方，MA20 上彎。</li><li>上漲伴隨量能，MACD 柱體改善。</li><li>法人連買或事件後價格沒有失守關鍵區。</li></ul><p class="muted small">這表示「值得進一步研究」，不是「應該買」。</p></div>
          <div class="card help-card"><h3><span class="help-badge neutral">中性觀察</span>訊號互相打架</h3><ul><li>價格在均線附近，量能普通。</li><li>RSI、KD 位於中間，法人沒有連續方向。</li><li>消息熱度上升但基本資料尚未確認。</li></ul><p class="muted small">做法是設定觀察條件，等資料更新，而不是硬猜方向。</p></div>
          <div class="card help-card"><h3><span class="help-badge risk">風險提示</span>先查資料品質與事件</h3><ul><li>跌破 MA20 且放量，MACD 柱體轉弱。</li><li>高溢價、流動性低或來源時間落後。</li><li>新聞／社群突然爆量但只有單一來源。</li></ul><p class="muted small">「風險」代表降低誤判優先，不是預測一定下跌。</p></div>
        </div>
        <div class="grid2">
          <div class="card help-card"><h3>合成範例 A：2330（教學用假資料）</h3><p><span class="help-badge good">偏多線索</span>假設價格連續 3 天在 MA20 上方，成交量高於近 20 日平均，MACD 柱體連兩日改善，外資連買 3 日；同時沒有重大事件落在明天。</p><p><b>怎麼走下一步：</b>把「量能是否維持、是否守住 MA20、法人是否中斷」加入觀察清單，並查看原始新聞。不要因為四項線索就跳過估值與風險承受度。</p></div>
          <div class="card help-card"><h3>合成範例 B：0050（教學用假資料）</h3><p><span class="help-badge neutral">中性＋需查證</span>假設 ETF 市價略高於估計淨值 1.2%，價格在 MA20 附近，成交量普通；大盤上漲但 ETF 輿情突然升溫。</p><p><b>怎麼走下一步：</b>先確認 NAV 與市價的來源時間、折溢價是否因盤中估值延遲，再比較其他 ETF 的重疊成分與費用。不能只因「0050 是大 ETF」就忽略溢價。</p></div>
        </div>
        <div class="card help-card help-note warn"><b>重要：</b>2330／0050 只是固定示範代號與合成情境，數字不是即時行情，也不代表任何個人持倉。這個網站不提供券商下單、交易執行或交易憑證整合。</div>
      </section>

      <section class="help-section" id="help-details" aria-labelledby="help-details-title">
        <h2 id="help-details-title">目前功能邊界與操作細節 <small>空白、估算或找不到按鈕時先看這裡</small></h2>
        <div class="help-grid">
          <div class="card help-card"><h3>事件、日報與通知的範圍</h3><ul>
            <li>事件目前提供除息、法說會、股東會與自訂事件；「股東會」頁可按月份與自選篩選。</li>
            <li>總覽只顯示最新一份日報；系統會保留近期報告資料，但歷史報告導覽頁仍待開發。</li>
            <li>開啟右上通知中心會一次標記目前通知為已讀；目前沒有單則已讀與永久歷史分頁。</li>
          </ul></div>
          <div class="card help-card"><h3>報價缺失時怎麼判斷</h3><ul>
            <li>個別列若沒有最新報價會顯示「—」；總覽市值可能暫以成本估算，<b>報價缺失不等於損益為零</b>。</li>
            <li>請先看來源時間、行情完整度與資料狀態，再決定是否重新整理；不要把估算數字當成交價。</li>
            <li>當日分時只有在排程器已啟動、且標的位於自選／庫存／提醒監控名單時才會累積；空白可能是監控條件尚未滿足。</li>
          </ul></div>
          <div class="card help-card"><h3>提醒與 AI 的實際流程</h3><ul>
            <li>到價提醒目前是新增／刪除；一次觸發後會帶 ✓。要改價格或停用，請刪除後重新建立。</li>
            <li>AI 設定頁目前沒有「測試 key／連線」按鈕：先用本機規則產生日報，再做一次摘要，最後查看用量與預算。</li>
            <li>API key 會在本機加密，但 AI prompt、新聞與社群內容可能送到你選的外部 LLM；<b>key 本地加密不等於內容不外傳</b>。</li>
          </ul></div>
          <div class="card help-card"><h3>自動備援與免費來源</h3><ul>
            <li>可開啟超額自動備援；目前設定頁只提供啟用／停用，<b>不支援手動排序 fallback_order</b>，實際順序依後端預設。</li>
            <li>新聞、PTT、Dcard、FinMind 等免費來源可能限流或暫時失敗；單一來源失敗時應看降級提示，不要反覆連點。</li>
          </ul></div>
          <div class="card help-card"><h3>ETF CSV 與折溢價</h3><ul>
            <li>CSV 請用 UTF-8，欄位必須是 <code>stock_id,name,weight</code>；目前匯入畫面沒有日期欄位，日期採 API 預設／當日可用資料。</li>
            <li>ETF 折溢價是估計 NAV，約 2 分鐘快取；沒有成交價時可能用買賣一中值估算。≥1% 只代表值得查證，不是可成交價格。</li>
          </ul></div>
          <div class="card help-card"><h3>排行與五檔的解讀邊界</h3><ul>
            <li>技術選股先做初篩，再只檢查前 40 檔；「無命中」不等於全市場都沒有符合條件，請留意 <code>stage2_checked</code> 與來源延遲。</li>
            <li>五檔委買總量大於委賣總量只是弱訊號，可能瞬間撤單，不能當成預測或買賣指令。</li>
          </ul></div>
        </div>
      </section>

      <section class="help-section" id="help-quality" aria-labelledby="help-quality-title">
        <h2 id="help-quality-title">資料新鮮度、來源失敗與安全 <small>遇到空白或警告時怎麼做</small></h2>
        <div class="help-grid">
          <div class="card help-card"><h3>先讀總覽狀態列</h3><ul><li><b>盤中資料</b>：代表目前在交易時段，仍要看「來源 HH:MM:SS」。</li><li><b>收盤／非盤中資料</b>：不是即時行情，畫面會保留最後可用觀測。</li><li><b>行情完整／部分可用</b>：部分標的失敗時，其他區塊仍可使用。</li><li><b>來源暫無資料／尚未設定標的</b>：先檢查清單、網路與來源，不要把空白當成零。</li></ul><button class="btn sm" data-go="home">看總覽狀態列</button></div>
          <div class="card help-card"><h3>外部來源的誠實限制</h3><ul><li>FinMind、TWSE／TPEx、集保、Google News、PTT、Dcard 都可能改版、限流或暫時無資料。</li><li>Dcard 公開 API 常被 Cloudflare 擋住；只會顯示 Dcard 降級提示，新聞、PTT 與其他功能不應一起消失。</li><li>ETF 自動抓取是 best-effort，CSV（<code>stock_id,name,weight</code>）是可靠備援。</li><li>資料卡出現「來源失敗」時，先查看日期與來源時間，再按重新整理；不要反覆連點。</li></ul></div>
          <div class="card help-card"><h3>AI 成本與權杖提醒</h3><ul><li>AI key、FinMind token 會加密存放，介面不回顯完整 key。</li><li>設定頁可輸入牌價、匯率與月預算；達預算會警告，並可自動切換供應商。</li><li>沒有 AI key 仍可使用本機規則日報；不會因為沒設定 key 而失去基本看盤。</li><li>開放區網時才設 <code>TWSTOCK_TOKEN</code>，不要把權杖貼在網址、截圖或聊天訊息。</li></ul><button class="btn sm" data-go="ai">檢查設定</button></div>
        </div>
      </section>

      <section class="help-section" id="help-routine" aria-labelledby="help-routine-title">
        <h2 id="help-routine-title">進階每日看盤建議 <small>把頁面變成可重複的研究流程</small></h2>
        <div class="grid2">
          <div class="card help-card"><h3>開盤前 5–10 分鐘</h3><ol><li>總覽：確認大盤、行情狀態與今日來源時間。</li><li>股東會日曆：先看本月自選股是否有股東常會／臨時會，記下日期與地點。</li><li>事件：查看自選股近 14 天的除息／法說／股東會。</li><li>自選：用 30 日迷你圖找出異常波動，不急著判斷。</li><li>個股：先看昨天收盤、成交量與法人，再讀新聞原文。</li></ol></div>
          <div class="card help-card"><h3>盤中快速巡檢</h3><ol><li>每次只追蹤一批清單，避免免費資料源被連續刷新。</li><li>看價格、五檔與當日分時是否一致；五檔約 15–20 秒更新。</li><li>用排行／選股找候選，再回到個股頁確認，不把排行直接當結論。</li><li>必要時設定到價提醒，讓系統通知你，不必一直盯著畫面。</li></ol></div>
          <div class="card help-card"><h3>收盤後復盤</h3><ol><li>切換 3 天、1 週、1 月與 1 年，看短中期是否同向。</li><li>查看法人、填息、估值與事件；把「價格」和「公司／基金資料」分開。</li><li>產生盤後總結；有 AI 時核對來源，無 AI 時使用本機規則。</li><li>把真正重要的觀察寫成自訂事件，隔天回看是否驗證。</li></ol></div>
          <div class="card help-card"><h3>安全與資料衛生清單</h3><div class="help-checklist"><label><input type="checkbox" disabled /> 我確認總覽來源時間，而不是把收盤資料當即時。</label><label><input type="checkbox" disabled /> 我會點開新聞／PTT 原文，不只看熱度分數。</label><label><input type="checkbox" disabled /> 我不把 API key、FinMind token 或 TWSTOCK_TOKEN 放進截圖。</label><label><input type="checkbox" disabled /> 我知道這是資訊整理工具，沒有下單、交易執行與交易憑證功能。</label></div></div>
        </div>
        <div class="card help-card help-note"><b>建議的最小研究紀錄：</b>日期／來源時間、觀察標的、價格與量、兩個支持證據、兩個風險證據、下一次要確認的條件。這比單看一個紅色箭頭更能避免誤判。</div>
      </section>

      <p class="help-foot">使用說明會隨功能更新；若畫面文字與實際資料狀態不同，請以來源時間、錯誤提示與設定頁狀態為準。這裡提供研究方法，不構成任何投資建議。</p>
    </div>`;
  $$("#help [data-go]").forEach(button => button.onclick = () => {
    const target = button.dataset.go;
    show(target, target === "stock" ? lastStock : undefined);
  });
};

/* ============================================================
   設定（AI 模型 + 排程）
============================================================ */
const PROVIDER_NAMES = { openai: "OpenAI", anthropic: "Claude", gemini: "Gemini", grok: "Grok", groq: "Groq" };
pages.ai = async (_arg, gen) => {
  const [cfg, usage] = await Promise.all([api("/api/settings/llm"), api("/api/ai/usage")]);
  if (!navAlive(gen)) return;
  main.innerHTML = `
    <div class="card"><h3>🧠 模型供應商（key 以本機金鑰加密存放，不回顯）</h3>
      <div class="grid2" id="providers"></div>
      <div class="row" style="margin-top:12px">
        <label>使用中 <select id="active">${Object.keys(PROVIDER_NAMES).map(k => `<option value="${k}" ${cfg.active_provider === k ? "selected" : ""}>${PROVIDER_NAMES[k]}</option>`).join("")}</select></label>
        <label><input type="checkbox" id="fb" ${cfg.auto_fallback ? "checked" : ""}/> 超額自動切換並提醒</label>
        <label>USD→TWD <input id="fx" style="width:70px" value="${esc(cfg.usd_twd)}" /></label>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="grow">FinMind token <input id="fm" type="password" class="grow" placeholder="${cfg.finmind_token ? "已設定" : "選填，提高資料上限"}" autocomplete="new-password" /></label>
        <button class="btn gold" id="save">儲存設定</button>
      </div></div>
    <div class="card"><h3>📊 本月（${esc(usage.month)}）用量與預算</h3><div id="usage"></div>
      <div class="muted small">成本＝tokens × 牌價 × 匯率即時累計；達預算跳提醒並自動切換。開放區網請設環境變數 TWSTOCK_TOKEN（見 README）。</div></div>
    <div class="card"><h3>🔐 本分頁連線安全</h3>
      <div class="row"><span id="auth-state" class="muted small">${appToken ? "已設定本分頁權杖" : "尚未設定本分頁權杖"}</span>
        <button class="btn sm" id="clear-token" ${appToken ? "" : "disabled"}>清除本頁權杖</button></div>
      <div class="muted small" style="margin-top:6px">權杖只放在目前分頁的 sessionStorage，不會出現在網址；清除後下一次讀取受保護資料會再次提示。</div>
    </div>
    <div class="card"><h3>🌐 CORS Proxy 設定</h3>
      <div class="muted small" style="margin-bottom:8px">靜態版需要 Cloudflare Worker 代理 TWSE/TAIFEX API。請參考 README 設定。</div>
      <div class="row">
        <input id="worker-url" placeholder="https://your-worker.workers.dev" class="grow" value="${esc(WORKER_URL)}" />
        <button class="btn gold" id="save-worker">儲存 Proxy</button>
      </div>
      <div class="muted small" style="margin-top:6px">儲存後請重新整理頁面。未設定 Proxy 時部分功能無法使用。</div>
    </div>
    <div class="card"><h3>🛰 背景排程器</h3><div class="muted small">靜態版無背景排程器。當日分時圖需要本機 server 版本才能使用。</div></div>`;

  $("#save-worker").onclick = () => {
    const url = $("#worker-url").value.trim();
    localStorage.setItem("twpan-worker", url);
    toast("Proxy URL 已儲存，請重新整理頁面");
  };

  $("#clear-token").onclick = () => {
    appToken = "";
    try { sessionStorage.removeItem("twstock-token"); } catch {}
    $("#auth-state").textContent = "尚未設定本分頁權杖";
    $("#clear-token").disabled = true;
    toast("已清除本頁權杖");
  };

  $("#providers").innerHTML = Object.entries(cfg.providers).map(([k, p]) => `
    <div class="provider ${cfg.active_provider === k ? "active" : ""}" data-p="${k}">
      <b>${PROVIDER_NAMES[k]}</b>
      <div class="prow"><span class="muted small">API key</span><input class="f-key" type="password" placeholder="${p.api_key ? "已設定" : "未設定"}" autocomplete="new-password" /></div>
      <div class="prow"><span class="muted small">模型</span><input class="f-model" value="${esc(p.model)}" /></div>
      <div class="prow"><span class="muted small">價 in/out</span><span class="row" style="gap:4px"><input class="f-in" style="width:64px" value="${esc(p.in_price)}" /> / <input class="f-out" style="width:64px" value="${esc(p.out_price)}" /></span></div>
      <div class="prow"><span class="muted small">月預算 NT$</span><input class="f-budget" style="width:90px" value="${esc(p.monthly_budget_twd)}" /></div>
    </div>`).join("");

  $("#usage").innerHTML = Object.entries(usage.providers).map(([k, u]) => {
    const pctUsed = u.budget_twd ? Math.min(100, u.cost_twd / u.budget_twd * 100) : 0;
    return `<div style="margin-bottom:10px"><b>${PROVIDER_NAMES[k]}</b>
      <span class="muted small"> in ${fmt(u.in, 0)}｜out ${fmt(u.out, 0)}｜NT$${fmt(u.cost_twd)}／${fmt(u.budget_twd, 0)} ${u.has_key ? "" : "（未設 key）"}</span>
      ${u.over_budget ? "<span class='warn'>⚠ 已達上限</span>" : ""}
      <div class="usagebar"><i class="${u.over_budget ? "over" : ""}" style="width:${pctUsed}%"></i></div></div>`;
  }).join("");

  $("#save").onclick = async () => {
    const providers = {};
    $$(".provider").forEach(el => {
      const key = $(".f-key", el).value.trim();
      providers[el.dataset.p] = { ...(key ? { api_key: key } : {}),
        model: $(".f-model", el).value.trim(),
        in_price: +$(".f-in", el).value, out_price: +$(".f-out", el).value,
        monthly_budget_twd: +$(".f-budget", el).value };
    });
    const fm = $("#fm").value.trim();
    try {
      await put("/api/settings/llm", { active_provider: $("#active").value, auto_fallback: $("#fb").checked,
        usd_twd: +$("#fx").value, providers, ...(fm ? { finmind_token: fm } : {}) });
      toast("已儲存並加密"); setTimeout(() => show("ai"), 500);
    } catch (e) { toast("儲存失敗：" + e.message, true); }
  };

  // 靜態版無排程器
};

{ const r = _parseHash(); show(r.page, r.arg); };
