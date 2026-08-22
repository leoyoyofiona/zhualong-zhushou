#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成演示数据 demo_data.json（数据源全部不可用时的兜底，也可用于离线体验）。

用双泊松模型从"期望进球"生成一致的赔率（胜平负/让球/总进球/比分/半全场），
保证演示数据内部自洽，能完整体验所有玩法卡片与自动方案。
运行: python3 mock/gen_demo.py   (重新生成 mock/demo_data.json)
"""
import json
import math
import os
import random
from datetime import datetime, timedelta

DATE = "2026-08-22"  # 演示日期（周六）

# ---------------- 概率工具 ----------------

def poisson_pmf(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)

def bivariate_score_probs(lh, la, maxg=6):
    """独立双泊松近似，返回 {(h,a): p}，含"其他"合并。"""
    ph = [poisson_pmf(k, lh) for k in range(maxg + 1)]
    pa = [poisson_pmf(k, la) for k in range(maxg + 1)]
    ph[maxg] = 1 - sum(ph[:-1])
    pa[maxg] = 1 - sum(pa[:-1])
    out = {}
    for h in range(maxg + 1):
        for a in range(maxg + 1):
            out[(h, a)] = ph[h] * pa[a]
    return out

CRS_MAIN = (["1:0","2:0","2:1","3:0","3:1","3:2","4:0","4:1","4:2","4:3","5:0","5:1","5:2"],
            ["0:0","1:1","2:2","3:3"],
            ["0:1","0:2","1:2","0:3","1:3","2:3","0:4","1:4","2:4","3:4","0:5","1:5","2:5"])

def build_crs_odds(score_probs, margin):
    odds = []
    home_main, draw_main, away_main = CRS_MAIN
    ph = sum(score_probs[(h, a)] for (h, a) in score_probs if h > a and f"{h}:{a}" not in home_main)
    pd = sum(score_probs[(h, a)] for (h, a) in score_probs if h == a and f"{h}:{a}" not in draw_main)
    pa = sum(score_probs[(h, a)] for (h, a) in score_probs if h < a and f"{h}:{a}" not in away_main)
    total = sum(score_probs.values())
    def add(label, p):
        p = max(p / total, 1e-4)
        odds.append({"label": label, "odds": round(1 / p * (1 - margin) * random.uniform(0.96, 1.04), 2)})
    for g in home_main:
        h, a = map(int, g.split(":")); add(g, score_probs.get((h, a), 0))
    add("胜其他", ph)
    for g in draw_main:
        h, a = map(int, g.split(":")); add(g, score_probs.get((h, a), 0))
    add("平其他", pd)
    for g in away_main:
        h, a = map(int, g.split(":")); add(g, score_probs.get((h, a), 0))
    add("负其他", pa)
    return odds

def build_ttg_odds(score_probs, margin):
    odds = []
    for g in ["0","1","2","3","4","5","6","7+"]:
        p = 0.0
        if g == "7+":
            p = sum(v for (h, a), v in score_probs.items() if h + a >= 7)
        else:
            p = sum(v for (h, a), v in score_probs.items() if h + a == int(g))
        odds.append({"label": g, "odds": round(1 / max(p, 1e-4) * (1 - margin) * random.uniform(0.96, 1.04), 2)})
    return odds

HAFU_ORDER = ["胜-胜","胜-平","胜-负","平-胜","平平","平-负","负-胜","负-平","负-负"]

def build_hafu_odds(lh, la, margin):
    # 半场期望进球约为全场 42%
    hl, ha = lh * 0.42, la * 0.42
    probs = bivariate_score_probs(hl, ha)
    combos = {}
    for (h, a), p in probs.items():
        hs = "胜" if h > a else ("平" if h == a else "负")
        fs = "胜" if lh + random.uniform(-0.15, 0.15) > la + random.uniform(-0.15, 0.15) else ("平" if abs(lh - la) < 0.25 else "负")
        combos[hs + "-" + fs] = combos.get(hs + "-" + fs, 0) + p
    odds = []
    for c in HAFU_ORDER:
        p = max(combos.get(c, 0), 1e-4)
        odds.append({"label": c, "odds": round(1 / p * (1 - margin) * random.uniform(0.96, 1.04), 2)})
    return odds

def build_had_odds(lh, la, margin):
    probs = bivariate_score_probs(lh, la)
    ph = sum(v for (h, a), v in probs.items() if h > a)
    pd = sum(v for (h, a), v in probs.items() if h == a)
    pa = sum(v for (h, a), v in probs.items() if h < a)
    return {"h": round(1 / ph * (1 - margin), 2), "d": round(1 / pd * (1 - margin), 2), "a": round(1 / pa * (1 - margin), 2)}

def build_hhad_odds(lh, la, goal_line):
    # goal_line=-1(主让1球) => 主队期望进球 -1；goal_line=+1(主受让1球) => +1
    hl, ha = max(lh + goal_line, 0.25), max(la, 0.25)
    probs = bivariate_score_probs(hl, ha)
    ph = sum(v for (h, a), v in probs.items() if h > a)
    pd = sum(v for (h, a), v in probs.items() if h == a)
    pa = sum(v for (h, a), v in probs.items() if h < a)
    return {"h": round(1 / ph * (1 - 0.12), 2), "d": round(1 / pd * (1 - 0.12), 2), "a": round(1 / pa * (1 - 0.12), 2)}

# ---------------- 比赛库 ----------------

LEAGUES = ["英超","西甲","意甲","德甲","法甲","日职联","韩K联","中超","英冠","葡超"]
PAIRS = [
    ("埃弗顿","水晶宫"),("皇马","塞维利亚"),("AC米兰","都灵"),("多特蒙德","弗赖堡"),("里昂","摩纳哥"),
    ("浦和红钻","横滨水手"),("全北现代","蔚山现代"),("上海海港","山东泰山"),("利兹联","诺维奇"),("本菲卡","波尔图"),
    ("曼城","纽卡斯尔"),("巴塞罗那","比利亚雷亚尔"),("国际米兰","亚特兰大"),("勒沃库森","莱比锡"),("马赛","里尔"),
]
KICKOFFS = ["19:30","19:35","20:00","20:30","21:00","21:30","22:00","22:15","22:30","23:00","23:30","00:30"]

def gen_jczq(rng, n=10):
    matches = []
    for i in range(n):
        league = rng.choice(LEAGUES)
        home, away = PAIRS[i]
        # 主队略强
        base = rng.uniform(0.7, 1.5)
        lh = base
        la = base * rng.uniform(0.55, 0.95)
        margin = 0.11
        probs = bivariate_score_probs(lh, la)
        goal_line = rng.choice([-1, -1, 0, 0, 1])
        matches.append({
            "id": f"周六{rng.choice(['001','002','003','004','005','006','007','008','009','010'])}",
            "business_date": DATE,
            "league": league,
            "home": home,
            "away": away,
            "kickoff": f"{DATE} {KICKOFFS[i]}",
            "sale_stop": f"{DATE} 21:55",
            "status": "Selling",
            "odds": {
                "had": build_had_odds(lh, la, margin),
                "hhad": build_hhad_odds(lh, la, goal_line),
                "crs": build_crs_odds(probs, margin),
                "ttg": build_ttg_odds(probs, margin),
                "hafu": build_hafu_odds(lh, la, margin),
            },
        })
    return matches

def gen_zucai14(rng):
    matches = []
    kickoff = datetime.strptime(DATE + " 22:00", "%Y-%m-%d %H:%M")
    for i in range(14):
        league = rng.choice(["英超","西甲","意甲","德甲","法甲"])
        home, away = PAIRS[(i + 4) % len(PAIRS)]
        lh = rng.uniform(0.8, 1.6)
        la = lh * rng.uniform(0.5, 0.95)
        eo = build_had_odds(lh, la, 0.06)
        matches.append({
            "num": i + 1,
            "league": league,
            "home": home,
            "away": away,
            "kickoff": (kickoff + timedelta(hours=i % 4, minutes=15 * (i % 4))).strftime("%Y-%m-%d %H:%M"),
            "euro_odds": eo,
        })
    return matches

def main():
    rng = random.Random(20260822)
    data = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "demo": True,
        "jczq": {"matches": gen_jczq(rng, 10)},
        "zucai": {
            "issues": [
                {"game_no": 85, "game_name": "胜负彩(14场)", "issue": "26109", "sale_end": "2026-08-22 20:30", "draw_time": "2026-08-24 10:00", "matches": gen_zucai14(rng)},
                {"game_no": 86, "game_name": "任选9场", "issue": "26109", "sale_end": "2026-08-22 20:30", "draw_time": "2026-08-24 10:00", "matches": gen_zucai14(rng)},
                {"game_no": 87, "game_name": "6场半全场", "issue": "26110", "sale_end": "2026-08-23 22:00", "draw_time": "2026-08-25 10:00", "matches": gen_zucai14(rng)[:6]},
                {"game_no": 88, "game_name": "4场进球", "issue": "26110", "sale_end": "2026-08-23 22:00", "draw_time": "2026-08-25 10:00", "matches": gen_zucai14(rng)[:4]},
            ]
        },
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo_data.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print("written:", out, os.path.getsize(out), "bytes")

if __name__ == "__main__":
    main()
