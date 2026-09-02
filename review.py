#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""复盘引擎：把"预测快照"与"真实赛果"比对，统计各玩法命中率，供模型校准与 DeepSeek 归因。

核心思路：赛果只需每场最终比分(可加半场比分)，就能判定所有玩法的对错——
  胜平负: 主客进球关系；总进球: 进球和；比分: 精确比分；半全场/6场半全场: 半场+全场结果；
  4场进球: 每队进球落在 0/1/2/3+ 哪档。
"""
from __future__ import annotations

import datetime as dt


def outcome_ft(h, a):
    return "胜" if h > a else ("平" if h == a else "负")


def outcome_label(hs, ha, h, a, kind):
    """kind: had(全场)/hafu(半全场组合)"""
    if kind == "hafu":
        return f"{outcome_ft(hs, ha)}-{outcome_ft(h, a)}"
    return outcome_ft(h, a)


def goal_bucket(g):
    return "3+" if g >= 3 else str(g)


def eval_pick(pool, option, hs, ha, h, a):
    """判定单个选项是否命中；缺少必要数据返回 None(无法判定)。"""
    if pool == "had":
        return option == outcome_ft(h, a)
    if pool == "hhad":
        return option == outcome_ft(h, a)  # 让球结果需让球数，暂按全场
    if pool == "ttg":
        total = h + a
        label = str(total) if total <= 6 else "7+"
        return option == label
    if pool == "crs":
        return option == f"{h}:{a}"
    if pool == "hafu":
        if hs is None:
            return None
        return option.replace("-", "") == (outcome_ft(hs, ha) + outcome_ft(h, a))
    if pool in ("zucai14", "ren9"):
        return option == outcome_ft(h, a)
    if pool == "ban6":
        if hs is None:
            return None
        return option.replace("-", "") == (outcome_ft(hs, ha) + outcome_ft(h, a))
    if pool == "goal4":
        # option 形如 "2" 或 "3+"，与队伍实际进球档比较
        return option == goal_bucket(h if hs is None else h)
    return None


def match_key(home, away):
    return f"{home}|{away}"


def evaluate_snapshot(snap, results):
    """snap: 预测快照 {date, jczq:{pool:[{mid,home,away,option,...}]}, zucai:{...}}
       results: {match_key: {hs,ha,h,a}}（key=home|away）
       返回 {pool: {hit,total,rows:[...]}, summary}
    """
    out = {}
    jczq = snap.get("jczq") or {}
    for pool, picks in jczq.items():
        st = out.setdefault(pool, {"hit": 0, "total": 0, "rows": []})
        for p in picks:
            key = match_key(p.get("home", ""), p.get("away", ""))
            r = results.get(key)
            if not r:
                st["rows"].append({**p, "actual": None, "correct": None})
                continue
            c = eval_pick(pool, p.get("option"), r.get("hs"), r.get("ha"), r["h"], r["a"])
            st["total"] += 1
            if c:
                st["hit"] += 1
            st["rows"].append({**p, "actual": f"{r['h']}:{r['a']}", "correct": c})
    zucai = snap.get("zucai") or {}
    for pool, rows in zucai.items():
        st = out.setdefault(pool, {"hit": 0, "total": 0, "rows": []})
        for row in rows:
            key = match_key(row.get("home", ""), row.get("away", ""))
            r = results.get(key)
            if not r:
                st["rows"].append({**row, "actual": None, "correct": None})
                continue
            if pool == "goal4" and (row.get("home_options") or row.get("away_options")):
                # 4场进球：主队进球档命中 且 客队进球档命中
                c = (goal_bucket(r["h"]) in (row.get("home_options") or [])) and \
                    (goal_bucket(r["a"]) in (row.get("away_options") or []))
                pick = "主" + "/".join(row.get("home_options") or []) + " 客" + "/".join(row.get("away_options") or [])
            elif isinstance(row.get("options"), list) and row["options"]:
                hits = [eval_pick(pool, o, r.get("hs"), r.get("ha"), r["h"], r["a"]) for o in row["options"]]
                hits = [x for x in hits if x is not None]
                c = any(hits) if hits else None
                pick = "/".join(row["options"])
            else:
                c = eval_pick(pool, row.get("option"), r.get("hs"), r.get("ha"), r["h"], r["a"])
                pick = row.get("option")
            st["total"] += 1
            if c:
                st["hit"] += 1
            st["rows"].append({**row, "pick": pick, "actual": f"{r['h']}:{r['a']}", "correct": c})
    # 汇总
    summary = []
    for pool, st in out.items():
        if st["total"]:
            summary.append({"pool": pool, "hit": st["hit"], "total": st["total"],
                            "rate": round(st["hit"] / st["total"] * 100, 1)})
    return {"pools": out, "summary": summary,
            "generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
