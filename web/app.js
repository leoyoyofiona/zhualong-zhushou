/* 抓龙助手 · 前端逻辑 */
"use strict";

const APP = {
  data: null, plan: null, budget: 100, weights: null,
  sourcePref: "auto",
  sel: {},      // pool -> Map("mid|option" -> item)
  combos: {},   // pool -> [combo]
  zsel: {},     // zucai key -> {issue, rows:[{num,home,away,options:[]}]}
  planLookup: {}, // pool -> Map("mid|option" -> pick)
  settings: {},
  manualCards: new Set(), // 处于"手动模式"的卡片（不显示推荐高亮）
  dateFilter: {},   // pool -> "all" | "YYYY-MM-DD"
  expandPools: {},  // pool -> bool（比分卡展开全部）
  cardPass: {},     // pool -> {mode:"single"|"parlay", M} 卡片过关模式
  passChecked: new Set(), // 过关生成器勾选的场次
  passM: 2,
  passTickets: [],  // 已加入投注单的过关票
  slipCollapsed: false, // 投注单收起状态（手机端默认收起）
  timer: null,
};

const THREE = { h: "胜", d: "平", a: "负" };
const POOL_TITLE = {
  had: "竞彩 · 胜平负", ttg: "竞彩 · 总进球",
  crs: "竞彩 · 比分", hafu: "竞彩 · 半全场",
  zucai14: "胜负彩(14场)", ren9: "任选9场", ban6: "6场半全场", goal4: "4场进球",
};
const JCZQ_POOLS = ["had", "ttg", "crs", "hafu"];
const ZUCAI_KEYS = { 85: "zucai14", 86: "ren9", 87: "ban6", 88: "goal4" };
const ZUCAI_ORDER = ["zucai14", "ren9", "ban6", "goal4"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const keyOf = (mid, option) => `${mid}|${option}`;
const fmt = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function wdOf(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  return isNaN(d) ? "" : WEEK[d.getDay()];
}

/* "2026-08-22 22:00" -> "周六 08-22 22:00" */
function fmtKickoff(kickoff) {
  const m = String(kickoff || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/);
  if (!m) return String(kickoff || "");
  return `${wdOf(m[1] + "-" + m[2] + "-" + m[3])} ${m[2]}-${m[3]} ${m[4]}`;
}

/* "2026-08-22" -> "周六 08-22" */
function fmtDateKey(dk) {
  if (!dk) return "";
  const w = wdOf(dk);
  return `${w} ${dk.slice(5)}`;
}

/* 金额显示：>=1万 显示为 x.x万 */
function fmtMoney(v) {
  v = Number(v) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  return Math.round(v).toLocaleString();
}

/* ---------------- 预计奖金范围 ---------------- */

/* 竞彩单关（固定奖金）：最低=单注最小回报（只中一注），最高=全部命中之和 */
function jczqPrizeRange(pool) {
  const plan = APP.plan.plans[pool] || {};
  const selItems = [...(APP.sel[pool] || new Map()).values()];
  const items = selItems.length ? selItems : (plan.picks || []).filter(p => p.recommended && p.stake > 0);
  if (!items.length) return null;
  const payouts = items.map(it => (Number(it.stake) || 2) * Number(it.odds));
  return { min: Math.min(...payouts), max: payouts.reduce((a, b) => a + b, 0), fixed: true };
}

/* 串关/过关票（固定奖金）：每注2元×组合赔率；最低=单注最小，最高=全部命中 */
function combosPrizeRange(combos) {
  if (!combos || !combos.length) return null;
  const payouts = combos.map(c => (Number(c.stake) || 2) * Number(c.odds));
  return { min: Math.min(...payouts), max: payouts.reduce((a, b) => a + b, 0), fixed: true };
}

/* 传统足彩（奖池玩法）：按中奖难度折算的估算区间（历史常见奖金带 × 难度系数） */
const ZUCAI_PRIZE_BANDS = {
  zucai14: { lo: 30000, hi: 1000000, typ: Math.pow(0.55, 14) }, // 一等奖历史常见区间
  ren9: { lo: 3000, hi: 100000, typ: Math.pow(0.55, 9) },
  ban6: { lo: 2000, hi: 50000, typ: Math.pow(0.25, 6) },
  goal4: { lo: 1000, hi: 30000, typ: Math.pow(0.5, 8) },
};

function zucaiPrizeRange(pool) {
  const r = cardRate(pool);
  if (!r || !r.main) return null;
  const b = ZUCAI_PRIZE_BANDS[pool];
  if (!b) return null;
  const ratio = Math.min(3, Math.max(0.5, b.typ / r.main)); // 越难奖金越高
  return { min: Math.round(b.lo * ratio), max: Math.round(b.hi * ratio), fixed: false };
}

function prizeRangeForPool(pool) {
  if (JCZQ_POOLS.includes(pool)) {
    const cfg = APP.cardPass[pool] || {};
    if (cfg.mode === "parlay") {
      const pc = parlayCompute(pool);
      if (pc && pc.notes) return { min: pc.minP, max: pc.maxP, fixed: true };
    }
    return jczqPrizeRange(pool);
  }
  return zucaiPrizeRange(pool);
}

function prizeHtml(range) {
  if (!range) return "";
  const note = range.fixed ? "" : "（估算）";
  return `<div class="rp-prize">💰 预计奖金${note}：<b>${fmtMoney(range.min)} ~ ${fmtMoney(range.max)} 元</b></div>`;
}

/* ---------------- 数据加载 ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  return res.json();
}

async function loadState() {
  const s = await api("/api/state");
  APP.data = s.data;
  APP.plan = s.plan;
  APP.sourcePref = s.source_pref || "auto";
  APP.weights = APP.weights || (s.defaults && s.defaults.weights);
  renderAll();
}

async function recomputePlan() {
  const r = await api("/api/plan", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budget: APP.budget, weights: APP.weights }),
  });
  if (r.ok && r.plan) {
    APP.plan = r.plan;
    renderAll();
  }
}

function refreshData(pref) {
  const btn = $("btn-refresh");
  btn.textContent = "⟳ 刷新中…";
  btn.disabled = true;
  api("/api/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: pref || APP.sourcePref }),
  }).then(() => {
    const poll = setInterval(async () => {
      const s = await api("/api/state");
      if (!s.refreshing) {
        clearInterval(poll);
        btn.textContent = "⟳ 刷新"; btn.disabled = false;
        APP.data = s.data; APP.plan = s.plan; APP.sourcePref = s.source_pref;
        renderAll();
        toast(s.last_error ? "刷新完成，但有部分源降级" : "数据已刷新");
      }
    }, 1500);
  });
}

function toast(msg) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:70px;left:50%;transform:translateX(-50%);background:#202a3f;border:1px solid #2f81f7;color:#fff;padding:8px 18px;border-radius:8px;z-index:200;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.4)";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ---------------- 渲染 ---------------- */

function renderAll() {
  if (!APP.data || !APP.plan) return;
  buildPlanLookup();
  renderBanners();
  renderCards();
  renderSlip();
}

function renderBanners() {
  const j = APP.data.sources.jczq || {}, z = APP.data.sources.zucai || {};
  const setBadge = (id, src, ok, err) => {
    const el = $(id);
    el.textContent = `${id === "src-jczq" ? "竞彩" : "传统"}源: ${src === "demo" ? "演示数据" : src}`;
    el.className = "src-badge " + (ok ? (src === "demo" ? "warn" : "ok") : "err");
    el.title = err || "";
  };
  setBadge("src-jczq", j.source, j.ok !== false, j.error || "");
  setBadge("src-zucai", z.source, z.ok !== false, z.error || "");
  $("updated-at").textContent = "更新于 " + (APP.data.generated_at || APP.plan.generated_at || "--");

  const demoParts = [];
  if (j.source === "demo") demoParts.push("竞彩足球为演示数据");
  if (z.source === "demo") demoParts.push("传统足彩为演示数据");
  if (z.partial) demoParts.push("部分传统玩法为演示数据");
  const bd = $("banner-demo");
  if (demoParts.length) { bd.textContent = "⚠️ " + demoParts.join("；") + "（官方接口在你的网络下不可用时自动降级；点右上角刷新重试）"; bd.classList.remove("hidden"); }
  else bd.classList.add("hidden");

  const be = $("banner-err");
  const errs = [j.error, z.error].filter(Boolean);
  if (errs.length) { be.textContent = "数据源提示：" + errs.join(" ｜ "); be.classList.remove("hidden"); }
  else be.classList.add("hidden");
}

function buildPlanLookup() {
  APP.planLookup = {};
  for (const pool of JCZQ_POOLS) {
    APP.planLookup[pool] = {};
    for (const p of (APP.plan.plans[pool] || {}).picks || []) {
      APP.planLookup[pool][keyOf(p.id, p.option)] = p;
    }
  }
}

/* ---------------- 预测成功率面板 ---------------- */

function matchPoolProbs(m, pool) {
  /* 该场该玩法 去水概率表 {option: prob} */
  const odds = (m.odds || {})[pool];
  if (!odds) return {};
  let items;
  if (pool === "had") items = ["h", "d", "a"].filter(k => odds[k] != null).map(k => [THREE[k], Number(odds[k])]);
  else items = odds.map(o => [o.label, Number(o.odds)]);
  const inv = items.map(([lb, o]) => [lb, 1 / o]).filter(([, v]) => v > 0);
  const s = inv.reduce((a, [, v]) => a + v, 0);
  if (!s) return {};
  const out = {};
  for (const [lb, v] of inv) out[lb] = v / s;
  return out;
}

function rowHitProb(pool, key, options) {
  /* 某场次（复式）选中的选项概率之和；key: 场次序号 或 "序号-主/客" */
  const plan = APP.plan.plans[pool] || {};
  const isGoal4 = pool === "goal4";
  const [matchNum, side] = isGoal4 ? String(key).split("-") : [String(key), null];
  const pk = (plan.picks || []).find(p => String(p.num) === matchNum && (!isGoal4 || p.side === side));
  if (!pk) return null;
  const probs = pk.probs || {};
  const M = { 胜: "h", 平: "d", 负: "a" };
  let sum = 0;
  for (const o of options) {
    const key2 = (pool === "zucai14" || pool === "ren9") ? (M[o] || o) : o;
    sum += probs[key2] || 0;
  }
  return sum > 0 ? sum : null;
}

function cardRate(pool) {
  /* 返回 {main, avg, count, combos} 或 null */
  if (JCZQ_POOLS.includes(pool)) {
    // 卡片过关模式：单注平均命中率（枚举所有注，取每注概率均值）
    const cfg = APP.cardPass[pool] || {};
    if (cfg.mode === "parlay") {
      const pc = parlayCompute(pool);
      if (!pc || pc.notes <= 0) return null;
      const matchesMap = new Map(APP.data.jczq.matches.map(m => [m.id, m]));
      let sum = 0, cnt = 0;
      for (const c of combos(pc.matches, pc.M)) {
        for (const pick of cartesian(c.map(e => e.options))) {
          let p = 1;
          for (const o of pick) {
            const probs = matchPoolProbs(matchesMap.get(o.mid), pool);
            p *= probs[o.option] || 0.005;
          }
          sum += p; cnt++;
        }
      }
      return { main: cnt ? sum / cnt : null, avg: cnt ? sum / cnt : null, count: cnt, combos: [] };
    }
    const plan = APP.plan.plans[pool] || {};
    const selItems = [...(APP.sel[pool] || new Map()).values()];
    const items = selItems.length ? selItems : (plan.picks || []).filter(p => p.recommended && p.stake > 0);
    const rates = [];
    for (const it of items) {
      let p = (APP.planLookup[pool] || {})[keyOf(it.mid, it.option)] && (APP.planLookup[pool])[keyOf(it.mid, it.option)].prob;
      if (p == null) {
        const m = APP.data.jczq.matches.find(x => x.id === it.mid);
        if (m) p = matchPoolProbs(m, pool)[it.option];
      }
      if (p != null) rates.push(p);
    }
    const comboProbs = (APP.combos[pool] || []).map(c => c.prob).filter(Boolean);
    if (!rates.length && !comboProbs.length) return null;
    const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
    return { main: avg, avg, count: rates.length, combos: comboProbs };
  }
  // 传统足彩：整票全中概率 = 各场次选中概率之和的乘积
  const issue = zucaiIssue(pool);
  const sel = APP.zsel[pool];
  const plan = APP.plan.plans[pool] || {};
  let entries = [];
  if (sel && Object.keys(sel.rows || {}).length) {
    entries = Object.entries(sel.rows).filter(([, r]) => (r.options || []).length);
  } else if (pool === "goal4") {
    entries = (plan.picks || []).filter(p => (p.options || []).length).map(p => [`${p.num}-${p.side}`, { options: p.options }]);
  } else {
    entries = (plan.picks || []).filter(p => (p.options || []).length).map(p => [String(p.num), { options: p.options }]);
  }
  if (!entries.length) return null;
  const per = [];
  for (const [key, r] of entries) {
    const hp = rowHitProb(pool, key, r.options);
    if (hp != null) per.push(hp);
  }
  if (!per.length) return null;
  const main = per.reduce((a, b) => a * b, 1);
  return { main, avg: per.reduce((a, b) => a + b, 0) / per.length, count: per.length, combos: [] };
}

function ratePanelHtml(pool) {
  const r = cardRate(pool);
  const prize = prizeHtml(prizeRangeForPool(pool));
  if (!r) {
    return `<div class="rate-panel"><span class="rp-title">📊 预测成功率</span><span class="rp-none">待选择</span>${prize}</div>`;
  }
  const fmtPct = (x) => {
    const v = x * 100;
    if (v >= 10) return v.toFixed(1) + "%";
    if (v >= 0.1) return v.toFixed(2) + "%";
    return "<0.1%";
  };
  const pct = r.main * 100;
  const cls = pct >= 50 ? "good" : pct >= 20 ? "mid" : "low";
  const isZucai = ZUCAI_ORDER.includes(pool);
  const label = isZucai ? "整票全中概率" : "单注平均命中";
  const sub = isZucai
    ? `平均单场 ${(r.avg * 100).toFixed(0)}% · ${r.count}场`
    : `共${r.count}注` + (r.combos && r.combos.length ? ` · 串关 ${r.combos.map(c => fmtPct(c)).join("/")}` : "");
  return `<div class="rate-panel" title="成功率 = 各注概率的均值（单关）或各场次选中概率的乘积（复式），仅衡量推荐的置信度，不代表中奖保证">
    <span class="rp-title">📊 预测成功率</span>
    <span class="rp-bar"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i></span>
    <span class="rp-num ${cls}">${fmtPct(r.main)}</span>
    <span class="rp-sub">${label} · ${sub}</span>
    ${prize}
  </div>`;
}

function renderCards() {
  const host = $("cards");
  host.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const pool of [...JCZQ_POOLS, ...ZUCAI_ORDER]) {
    const card = buildCard(pool);
    if (card) frag.appendChild(card);
  }
  host.appendChild(frag);
}

/* 只重建某一张卡片（避免每次点击全量重渲染，比分/进球卡按钮多时会卡顿） */
function renderCard(pool) {
  const card = buildCard(pool);
  if (!card) return;
  const old = document.querySelector(`#cards .card[data-pool="${pool}"]`);
  if (old) old.replaceWith(card);
}

/* ---------------- 竞彩卡片 ---------------- */

function poolOptions(match, pool) {
  const odds = (match.odds || {})[pool];
  if (!odds) return [];
  if (pool === "had") {
    return ["h", "d", "a"].filter(k => odds[k] != null).map(k => ({ option: THREE[k], odds: odds[k] }));
  }
  return odds.map(o => ({ option: o.label, odds: o.odds }));
}

function buildCard(pool) {
  if (JCZQ_POOLS.includes(pool)) return buildJczqCard(pool);
  return buildZucaiCard(pool);
}

function buildJczqCard(pool) {
  const plan = APP.plan.plans[pool] || { picks: [], combos: [], notes: [] };
  const matches = (APP.data.jczq.matches || []).filter(m => (m.odds || {})[pool]);
  if (!matches.length) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-head"><span class="title">${POOL_TITLE[pool]}</span><span class="tag-demo">当前数据源无此玩法数据</span></div>
      <div class="card-body" style="color:var(--dim);padding:14px">该玩法暂无可用赔率，可在设置里切换数据源。</div>`;
    return card;
  }
  const noteMap = {};
  for (const n of plan.notes || []) noteMap[n.match] = n.text;
  const manual = APP.manualCards.has(pool);

  // 日期筛选（体彩场次按天开售，可点选日期只看当天）
  const dateKeys = [...new Set(matches.map(m => (m.business_date || (m.kickoff || "").slice(0, 10)) || ""))].filter(Boolean).sort();
  const curDate = APP.dateFilter[pool] || "all";
  const shown = curDate === "all" ? matches : matches.filter(m => (m.business_date || (m.kickoff || "").slice(0, 10)) === curDate);
  const chips = `<div class="date-chips">
    <button class="chip ${curDate === "all" ? "on" : ""}" data-date="all">全部</button>
    ${dateKeys.map(dk => `<button class="chip ${curDate === dk ? "on" : ""}" data-date="${dk}">${fmtDateKey(dk)}</button>`).join("")}
    ${pool === "crs" ? `<button class="chip expand ${APP.expandPools.crs ? "on" : ""}" data-expand="crs">${APP.expandPools.crs ? "收起比分" : "展开全部比分"}</button>` : ""}
  </div>`;

  // 过关模式（同一玩法 2~8串1，规则同体彩中心）
  const passCfg = APP.cardPass[pool] || { mode: "single", M: 2 };
  const passModeHtml = `<div class="pass-mode">
    <span class="pm-label">过关:</span>
    <button class="chip ${passCfg.mode === "single" ? "on" : ""}" data-passmode="single">单关</button>
    ${[2, 3, 4, 5, 6, 7, 8].map(m => `<button class="chip ${passCfg.mode === "parlay" && passCfg.M === m ? "on" : ""}" data-passmode="${m}">${m}串1</button>`).join("")}
    <span class="pm-tip">同一玩法最高8串1 · 混合过关最高4串1</span>
  </div><div class="pass-summary">${passSummaryHtml(pool)}</div>`;

  const card = document.createElement("div");
  card.className = "card";
  card.dataset.pool = pool;
  let body = "";
  for (const m of shown) {
    let opts = poolOptions(m, pool);
    if (pool === "crs" && !APP.expandPools.crs) {
      opts = opts.slice().sort((a, b) => {
        const pa = (APP.planLookup.crs || {})[keyOf(m.id, a.option)] || {};
        const pb = (APP.planLookup.crs || {})[keyOf(m.id, b.option)] || {};
        return (pb.prob || 0) - (pa.prob || 0);
      }).slice(0, 6);
    }
    const derived = (m.derived_pools || []).includes(pool);
    const gridCls = pool === "crs" ? "opts crs-grid" : pool === "hafu" ? "opts hafu-grid" : "opts";
    body += `<div class="mrow" data-mid="${esc(m.id)}">
      <div class="mrow-head">
        <span class="tid">${esc(m.id)} ${esc(m.league)}</span>
        <span class="teams">${esc(m.home)} <b style="color:var(--dim)">VS</b> ${esc(m.away)}</span>
        <span class="kickoff">${esc(fmtKickoff(m.kickoff))}</span>
      </div>
      <div class="${gridCls}">${opts.map(o => optHtml(pool, m, o, manual)).join("")}</div>
      ${derived ? `<div class="note-line derive">🛠 赔率为估算值（由胜平负推导）</div>` : ""}
      ${noteMap[m.id] ? `<div class="note-line">💡 ${esc(noteMap[m.id])}</div>` : ""}
    </div>`;
  }
  const combosHtml = (plan.combos || []).length ? renderCombos(pool, plan.combos) : "";
  const spent = plan.spent || 0;
  const manualBadge = manual ? '<span class="tag-manual">手动模式</span>' : "";
  card.innerHTML = `<div class="card-head" data-toggle>
      <span class="title">${POOL_TITLE[pool]}</span>
      ${manualBadge}
      <span class="meta">${shown.length}/${matches.length}场 · 方案${fmt(spent)}元</span>
      <button class="btn small adopt" data-adopt="${pool}">采用推荐</button>
      <button class="btn small manual-btn ${manual ? "active" : ""}" data-manual="${pool}">手动</button>
    </div>
    <div class="card-body">${ratePanelHtml(pool)}${chips}${passModeHtml}${body}${combosHtml}</div>`;
  return card;
}

function optHtml(pool, m, o, manual) {
  const pick = (APP.planLookup[pool] || {})[keyOf(m.id, o.option)];
  const rec = !manual && !!(pick && pick.recommended);
  const sel = (APP.sel[pool] || new Map()).has(keyOf(m.id, o.option));
  const tags = !manual && pick && pick.tags ? pick.tags.map(t => `<span class="tag ${t}">${t}</span>`).join("") : "";
  const label = pool === "ttg" ? o.option + "球" : o.option;
  const cls = ["opt", rec ? "rec" : "", sel ? "sel" : ""].join(" ");
  return `<button class="${cls}" data-pool="${pool}" data-mid="${esc(m.id)}" data-opt="${esc(o.option)}" data-odds="${o.odds}"
      title="概率 ${pick && !manual ? Math.round(pick.prob * 100) : "?"}%">${rec ? "<span class='tags'>" + tags + "</span>" : ""}
      <span class="o">${esc(label)}</span><span class="ov">${fmt(o.odds)}</span></button>`;
}

function renderCombos(pool, combos) {
  let h = `<div class="ticket-line"><b>🎯 过关串关建议（2串1/3串1，可勾选加入）</b>`;
  for (const c of combos) {
    const key = c.match_a + c.match_b + (c.match_c || "");
    const sel = (APP.combos[pool] || []).some(x => x.key === key);
    const parts = [c.match_a, c.match_b];
    if (c.match_c) parts.push(c.match_c);
    h += `<div style="margin-top:4px"><label style="cursor:pointer;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="checkbox" data-combo="${pool}" data-combo-key="${esc(key)}" ${sel ? "checked" : ""}>
      <span>${parts.map(esc).join(" <b>×</b> ")} = <b style="color:var(--gold)">${fmt(c.odds)}</b>（${c.serial}串1，概率 ${Math.round(c.prob * 100)}%）</span></label></div>`;
  }
  return h + "</div>";
}

/* ---------------- 传统足彩卡片 ---------------- */

function zucaiIssue(pool) {
  const gno = { zucai14: 85, ren9: 86, ban6: 87, goal4: 88 }[pool];
  return (APP.data.zucai.issues || []).find(i => i.game_no === gno);
}

function buildZucaiCard(pool) {
  const issue = zucaiIssue(pool);
  if (!issue) return null;
  const plan = APP.plan.plans[pool] || {};
  const matches = issue.matches || [];
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.pool = pool;
  const sel = APP.zsel[pool] || { issue: issue.issue, rows: {} };
  const manual = APP.manualCards.has(pool);
  let body = "";
  for (const m of matches) {
    if (pool === "goal4") { body += buildGoal4Rows(m, sel, plan, manual); continue; }
    if (pool === "ban6") { body += buildBan6Row(m, sel, plan, manual); continue; }
    body += buildZ310Row(pool, m, sel, plan, manual);
  }
  const ticket = computeZucaiTicket(pool);
  const manualBadge = manual ? '<span class="tag-manual">手动模式</span>' : "";
  card.innerHTML = `<div class="card-head" data-toggle>
      <span class="title">${POOL_TITLE[pool]}</span>
      <span class="tag-issue">${esc(issue.issue)}期</span>
      ${issue.demo_fill ? '<span class="tag-demo">演示</span>' : ""}
      ${manualBadge}
      <span class="meta">${matches.length}场</span>
      <button class="btn small adopt" data-adopt="${pool}">采用推荐</button>
      <button class="btn small manual-btn ${manual ? "active" : ""}" data-manual="${pool}">手动</button>
    </div>
    <div class="card-body">${ratePanelHtml(pool)}${body}
      <div class="ticket-line">${ticket}</div>
    </div>`;
  return card;
}

function buildZ310Row(pool, m, sel, plan, manual) {
  const rows = sel.rows || {};
  const cur = rows[m.num] || {};
  const options = cur.options || [];
  const pick = (plan.picks || []).find(p => String(p.num) === String(m.num));
  const labels = ["胜", "平", "负"].map((lb, i) => {
    const odds = (m.euro_odds || {}) ? [m.euro_odds.h, m.euro_odds.d, m.euro_odds.a][i] : null;
    const selCls = options.includes(lb) ? "sel" : "";
    const recCls = !manual && pick && pick.options && pick.options.includes(lb) ? "rec" : "";
    return `<button class="opt ${selCls} ${recCls}" data-zpool="${pool}" data-num="${esc(m.num)}" data-opt="${lb}" data-odds="${odds || ""}">
      <span class="o">${lb}</span><span class="ov">${odds ? fmt(odds) : ""}</span></button>`;
  }).join("");
  const tier = !manual && pick ? `<span class="tier ${pick.tier}">${pick.tier}</span>` : "";
  const best = !manual && pick ? `<span style="color:var(--accent2);font-size:11px">推荐${pick.best}${pick.options.length > 1 ? "/" + pick.options.slice(1).join("/") : ""}</span>` : "";
  return `<div class="zt-row" data-num="${esc(m.num)}">
    <div class="zt-head"><span class="tid">${esc(m.num)} ${esc(m.league)}</span>
      <span class="teams">${esc(m.home)} <b style="color:var(--dim)">VS</b> ${esc(m.away)}</span> ${tier} ${best}
      <span class="kickoff">${esc(m.kickoff)}</span></div>
    <div class="opts">${labels}</div></div>`;
}

function buildBan6Row(m, sel, plan, manual) {
  const rows = sel.rows || {};
  const cur = rows[m.num] || {};
  const options = cur.options || [];
  const pick = (plan.picks || []).find(p => String(p.num) === String(m.num));
  const combos = ["胜", "平", "负"].flatMap(ht => ["胜", "平", "负"].map(ft => `${ht}-${ft}`));
  const cells = combos.map(c => {
    const selCls = options.includes(c) ? "sel" : "";
    const recCls = !manual && pick && pick.options && pick.options.includes(c) ? "rec" : "";
    return `<button class="opt ${selCls} ${recCls}" data-zpool="ban6" data-num="${esc(m.num)}" data-opt="${c}"><span class="o" style="font-size:11px">${c}</span></button>`;
  }).join("");
  return `<div class="zt-row" data-num="${esc(m.num)}">
    <div class="zt-head"><span class="tid">${esc(m.num)} ${esc(m.league)}</span>
      <span class="teams">${esc(m.home)} <b style="color:var(--dim)">VS</b> ${esc(m.away)}</span></div>
    <div class="crs-grid">${cells}</div></div>`;
}

function buildGoal4Rows(m, sel, plan, manual) {
  const rows = sel.rows || {};
  const teams = [["主", m.home], ["客", m.away]];
  let h = "";
  for (const [side, name] of teams) {
    const cur = rows[`${m.num}-${side}`] || {};
    const options = cur.options || [];
    const pick = (plan.picks || []).find(p => String(p.num) === String(m.num) && p.side === side);
    const goals = ["0", "1", "2", "3+"];
    const cells = goals.map(g => {
      const selCls = options.includes(g) ? "sel" : "";
      const recCls = !manual && pick && pick.options && pick.options.includes(g) ? "rec" : "";
      return `<button class="opt ${selCls} ${recCls}" data-zpool="goal4" data-num="${esc(m.num)}-${side}" data-opt="${g}" data-team="${esc(name)}"><span class="o">${g}</span><span class="ov">球</span></button>`;
    }).join("");
    h += `<div class="zt-row" data-num="${esc(m.num)}-${side}">
      <div class="zt-head"><span class="tid">${esc(m.num)} ${esc(m.league)}</span><span>${side}队</span>
        <span class="teams">${esc(name)}</span></div>
      <div class="opts">${cells}</div></div>`;
  }
  return h;
}

function computeZucaiTicket(pool) {
  const issue = zucaiIssue(pool);
  const sel = APP.zsel[pool];
  if (!issue || !sel) return "—";
  const rows = sel.rows || {};
  let notes = 1;
  const counts = Object.values(rows).filter(r => (r.options || []).length > 0);
  if (pool === "ren9") {
    if (counts.length < 9) return `<b style="color:var(--warn)">请选择 9 场（当前 ${counts.length} 场）</b>`;
  }
  for (const r of counts) notes *= r.options.length;
  const stake = notes * 2;
  const budget = (APP.plan.allocs || {})[pool] || 5;
  const over = stake > budget ? `<span style="color:var(--danger)">超出该玩法预算 ${fmt(budget)} 元</span>` : `<span style="color:var(--accent2)">预算 ${fmt(budget)} 元内</span>`;
  return `<b>${pool === "ren9" ? "任选9场" : POOL_TITLE[pool]} ${issue.issue}期</b>：${counts.length} 场参与 · 复式 ${notes} 注 × 2元 = <b style="color:var(--gold)">${fmt(stake)} 元</b> · ${over}`;
}

/* ---------------- 推荐应用 ---------------- */

function applyPoolRec(pool) {
  APP.manualCards.delete(pool); // 采用推荐 = 退出该卡片手动模式
  const plan = APP.plan.plans[pool] || {};
  if (JCZQ_POOLS.includes(pool)) {
    APP.sel[pool] = new Map();
    for (const p of plan.picks || []) {
      if (p.recommended && p.stake > 0) {
        APP.sel[pool].set(keyOf(p.id, p.option), {
          mid: p.id, home: p.home, away: p.away, league: p.league, kickoff: p.kickoff,
          option: p.option, odds: p.odds, stake: p.stake,
        });
      }
    }
    APP.combos[pool] = (plan.combos || []).map(c => ({ ...c, key: c.match_a + c.match_b + (c.match_c || "") }));
    return;
  }
  // 传统足彩
  const issue = zucaiIssue(pool);
  if (!issue) return;
  const sel = { issue: issue.issue, rows: {} };
  const pk = plan.picks || [];
  for (const m of issue.matches || []) {
    if (pool === "goal4") {
      for (const side of ["主", "客"]) {
        const name = side === "主" ? m.home : m.away;
        const p = pk.find(x => String(x.num) === String(m.num) && (x.side === side));
        if (p) sel.rows[`${m.num}-${side}`] = { options: p.options.slice(), team: name };
      }
      continue;
    }
    const p = pk.find(x => String(x.num) === String(m.num));
    if (p && p.options) sel.rows[m.num] = { options: p.options.slice() };
  }
  APP.zsel[pool] = sel;
}

function applyAllRecs() {
  APP.manualCards.clear();
  for (const pool of [...JCZQ_POOLS, ...ZUCAI_ORDER]) applyPoolRec(pool);
  renderCards();
  renderSlip();
  toast("已采用全部推荐方案（可在卡片上修改）");
}

/* 一键推荐：先取"最有把握"模式的方案再全部采用 */
async function applyAllRecsConfident() {
  const btn = $("btn-apply-all");
  const old = btn.textContent;
  btn.textContent = "⏳ 计算最有把握方案…"; btn.disabled = true;
  try {
    const r = await api("/api/plan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget: APP.budget, weights: APP.weights, mode: "confident" }),
    });
    if (r.ok && r.plan) {
      APP.plan = r.plan;
      applyAllRecs();
      toast("已按『最有把握』模式生成推荐方案");
    } else toast("推荐失败：" + (r.error || "请重试"));
  } catch (e) { toast("推荐失败：" + e.message); }
  btn.textContent = old; btn.disabled = false;
}

/* 进入某张卡片的"手动模式"：清掉该卡片投注单里的选择，并隐藏推荐高亮 */
function applyManualPool(pool) {
  if (JCZQ_POOLS.includes(pool)) {
    APP.sel[pool] = new Map();
    APP.combos[pool] = [];
  } else {
    delete APP.zsel[pool];
  }
  APP.manualCards.add(pool);
}

/* 一键采用全部手动：所有卡片进入手动模式，投注单清空，推荐高亮全部隐藏 */
function applyAllManual() {
  for (const pool of [...JCZQ_POOLS, ...ZUCAI_ORDER]) {
    if (JCZQ_POOLS.includes(pool)) {
      APP.sel[pool] = new Map();
      APP.combos[pool] = [];
    } else {
      delete APP.zsel[pool];
    }
    APP.manualCards.add(pool);
  }
  renderCards();
  renderSlip();
  toast("已进入全手动模式：推荐已清空/隐藏，请自行点选");
}

function clearSlip() {
  APP.sel = {}; APP.combos = {}; APP.zsel = {};
  APP.passTickets = []; APP.passChecked = new Set();
  renderCards();
  renderSlip();
}

/* ---------------- 投注单 ---------------- */

/* 从当前竞彩选择按场次分组（过关生成器用；混合过关每场取一种玩法，优先胜平负；
   已设置"过关模式"的卡片不参与混合过关） */
function buildPassSelections() {
  const POOL_ORDER = ["had", "ttg", "hafu", "crs"];
  const byMatch = new Map();
  for (const pool of POOL_ORDER) {
    if (APP.cardPass[pool] && APP.cardPass[pool].mode === "parlay") continue;
    for (const it of (APP.sel[pool] || new Map()).values()) {
      let e = byMatch.get(it.mid);
      if (!e) { e = { mid: it.mid, league: it.league, home: it.home, away: it.away, options: [] }; byMatch.set(it.mid, e); }
      e.options.push({ option: it.option, odds: it.odds, pool });
    }
  }
  const out = [];
  for (const e of byMatch.values()) {
    const pools = [...new Set(e.options.map(o => o.pool))];
    e.pool = POOL_ORDER.find(p => pools.includes(p));
    e.options = e.options.filter(o => o.pool === e.pool);
    out.push(e);
  }
  return out;
}

function* combos(arr, m) {
  if (m === 0) { yield []; return; }
  for (let i = 0; i <= arr.length - m; i++) {
    for (const rest of combos(arr.slice(i + 1), m - 1)) yield [arr[i], ...rest];
  }
}

function cartesian(arrays) {
  return arrays.reduce((acc, arr) => acc.flatMap(a => arr.map(b => [...a, b])), [[]]);
}

/* ---------------- 卡片过关模式（同一玩法 2~8串1，规则同体彩中心） ---------------- */

function jczqSelectionsByMatch(pool) {
  const byMatch = new Map();
  for (const it of (APP.sel[pool] || new Map()).values()) {
    let e = byMatch.get(it.mid);
    if (!e) { e = { mid: it.mid, league: it.league, home: it.home, away: it.away, options: [] }; byMatch.set(it.mid, e); }
    e.options.push({ option: it.option, odds: it.odds, mid: it.mid });
  }
  return [...byMatch.values()];
}

/* 卡片过关票计算：M串1（N场自由过关+复式），注数 = Σ_{C(N,M)} Π(各场选项数)
   超限保护：估算注数 > MAX_NOTES 时停止枚举（防浏览器卡死，体彩单票约1万注上限） */
const MAX_NOTES = 5000;

function estNotes(N, M, maxOpts) {
  let combosCount = 1;
  for (let i = 0; i < M; i++) combosCount = combosCount * (N - i) / (i + 1);
  return combosCount * Math.pow(maxOpts, M);
}

function parlayCompute(pool) {
  const cfg = APP.cardPass[pool] || { mode: "single", M: 2 };
  if (cfg.mode !== "parlay") return null;
  const matches = jczqSelectionsByMatch(pool);
  const M = cfg.M, N = matches.length;
  let notes = 0, minP = Infinity, maxP = 0;
  if (M <= N) {
    const maxOpts = Math.max(...matches.map(e => e.options.length));
    if (estNotes(N, M, maxOpts) > MAX_NOTES) {
      return { M, N, notes: -1, stake: 0, minP: 0, maxP: 0, matches, tooMany: true };
    }
    for (const c of combos(matches, M)) {
      for (const pick of cartesian(c.map(e => e.options))) {
        notes++;
        const payout = 2 * pick.reduce((a, o) => a * Number(o.odds), 1);
        minP = Math.min(minP, payout);
        maxP += payout;
      }
    }
  }
  return { M, N, notes, stake: notes * 2, minP: minP === Infinity ? 0 : minP, maxP, matches };
}

function passSummaryHtml(pool) {
  const cfg = APP.cardPass[pool] || { mode: "single", M: 2 };
  if (cfg.mode !== "parlay") return "";
  const pc = parlayCompute(pool);
  if (!pc) return "";
  if (pc.tooMany) {
    return `<div class="ticket-line" style="color:var(--danger)">过关${cfg.M}串1：已选 ${pc.N} 场，注数将超过 5000 注，请减少场次或每场选项</div>`;
  }
  if (!pc.notes) {
    return `<div class="ticket-line" style="color:var(--danger)">过关${cfg.M}串1：请先在场次上点选选项，至少选 <b>${cfg.M}</b> 场（当前 ${pc.N} 场）</div>`;
  }
  return `<div class="ticket-line">过关${pc.M}串1：已选<b>${pc.N}</b>场 · 复式<b>${pc.notes}注</b> × 2元 = <b style="color:var(--gold)">${fmt(pc.stake)}元</b> · 预计奖金 <b style="color:var(--gold)">${fmtMoney(pc.minP)} ~ ${fmtMoney(pc.maxP)}元</b></div>`;
}

function passCompute() {
  const sel = buildPassSelections();
  const checked = sel.filter(e => APP.passChecked.has(e.mid));
  const M = APP.passM;
  let notes = 0;
  if (M <= checked.length) {
    const maxOpts = Math.max(...checked.map(e => e.options.length));
    if (estNotes(checked.length, M, maxOpts) > MAX_NOTES) {
      return { sel, checked, notes: -1, stake: 0, tooMany: true };
    }
    for (const c of combos(checked, M)) {
      let n = 1;
      for (const e of c) n *= e.options.length;
      notes += n;
    }
  }
  return { sel, checked, notes, stake: notes * 2 };
}

function passGeneratorHtml() {
  const { sel, checked, notes, stake, tooMany } = passCompute();
  if (!sel.length) return "";
  const rows = sel.map(e => {
    const on = APP.passChecked.has(e.mid);
    return `<label class="pass-match ${on ? "on" : ""}">
      <input type="checkbox" data-pass-check="${esc(e.mid)}" ${on ? "checked" : ""}>
      <span>${esc(e.mid)} ${esc(e.league)} ${esc(e.home)} <b style="color:var(--dim)">VS</b> ${esc(e.away)}</span>
      <span class="pm-opts">${e.options.map(o => `${esc(o.option)}@${fmt(o.odds)}`).join(" / ")}</span>
    </label>`;
  }).join("");
  const M = APP.passM;
  const optM = [2, 3, 4].map(m => `<option value="${m}" ${m === M ? "selected" : ""}>${m}串1</option>`).join("");
  const summary = tooMany
    ? `<span style="color:var(--danger)">已选 ${checked.length} 场，注数将超过 5000，请减少场次或选项</span>`
    : `已选 <b id="pass-n">${checked.length}</b> 场 · 注数 <b id="pass-notes">${notes}</b> · 金额 <b id="pass-stake">${fmt(stake)}</b> 元`;
  return `<div class="pass-box">
    <div class="pass-title">🎯 混合过关生成器（跨玩法 · 最高4串1 · 规则同体彩中心，每场限一种玩法）</div>
    <div class="pass-matches">${rows}</div>
    <div class="pass-controls">
      <select id="pass-m">${optM}</select>
      <span>${summary}</span>
      <button id="btn-pass-add" class="btn primary small" ${notes <= 0 ? "disabled" : ""}>加入投注单</button>
    </div>
  </div>`;
}

function renderSlip() {
  const body = $("slip-body");
  const groups = [];
  let total = 0;

  // 竞彩单关（已设过关模式的卡不重复计入单关）
  for (const pool of JCZQ_POOLS) {
    if (APP.cardPass[pool] && APP.cardPass[pool].mode === "parlay") continue;
    const items = [...(APP.sel[pool] || new Map()).values()];
    if (!items.length) continue;
    for (const it of items) total += Number(it.stake) || 0;
    groups.push({ title: `${POOL_TITLE[pool]} · 单关（${items.length}注）`, pool, items });
  }
  // 串关（2串1/3串1）
  for (const pool of JCZQ_POOLS) {
    const cs = APP.combos[pool] || [];
    if (!cs.length) continue;
    for (const c of cs) total += Number(c.stake) || 0;
    const serials = [...new Set(cs.map(c => c.serial || 2))].join("/");
    groups.push({ title: `${POOL_TITLE[pool]} · ${serials}（${cs.length}注）`, pool, combos: cs });
  }
  // 卡片过关票（过关模式）
  for (const pool of JCZQ_POOLS) {
    const cfg = APP.cardPass[pool];
    if (!cfg || cfg.mode !== "parlay") continue;
    const pc = parlayCompute(pool);
    if (!pc || pc.notes <= 0) continue;
    total += pc.stake;
    groups.push({
      title: `${POOL_TITLE[pool]} · 过关${pc.M}串1（${pc.N}场复式） ${pc.notes}注`, pool: "pass",
      passTicket: {
        i: "card-" + pool, M: pc.M, notes: pc.notes, stake: pc.stake, live: pool,
        matches: pc.matches.map(e => ({ mid: e.mid, league: e.league, home: e.home, away: e.away, options: e.options.map(o => o.option) })),
        prize: { min: pc.minP, max: pc.maxP, fixed: true },
      },
    });
  }
  // 传统
  for (const pool of ZUCAI_ORDER) {
    const issue = zucaiIssue(pool);
    const sel = APP.zsel[pool];
    if (!issue || !sel) continue;
    const rows = Object.values(sel.rows || {}).filter(r => (r.options || []).length);
    if (!rows.length) continue;
    let notes = 1;
    for (const r of rows) notes *= r.options.length;
    const stake = notes * 2;
    total += stake;
    groups.push({ title: `${POOL_TITLE[pool]} ${issue.issue}期 · 复式${notes}注`, pool, zucai: { issue: issue.issue, rows: sel.rows, notes, stake } });
  }
  // 过关票（用户自选生成的 M串1）
  for (const [i, t] of APP.passTickets.entries()) {
    total += t.stake;
    groups.push({ title: `过关 · ${t.M}串1（${t.matches.length}场复式） ${t.notes}注`, pool: "pass", passTicket: { i, ...t } });
  }

  const groupsHtml = groups.length ? groups.map(g => {
    let rows = "";
    let prize = null;
    if (g.items) {
      rows = g.items.map(it => `<div class="slip-item" data-slip="${g.pool}" data-key="${esc(keyOf(it.mid, it.option))}">
        <span class="t">${esc(it.mid)} ${esc(it.league)} ${esc(it.home)} <b style="color:var(--dim)">VS</b> ${esc(it.away)} <b>${esc(it.option)}</b>@${fmt(it.odds)}</span>
        <input class="st" type="number" min="2" step="2" value="${it.stake}" data-stake="${g.pool}|${esc(keyOf(it.mid, it.option))}">
        <button class="rm" data-rm="${g.pool}|${esc(keyOf(it.mid, it.option))}">×</button></div>`).join("");
      prize = jczqPrizeRange(g.pool);
    } else if (g.combos) {
      rows = g.combos.map(c => {
        const parts = [c.match_a, c.match_b];
        if (c.match_c) parts.push(c.match_c);
        return `<div class="slip-item" data-slip-combo="${g.pool}" data-combo-key="${esc(c.key)}">
          <span class="t">${parts.map(esc).join(" <b>×</b> ")} = ${fmt(c.odds)}（${c.serial || 2}串1）</span>
          <span class="st" style="width:52px;text-align:center">2元</span>
          <button class="rm" data-rm-combo="${g.pool}|${esc(c.key)}">×</button></div>`;
      }).join("");
      prize = combosPrizeRange(g.combos);
    } else if (g.zucai) {
      rows = `<div class="slip-item"><span class="t">${g.zucai.notes}注 × 2元 = ${fmt(g.zucai.stake)} 元（复式，点击卡片可修改选项）</span>
        <button class="rm" data-rm-zucai="${g.pool}">×</button></div>`;
      prize = zucaiPrizeRange(g.pool);
    } else if (g.passTicket) {
      rows = `<div class="slip-item"><span class="t">${g.passTicket.notes}注 × 2元 = ${fmt(g.passTicket.stake)} 元（${g.passTicket.matches.length}场复式：${g.passTicket.matches.map(e => `${e.mid} ${e.home} VS ${e.away}【${e.options.join("/")}】`).join("；")}）</span>
        <button class="rm" data-rm-pass="${g.passTicket.i}">×</button></div>`;
      prize = g.passTicket.prize || null;
    }
    const prizeLine = prize ? `<div class="slip-prize">💰 预计奖金${prize.fixed ? "" : "（估算）"}：<b>${fmtMoney(prize.min)} ~ ${fmtMoney(prize.max)} 元</b></div>` : "";
    return `<div class="slip-group"><div class="slip-group-title">${esc(g.title)}</div>${rows}${prizeLine}</div>`;
  }).join("") : `<div class="slip-empty">还没有选择任何投注。<br>点卡片上的赔率按钮，或点"一键推荐"。</div>`;

  body.innerHTML = groupsHtml + passGeneratorHtml();

  $("slip-total").textContent = fmt(total);
  const warn = $("slip-warn");
  if (total > APP.budget) { warn.textContent = `⚠ 超出预算 ${fmt(total - APP.budget)} 元`; warn.className = "over"; }
  else { warn.textContent = `≤ 预算 ${APP.budget} 元`; warn.className = "ok"; }
}

function slipText() {
  const lines = [];
  lines.push(`【抓龙助手 · ${APP.data.generated_at.slice(0, 10)}】`);
  const today = APP.data.generated_at;
  for (const pool of JCZQ_POOLS) {
    const items = [...(APP.sel[pool] || new Map()).values()];
    if (items.length) {
      lines.push(`\n—— ${POOL_TITLE[pool]} 单关 ${items.length}注 ${fmt(items.reduce((s, x) => s + (Number(x.stake) || 0), 0))}元 ——`);
      for (const it of items) lines.push(`${it.mid} ${it.league} ${it.home} VS ${it.away}【${it.option}】@${fmt(it.odds)} ×${fmt(it.stake)}元`);
      const pr = jczqPrizeRange(pool);
      if (pr) lines.push(`    💰 预计奖金：${fmtMoney(pr.min)} ~ ${fmtMoney(pr.max)} 元`);
    }
    const cs = APP.combos[pool] || [];
    if (cs.length) {
      const serials = [...new Set(cs.map(c => c.serial || 2))].join("/");
      lines.push(`\n—— ${POOL_TITLE[pool]} 过关 ${serials} ${cs.length}注 ——`);
      for (const c of cs) {
        const parts = [c.match_a, c.match_b];
        if (c.match_c) parts.push(c.match_c);
        lines.push(`${parts.join(" × ")} = ${fmt(c.odds)}（${c.serial || 2}串1）×2元`);
      }
      const pr = combosPrizeRange(cs);
      if (pr) lines.push(`    💰 预计奖金：${fmtMoney(pr.min)} ~ ${fmtMoney(pr.max)} 元`);
    }
  }
  for (const t of APP.passTickets) {
    lines.push(`\n—— 过关 ${t.M}串1（${t.matches.length}场复式） ${t.notes}注 ${fmt(t.stake)}元 ——`);
    for (const e of t.matches) lines.push(`  ${e.mid} ${e.league} ${e.home} VS ${e.away}【${e.options.join("/")}】`);
  }
  for (const pool of ZUCAI_ORDER) {
    const issue = zucaiIssue(pool);
    const sel = APP.zsel[pool];
    if (!issue || !sel) continue;
    const rows = Object.values(sel.rows || {}).filter(r => (r.options || []).length);
    if (!rows.length) continue;
    let notes = 1;
    for (const r of rows) notes *= r.options.length;
    lines.push(`\n—— ${POOL_TITLE[pool]} ${issue.issue}期 复式${notes}注 ${fmt(notes * 2)}元 ——`);
    const teamMap = {};
    for (const m of issue.matches) { teamMap[m.num] = `${m.home} VS ${m.away}`; teamMap[`${m.num}-主`] = m.home; teamMap[`${m.num}-客`] = m.away; }
    for (const [k, r] of Object.entries(sel.rows || {})) {
      if (!(r.options || []).length) continue;
      const t = teamMap[k] || k;
      lines.push(`场${k} ${t}: ${r.options.join("/")}`);
    }
    const pr = zucaiPrizeRange(pool);
    if (pr) lines.push(`    💰 预计奖金（估算，奖池玩法以开奖为准）：${fmtMoney(pr.min)} ~ ${fmtMoney(pr.max)} 元`);
  }
  const total = $("slip-total").textContent;
  lines.push(`\n合计 ${total} 元（预算 ${APP.budget} 元）`);
  return lines.join("\n");
}

function copySlip() {
  const text = slipText();
  const done = () => toast("已复制到剪贴板，可直接粘贴发给彩票店");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败，请手动选择文本"); }
  ta.remove();
}

function pngSlip() {
  const text = slipText();
  const lines = text.split("\n");
  const canvas = $("slip-canvas");
  const ctx = canvas.getContext("2d");
  const W = 1200, LH = 34, pad = 40;
  const H = Math.max(600, pad * 2 + lines.length * LH + 60);
  canvas.width = W; canvas.height = H;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1f2937"; ctx.font = "30px 'PingFang SC', 'Microsoft YaHei', sans-serif";
  let y = pad;
  for (const ln of lines) {
    if (ln.startsWith("【")) { ctx.fillStyle = "#2563eb"; ctx.font = "bold 34px 'PingFang SC','Microsoft YaHei',sans-serif"; }
    else if (ln.startsWith("——")) { ctx.fillStyle = "#2563eb"; ctx.font = "bold 30px 'PingFang SC','Microsoft YaHei',sans-serif"; }
    else if (ln.startsWith("合计")) { ctx.fillStyle = "#b45309"; ctx.font = "bold 32px 'PingFang SC','Microsoft YaHei',sans-serif"; }
    else { ctx.fillStyle = "#1f2937"; ctx.font = "28px 'PingFang SC','Microsoft YaHei',sans-serif"; }
    ctx.fillText(ln, pad, y);
    y += LH;
  }
  const a = document.createElement("a");
  a.download = `抓龙助手_${APP.data.generated_at.slice(0, 10)}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
  toast("截图已生成（保存在下载目录）");
}

function saveSlip() {
  const groups = [];
  for (const pool of JCZQ_POOLS) {
    const items = [...(APP.sel[pool] || new Map()).values()];
    if (items.length) groups.push({ game_type: POOL_TITLE[pool], title: `单关${items.length}注`,
      selections: items.map(it => `${it.mid} ${it.league} ${it.home} VS ${it.away} ${it.option}@${fmt(it.odds)}`),
      stake: items.reduce((s, x) => s + (Number(x.stake) || 0), 0) });
  }
  for (const pool of ZUCAI_ORDER) {
    const issue = zucaiIssue(pool);
    const sel = APP.zsel[pool];
    if (!issue || !sel) continue;
    const rows = Object.values(sel.rows || {}).filter(r => (r.options || []).length);
    if (!rows.length) continue;
    let notes = 1;
    for (const r of rows) notes *= r.options.length;
    groups.push({ game_type: POOL_TITLE[pool], issue: issue.issue, title: `复式${notes}注`,
      selections: Object.entries(sel.rows || {}).filter(([, r]) => (r.options || []).length)
        .map(([k, r]) => `场${k}: ${r.options.join("/")}`), stake: notes * 2 });
  }
  for (const t of APP.passTickets) {
    groups.push({ game_type: `过关${t.M}串1`, issue: "", title: `${t.matches.length}场复式${t.notes}注`,
      selections: t.matches.map(e => `${e.mid} ${e.league} ${e.home} VS ${e.away}【${e.options.join("/")}】`),
      stake: t.stake });
  }
  if (!groups.length) { toast("投注单是空的"); return; }
  const total = groups.reduce((s, g) => s + g.stake, 0);
  api("/api/bet", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bet_date: APP.data.generated_at.slice(0, 10), game_type: "多玩法组合",
      issue: "", title: `方案 ${groups.length} 组`, selections: groups,
      stake: total, odds: "", note: slipText().slice(0, 800) }),
  }).then(r => { if (r.ok) toast("已保存到历史"); else toast("保存失败"); });
}

/* ---------------- 设置 ---------------- */

function openSettings() {
  const s = APP.settings;
  $("modal-settings").classList.remove("hidden");
  const wg = $("weights-grid");
  wg.innerHTML = Object.entries(APP.weights || {}).map(([k, v]) =>
    `<label>${POOL_TITLE[k] || k}<input type="number" step="1" min="0" max="100" data-w="${k}" value="${Math.round(v * 100)}"></label>`).join("");
  document.querySelectorAll('input[name="pref"]').forEach(r => { r.checked = r.value === (APP.sourcePref || "auto"); });
  $("llm-base").value = s.llm_base || "https://api.deepseek.com";
  $("llm-model").value = s.llm_model || "deepseek-chat";
  $("llm-key").value = s.llm_key || "";
  $("llm-result").innerHTML = "";
}

function saveSettings() {
  const weights = {};
  document.querySelectorAll("#weights-grid input[data-w]").forEach(inp => {
    weights[inp.dataset.w] = Math.max(0, Math.min(100, Number(inp.value) || 0)) / 100;
  });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0) { toast("权重之和不能为 0"); return; }
  for (const k in weights) weights[k] = weights[k] / sum;
  APP.weights = weights;
  const pref = document.querySelector('input[name="pref"]:checked').value;
  APP.settings = {
    ...APP.settings,
    llm_base: $("llm-base").value.trim(),
    llm_model: $("llm-model").value.trim(),
    llm_key: $("llm-key").value.trim(),
  };
  localStorage.setItem("zucai_settings", JSON.stringify(APP.settings));
  localStorage.setItem("zucai_weights", JSON.stringify(weights));
  api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, source_pref: pref }) });
  APP.sourcePref = pref;
  $("modal-settings").classList.add("hidden");
  recomputePlan().then(() => toast("设置已保存，方案已按新权重重算"));
}

function llmTest() {
  const cfg = {
    api_key: $("llm-key").value.trim(), base_url: $("llm-base").value.trim(),
    model: $("llm-model").value.trim(),
  };
  const out = $("llm-result");
  out.innerHTML = '<span style="color:var(--dim)">分析中（大模型可能耗时 1-2 分钟）…</span>';
  api("/api/llm", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...cfg, budget: APP.budget }) }).then(r => {
    if (!r.ok) { out.innerHTML = `<div class="err">❌ ${esc(r.error)}</div>`; return; }
    out.innerHTML = `<b style="color:var(--accent2)">✅ 分析完成（${esc(r.model)}）</b>\n` + esc(JSON.stringify(r.result, null, 2));
  }).catch(e => { out.innerHTML = `<div class="err">请求失败: ${esc(e.message)}</div>`; });
}

/* ---------------- 历史 ---------------- */

function openHistory() {
  $("modal-history").classList.remove("hidden");
  loadHistory();
}

async function loadHistory() {
  const r = await api("/api/history");
  const sum = r.summary;
  const hs = $("hstats");
  hs.innerHTML = `<div class="hs"><b>${fmt(sum.total_stake)}</b>累计投入</div>
    <div class="hs ${sum.total_profit >= 0 ? "pos" : "neg"}"><b>${sum.total_profit >= 0 ? "+" : ""}${fmt(sum.total_profit)}</b>累计盈亏</div>
    <div class="hs"><b>${(sum.by_status.win || {}).count || 0}</b>已中</div>
    <div class="hs"><b>${(sum.by_status.lose || {}).count || 0}</b>未中</div>
    <div class="hs"><b>${(sum.by_status.pending || {}).count || 0}</b>待开奖</div>`;
  const tb = $("htbody");
  tb.innerHTML = r.bets.map(b => {
    const status = b.status || "pending";
    const pill = { pending: "待开奖", win: "已中", lose: "未中" }[status];
    let selText = "";
    try { selText = Array.isArray(b.selections) ? b.selections.map(s =>
      typeof s === "string" ? s : `${s.game_type} ${s.title}: ${s.selections.join("；")}`).join("<br>") : ""; } catch (e) { selText = ""; }
    return `<tr data-id="${b.id}">
      <td>${esc(b.bet_date)}</td><td>${esc(b.game_type)}</td><td>${esc(b.issue || "")}</td>
      <td style="max-width:340px">${selText || esc((b.note || "").slice(0, 120))}</td>
      <td>${fmt(b.stake)}</td>
      <td><select data-status="${b.id}"><option value="pending" ${status === "pending" ? "selected" : ""}>待开奖</option>
        <option value="win" ${status === "win" ? "selected" : ""}>已中</option>
        <option value="lose" ${status === "lose" ? "selected" : ""}>未中</option></select></td>
      <td><input type="number" step="0.01" style="width:80px" value="${b.profit || 0}" data-profit="${b.id}"></td>
      <td><button class="btn small" data-save-result="${b.id}">保存</button></td></tr>`;
  }).join("") || '<tr><td colspan="8" style="color:var(--dim);text-align:center">暂无记录</td></tr>';
}

function saveResult(id) {
  const status = document.querySelector(`select[data-status="${id}"]`).value;
  const profit = document.querySelector(`input[data-profit="${id}"]`).value || 0;
  api("/api/result", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status, profit }) }).then(() => { loadHistory(); toast("已保存"); });
}

/* ---------------- 事件 ---------------- */

function bindEvents() {
  $("btn-refresh").onclick = () => refreshData();
  $("btn-apply-all").onclick = applyAllRecsConfident;
  $("btn-apply-manual").onclick = applyAllManual;
  $("btn-clear-slip").onclick = clearSlip;
  $("btn-slip-toggle").onclick = () => {
    APP.slipCollapsed = !APP.slipCollapsed;
    $("slip-panel").classList.toggle("collapsed", APP.slipCollapsed);
    $("btn-slip-toggle").textContent = APP.slipCollapsed ? "展开 ▴" : "收起 ▾";
  };
  $("btn-copy-slip").onclick = copySlip;
  $("btn-png-slip").onclick = pngSlip;
  $("btn-save-slip").onclick = saveSlip;
  $("btn-settings").onclick = openSettings;
  $("btn-history").onclick = openHistory;
  $("btn-save-settings").onclick = saveSettings;
  $("btn-llm-test").onclick = llmTest;
  $("budget-slider").oninput = (e) => {
    const v = Number(e.target.value);
    $("budget-num").value = v;
    setBudget(v);
  };
  $("budget-num").onchange = (e) => {
    let v = Math.max(0, Number(e.target.value) || 0);
    $("budget-num").value = v;
    $("budget-slider").value = Math.min(200, Math.max(50, v));
    setBudget(v);
  };
  document.querySelectorAll(".modal-close").forEach(b => b.onclick = () => $(b.dataset.close).classList.add("hidden"));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => {
    if (e.target === m) m.classList.add("hidden");
  }));

  $("cards").addEventListener("click", (e) => {
    const t = e.target;
    const cardEl = t.closest(".card");
    const pool = cardEl ? cardEl.dataset.pool : null;
    // 关键：用 closest 捕获按钮内部文字（<span>）上的点击，否则点"5球"这类文字无效
    const optBtn = t.closest ? t.closest(".opt") : null;
    if (optBtn) {
      if (optBtn.dataset.pool) toggleJczqSel(optBtn, optBtn.dataset.pool);
      else toggleZucaiSel(optBtn);
      return;
    }
    const adoptBtn = t.closest ? t.closest(".adopt") : null;
    if (adoptBtn) { applyPoolRec(adoptBtn.dataset.adopt); renderCard(adoptBtn.dataset.adopt); renderSlip(); toast("已采用该玩法推荐"); return; }
    const manualBtn = t.closest ? t.closest(".manual-btn") : null;
    if (manualBtn) { applyManualPool(manualBtn.dataset.manual); renderCard(manualBtn.dataset.manual); renderSlip(); toast("已切换为手动模式"); return; }
    const chip = t.closest ? t.closest(".chip") : null;
    if (chip) {
      if (chip.dataset.passmode !== undefined) {
        const v = chip.dataset.passmode;
        APP.cardPass[pool] = v === "single" ? { mode: "single", M: 2 } : { mode: "parlay", M: Number(v) };
        renderCard(pool);
        renderSlip();
        return;
      }
      if (chip.dataset.date !== undefined) {
        APP.dateFilter[pool] = chip.dataset.date;
        renderCard(pool);
      } else if (chip.dataset.expand) {
        APP.expandPools[chip.dataset.expand] = !APP.expandPools[chip.dataset.expand];
        renderCard(pool);
      }
      return;
    }
    const toggle = t.closest("[data-toggle]");
    if (toggle && cardEl) cardEl.classList.toggle("collapsed");
  });

  $("cards").addEventListener("change", (e) => {
    const cb = e.target;
    if (cb.dataset.combo) {
      const pool = cb.dataset.combo, key = cb.dataset.comboKey;
      APP.combos[pool] = APP.combos[pool] || [];
      if (cb.checked) {
        const c = (APP.plan.plans[pool].combos || []).find(x => x.match_a + x.match_b + (x.match_c || "") === key);
        if (c && !APP.combos[pool].some(x => x.key === key)) APP.combos[pool].push({ ...c, key, stake: 2 });
      } else {
        APP.combos[pool] = APP.combos[pool].filter(x => x.key !== key);
      }
      renderSlip();
    }
  });

  $("slip-body").addEventListener("click", (e) => {
    const t = e.target;
    if (t.id === "btn-pass-add") {
      const { checked, notes, stake, M, tooMany } = passCompute();
      if (!notes || notes < 0) { toast(tooMany ? "注数超限，请减少场次" : "没有可生成的过关票"); return; }
      // 预计奖金范围（固定奖金）：每注2元×组合赔率；最低=单注最小，最高=全部命中
      let minP = Infinity, maxP = 0;
      for (const c of combos(checked, M)) {
        const optionSets = c.map(e => e.options);
        for (const pick of cartesian(optionSets)) {
          const payout = 2 * pick.reduce((a, o) => a * Number(o.odds), 1);
          minP = Math.min(minP, payout);
          maxP += payout;
        }
      }
      APP.passTickets.push({
        M, notes, stake,
        prize: { min: minP === Infinity ? 0 : minP, max: maxP, fixed: true },
        matches: checked.map(e => ({ mid: e.mid, league: e.league, home: e.home, away: e.away, options: e.options.map(o => o.option) })),
      });
      renderSlip();
      toast(`已加入过关 ${M}串1（${notes}注 ${fmt(stake)}元）`);
      return;
    }
    if (t.dataset.rmPass !== undefined) {
      const v = t.dataset.rmPass;
      if (v.startsWith("card-")) {
        // 卡片过关票：清空该卡片的场次选择
        const pool = v.slice(5);
        APP.sel[pool] = new Map();
        APP.combos[pool] = [];
        renderCard(pool);
        renderSlip();
        toast("已清空该卡片的选择");
      } else {
        APP.passTickets.splice(Number(v), 1);
        renderSlip();
      }
      return;
    }
    if (t.dataset.rmCombo) {
      const [pool, key] = t.dataset.rmCombo.split("|");
      APP.combos[pool] = (APP.combos[pool] || []).filter(x => x.key !== key);
      renderCard(pool); renderSlip();
    } else if (t.dataset.rmZucai) {
      delete APP.zsel[t.dataset.rmZucai];
      renderCard(t.dataset.rmZucai); renderSlip();
    } else if (t.classList.contains("rm")) {
      const [pool, key] = t.dataset.rm.split("|");
      if (APP.sel[pool]) APP.sel[pool].delete(key);
      renderCard(pool); renderSlip();
    }
  });

  $("slip-body").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.passCheck !== undefined) {
      if (t.checked) APP.passChecked.add(t.dataset.passCheck);
      else APP.passChecked.delete(t.dataset.passCheck);
      renderSlip();
    } else if (t.id === "pass-m") {
      APP.passM = Number(t.value);
      renderSlip();
    }
  });

  $("slip-body").addEventListener("input", (e) => {
    if (e.target.dataset.stake) {
      const [pool, key] = e.target.dataset.stake.split("|");
      const it = APP.sel[pool].get(key);
      if (it) { it.stake = Math.max(0, Number(e.target.value) || 0); renderSlip(); }
    }
  });

  $("htbody").addEventListener("click", (e) => {
    if (e.target.dataset.saveResult) saveResult(e.target.dataset.saveResult);
  });
}

/* 只更新某张卡片的成功率面板（以及传统足彩的注数行），不重建卡片。
   点击选项时用就地切换，避免全卡重建导致点击反馈丢失/吞点击。 */
function updateCardPanel(pool) {
  const cardEl = document.querySelector(`#cards .card[data-pool="${pool}"]`);
  if (!cardEl) return;
  const rp = cardEl.querySelector(".rate-panel");
  if (rp) rp.outerHTML = ratePanelHtml(pool);
  if (JCZQ_POOLS.includes(pool)) {
    const ps = cardEl.querySelector(".pass-summary");
    if (ps) ps.outerHTML = `<div class="pass-summary">${passSummaryHtml(pool)}</div>`;
  }
  if (ZUCAI_ORDER.includes(pool)) {
    const tl = cardEl.querySelector(".ticket-line");
    if (tl) tl.outerHTML = `<div class="ticket-line">${computeZucaiTicket(pool)}</div>`;
  }
}

function toggleJczqSel(btn, pool) {
  const mid = btn.dataset.mid, opt = btn.dataset.opt, odds = Number(btn.dataset.odds);
  const map = APP.sel[pool] || (APP.sel[pool] = new Map());
  const key = keyOf(mid, opt);
  if (map.has(key)) {
    map.delete(key);
    btn.classList.remove("sel");
  } else {
    const m = APP.data.jczq.matches.find(x => x.id === mid);
    if (!m) { toast("该场比赛数据缺失，请刷新后重试"); return; }
    map.set(key, { mid, home: m.home, away: m.away, league: m.league, kickoff: m.kickoff, option: opt, odds, stake: 2 });
    btn.classList.add("sel");
  }
  updateCardPanel(pool);
  renderSlip();
}

function toggleZucaiSel(btn) {
  const pool = btn.dataset.zpool, num = btn.dataset.num, opt = btn.dataset.opt;
  const issue = zucaiIssue(pool);
  if (!issue) return;
  const sel = APP.zsel[pool] || (APP.zsel[pool] = { issue: issue.issue, rows: {} });
  const row = sel.rows[num] || (sel.rows[num] = { options: [] });
  const i = row.options.indexOf(opt);
  if (i >= 0) {
    row.options.splice(i, 1);
    btn.classList.remove("sel");
  } else {
    if (pool === "ren9") {
      const selected = Object.values(sel.rows).filter(r => r.options.length).length;
      if (selected >= 9) { toast("任选9场最多选 9 场"); return; }
    }
    row.options.push(opt);
    btn.classList.add("sel");
  }
  updateCardPanel(pool);
  renderSlip();
}

/* ---------------- 启动 ---------------- */

function setBudget(v) {
  APP.budget = v;
  APP.settings.budget = v;
  try { localStorage.setItem("zucai_settings", JSON.stringify(APP.settings)); } catch (err) {}
  $("budget-slider").value = v;
  $("budget-num").value = v;
  recomputePlan();
}

async function init() {
  try { APP.settings = JSON.parse(localStorage.getItem("zucai_settings") || "{}"); } catch (e) { APP.settings = {}; }
  try { APP.weights = JSON.parse(localStorage.getItem("zucai_weights") || "null") || null; } catch (e) { APP.weights = null; }
  // 兼容旧权重：剔除已移除的"让球胜平负"并重新归一化
  if (APP.weights) {
    delete APP.weights.hhad;
    const s = Object.values(APP.weights).reduce((a, b) => a + b, 0);
    if (s > 0) for (const k in APP.weights) APP.weights[k] = APP.weights[k] / s;
  }
  const budget = Number(APP.settings.budget || 100);
  APP.budget = budget;
  $("budget-slider").value = Math.min(200, Math.max(50, budget));
  $("budget-num").value = budget;
  // 手机端投注单默认收起，避免占太多屏幕
  if (window.innerWidth < 900) {
    APP.slipCollapsed = true;
    $("slip-panel").classList.add("collapsed");
    $("btn-slip-toggle").textContent = "展开 ▴";
  }
  bindEvents();
  await loadState();
  if (APP.weights) recomputePlan();
  APP.timer = setInterval(() => {
    api("/api/state").then(s => {
      if (!s.refreshing && s.updated_at !== (APP.data && APP.data.generated_at)) {
        APP.data = s.data; APP.plan = s.plan;
        renderAll();
      }
    }).catch(() => {});
  }, 120000);
}

init();
