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

/* ---------------- LEO 的作品（GitHub 开源 + Render 线上） ---------------- */
const GH = "https://github.com/leoyoyofiona/";
const WORKS = [
  { name: "世界杯", emoji: "🏆", desc: "2026 世界杯预测 Web 应用", gh: "worldcup-prediction", render: "https://worldcup-prediction-peur.onrender.com" },
  { name: "足彩", emoji: "🎯", desc: "足彩数据分析与投注辅助", gh: "leo-football-lottery", render: "https://leo-football-lottery.onrender.com" },
  { name: "大乐透", emoji: "🎰", desc: "大乐透走势分析与预测面板", gh: "super-lotto-trend-model", render: "https://super-lotto-trend-model.onrender.com" },
  { name: "福彩", emoji: "🧧", desc: "福彩数据分析工具", gh: "leo-welfare-lottery", render: "https://leo-welfare-lottery.onrender.com" },
  { name: "周星弛", emoji: "🎬", desc: "周星驰先生作品欣赏：时间线·人物关系·影迷档案", gh: "stephen-chow-works-mainland", render: "https://stephen-chow-works-mainland.onrender.com" },
  { name: "抓小红书", emoji: "📕", desc: "小红书收藏整理工具", gh: "xiaohongshu-favorites", render: "" },
  { name: "同声传译", emoji: "🗣️", desc: "中英泰同声传译工具", gh: "ZH-EN-TH-translate", render: "" },
  { name: "三下空格翻译", emoji: "⌨️", desc: "打字三下空格即翻译", gh: "triple-space-translator", render: "" },
  { name: "macOS快捷助手", emoji: "🍎", desc: "按住一键，弹出当前应用快捷键", gh: "LEO-MACOS-Shortcut-Assistant", render: "" },
  { name: "yoyo学习", emoji: "🚀", desc: "yoyo 学习成长工具", gh: "yoyo-learning-boost", render: "https://yoyo-learning-boost.onrender.com" },
  { name: "足彩分析", emoji: "📊", desc: "足彩方案助手 · 8种玩法一张面板（本工具）", gh: "zhualong-zhushou", render: "https://zhualong-assistant.onrender.com" },
  { name: "高考志愿填报", emoji: "🎓", desc: "高考志愿填报指南针", gh: "leo-zhiyuan-compass", render: "https://leo-zhiyuan.onrender.com" },
  { name: "今天你笑了吗？", emoji: "😄", desc: "LEO 个人网站：教学·每日文摘·幽默一刻", gh: "dengzhimin-site", render: "https://dengzhimin-site.onrender.com" },
  { name: "浙师大约球", emoji: "🏀", desc: "浙师大教职工约球平台", gh: "zjnu-staff-football", render: "https://zjnu-staff-football.onrender.com" },
  { name: "自动模仿手打字", emoji: "✍️", desc: "自动模仿手打字脚本", gh: "autotype", render: "" },
  { name: "NoType", emoji: "🎙️", desc: "macOS 原生语音输入：实时听写·句子润色", gh: "NoType", render: "" },
  { name: "Learn English Vlog", emoji: "🇬🇧", desc: "LEO 学英语 vlog 视频内容", gh: "leo-videos-2", render: "" },
];

function renderWorksMenu() {
  const panel = $("dd-works-panel");
  if (!panel) return;
  const cards = WORKS.map((w, i) => {
    const links = [`<a href="${GH}${w.gh}" target="_blank" rel="noopener" onclick="event.stopPropagation()">GitHub</a>`];
    if (w.render) links.push(`<a href="${w.render}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🌐 在线</a>`);
    // 外层用 div 而不是 <a>：避免嵌套链接被浏览器解析破坏
    return `<div class="work-card" data-work="${i}" style="animation-delay:${i * 45}ms">
      <div class="work-ico">${w.emoji}</div>
      <div class="work-name">${esc(w.name)}</div>
      <div class="work-desc">${esc(w.desc)}</div>
      <div class="work-links">${links.join("")}</div>
    </div>`;
  }).join("");
  panel.innerHTML = `
    <div class="works-title">🚀 LEO 的作品 · 全部开源在 GitHub，多数已上线 Render</div>
    <div class="works-grid">${cards}</div>
    <div class="coffee">
      <h3>☕ 请 LEO 喝球咖啡</h3>
      <p>喜欢哪个作品？请我喝杯咖啡，继续做更多好玩的工具 🙏</p>
      <div class="qrs">
        <div class="qr"><img src="qr/alipay.jpg" alt="支付宝收款码"><span>支付宝</span></div>
        <div class="qr"><img src="qr/wechat.jpg" alt="微信收款码"><span>微信</span></div>
      </div>
    </div>`;
  // 点击卡片本体 → 打开作品主链接
  panel.addEventListener("click", (e) => {
    const card = e.target.closest(".work-card");
    if (!card) return;
    if (e.target.closest("a")) return;
    const w = WORKS[Number(card.dataset.work)];
    if (w) window.open(w.render || GH + w.gh, "_blank");
  });
}

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

/* ---------------- 体彩票面布局（对齐体彩小程序投注单） ---------------- */
const GAME_SHORT = { had: "胜平负", ttg: "总进球数", crs: "比分", hafu: "半全场" };
const ZUCAI_SHORT = { zucai14: "胜负彩", ren9: "任选9场", ban6: "6场半全场", goal4: "4场进球" };

function pickText(pool, option) {
  let p = option;
  if (pool === "hafu") p = String(option).replace(/-/g, "");
  return p;
}

/* 生成"一张票"的结构化数据：{game, name, issue, serial, multiplier, notes, stake, rows:[{no,teams,game,pick}]} */
function buildTicketBlocks() {
  const blocks = [];
  // ---- 竞彩单关 ----
  for (const pool of JCZQ_POOLS) {
    if (APP.cardPass[pool] && APP.cardPass[pool].mode === "parlay") continue;
    const items = [...(APP.sel[pool] || new Map()).values()];
    if (!items.length) continue;
    blocks.push({
      game: "竞彩足球", name: GAME_SHORT[pool], issue: "",
      serial: "单关", multiplier: 1,
      notes: items.length, stake: items.reduce((s, x) => s + (Number(x.stake) || 0), 0),
      rows: items.map(it => ({
        no: it.mid, teams: `${it.home} VS ${it.away}`,
        game: GAME_SHORT[pool], pick: `${pickText(pool, it.option)}@${fmt(it.odds)}`,
      })),
    });
  }
  // ---- 竞彩串关（2串1/3串1 建议） ----
  for (const pool of JCZQ_POOLS) {
    const cs = APP.combos[pool] || [];
    if (!cs.length) continue;
    const serials = [...new Set(cs.map(c => c.serial || 2))].map(s => `${s}×1`).join("/");
    const rows = [], seen = new Set();
    for (const c of cs) {
      for (const m of c.matches || []) {
        const k = m.id + m.option;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ no: m.id, teams: `${m.home} VS ${m.away}`, game: GAME_SHORT[pool], pick: `${pickText(pool, m.option)}@${fmt(m.odds)}` });
      }
    }
    blocks.push({
      game: "竞彩足球", name: GAME_SHORT[pool], issue: "",
      serial: serials, multiplier: 1,
      notes: cs.length, stake: cs.reduce((s, c) => s + (Number(c.stake) || 0), 0),
      rows,
    });
  }
  // ---- 卡片过关票 ----
  for (const pool of JCZQ_POOLS) {
    const cfg = APP.cardPass[pool];
    if (!cfg || cfg.mode !== "parlay") continue;
    const pc = parlayCompute(pool);
    if (!pc || pc.notes <= 0) continue;
    blocks.push({
      game: "竞彩足球", name: GAME_SHORT[pool], issue: "",
      serial: `${pc.M}×1`, multiplier: 1,
      notes: pc.notes, stake: pc.stake,
      rows: pc.matches.map(e => ({
        no: e.mid, teams: `${e.home} VS ${e.away}`,
        game: GAME_SHORT[pool], pick: e.options.map(o => pickText(pool, o.option)).join("/"),
      })),
    });
  }
  // ---- 混合过关生成器票 ----
  for (const t of APP.passTickets) {
    blocks.push({
      game: "竞彩足球", name: "混合过关", issue: "",
      serial: `${t.M}×1`, multiplier: 1,
      notes: t.notes, stake: t.stake,
      rows: t.matches.map(e => ({
        no: e.mid, teams: `${e.home} VS ${e.away}`,
        game: "", pick: e.options.join("/"),
      })),
    });
  }
  // ---- 传统足彩 ----
  for (const pool of ZUCAI_ORDER) {
    const issue = zucaiIssue(pool);
    const sel = APP.zsel[pool];
    if (!issue || !sel) continue;
    const rows = Object.values(sel.rows || {}).filter(r => (r.options || []).length);
    if (!rows.length) continue;
    let notes = 1;
    for (const r of rows) notes *= r.options.length;
    const rowList = [];
    if (pool === "goal4") {
      const byNum = {};
      for (const [k, r] of Object.entries(sel.rows)) {
        if (!(r.options || []).length) continue;
        const [num, side] = k.split("-");
        byNum[num] = byNum[num] || {};
        byNum[num][side] = r.options.join("/");
      }
      for (const m of issue.matches) {
        const s = byNum[m.num];
        if (!s) continue;
        const pick = `${s["主"] ? "主" + s["主"] : ""} ${s["客"] ? "客" + s["客"] : ""}`.trim();
        rowList.push({ no: `第${m.num}场`, teams: `${m.home} VS ${m.away}`, game: "4场进球", pick });
      }
    } else {
      for (const m of issue.matches) {
        const r = sel.rows[m.num];
        if (!r || !(r.options || []).length) continue;
        rowList.push({
          no: `第${m.num}场`, teams: `${m.home} VS ${m.away}`,
          game: "", pick: r.options.map(o => pool === "ban6" ? pickText("hafu", o) : o).join("/"),
        });
      }
    }
    blocks.push({
      game: ZUCAI_SHORT[pool], name: POOL_TITLE[pool], issue: issue.issue,
      serial: "复式", multiplier: 1,
      notes, stake: notes * 2, rows: rowList,
    });
  }
  return blocks;
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
  // 赔率变化（初盘→临场）非阻塞拉取，用于卡片箭头
  api("/api/odds-moves").then(r => { APP.moves = r.moves || {}; renderCards(); }).catch(() => { APP.moves = {}; });
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
  // 赔率变化箭头（had/hhad 三路：h→胜,d→平,a→负）
  let moveHtml = "";
  if ((pool === "had" || pool === "hhad") && APP.moves && APP.moves[m.id] && APP.moves[m.id][pool]) {
    const kMap = { 胜: "h", 平: "d", 负: "a" };
    const mv = APP.moves[m.id][pool][kMap[o.option]];
    if (mv && mv.dir !== "flat") {
      const hot = mv.dir === "down"; // 赔率下降=受热
      moveHtml = `<span class="mover ${hot ? "hot" : "cold"}">${hot ? "▼" : "▲"}${Math.abs(mv.pct).toFixed(1)}%</span>`;
    }
  }
  const tags = !manual && pick && pick.tags ? pick.tags.map(t => `<span class="tag ${t}">${t}</span>`).join("") : "";
  const label = pool === "ttg" ? o.option + "球" : o.option;
  const cls = ["opt", rec ? "rec" : "", sel ? "sel" : ""].join(" ");
  return `<button class="${cls}" data-pool="${pool}" data-mid="${esc(m.id)}" data-opt="${esc(o.option)}" data-odds="${o.odds}"
      title="概率 ${pick && !manual ? Math.round(pick.prob * 100) : "?"}%">${rec ? "<span class='tags'>" + tags + "</span>" : ""}
      <span class="o">${esc(label)}</span><span class="ov">${fmt(o.odds)}${moveHtml}</span></button>`;
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
  saveSnapshot("apply-recs"); // 预测快照自动归档，供复盘训练
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
    let title = esc(g.title);
    if (g.items) {
      const stake = g.items.reduce((s, x) => s + (Number(x.stake) || 0), 0);
      title = `${GAME_SHORT[g.pool]} · 过关：单关 倍数：1 · ${g.items.length}注 ${fmt(stake)}元`;
      rows = g.items.map(it => `<div class="slip-item ticket-row" data-slip="${g.pool}" data-key="${esc(keyOf(it.mid, it.option))}">
        <span class="t"><b>${esc(it.mid)}</b> ${esc(it.home)} <b style="color:var(--dim)">VS</b> ${esc(it.away)}
          <small>${GAME_SHORT[g.pool]} ${esc(pickText(g.pool, it.option))}@${fmt(it.odds)}</small></span>
        <input class="st" type="number" min="2" step="2" value="${it.stake}" data-stake="${g.pool}|${esc(keyOf(it.mid, it.option))}">
        <button class="rm" data-rm="${g.pool}|${esc(keyOf(it.mid, it.option))}">×</button></div>`).join("");
      prize = jczqPrizeRange(g.pool);
    } else if (g.combos) {
      const serials = [...new Set(g.combos.map(c => c.serial || 2))].map(s => `${s}×1`).join("/");
      title = `${GAME_SHORT[g.pool]} · 过关：${serials} 倍数：1 · ${g.combos.length}注 ${fmt(g.combos.reduce((s, c) => s + (Number(c.stake) || 0), 0))}元`;
      const seen = new Set();
      rows = "";
      for (const c of g.combos) {
        for (const m of c.matches || []) {
          const k = m.id + m.option;
          if (seen.has(k)) continue;
          seen.add(k);
          rows += `<div class="slip-item ticket-row"><span class="t"><b>${esc(m.id)}</b> ${esc(m.home)} <b style="color:var(--dim)">VS</b> ${esc(m.away)}
            <small>${GAME_SHORT[g.pool]} ${esc(pickText(g.pool, m.option))}@${fmt(m.odds)}</small></span></div>`;
        }
      }
      prize = combosPrizeRange(g.combos);
    } else if (g.zucai) {
      const issue = g.zucai.issue;
      title = `${ZUCAI_SHORT[g.pool]} 第${issue}期 · ${POOL_TITLE[g.pool]} · 过关：复式 倍数：1 · ${g.zucai.notes}注 ${fmt(g.zucai.stake)}元`;
      const tm = {};
      const it = zucaiIssue(g.pool);
      for (const m of (it ? it.matches : [])) tm[m.num] = m;
      rows = Object.entries(g.zucai.rows || {}).filter(([, r]) => (r.options || []).length).map(([k, r]) => {
        const m = tm[k] || {};
        const pick = r.options.map(o => g.pool === "ban6" ? pickText("hafu", o) : o).join("/");
        return `<div class="slip-item ticket-row"><span class="t"><b>第${k}场</b> ${esc(m.home || "")} <b style="color:var(--dim)">VS</b> ${esc(m.away || "")}
          <small>${esc(pick)}</small></span></div>`;
      }).join("");
      prize = zucaiPrizeRange(g.pool);
    } else if (g.passTicket) {
      const t = g.passTicket;
      title = `混合过关 · 过关：${t.M}×1 倍数：1 · ${t.notes}注 ${fmt(t.stake)}元`;
      rows = t.matches.map(e => `<div class="slip-item ticket-row"><span class="t"><b>${esc(e.mid)}</b> ${esc(e.home)} <b style="color:var(--dim)">VS</b> ${esc(e.away)}
        <small>${esc(e.options.join("/"))}</small></span>
        <button class="rm" data-rm-pass="${esc(t.i)}">×</button></div>`).join("");
      prize = g.passTicket.prize || null;
    }
    const prizeLine = prize ? `<div class="slip-prize">💰 预计奖金${prize.fixed ? "" : "（估算）"}：<b>${fmtMoney(prize.min)} ~ ${fmtMoney(prize.max)} 元</b></div>` : "";
    return `<div class="slip-group"><div class="slip-group-title">${title}</div>${rows}${prizeLine}</div>`;
  }).join("") : `<div class="slip-empty">还没有选择任何投注。<br>点卡片上的赔率按钮，或点"一键推荐"。</div>`;

  body.innerHTML = groupsHtml + passGeneratorHtml();

  $("slip-total").textContent = fmt(total);
  $("slip-tickets").textContent = buildTicketBlocks().length;
  const warn = $("slip-warn");
  if (total > APP.budget) { warn.textContent = `⚠ 超出预算 ${fmt(total - APP.budget)} 元`; warn.className = "over"; }
  else { warn.textContent = `≤ 预算 ${APP.budget} 元`; warn.className = "ok"; }
}

function slipText() {
  const blocks = buildTicketBlocks();
  const lines = [];
  lines.push(`【抓龙助手 · ${APP.data.generated_at.slice(0, 10)}】`);
  let ticketNo = 0;
  const totalNotes = blocks.reduce((s, b) => s + b.notes, 0);
  const totalStake = blocks.reduce((s, b) => s + b.stake, 0);
  for (const b of blocks) {
    ticketNo += 1;
    lines.push(`\n================ 第 ${ticketNo} 张 ================`);
    lines.push(`${b.game}${b.issue ? " 第" + b.issue + "期" : ""} · ${b.name}`);
    lines.push(`票数注数：1张${b.notes}注    金额：${fmt(b.stake)} 元`);
    lines.push(`过关：${b.serial}    倍数：${b.multiplier}`);
    for (const r of b.rows) {
      lines.push(`${r.no}  ${r.teams}`);
      lines.push(`     ${r.game ? r.game + "  " : ""}${r.pick}`);
    }
  }
  lines.push(`\n合计：${blocks.length} 张 / ${totalNotes} 注 / ${fmt(totalStake)} 元（预算 ${APP.budget} 元）`);
  lines.push("注：明细信息请以彩票票面实际显示为准。");
  lines.push(`保存时间：${APP.data.generated_at}`);
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
  const blocks = buildTicketBlocks();
  const canvas = $("slip-canvas");
  const ctx = canvas.getContext("2d");
  const W = 1000, M = 46, LH = 40;
  const F = "'PingFang SC','Microsoft YaHei',sans-serif";

  // 计算高度：每张票 = 头部区 + 行数*LH*1.4 + 底注
  let totalH = 160;
  for (const b of blocks) {
    totalH += 150 + b.rows.length * 84 + 120;
  }
  const H = Math.max(700, totalH);
  canvas.width = W; canvas.height = H;
  ctx.fillStyle = "#eef2f7"; ctx.fillRect(0, 0, W, H);

  let y = 40;
  // 全局标题
  ctx.fillStyle = "#1f2937"; ctx.font = `bold 40px ${F}`;
  ctx.fillText("抓龙助手 · 投注单", M, y + 30);
  y += 74;

  let ticketNo = 0;
  const totalNotes = blocks.reduce((s, b) => s + b.notes, 0);
  const totalStake = blocks.reduce((s, b) => s + b.stake, 0);

  for (const b of blocks) {
    ticketNo += 1;
    const cardH = 120 + b.rows.length * 84 + 110;
    // 票卡背景
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, M, y, W - M * 2, cardH, 14);
    ctx.strokeStyle = "#d1d9e6"; ctx.lineWidth = 2;
    ctx.stroke();
    let cy = y + 40;
    // 票头
    ctx.fillStyle = "#2563eb"; ctx.font = `bold 30px ${F}`;
    ctx.fillText(`${b.game}${b.issue ? " 第" + b.issue + "期" : ""} · ${b.name}`, M + 28, cy);
    ctx.fillStyle = "#64748b"; ctx.font = `22px ${F}`;
    ctx.fillText(`票数注数：1张${b.notes}注`, M + 28, cy + 34);
    ctx.fillText(`金额：${fmt(b.stake)} 元`, W - M - 28 - ctx.measureText(`金额：${fmt(b.stake)} 元`).width, cy + 34);
    ctx.fillStyle = "#b45309"; ctx.font = `bold 24px ${F}`;
    ctx.fillText(`过关：${b.serial}    倍数：${b.multiplier}`, M + 28, cy + 72);
    cy += 96;
    // 分隔线
    ctx.strokeStyle = "#e5eaf1"; ctx.beginPath(); ctx.moveTo(M + 20, cy); ctx.lineTo(W - M - 20, cy); ctx.stroke();
    // 行
    for (const r of b.rows) {
      ctx.fillStyle = "#1f2937"; ctx.font = `600 26px ${F}`;
      ctx.fillText(`${r.no}  ${r.teams}`, M + 30, cy + 32);
      ctx.fillStyle = "#334155"; ctx.font = `24px ${F}`;
      ctx.fillText(`    ${r.game ? r.game + "  " : ""}${r.pick}`, M + 30, cy + 66);
      cy += 84;
    }
    // 底注
    ctx.strokeStyle = "#e5eaf1"; ctx.beginPath(); ctx.moveTo(M + 20, cy); ctx.lineTo(W - M - 20, cy); ctx.stroke();
    ctx.fillStyle = "#94a3b8"; ctx.font = `20px ${F}`;
    ctx.fillText("注：明细信息请以彩票票面实际显示为准。", M + 28, cy + 34);
    ctx.fillText(`保存时间：${APP.data.generated_at}`, M + 28, cy + 64);
    y += cardH + 26;
  }

  // 汇总
  ctx.fillStyle = "#b45309"; ctx.font = `bold 28px ${F}`;
  ctx.fillText(`合计：${blocks.length} 张 / ${totalNotes} 注 / ${fmt(totalStake)} 元（预算 ${APP.budget} 元）`, M, y + 30);

  const a = document.createElement("a");
  a.download = `抓龙助手_${APP.data.generated_at.slice(0, 10)}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
  toast("截图已生成（保存在下载目录）");
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function saveSlip() {
  const blocks = buildTicketBlocks();
  if (!blocks.length) { toast("投注单是空的"); return; }
  const groups = blocks.map(b => ({
    game_type: b.game + (b.issue ? " 第" + b.issue + "期" : ""),
    issue: b.issue, title: `${b.name} ${b.serial} ${b.notes}注`,
    selections: b.rows.map(r => `${r.no} ${r.teams} ${r.game ? r.game + " " : ""}${r.pick}`),
    stake: b.stake,
  }));
  const total = groups.reduce((s, g) => s + g.stake, 0);
  api("/api/bet", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bet_date: APP.data.generated_at.slice(0, 10), game_type: "多玩法组合",
      issue: "", title: `方案 ${blocks.length} 张`, selections: groups,
      stake: total, odds: "", note: slipText().slice(0, 800) }),
  }).then(r => { if (r.ok) toast("已保存到历史"); else toast("保存失败"); });
}

/* ---------------- 预测快照 / 今日投注分析 / 复盘（模型训练闭环） ---------------- */

const POOL_CN = { had: "胜平负", ttg: "总进球数", crs: "比分", hafu: "半全场",
  zucai14: "胜负彩14场", ren9: "任选9场", ban6: "6场半全场", goal4: "4场进球" };

function llmCfg() {
  return { api_key: APP.settings.llm_key || "", base_url: APP.settings.llm_base || "https://api.deepseek.com",
    model: APP.settings.llm_model || "deepseek-chat" };
}

/* 把当前投注单整理成"可复盘"的结构化快照 */
function buildSnapshotPlan() {
  const date = APP.data.generated_at.slice(0, 10);
  const jczq = {};
  for (const pool of JCZQ_POOLS) {
    if (APP.cardPass[pool] && APP.cardPass[pool].mode === "parlay") continue;
    const items = [...(APP.sel[pool] || new Map()).values()];
    if (items.length) jczq[pool] = items.map(it => ({ mid: it.mid, home: it.home, away: it.away, option: it.option, odds: it.odds }));
  }
  const zucai = {};
  for (const pool of ZUCAI_ORDER) {
    const issue = zucaiIssue(pool);
    const sel = APP.zsel[pool];
    if (!issue || !sel) continue;
    const rows = [];
    if (pool === "goal4") {
      const byNum = {};
      for (const [k, r] of Object.entries(sel.rows)) {
        if (!(r.options || []).length) continue;
        const [num, side] = k.split("-");
        byNum[num] = byNum[num] || {};
        byNum[num][side] = r.options.slice();
      }
      for (const m of issue.matches) {
        const s = byNum[m.num];
        if (!s) continue;
        rows.push({ num: m.num, home: m.home, away: m.away, home_options: s["主"] || [], away_options: s["客"] || [] });
      }
    } else {
      for (const m of issue.matches) {
        const r = sel.rows[m.num];
        if (!r || !(r.options || []).length) continue;
        rows.push({ num: m.num, home: m.home, away: m.away, options: r.options.slice() });
      }
    }
    if (rows.length) zucai[pool] = rows;
  }
  return { meta: { date, budget: APP.budget }, date, jczq, zucai };
}

function saveSnapshot(source) {
  if (!APP.data) return;
  const plan = buildSnapshotPlan();
  const total = $("slip-total") ? Number($("slip-total").textContent) || 0 : 0;
  api("/api/snapshot", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: plan.date, budget: APP.budget, source: source || "zhualong", plan, summary: { total } }),
  });
}

/* 🎯 今日投注分析：内置引擎 + 预算分配 + 可选 DeepSeek 统筹 */
async function analyzeToday() {
  const btn = $("btn-analyze-today");
  const old = btn.textContent;
  btn.textContent = "⏳ 正在分析（DeepSeek 可能需1-2分钟）…";
  btn.disabled = true;
  const out = $("analyze-out");
  out.innerHTML = '<p style="color:var(--dim)">后台执行：采集当日比赛赔率 → 概率模型 → 资金分配 → 两队近期战绩' + (llmCfg().api_key ? ' → DeepSeek 深度统筹' : '') + '…（约10-60秒）</p>';
  const hint = $("analyze-llm-hint");
  if (hint) hint.textContent = llmCfg().api_key ? "" : "（未填 Key：仅内置引擎）";
  $("modal-analyze").classList.remove("hidden");
  try {
    const budgets = readBudgets();
    const r = await api("/api/analyze-today", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmCfg(), daily: budgets.daily, monthly: budgets.monthly, yearly: budgets.yearly }),
    });
    if (!r.ok) { out.innerHTML = `<div class="err">❌ ${esc(r.error)}</div>`; return; }
    APP._lastAnalyze = r;
    renderAnalyzeResult(r);
  } catch (e) {
    out.innerHTML = `<div class="err">❌ ${esc(e.message)}</div>`;
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

function readBudgets() {
  const num = (id, d) => { const v = Number($(id).value); return v > 0 ? v : d; };
  return { daily: num("b-daily", 100), monthly: num("b-monthly", 0), yearly: num("b-yearly", 0) };
}

function prettyLLM(lr) {
  let h = "";
  if (!lr || typeof lr !== "object") return `<div class="llm-result">${esc(JSON.stringify(lr, null, 2))}</div>`;
  if (lr.summary) h += `<div class="llm-sum">📌 ${esc(lr.summary)}</div>`;
  const plans = lr.plans || {};
  if (plans.had && plans.had.length) {
    h += "<div style='font-size:13px;font-weight:700;margin:8px 0 4px'>胜平负建议</div><table class='htable'><tr><th>场次</th><th>选择</th><th>金额</th><th>理由</th></tr>";
    for (const p of plans.had.slice(0, 14)) {
      const stake = p.stake === undefined || p.stake === null ? "" : `${p.stake}元`;
      h += `<tr><td>${esc(p.match || "")}</td><td><b>${esc(p.pick || "")}</b></td><td>${esc(String(stake))}</td><td style="font-size:11px;color:var(--dim)">${esc(p.reason || "")}</td></tr>`;
    }
    h += "</table>";
  }
  const otherPlans = Object.entries(plans).filter(([k]) => k !== "had" && k !== "zucai14");
  if (plans.zucai14) {
    h += `<div style="font-size:12px;margin-top:6px"><b>胜负彩14场建议：</b>${esc(JSON.stringify(plans.zucai14))}</div>`;
  }
  for (const [k, v] of otherPlans) {
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    h += `<div style="font-size:12px;margin-top:4px"><b>${esc(POOL_CN[k] || k)}：</b>${esc(typeof v === "string" ? v : JSON.stringify(v))}</div>`;
  }
  if (lr.risks && lr.risks.length) {
    h += `<div style="font-size:12px;color:var(--warn);margin-top:8px">⚠️ ${lr.risks.map(x => esc(typeof x === "string" ? x : JSON.stringify(x))).join("<br>⚠️ ")}</div>`;
  }
  if (!h) h = `<div class="llm-result">${esc(JSON.stringify(lr, null, 2))}</div>`;
  return `<div class="llm-result" style="white-space:normal">${h}</div>`;
}

function renderAnalyzeResult(r) {
  const out = $("analyze-out");
  const alloc = (r.allocation && r.allocation.allocation) || {};
  const adv = (r.allocation && r.allocation.advice) || [];
  const hasLlm = !!(r.llm && r.llm.ok);
  let html = "";
  // ① 最终结论框
  const llmSummary = r.llm && r.llm.ok && r.llm.result && r.llm.result.summary;
  html += `<div class="final-box"><b>🎯 今日方案结论</b><br>
    预算 ${fmt(r.plan.budget)} 元 → 内置模型方案 ${fmt(r.plan.total_recommended)} 元
    ${hasLlm ? " + DeepSeek 统筹（见下方 🤖）" : "（未填 DeepSeek Key，仅内置引擎；设置里填 Key 后可获得 AI 统筹）"}
    ${llmSummary ? `<div style="margin-top:4px">📌 ${esc(llmSummary)}</div>` : ""}
    <div style="margin-top:4px;color:var(--dim);font-size:12px">点底部"✅ 采用此方案进投注单"把方案装入投注单 → 复制文本/生成截图发彩票店。</div></div>`;
  // ② 资金分配
  html += "<h4>① 资金分配（按日预算）</h4><table class='htable' style='margin-bottom:8px'><tr><th>玩法</th><th>分配(元)</th></tr>";
  for (const [k, v] of Object.entries(alloc.daily || {})) html += `<tr><td>${esc(POOL_CN[k] || k)}</td><td>${fmt(v)}</td></tr>`;
  html += "</table><div style='font-size:11px;color:var(--dim)'>" + adv.map(esc).join("<br>") + "</div>";
  // ③ 内置方案明细
  html += `<h4>② 内置模型方案（${fmt(r.plan.total_recommended)} 元）</h4>`;
  for (const [pool, pl] of Object.entries(r.plan.plans || {})) {
    const spent = pl.spent || (pl.ticket ? pl.ticket.stake : 0) || 0;
    if (spent > 0) html += `<div style="font-size:12px">· ${esc(pl.label)}：约 ${fmt(spent)} 元</div>`;
  }
  // ④ 战绩 / 赔率变化
  if (r.forms && r.forms.length) {
    html += "<h4>③ 两队近期战绩</h4>";
    for (const f of r.forms) {
      if (!f.text || !f.text.length) continue;
      html += `<div style="font-size:12px;background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin-bottom:6px"><b>${esc(f.home)} vs ${esc(f.away)}</b><br>${f.text.map(esc).join("<br>")}</div>`;
    }
  }
  if (r.moves && Object.keys(r.moves).length) {
    html += "<h4>④ 赔率变化（资金流向参考）</h4>";
    for (const [mid, mm] of Object.entries(r.moves).slice(0, 8)) {
      const bits = [];
      for (const [pool, d] of Object.entries(mm)) for (const [k, v] of Object.entries(d))
        bits.push(`${pool === "hhad" ? "让球" : "胜平负"}·${k} ${v.prev}→${v.now} (${v.dir === "down" ? "↓受热" : v.dir === "up" ? "↑走冷" : "平"})`);
      if (bits.length) html += `<div style="font-size:11px;color:var(--dim)">${esc(mid)}：${bits.map(esc).join("；")}</div>`;
    }
  }
  // ⑤ LLM
  if (r.llm) {
    html += "<h4>⑤ 🤖 DeepSeek 统筹建议</h4>";
    if (r.llm.ok) {
      html += prettyLLM(r.llm.result || {});
    } else {
      html += `<div class="llm-result err">${esc(r.llm.error)}</div>`;
    }
  }
  out.innerHTML = html;
}

function adoptLastAnalyze() {
  const r = APP._lastAnalyze;
  if (!r || !r.plan) { toast("还没有分析结果"); return; }
  APP.plan = r.plan;
  applyAllRecs();
  saveSnapshot("analyze-today");
  toast("已采用今日分析方案并保存预测快照");
}

/* ---------------- 复盘 ---------------- */

async function openReview() {
  $("modal-review").classList.remove("hidden");
  const today = APP.data.generated_at.slice(0, 10);
  $("rv-date").value = today;
  $("rv-llm").innerHTML = "";
  $("rv-stats").innerHTML = "";
  $("rv-rows").innerHTML = "";
  await loadReviewPlan();
}

async function loadReviewPlan() {
  const date = $("rv-date").value;
  const r = await api("/api/snapshots?date=" + encodeURIComponent(date));
  const info = $("rv-info");
  $("rv-llm").innerHTML = "";
  if (!r.snapshots || !r.snapshots.length) {
    info.textContent = "该日期没有预测快照 —— 先做一次 今日投注分析/一键推荐 产生预测，开奖后再来复盘。";
    $("rv-entry").innerHTML = "";
    $("rv-stats").innerHTML = "";
    $("rv-rows").innerHTML = "";
    return;
  }
  const snap = r.snapshots[0];
  let plan = {};
  try { plan = JSON.parse(snap.plan); } catch (e) { plan = {}; }
  APP._reviewPlan = plan;
  info.textContent = `预测快照 #${snap.id} · ${snap.created_at} · 预算 ${fmt(snap.budget || 0)} 元 · ${snap.source}`;
  const seen = new Map();
  const pushMatch = (home, away) => {
    if (home && away && !seen.has(home + "|" + away)) seen.set(home + "|" + away, { home, away });
  };
  for (const pool of JCZQ_POOLS) for (const p of (plan.jczq || {})[pool] || []) pushMatch(p.home, p.away);
  for (const pool of ZUCAI_ORDER) for (const row of (plan.zucai || {})[pool] || []) pushMatch(row.home, row.away);
  const entry = [...seen.values()].map((m, i) =>
    `<div style="display:flex;gap:6px;align-items:center;font-size:12px;padding:3px 0;flex-wrap:wrap">
      <span style="min-width:170px"><b>${esc(m.home)}</b> VS <b>${esc(m.away)}</b></span>
      <label>半场 主 <input id="rvhs${i}" type="number" style="width:40px"> <input id="rvha${i}" type="number" style="width:40px"> 客</label>
      <label>全场 主 <input id="rvh${i}" type="number" style="width:40px" min="0"> <input id="rva${i}" type="number" style="width:40px" min="0"> 客</label>
    </div>`).join("");
  $("rv-entry").innerHTML = entry || "<span style='color:var(--dim)'>快照里没有可录入的比赛</span>";
  await loadReviewResult();
}

async function saveReviewResults() {
  const date = $("rv-date").value;
  const plan = APP._reviewPlan || {};
  const seen = new Map();
  const pushMatch = (home, away) => {
    if (home && away && !seen.has(home + "|" + away)) seen.set(home + "|" + away, { home, away });
  };
  for (const pool of JCZQ_POOLS) for (const p of (plan.jczq || {})[pool] || []) pushMatch(p.home, p.away);
  for (const pool of ZUCAI_ORDER) for (const row of (plan.zucai || {})[pool] || []) pushMatch(row.home, row.away);
  const matches = [...seen.values()];
  const results = [];
  matches.forEach((m, i) => {
    const g = (id) => { const v = $(id); if (!v) return null; const n = Number(v.value); return Number.isFinite(n) ? n : null; };
    const h = g(`rvh${i}`), a = g(`rva${i}`);
    if (h === null || a === null) return;
    const hs = g(`rvhs${i}`), ha = g(`rvha${i}`);
    results.push({ home: m.home, away: m.away, hs: hs, ha: ha, fs_h: h, fs_a: a });
  });
  if (!results.length) { toast("请先填写至少一场的全场比分"); return; }
  const r = await api("/api/results", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, results }),
  });
  if (r.ok) { toast(`已保存 ${r.saved} 场赛果`); await loadReviewResult(); }
}

async function loadReviewResult() {
  const date = $("rv-date").value;
  const r = await api("/api/review?date=" + encodeURIComponent(date));
  $("rv-stats").innerHTML = r.stats && r.stats.length
    ? "<table class='htable'><tr><th>玩法</th><th>命中/场次</th><th>命中率</th></tr>" +
      r.stats.map(s => `<tr><td>${esc(POOL_CN[s.pool] || s.pool)}</td><td>${s.hit}/${s.total}</td>
        <td style="color:${s.rate >= 50 ? "var(--accent2)" : "var(--danger)"}"><b>${s.rate}%</b></td></tr>`).join("") + "</table>"
    : "<span style='color:var(--dim)'>还没有可判定的结果（先录入赛果）</span>";
  const rowsHtml = [];
  for (const [pool, st] of Object.entries(r.pools || {})) {
    for (const row of st.rows || []) {
      const c = row.correct;
      rowsHtml.push(`<div style="font-size:12px;padding:2px 0">
        <span class="status-pill ${c === true ? "win" : c === false ? "lose" : "pending"}">${c === true ? "✓中" : c === false ? "✗错" : "待定"}</span>
        ${esc(POOL_CN[pool] || pool)} | ${esc(row.home || row.mid || "")}${row.away ? " VS " + esc(row.away) : ""}
        | 我选 <b>${esc(row.pick || row.option || "")}</b> | 赛果 ${esc(row.actual || "—")}</div>`);
    }
  }
  $("rv-rows").innerHTML = rowsHtml.join("") || "<span style='color:var(--dim)'>无</span>";
}

async function runReviewLLM() {
  const date = $("rv-date").value;
  const out = $("rv-llm");
  const cfg = llmCfg();
  if (!cfg.api_key) { out.innerHTML = '<div class="err">请在 设置→大模型分析 填入 DeepSeek API Key</div>'; return; }
  out.innerHTML = '<span style="color:var(--dim)">DeepSeek 正在分析每场对错原因（1-2分钟）…</span>';
  const r = await api("/api/llm-review", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...cfg, date }),
  });
  if (!r.ok) { out.innerHTML = `<div class="err">❌ ${esc(r.error)}</div>`; return; }
  out.innerHTML = `<b style="color:var(--accent2)">✅ 复盘完成（${esc(r.model)}）</b>\n` + esc(JSON.stringify(r.result, null, 2));
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
  // 预算三档
  $("b-daily").value = s.budget_daily || APP.budget || 100;
  $("b-monthly").value = s.budget_monthly || "";
  $("b-yearly").value = s.budget_yearly || "";
}

function showAllocation() {
  const out = $("alloc-out");
  const budgets = readBudgets();
  out.innerHTML = '<span style="color:var(--dim)">计算中…</span>';
  api("/api/allocation", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(budgets) }).then(r => {
    if (!r.ok || !r.allocation) { out.innerHTML = '<span class="err">失败</span>'; return; }
    const a = r.allocation.allocation || {};
    let h = "";
    if (a.daily) {
      h += "<b>日预算分配：</b><br>";
      for (const [k, v] of Object.entries(a.daily)) h += `· ${esc(POOL_CN[k] || k)}：${fmt(v)} 元<br>`;
    }
    if (a.monthly_daily_avg) h += `<br><b>月预算</b> ≈ 每个投注日 ${fmt(a.monthly_daily_avg)} 元<br>`;
    if (a.yearly_monthly_avg) h += `<br><b>年预算</b> ≈ 每月 ${fmt(a.yearly_monthly_avg)} 元<br>`;
    h += "<br><b>纪律清单：</b><br>" + r.allocation.advice.map(x => esc(x)).join("<br>");
    out.innerHTML = h;
  }).catch(() => { out.innerHTML = '<span class="err">计算失败</span>'; });
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
  const bd = Number($("b-daily").value) || 100;
  const bm = Number($("b-monthly").value) || 0;
  const by = Number($("b-yearly").value) || 0;
  APP.settings = {
    ...APP.settings,
    llm_base: $("llm-base").value.trim(),
    llm_model: $("llm-model").value.trim(),
    llm_key: $("llm-key").value.trim(),
    budget_daily: bd, budget_monthly: bm, budget_yearly: by,
  };
  localStorage.setItem("zucai_settings", JSON.stringify(APP.settings));
  localStorage.setItem("zucai_weights", JSON.stringify(weights));
  api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, source_pref: pref }) });
  api("/api/budgets", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daily: bd, monthly: bm, yearly: by }) });
  APP.sourcePref = pref;
  APP.budget = bd;
  setBudget(bd); // 内部会重算方案
  $("modal-settings").classList.add("hidden");
  toast("设置已保存，预算与方案已更新");
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

function handleDdAction(action) {
  if (action === "refresh") {
    refreshData();
    toast("正在刷新数据…");
  } else if (action.startsWith("source-")) {
    const pref = action.slice(7);
    const label = { auto: "自动", official: "官方接口", fallback: "备用源", demo: "演示数据" }[pref] || pref;
    APP.sourcePref = pref;
    api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_pref: pref }) });
    refreshData(pref);
    toast("正在切换到数据源：" + label);
  } else if (action === "open-settings") {
    openSettings();
  } else if (action === "open-history") {
    openHistory();
  } else if (action === "clear-history") {
    if (confirm("确定清空全部历史记录吗？此操作不可恢复。")) {
      api("/api/clear-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(r => { if (r.ok) { toast("历史已清空"); if (!$("modal-history").classList.contains("hidden")) loadHistory(); } });
    }
  }
}

function applyTheme(pref) {
  // pref: "auto" | "light" | "dark"
  const dark = pref === "dark" || (pref !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const icon = pref === "dark" ? "🌙" : pref === "light" ? "☀️" : "🌓";
  const b = $("btn-theme");
  if (b) b.textContent = icon;
}

function cycleTheme() {
  const cur = APP.settings.theme || "auto";
  const next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
  APP.settings.theme = next;
  try { localStorage.setItem("zucai_settings", JSON.stringify(APP.settings)); } catch (e) {}
  applyTheme(next);
  toast(next === "auto" ? "主题：跟随系统" : next === "light" ? "主题：浅色" : "主题：深色");
}

function bindEvents() {
  renderWorksMenu();
  // 下拉菜单：鼠标悬停由 CSS 控制(.dd:hover)；LEO作品菜单支持点击切换(触屏)
  $("btn-works").addEventListener("click", (e) => {
    e.stopPropagation();
    const dd = e.target.closest(".dd");
    const isOpen = dd.classList.contains("open");
    document.querySelectorAll(".dd.open").forEach(d => d.classList.remove("open"));
    if (!isOpen) dd.classList.add("open");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dd")) {
      document.querySelectorAll(".dd.open").forEach(d => d.classList.remove("open"));
    }
  });
  document.querySelectorAll(".dd-panel [data-action]").forEach(item => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      document.querySelectorAll(".dd.open").forEach(d => d.classList.remove("open"));
      handleDdAction(action);
    });
  });
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
  $("btn-review").onclick = openReview;
  $("btn-theme").onclick = cycleTheme;
  $("btn-save-settings").onclick = saveSettings;
  $("btn-llm-test").onclick = llmTest;
  $("btn-alloc").onclick = showAllocation;
  $("btn-analyze-today").onclick = analyzeToday;
  $("btn-analyze-adopt").onclick = adoptLastAnalyze;
  $("btn-analyze-snapshot").onclick = () => { saveSnapshot("analyze-manual"); toast("已保存预测快照（复盘用）"); };
  $("btn-rv-load").onclick = loadReviewPlan;
  $("btn-rv-save").onclick = saveReviewResults;
  $("btn-rv-analyze").onclick = runReviewLLM;
  $("budget-slider").oninput = (e) => {
    const v = Number(e.target.value);
    $("budget-num").value = v;
    $("b-daily").value = v;
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
  // 主题：跟随设置（默认自动=系统深浅）
  applyTheme(APP.settings.theme || "auto");
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if ((APP.settings.theme || "auto") === "auto") applyTheme("auto");
    });
  }
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
