#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析引擎：赔率→概率换算、价值检测、凯利仓位、九种玩法方案生成、可选大模型分析。

设计原则（重要）：
  * 本引擎不承诺预测准确——足球比赛不可预测，彩票长期是负期望游戏。
  * 它做三件实事：1) 把赔率换算成可解释的概率；2) 用凯利/预算控制把每天
    50-100 元花在"相对合理"的注上；3) 自动生成所有玩法的方案卡片，省去手工。
  * 所有推荐都带理由（概率/价值/热度），便于你自行判断和修改。
"""
from __future__ import annotations

import json
import math
import re
import urllib.parse
import urllib.request
import datetime as dt

# 每日预算在八种玩法间的默认分配（权重，和为1；让球胜平负已按用户要求移除）
DEFAULT_WEIGHTS = {
    "had": 0.15,      # 竞彩-胜平负
    "ttg": 0.06,      # 竞彩-总进球
    "crs": 0.06,      # 竞彩-比分
    "hafu": 0.06,     # 竞彩-半全场
    "zucai14": 0.25,  # 传统-胜负彩14场
    "ren9": 0.20,     # 传统-任选9场
    "ban6": 0.11,     # 传统-6场半全场
    "goal4": 0.11,    # 传统-4场进球
}

POOL_NAMES = {
    "had": "胜平负", "ttg": "总进球",
    "crs": "比分", "hafu": "半全场", "zucai14": "胜负彩(14场)",
    "ren9": "任选9场", "ban6": "6场半全场", "goal4": "4场进球",
}

THREE_LABELS = {"h": "胜", "d": "平", "a": "负"}

# 凯利系数（分数凯利，防爆仓）
KELLY_FRACTION = 0.25
# 价值线：期望收益率超过该值视为"有价值"
VALUE_EDGE = 0.10
# 稳胆线：概率
LOCK_PROB = 0.55
# 冷门线
COLD_PROB = 0.18
COLD_ODDS = 5.5


# ---------------- 概率工具 ----------------

def de_vig(three):
    """三路赔率 -> (概率dict, 返还率)。three: {h,d,a} 或 {胜,平,负}。"""
    if not isinstance(three, dict):
        return None, 0.0
    inv = {}
    for k, v in three.items():
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 1.0:
            inv[k] = 1.0 / f
    s = sum(inv.values())
    if s <= 0:
        return None, 0.0
    return {k: v / s for k, v in inv.items()}, 1.0 / s


def poisson_pmf(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)


def lambda_from_win_prob(p_win, p_draw=0.28):
    """由主胜概率粗估主队期望进球（用于4场进球/总进球）。"""
    lam = 1.15
    for _ in range(8):
        p_w = 0.0
        for h in range(0, 7):
            for a in range(0, h):
                p_w += poisson_pmf(h, lam) * poisson_pmf(a, lam * 0.72)
        p_w += poisson_pmf(7, lam) * 0.5
        lam += (p_win - p_w) * 2.2
        lam = max(lam, 0.2)
    return lam


def poisson_goals(lam, maxg=5):
    out = {}
    s = 0.0
    for k in range(maxg):
        p = poisson_pmf(k, lam)
        out[str(k)] = p
        s += p
    out[f"{maxg}+"] = max(0.0, 1.0 - s)
    return out


# ---------------- 推导赔率（数据源未提供 比分/总进球/半全场 时的估算） ----------------

def bivariate_score_probs(lh, la, maxg=6):
    """独立双泊松比分概率 {(h,a): p}，含'其他'合并。"""
    ph = [poisson_pmf(k, lh) for k in range(maxg + 1)]
    pa = [poisson_pmf(k, la) for k in range(maxg + 1)]
    ph[maxg] = max(0.0, 1.0 - sum(ph[:-1]))
    pa[maxg] = max(0.0, 1.0 - sum(pa[:-1]))
    return {(h, a): ph[h] * pa[a] for h in range(maxg + 1) for a in range(maxg + 1)}


CRS_MAIN = (["1:0","2:0","2:1","3:0","3:1","3:2","4:0","4:1","4:2","4:3","5:0","5:1","5:2"],
            ["0:0","1:1","2:2","3:3"],
            ["0:1","0:2","1:2","0:3","1:3","2:3","0:4","1:4","2:4","3:4","0:5","1:5","2:5"])

HAFU_ORDER2 = ["胜-胜","胜-平","胜-负","平-胜","平平","平-负","负-胜","负-平","负-负"]


def _odds_from_probs(items, margin=0.11):
    return [{"label": lb, "odds": round(1 / max(p, 1e-4) * (1 - margin), 2)}
            for lb, p in items]


def derive_ttg(lh, la):
    """总进球 0~7+ 估算。"""
    probs = bivariate_score_probs(lh, la)
    items = []
    for g in ["0", "1", "2", "3", "4", "5", "6", "7+"]:
        if g == "7+":
            p = sum(v for (h, a), v in probs.items() if h + a >= 7)
        else:
            p = sum(v for (h, a), v in probs.items() if h + a == int(g))
        items.append((g, p))
    return _odds_from_probs(items)


def derive_crs(lh, la):
    """比分 31 项估算。"""
    probs = bivariate_score_probs(lh, la)
    home_main, draw_main, away_main = CRS_MAIN
    total = sum(probs.values())
    ph = sum(v for (h, a), v in probs.items() if h > a and f"{h}:{a}" not in home_main)
    pd = sum(v for (h, a), v in probs.items() if h == a and f"{h}:{a}" not in draw_main)
    pa = sum(v for (h, a), v in probs.items() if h < a and f"{h}:{a}" not in away_main)
    items = []
    for g in home_main:
        h, a = map(int, g.split(":"))
        items.append((g, probs.get((h, a), 0) / total))
    items.append(("胜其他", ph / total))
    for g in draw_main:
        h, a = map(int, g.split(":"))
        items.append((g, probs.get((h, a), 0) / total))
    items.append(("平其他", pd / total))
    for g in away_main:
        h, a = map(int, g.split(":"))
        items.append((g, probs.get((h, a), 0) / total))
    items.append(("负其他", pa / total))
    return _odds_from_probs(items)


def derive_hafu(lh, la):
    """半全场 9 项估算：半场分布（期望×0.42）与全场分布独立近似。"""
    hl, ha = lh * 0.42, la * 0.42

    def outcome_probs(l1, l2):
        pr = bivariate_score_probs(l1, l2)
        h = sum(v for (x, y), v in pr.items() if x > y)
        d = sum(v for (x, y), v in pr.items() if x == y)
        a = sum(v for (x, y), v in pr.items() if x < y)
        return {"胜": h, "平": d, "负": a}

    pht, pft = outcome_probs(hl, ha), outcome_probs(lh, la)
    combos = {}
    for ht, p1 in pht.items():
        for ft, p2 in pft.items():
            combos[f"{ht}-{ft}"] = p1 * p2
    s = sum(combos.values())
    return _odds_from_probs([(lb, p / s) for lb, p in combos.items()])


def enrich_jczq_pools(data):
    """当数据源缺少 比分/总进球/半全场 赔率时，用胜平负概率推导估算，并标记 derived_pools。"""
    for m in data.get("jczq", {}).get("matches", []):
        odds = m.get("odds") or {}
        had = odds.get("had")
        if not isinstance(had, dict):
            continue
        probs, _ = de_vig(had)
        if not probs:
            continue
        lh = lambda_from_win_prob(probs.get("h", 0.4))
        la = lambda_from_win_prob(probs.get("a", 0.3))
        derived = m.setdefault("derived_pools", [])
        for pool, builder in (("ttg", derive_ttg), ("crs", derive_crs), ("hafu", derive_hafu)):
            if not odds.get(pool):
                odds[pool] = builder(lh, la)
                derived.append(pool)


def kelly_fraction(p, odds):
    """全凯利仓位 f=(p*b-1)/(b-1)，edge<=0 时返回 0。"""
    if odds <= 1 or p <= 0:
        return 0.0
    edge = p * odds - 1
    if edge <= 0:
        return 0.0
    return edge / (odds - 1)


def tag_for(p, odds, is_best):
    tags = []
    if is_best:
        tags.append("首选")
    if p >= LOCK_PROB and odds >= 1.2:
        tags.append("稳胆")
    edge = p * odds - 1
    if edge >= VALUE_EDGE:
        tags.append("价值")
    if p <= COLD_PROB and odds >= COLD_ODDS:
        tags.append("冷门")
    return tags, edge


# ---------------- 竞彩各玩法 ----------------

def _match_brief(m):
    return {
        "id": m.get("id", ""),
        "league": m.get("league", ""),
        "home": m.get("home", ""),
        "away": m.get("away", ""),
        "kickoff": m.get("kickoff", ""),
    }


def plan_pool(matches, pool, alloc, pool_label, opt_labels, mode="normal"):
    """胜平负/总进球/比分/半全场 共用：每场给概率+标签+推荐。

    opt_labels: 将赔率键/标签翻译为展示名，如 {"h":"胜"}；列表池用原标签。
    mode="confident"：只推荐最有把握的（三路仅 p≥0.50 的首选；列表池仅 top-1）。
    """
    picks, notes = [], []
    for m in matches:
        odds = (m.get("odds") or {}).get(pool)
        if not odds:
            continue
        brief = _match_brief(m)
        if isinstance(odds, dict) and "h" in odds:  # 三路池
            probs, ret = de_vig(odds)
            if not probs:
                continue
            best_key = max(probs, key=probs.get)
            for k, p in probs.items():
                o = odds[k]
                tags, edge = tag_for(p, o, k == best_key)
                if mode == "confident":
                    is_rec = (k == best_key) and p >= 0.50
                else:
                    is_rec = k == best_key or "价值" in tags
                if k == best_key or "价值" in tags or "稳胆" in tags or "冷门" in tags:
                    picks.append({
                        **brief, "pool": pool, "option": opt_labels.get(k, k),
                        "odds": o, "prob": round(p, 3), "edge": round(edge, 3),
                        "tags": tags, "stake": 0, "recommended": is_rec,
                    })
            note = f"返还率 {ret * 100:.0f}%"
            if ret < 0.90:
                note += "（偏低，谨慎单选）"
            notes.append({"match": brief["id"], "text": note})
        else:  # 列表池（比分/总进球/半全场）
            items = []
            for it in odds:
                label, o = it.get("label"), it.get("odds")
                if label and o:
                    items.append((label, float(o)))
            if not items:
                continue
            probs, ret = de_vig({lb: o for lb, o in items})
            if not probs:
                continue
            ordered = sorted(probs.items(), key=lambda x: -x[1])
            for label, p in ordered[:3]:
                o = dict(items)[label]
                tags, edge = tag_for(p, o, label == ordered[0][0])
                is_rec = label == ordered[0][0] if mode == "confident" else (label == ordered[0][0] or "价值" in tags)
                picks.append({
                    **brief, "pool": pool, "option": opt_labels.get(label, label),
                    "odds": o, "prob": round(p, 3), "edge": round(edge, 3),
                    "tags": tags, "stake": 0, "recommended": is_rec,
                })
            if pool == "ttg":
                p_big = sum(probs.get(str(g), 0) for g in (3, 4, 5, 6, "7+"))
                notes.append({"match": brief["id"],
                              "text": f"3球及以上 {p_big * 100:.0f}% / 2球及以下 {(1 - p_big) * 100:.0f}%"})
            elif pool == "hafu" and ordered:
                notes.append({"match": brief["id"],
                              "text": f"首选 {ordered[0][0]}（{ordered[0][1] * 100:.0f}%）"})
            if "derived_pools" in m and pool in m["derived_pools"]:
                notes.append({"match": brief["id"],
                              "text": "🛠 该玩法赔率为估算值（由胜平负赔率推导）"})
    return {"pool": pool, "label": pool_label, "picks": picks, "notes": notes}


def _apply_stakes(picks, alloc, min_stake=2.0):
    """给推荐注分配仓位（1/4 凯利，下限 2 元），总额不超过 alloc。"""
    recs = [p for p in picks if p.get("recommended")]
    budget = alloc
    for p in recs:
        if budget < min_stake:
            p["stake"] = 0
            continue
        f = kelly_fraction(p["prob"], p["odds"]) * KELLY_FRACTION
        stake = max(min_stake, round(f * alloc, 0))
        stake = min(stake, budget)
        p["stake"] = stake
        budget -= stake
    return sum(p["stake"] for p in recs)


def plan_jczq_singles(data, weights, budget, mode="normal"):
    """竞彩四池的单关方案（让球胜平负已按用户要求移除）。"""
    matches = (data.get("jczq") or {}).get("matches") or []
    out = {}
    specs = {
        "had": ("胜平负", THREE_LABELS),
        "ttg": ("总进球", {}),
        "crs": ("比分", {}),
        "hafu": ("半全场", {}),
    }
    for pool, (label, opt_labels) in specs.items():
        alloc = budget * weights.get(pool, 0.05)
        plan = plan_pool(matches, pool, alloc, label, opt_labels, mode=mode)
        # 胜平负预留 6 元给串关（2串1/3串1），其余玩法全额给单关
        combos_reserve = 6.0 if pool == "had" else 0.0
        plan["spent"] = _apply_stakes(plan["picks"], max(alloc - combos_reserve, 0.0))
        # 串关建议（2串1/3串1，与体彩"过关"玩法一致）：从中赔首选/稳胆里挑组合
        locks = [p for p in plan["picks"] if (("稳胆" in p["tags"]) or ("首选" in p["tags"]))
                 and 1.4 <= p["odds"] <= 2.8 and p["prob"] >= 0.45]
        combos = []
        if len(locks) >= 2 and pool in ("had",):
            cand = []
            n = len(locks)
            for i in range(n):
                for j in range(i + 1, n):
                    a, b = locks[i], locks[j]
                    if a["id"] == b["id"]:
                        continue
                    cp = a["prob"] * b["prob"]
                    om = round(a["odds"] * b["odds"], 2)
                    if cp >= 0.20 and om >= 2.0:
                        cand.append((cp, om, 2, [a, b]))
            for i in range(n):
                for j in range(i + 1, n):
                    for k in range(j + 1, n):
                        a, b, c = locks[i], locks[j], locks[k]
                        if len({a["id"], b["id"], c["id"]}) < 3:
                            continue
                        cp = a["prob"] * b["prob"] * c["prob"]
                        om = round(a["odds"] * b["odds"] * c["odds"], 2)
                        if cp >= 0.08 and om >= 3.0:
                            cand.append((cp, om, 3, [a, b, c]))
            cand.sort(key=lambda x: -x[0])
            combos_budget = max(alloc - plan["spent"], 0)
            combo_count = min(4, int(combos_budget // 2))  # 每注2元
            # 2串1 与 3串1 交错择优（先各取最优，再轮流补位），兼顾把握与多样性
            cand2 = [c for c in cand if c[2] == 2]
            cand3 = [c for c in cand if c[2] == 3]
            ordered_cand = []
            i2 = i3 = 0
            take3 = False
            while len(ordered_cand) < combo_count:
                if not take3 and i2 < len(cand2):
                    ordered_cand.append(cand2[i2]); i2 += 1
                elif i3 < len(cand3):
                    ordered_cand.append(cand3[i3]); i3 += 1
                elif i2 < len(cand2):
                    ordered_cand.append(cand2[i2]); i2 += 1
                else:
                    break
                take3 = not take3
            added = 0
            for cp, om, mlen, picks_ in ordered_cand[:combo_count]:
                fmt_m = lambda p: f"{p['id']} {p['league']} {p['home']} VS {p['away']} {p['option']}@{p['odds']}"
                combos.append({
                    "match_a": fmt_m(picks_[0]),
                    "match_b": fmt_m(picks_[1]),
                    "match_c": fmt_m(picks_[2]) if mlen == 3 else None,
                    "serial": mlen, "odds": om, "prob": round(cp, 3), "stake": 2.0,
                })
                added += 1
            plan["spent"] = round(plan["spent"] + added * 2.0, 2)
        plan["combos"] = combos
        out[pool] = plan
    return out


# ---------------- 传统足彩 ----------------

def _tier(p):
    if p >= 0.62:
        return "胆"
    if p >= 0.45:
        return "稳"
    return "博"


def plan_zucai14(issue, alloc, mode="normal"):
    matches = issue.get("matches") or []
    rows, picks = [], []
    for m in matches:
        eo = m.get("euro_odds")
        if not eo:
            eo = {"h": 3.0, "d": 3.2, "a": 3.0}
        probs, ret = de_vig(eo)
        best = max(probs, key=probs.get) if probs else "h"
        rows.append({
            "num": m.get("num"), "league": m.get("league", ""),
            "home": m.get("home", ""), "away": m.get("away", ""),
            "kickoff": m.get("kickoff", ""),
            "probs": {k: round(v, 3) for k, v in (probs or {}).items()},
            "best": best, "tier": _tier(probs[best]) if probs else "博",
            "odds": eo,
        })
    # 复式生成：前 N 单(胆)，其余双/三，注数 ≤ 预算/2
    rows_sorted = sorted(rows, key=lambda r: -max(r["probs"].values()))
    notes_budget = max(alloc / 2.0, 2.0)
    n_dan, n_double = 0, 0
    prod = 1
    for r in rows_sorted:
        p = max(r["probs"].values())
        if prod * 1 <= notes_budget and (n_dan < 6 or p >= 0.62):
            n_dan += 1
            r["options"] = [r["best"]]
        elif prod * 2 <= notes_budget:
            n_double += 1
            r["options"] = [r["best"], _second(r["probs"], r["best"])]
        else:
            r["options"] = [r["best"]]
        prod *= len(r["options"])
    combos = 0
    for r in rows:
        combos += len(r["options"]) - 1
    ticket = {
        "type": "胜负彩14场 复式",
        "issue": issue.get("issue", ""),
        "dan": [r["num"] for r in rows if len(r["options"]) == 1],
        "double_or_more": [r["num"] for r in rows if len(r["options"]) > 1],
        "notes": prod, "stake": prod * 2.0, "budget": alloc,
    }
    for r in rows:
        picks.append({
            **{k: r[k] for k in ("num", "league", "home", "away", "kickoff")},
            "options": [THREE_LABELS.get(o, o) for o in r["options"]],
            "probs": r["probs"], "best": THREE_LABELS.get(r["best"], r["best"]),
            "tier": r["tier"], "odds": r["odds"],
        })
    return {"pool": "zucai14", "label": POOL_NAMES["zucai14"], "issue": issue.get("issue", ""),
            "picks": picks, "ticket": ticket}


def _second(probs, best):
    """概率次高选项。"""
    return sorted(probs.items(), key=lambda x: -x[1])[1][0]


def plan_ren9(issue, alloc, mode="normal"):
    matches = issue.get("matches") or []
    rows = []
    for m in matches:
        eo = m.get("euro_odds") or {"h": 3.0, "d": 3.2, "a": 3.0}
        probs, _ = de_vig(eo)
        best = max(probs, key=probs.get) if probs else "h"
        rows.append({
            "num": m.get("num"), "league": m.get("league", ""),
            "home": m.get("home", ""), "away": m.get("away", ""),
            "probs": {k: round(v, 3) for k, v in (probs or {}).items()},
            "best": best, "conf": probs[best] if probs else 0.0,
        })
    rows.sort(key=lambda r: -r["conf"])
    chosen = rows[:9]  # 概率最高的 9 场
    notes_budget = max(alloc / 2.0, 2.0)
    prod = 1
    for r in sorted(chosen, key=lambda x: x["conf"]):
        if prod * 2 <= notes_budget and r["conf"] < 0.60:
            r["options"] = [r["best"], _second(r["probs"], r["best"])]
        else:
            r["options"] = [r["best"]]
        prod *= len(r["options"])
    ticket = {
        "type": "任选9场 复式", "issue": issue.get("issue", ""),
        "selected": [r["num"] for r in sorted(chosen, key=lambda x: x["num"])],
        "notes": prod, "stake": prod * 2.0, "budget": alloc,
    }
    picks = [{
        "num": r["num"], "league": r["league"], "home": r["home"], "away": r["away"],
        "options": [THREE_LABELS.get(o, o) for o in r["options"]],
        "best": THREE_LABELS.get(r["best"], r["best"]),
        "conf": round(r["conf"], 3), "odds": r.get("odds"),
        "probs": {k: round(v, 3) for k, v in r["probs"].items()},
    } for r in sorted(chosen, key=lambda x: x["num"])]
    return {"pool": "ren9", "label": POOL_NAMES["ren9"], "issue": issue.get("issue", ""),
            "picks": picks, "ticket": ticket}


def plan_ban6(issue, alloc, mode="normal"):
    """6场半全场：用全场概率近似半场分布，选 半场-全场 组合。"""
    matches = (issue.get("matches") or [])[:6]
    rows = []
    for m in matches:
        eo = m.get("euro_odds") or {"h": 3.0, "d": 3.2, "a": 3.0}
        probs, _ = de_vig(eo)
        ph = probs.get("h", 0.33) * 0.72 + 0.03
        pa = probs.get("a", 0.33) * 0.72 + 0.03
        pd = max(0.05, 1 - ph - pa)
        combos = []
        for ht, pht in (("胜", ph), ("平", pd), ("负", pa)):
            for ft, pft in (("胜", probs.get("h", 0.33)), ("平", probs.get("d", 0.33)), ("负", probs.get("a", 0.33))):
                combos.append({"label": f"{ht}-{ft}", "prob": pht * pft})
        combos.sort(key=lambda c: -c["prob"])
        rows.append({
            "num": m.get("num"), "league": m.get("league", ""),
            "home": m.get("home", ""), "away": m.get("away", ""),
            "kickoff": m.get("kickoff", ""),
            "top": combos[:2], "best": combos[0]["label"],
        })
    notes_budget = max(alloc / 2.0, 2.0)
    prod = 1
    for r in sorted(rows, key=lambda x: x["top"][0]["prob"]):
        if mode == "confident":
            r["options"] = [r["top"][0]["label"]]
        elif prod * 2 <= notes_budget:
            r["options"] = [r["top"][0]["label"], r["top"][1]["label"]]
        else:
            r["options"] = [r["top"][0]["label"]]
        prod *= len(r["options"])
    ticket = {
        "type": "6场半全场 复式", "issue": issue.get("issue", ""),
        "notes": prod, "stake": prod * 2.0, "budget": alloc,
    }
    picks = [{
        "num": r["num"], "league": r["league"], "home": r["home"], "away": r["away"],
        "options": r["options"], "best": r["best"],
        "probs": {c["label"]: round(c["prob"], 3) for c in r["top"]},
    } for r in rows]
    return {"pool": "ban6", "label": POOL_NAMES["ban6"], "issue": issue.get("issue", ""),
            "picks": picks, "ticket": ticket}


def plan_goal4(issue, alloc, mode="normal"):
    """4场进球：每队进球数 0/1/2/3+，按泊松分布选 1-2 个。"""
    matches = (issue.get("matches") or [])[:4]
    teams = []
    for m in matches:
        eo = m.get("euro_odds") or {"h": 3.0, "d": 3.2, "a": 3.0}
        probs, _ = de_vig(eo)
        lam_h = lambda_from_win_prob(probs.get("h", 0.4))
        lam_a = lambda_from_win_prob(probs.get("a", 0.3))
        teams.append({"match": m, "side": "主", "name": m.get("home", ""), "lam": lam_h})
        teams.append({"match": m, "side": "客", "name": m.get("away", ""), "lam": lam_a})
    rows = []
    for t in teams:
        g = poisson_goals(t["lam"])
        ordered = sorted(g.items(), key=lambda x: -x[1])
        rows.append({
            "num": t["match"].get("num"), "team": t["name"], "side": t["side"],
            "league": t["match"].get("league", ""),
            "top": ordered[:3],
            "best": ordered[0][0],
        })
    notes_budget = max(alloc / 2.0, 2.0)
    prod = 1
    for r in sorted(rows, key=lambda x: x["top"][0][1]):
        if mode == "confident":
            r["options"] = [r["top"][0][0]]
        elif prod * 2 <= notes_budget:
            r["options"] = [r["top"][0][0], r["top"][1][0]]
        else:
            r["options"] = [r["top"][0][0]]
        prod *= len(r["options"])
    ticket = {
        "type": "4场进球 复式", "issue": issue.get("issue", ""),
        "notes": prod, "stake": prod * 2.0, "budget": alloc,
    }
    picks = [{
        "num": r["num"], "team": r["team"], "side": r["side"], "league": r["league"],
        "options": r["options"], "best": r["best"],
        "probs": {lb: round(p, 3) for lb, p in r["top"]},
    } for r in rows]
    return {"pool": "goal4", "label": POOL_NAMES["goal4"], "issue": issue.get("issue", ""),
            "picks": picks, "ticket": ticket}


# ---------------- 总入口 ----------------

def allocate(budget, weights):
    return {k: round(budget * w, 2) for k, w in weights.items()}


def build_full_plan(data, budget=100.0, weights=None, mode="normal"):
    weights = weights or DEFAULT_WEIGHTS
    allocs = allocate(budget, weights)
    plans = plan_jczq_singles(data, weights, budget, mode=mode)
    issues = (data.get("zucai") or {}).get("issues") or []
    for gno, fn in ((85, plan_zucai14), (86, plan_ren9), (87, plan_ban6), (88, plan_goal4)):
        issue = next((i for i in issues if i.get("game_no") == gno), None)
        key = {85: "zucai14", 86: "ren9", 87: "ban6", 88: "goal4"}[gno]
        if issue:
            plans[key] = fn(issue, allocs.get(key, 5.0), mode=mode)
        else:
            plans[key] = {"pool": key, "label": POOL_NAMES[key], "issue": "", "picks": [],
                          "ticket": None, "error": "无在售期"}
    total = sum(p.get("spent") or (p.get("ticket") or {}).get("stake", 0) or 0 for p in plans.values())
    return {
        "generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "budget": budget,
        "mode": mode,
        "allocs": allocs,
        "plans": plans,
        "total_recommended": round(total, 2),
        "disclaimer": "概率模型仅供参考，彩票为负期望游戏，请理性购彩、量力而行。",
    }


# ---------------- 可选大模型分析 ----------------

def llm_analyze(cfg, data, plan, budget=100.0, timeout=150.0):
    """调用 OpenAI 兼容接口（DeepSeek/OpenAI/Kimi/Qwen 等）做深度分析。

    cfg: {api_key, base_url, model}。base_url 形如 https://api.deepseek.com
    """
    api_key = (cfg.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "error": "未配置 API Key（设置→大模型分析→填入你的 Key）"}
    base = (cfg.get("base_url") or "https://api.deepseek.com").rstrip("/")
    model = (cfg.get("model") or "deepseek-chat").strip()
    url = base + "/chat/completions"
    if base.endswith("/v1"):
        url = base + "/chat/completions"

    matches = (data.get("jczq") or {}).get("matches") or []
    brief = []
    for m in matches[:30]:
        o = m.get("odds") or {}
        had = o.get("had") or {}
        brief.append({"id": m.get("id"), "league": m.get("league"), "home": m.get("home"),
                      "away": m.get("away"), "kickoff": m.get("kickoff"),
                      "胜平负赔率": had})
    zucai = []
    for i in (data.get("zucai") or {}).get("issues") or []:
        zucai.append({"玩法": i.get("game_name"), "期": i.get("issue"),
                      "场次": [f"{m.get('num')}.{m.get('home')}vs{m.get('away')}" for m in i.get("matches", [])]})

    system = ("你是中国体育彩票足球彩票的投注分析助手。用户每天预算有限（50-100元）。"
              "请基于给出的比赛赔率和概率，给出各玩法的投注建议：控制注数、分散风险、"
              "优先推荐高概率选项，冷门小注。只输出 JSON。")
    user = (f"今日预算：{budget}元。\n"
            f"竞彩足球（{len(brief)}场）：\n{json.dumps(brief, ensure_ascii=False)}\n"
            f"传统足彩：\n{json.dumps(zucai, ensure_ascii=False)}\n"
            f"内置模型推荐（供参考）：\n{json.dumps(plan, ensure_ascii=False)[:3000]}\n"
            "请输出 JSON：{\"summary\":\"一句话整体判断\","
            "\"plans\":{\"had\":[{\"match\":\"周六001\",\"pick\":\"胜\",\"stake\":2,\"reason\":\"...\"}],"
            "\"zucai14\":{\"dan\":[1,2],\"double\":[3,4],\"notes\":8},"
            "\"ren9\":[9,10,11,12,13,14,15,16,17],\"ban6\":{},\"goal4\":{}},"
            "\"risks\":[\"...\"]}。"
            "stake 单位为元，全部玩法合计不超过预算。")

    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.4,
        "response_format": {"type": "json_object"},
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "zucai-dashboard/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"请求失败: {e}"}
    try:
        obj = json.loads(raw)
        content = obj["choices"][0]["message"]["content"]
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": f"响应解析失败: {raw[:200]}"}
    # 兼容返回内容里带 ```json 包裹
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
    try:
        return {"ok": True, "result": json.loads(content), "model": model}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"内容不是合法 JSON: {e}"}


if __name__ == "__main__":
    import sys
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from sources import load_demo
    d = load_demo()
    p = build_full_plan(d, budget=100)
    print(json.dumps({
        "budget": p["budget"], "total_recommended": p["total_recommended"],
        "allocs": p["allocs"],
        "plans": {k: {"label": v["label"], "picks": len(v.get("picks", [])),
                      "ticket": v.get("ticket"), "spent": v.get("spent"),
                      "combos": len(v.get("combos", []))} for k, v in p["plans"].items()},
    }, ensure_ascii=False, indent=1))
