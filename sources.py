#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据源层：中国体育彩票官方公开接口（主）→ 500.com / okooo 解析（备用）→ 演示数据（兜底）。

官方接口说明（境外/数据中心 IP 会被 WAF 以 HTTP 567 拒绝，中国家庭网络正常）：
  - 竞彩足球: webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry
              ?channel=c&poolCode=hhad,had,crs,ttg,hafu
              返回 {success, value:{matchInfoList:[...]}}，含全部 5 种玩法赔率。
  - 传统足彩: webapi.sporttery.cn/gateway/lottery/getIssueListV1.qry?gameNo=85&...
              gameNo: 85胜负彩 / 86任选9 / 87六场半全场 / 88四场进球
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
import datetime as dt
import difflib

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_FILE = os.path.join(BASE_DIR, "mock", "demo_data.json")

UA_MOBILE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1")
UA_DESKTOP = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

CRS_RE = re.compile(r"^(\d+:\d+|胜其他|平其他|负其他)$")
TTG_RE = re.compile(r"^(\d{1,2}|7\+)$")
HAFU_RE = re.compile(r"^[胜平负]{1,2}(?:-[胜平负])?$")


class SourceError(Exception):
    pass


# ---------------- HTTP ----------------

def http_get(url: str, timeout: float = 15.0, ua: str = UA_MOBILE,
             referer: str | None = None, encoding: str | None = None) -> str:
    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return raw.decode(encoding or "utf-8", errors="replace")


def http_get_json(url: str, timeout: float = 15.0, ua: str = UA_MOBILE,
                  referer: str | None = None):
    return json.loads(http_get(url, timeout=timeout, ua=ua, referer=referer))


# ---------------- 通用防御解析 ----------------

def _pick(d, keys, default=None):
    if not isinstance(d, dict):
        return default
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return default


def _num(v):
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def _iter_dicts(obj, depth=0, max_depth=4):
    """递归产出所有 dict。"""
    if depth > max_depth:
        return
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _iter_dicts(v, depth + 1, max_depth)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_dicts(v, depth + 1, max_depth)


def _tw(pool: dict):
    """把一个 dict 当成三路赔率解析：{h,d,a}。"""
    cand = {}
    for k, v in pool.items():
        f = _num(v)
        if f is None:
            continue
        kl = str(k).lower()
        if kl in ("h", "home", "主", "主胜", "胜"):
            cand["h"] = f
        elif kl in ("d", "draw", "平", "平局"):
            cand["d"] = f
        elif kl in ("a", "away", "客", "客胜", "负"):
            cand["a"] = f
    if {"h", "d", "a"} <= set(cand) and all(cand[k] > 1.0 for k in ("h", "d", "a")):
        return cand
    return None


def extract_three_way(pool):
    """pool -> {h,d,a}；兼容直接键或嵌套 dict。"""
    if isinstance(pool, dict):
        r = _tw(pool)
        if r:
            return r
        for v in pool.values():
            if isinstance(v, dict):
                r = _tw(v)
                if r:
                    return r
    return None


def _goal_line(pool):
    """从让球池里找让球数。"""
    if not isinstance(pool, dict):
        return None
    for k in ("goalLine", "rq", "rang", "goal", "line", "rqs"):
        if k in pool:
            v = pool[k]
            try:
                return int(float(v))
            except (TypeError, ValueError):
                continue
    return None


def extract_list_pool(pool, label_re):
    """pool -> [{"label","odds"}]；标签与赔率字段名未知，按类型猜测。"""
    seq = None
    if isinstance(pool, list):
        seq = pool
    elif isinstance(pool, dict):
        seq = next((v for v in pool.values() if isinstance(v, list)), None)
    if not seq:
        return []
    out = []
    for it in seq:
        if not isinstance(it, dict):
            continue
        label, odds = None, None
        for k, v in it.items():
            if label is None and isinstance(v, str) and label_re.match(v.strip()):
                label = v.strip()
            elif label is None and isinstance(k, str) and label_re.match(k) and isinstance(v, (int, float)):
                label, odds = k, float(v)
            elif odds is None:
                f = _num(v)
                if f and f > 1.0:
                    odds = f
        if label and odds:
            out.append({"label": label, "odds": round(odds, 2)})
    return out


def find_match_records(obj):
    """递归找形如比赛记录的 dict：同时有主队、客队名称。"""
    out, seen = [], set()
    for d in _iter_dicts(obj):
        home = _pick(d, ["homeTeamAllName", "homeTeamName", "homeTeam", "homeName", "home", "主队"])
        away = _pick(d, ["awayTeamAllName", "awayTeamName", "awayTeam", "awayName", "away", "客队"])
        if not (isinstance(home, str) and isinstance(away, str) and home and away):
            continue
        key = (home, away, str(_pick(d, ["leagueAllName", "leagueName", "league", ""])))
        if key in seen:
            continue
        seen.add(key)
        num = _pick(d, ["matchNum", "matchNumStr", "no", "num", "matchId"])
        league = _pick(d, ["leagueAllName", "leagueName", "leagueAbbr", "league", "matchDesc"])
        kickoff = _pick(d, ["matchDate", "matchTime", "kickoffTime", "matchTimeStr"])
        if isinstance(kickoff, (list, dict)):
            kickoff = None
        rec = {
            "num": num if num is not None else len(out) + 1,
            "league": league or "",
            "home": home,
            "away": away,
            "kickoff": kickoff,
            "euro_odds": None,
        }
        eo = None
        for key in ("euroOdds", "euro", "ouOdds", "avgOdds", "europeOdds"):
            v = d.get(key)
            if isinstance(v, dict):
                eo = extract_three_way(v)
                if eo:
                    break
        if eo is None:
            eo = extract_three_way(d)
        rec["euro_odds"] = eo
        out.append(rec)
    return out


# ---------------- 竞彩足球：官方 ----------------

JCZQ_APIS = [
    "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry",
    "https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry",
]
JCZQ_POOLS = "hhad,had,crs,ttg,hafu"


def _sale_stop(business_date: str, kickoff: str | None) -> str | None:
    """竞彩截止：工作日 22:00 / 周末 23:00（按比赛日），并取与开赛时间的较早者。"""
    try:
        d = dt.date.fromisoformat(str(business_date)[:10])
    except ValueError:
        d = None
    stop = None
    if d:
        hour = 23 if d.weekday() >= 5 else 22
        stop = dt.datetime.combine(d, dt.time(hour, 0))
    if kickoff:
        try:
            kt = dt.datetime.fromisoformat(str(kickoff).replace(" ", "T")[:16])
            if stop:
                stop = min(kt, stop)
            else:
                stop = kt
        except ValueError:
            pass
    return stop.strftime("%Y-%m-%d %H:%M") if stop else None


def extract_jczq_match(m: dict):
    home = _pick(m, ["homeTeamAllName", "homeTeamName", "homeTeam", "homeName", "home"])
    away = _pick(m, ["awayTeamAllName", "awayTeamName", "awayTeam", "awayName", "away"])
    if not (home and away):
        return None
    league = _pick(m, ["leagueAllName", "leagueName", "leagueAbbr", "league", "matchDesc"])
    mid = _pick(m, ["matchNumStr", "matchNum", "matchId", "id"])
    biz = _pick(m, ["businessDate", "matchDate"])
    mdate = _pick(m, ["matchDate", "businessDate"])
    mtime = _pick(m, ["matchTime", "time"])
    kickoff = None
    if mdate and mtime:
        try:
            kickoff = f"{mdate[:10]} {str(mtime)[:5]}"
        except Exception:
            kickoff = None
    odds = {}
    # 池子可能在 match 顶层，也可能在某个嵌套 dict（如 odds/poolList）里
    pool_holder = {**m}
    for v in m.values():
        if isinstance(v, dict):
            pool_holder.update(v)
    for name, re_lab in (("had", None), ("hhad", None), ("crs", CRS_RE), ("ttg", TTG_RE), ("hafu", HAFU_RE)):
        pool = None
        for d in (pool_holder, m):
            if isinstance(d, dict) and name in d:
                pool = d[name]
                break
        if pool is None:
            continue
        if name in ("had", "hhad"):
            tw = extract_three_way(pool)
            if tw:
                entry = dict(tw)
                gl = _goal_line(pool) if name == "hhad" else None
                if gl is not None:
                    entry["goal_line"] = gl
                odds[name] = entry
        else:
            items = extract_list_pool(pool, re_lab)
            if items:
                odds[name] = items
    return {
        "id": str(mid or ""),
        "business_date": str(biz or "")[:10],
        "league": str(league or ""),
        "home": home,
        "away": away,
        "kickoff": kickoff or "",
        "sale_stop": _sale_stop(str(biz or mdate or ""), kickoff),
        "status": str(_pick(m, ["matchStatus", "status", "saleStatus"], "")),
        "odds": odds,
    }


def fetch_jczq_official():
    last_err = None
    for api in JCZQ_APIS:
        try:
            url = f"{api}?channel=c&poolCode={urllib.parse.quote(JCZQ_POOLS, safe=',')}"
            obj = http_get_json(url, referer="https://m.sporttery.cn/")
            if not isinstance(obj, dict):
                raise SourceError("返回不是 JSON 对象")
            ml = (obj.get("value") or {}).get("matchInfoList")
            if not isinstance(ml, list):
                raise SourceError("返回中没有 matchInfoList: " + str(obj)[:120])
            matches = [extract_jczq_match(x) for x in ml]
            matches = [x for x in matches if x]
            if not matches:
                raise SourceError("解析出 0 场比赛")
            return matches, "sporttery"
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise SourceError(f"官方竞彩接口失败: {last_err}")


# ---------------- 竞彩足球：500.com 备用 ----------------

BQC_MAP = {"3": "胜", "1": "平", "0": "负"}
# 500.com 各玩法页 playid（与体彩中心赔率同步的镜像）
PLAYID_POOLS = {"ttg": 270, "crs": 271, "hafu": 272}


def _parse_500_extra_page(html: str, pool: str):
    """解析 500.com 比分/总进球/半全场页的赔率按钮，返回 {match_id: [{label, odds}]}。

    结构：总进球/半全场在主行 td-betbtn 里（class=betbtn, data-type=jqs/bqc）；
          比分在行后 bet-more-wrap 里（class=sbetbtn, data-type=bf）。
    """
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
    out, cur = {}, None
    for r in rows:
        m = re.search(r'class="td td-no">.*?>\s*([^<\s]+)', r, re.S)
        if m:
            cur = m.group(1).strip()
        if not cur:
            continue
        btns = re.findall(r'class="betbtn" data-type="(?:jqs|bqc)" data-value="([^"]*)" data-sp="([\d.]+)"', r)
        if not btns:
            btns = re.findall(r'data-type="bf" data-value="([^"]*)" data-sp="([\d.]+)"', r)
        items = []
        for val, sp in btns:
            label = val
            if pool == "hafu":
                label = "-".join(BQC_MAP.get(c, c) for c in val.split("-"))
            items.append({"label": label, "odds": float(sp)})
        if items:
            out.setdefault(cur, []).extend(items)
    return out


def fetch_jczq_500():
    html = http_get("https://trade.500.com/jczq/", ua=UA_DESKTOP, encoding="gb18030")
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
    matches, today = [], dt.date.today()
    for r in rows:
        if "td-team" not in r:
            continue
        try:
            no = re.search(r'class="td td-no">.*?>\s*([^<\s]+)', r, re.S)
            league = re.search(r'class="td td-evt">.*?title="([^"]+)"', r, re.S)
            endtime = re.search(r'class="td td-endtime"[^>]*>\s*([^<]+)', r, re.S)
            home = re.search(r'class="team-l"[^>]*title="([^"]+)"', r, re.S)
            away = re.search(r'class="team-r"[^>]*title="([^"]+)"', r, re.S)
            rang = re.search(r'class="[^"]*itm-rangA2[^"]*"[^>]*title="([^"]+)"[^>]*>\s*([-+]?\d+)', r, re.S)
            # B1(nspf)=非让球胜平负, B2(spf)=让球胜平负（已用63场一致性验证）
            b1 = re.findall(r'class="betbtn" data-type="nspf" data-value="\d" data-sp="([\d.]+)"', r)
            b2 = re.findall(r'class="betbtn" data-type="spf" data-value="\d" data-sp="([\d.]+)"', r)
            if not (no and league and home and away):
                continue
            kickoff = ""
            if endtime:
                try:
                    md = endtime.group(1).strip()[:10]  # MM-DD HH:MM
                    mo, dd = md[:2], md[3:5]
                    kickoff = f"{today.year}-{mo}-{dd} {md[6:]}"
                except Exception:
                    kickoff = endtime.group(1).strip()
            hd = dict(zip(("h", "d", "a"), (float(x) for x in b1))) if len(b1) == 3 else None
            hh = dict(zip(("h", "d", "a"), (float(x) for x in b2))) if len(b2) == 3 else None
            gl = None
            if rang and rang.group(2) not in ("", "0"):
                gl = int(rang.group(2))
            odds = {}
            if hd:
                odds["had"] = hd
            if hh:
                entry = dict(hh)
                if gl is not None:
                    entry["goal_line"] = gl
                odds["hhad"] = entry
            matches.append({
                "id": no.group(1).strip(),
                "business_date": today.isoformat(),
                "league": league.group(1).strip(),
                "home": home.group(1).strip(),
                "away": away.group(1).strip(),
                "kickoff": kickoff,
                "sale_stop": kickoff,
                "status": "Selling",
                "odds": odds,
            })
        except Exception:  # noqa: BLE001
            continue
    if not matches:
        raise SourceError("500.com 解析出 0 场比赛")
    # 比分/总进球/半全场（与体彩中心赔率同步的镜像页）
    by_id = {m["id"]: m for m in matches}
    for pool, playid in PLAYID_POOLS.items():
        try:
            h2 = http_get(f"https://trade.500.com/jczq/?playid={playid}&g=2",
                          ua=UA_DESKTOP, encoding="gb18030")
            extra = _parse_500_extra_page(h2, pool)
            for mid, items in extra.items():
                if mid in by_id:
                    by_id[mid]["odds"][pool] = items
        except Exception:  # noqa: BLE001
            continue
    return matches, "500com"


# ---------------- 传统足彩：官方 ----------------

LOTTERY_BASE = "https://webapi.sporttery.cn/gateway/lottery"
GAME_NOS = {85: "胜负彩(14场)", 86: "任选9场", 87: "6场半全场", 88: "4场进球"}
ISSUE_ENDPOINTS = ("getMatchListV1.qry", "getIssueMatchV1.qry", "getFootballMatchV1.qry",
                   "getMatchScheduleV1.qry")


def _parse_dt(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(str(s).replace("/", "-")[:16].replace("T", " "))
    except (ValueError, TypeError):
        return None


def fetch_zucai_issue(gno: int) -> dict:
    url = (f"{LOTTERY_BASE}/getIssueListV1.qry?gameNo={gno}&provinceId=0"
           f"&pageSize=10&isVerify=1&pageNo=1")
    obj = http_get_json(url, referer="https://www.sporttery.cn/")
    value = obj.get("value") or {}
    issues = value.get("list") or value.get("issueList") or []
    if not isinstance(issues, list) or not issues:
        raise SourceError(f"gameNo {gno} 期列表为空")
    now = dt.datetime.now()
    cur = None
    for it in issues:
        et = _parse_dt(_pick(it, ["saleEndTime", "endTime", "stopTime", "saleEnd"]))
        if et and et > now:
            cur = it
            break
    if cur is None:
        cur = issues[0]
    issue = _pick(cur, ["issueNum", "issue", "issueNumber", "lotteryIssue"])
    if issue is None:
        raise SourceError(f"gameNo {gno} 期号缺失")
    matches = None
    last_err = None
    for ep in ISSUE_ENDPOINTS:
        try:
            u = f"{LOTTERY_BASE}/{ep}?gameNo={gno}&issueNum={issue}"
            o = http_get_json(u, referer="https://www.sporttery.cn/")
            found = find_match_records(o)
            if found:
                matches = found
                break
        except Exception as e:  # noqa: BLE001
            last_err = e
    if not matches:
        matches = find_match_records(cur)
    if not matches:
        raise SourceError(f"gameNo {gno} 期 {issue} 未找到比赛" + (f"（{last_err}）" if last_err else ""))
    return {
        "game_no": gno,
        "game_name": GAME_NOS.get(gno, f"传统足彩{gno}"),
        "issue": str(issue),
        "sale_end": str(_pick(cur, ["saleEndTime", "endTime", "stopTime", "saleEnd"], "")),
        "draw_time": str(_pick(cur, ["drawTime", "drawDate", "awardTime"], "")),
        "matches": matches,
    }


def fetch_zucai_official():
    issues, errs = [], []
    for gno in (85, 86, 87, 88):
        try:
            issues.append(fetch_zucai_issue(gno))
        except Exception as e:  # noqa: BLE001
            errs.append(f"gameNo{gno}: {e}")
    if not issues:
        raise SourceError("官方传统足彩接口失败: " + "; ".join(errs))
    return issues, "sporttery"


# ---------------- 传统足彩：okooo 备用 ----------------

def parse_okooo_rows(html: str):
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
    year = dt.date.today().year
    out = []
    for r in rows:
        if "jsLeagueName" not in r:
            continue
        try:
            # 序号
            nm = re.search(r'class="[^"]*td1[^"]*"[^>]*>\s*([^<\s]+)', r, re.S)
            num = nm.group(1).strip() if nm else ""
            # 联赛（锚文本）
            lm = re.search(r'class="[^"]*jsLeagueName[^"]*"[^>]*>\s*([^<]+?)</a>', r, re.S)
            league = re.sub(r"<[^>]+>", "", lm.group(1)).strip() if lm else ""
            # 时间：优先 td 的 title（完整日期时间），否则 MatchTime 文本
            tm = re.search(r'class="[^"]*(?:switchtime|timetd)[^"]*"(?:[^>]*title="([^"]*)")?[^>]*>', r, re.S)
            t = ""
            if tm and tm.group(1):
                t = tm.group(1).replace("比赛时间:", "")
            else:
                t2 = re.search(r'class="MatchTime"[^>]*>\s*([^<]+)', r, re.S)
                t = t2.group(1).strip() if t2 else ""
            kickoff = ""
            if t:
                try:
                    mm, dd = t[5:7], t[8:10]
                    kickoff = f"{t[:4]}-{mm}-{dd} {t[11:16]}"
                except Exception:
                    kickoff = t
            # 主/客队名
            hm = re.search(r'class="[^"]*homename[^"]*"[^>]*>\s*([^<]+)', r, re.S)
            am = re.search(r'class="[^"]*awayname[^"]*"[^>]*>\s*([^<]+)', r, re.S)
            home = hm.group(1).strip() if hm else ""
            away = am.group(1).strip() if am else ""
            # 欧指（99家平均）: 三个 pltxt 数值 主胜/平/客胜
            nums = re.findall(r'class="pltxt"[^>]*>\s*([\d.]+)', r, re.S)
            eo = None
            if len(nums) >= 3:
                try:
                    eo = {"h": float(nums[0]), "d": float(nums[1]), "a": float(nums[2])}
                except ValueError:
                    eo = None
            if not (home and away):
                continue
            out.append({
                "num": num or (len(out) + 1),
                "league": league,
                "home": home,
                "away": away,
                "kickoff": kickoff,
                "euro_odds": eo,
            })
        except Exception:  # noqa: BLE001
            continue
    return out


def fetch_zucai_okooo():
    html = http_get("https://www.okooo.com/zucai/", ua=UA_DESKTOP, encoding="gb18030")
    m = re.search(r'title="(\d{5})期"', html)
    if not m:
        raise SourceError("okooo: 未找到当前期号")
    issue = m.group(1)
    matches = parse_okooo_rows(html)
    if len(matches) < 14:
        raise SourceError(f"okooo: 比赛行不足（{len(matches)}<14）")
    base = {
        "issue": issue,
        "sale_end": "",
        "draw_time": "",
        "matches": matches[:14],
    }
    return [
        {**base, "game_no": 85, "game_name": "胜负彩(14场)"},
        {**base, "game_no": 86, "game_name": "任选9场"},
    ], "okooo"


# ---------------- 传统足彩：500.com 半全场/进球彩 备用 ----------------

Z500_BQC = "https://trade.500.com/bqc/"
Z500_JQC = "https://trade.500.com/jqc/"


def _parse_500_zucai_page(html: str):
    """解析 500.com 半全场/进球彩页 -> (期号, 比赛列表)。"""
    m = re.search(r"(\d{5})期", html)
    issue = m.group(1) if m else ""
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
    year = dt.date.today().year
    matches = []
    for r in rows:
        if "td-no" not in r or "td-team" not in r:
            continue
        try:
            no = re.search(r'class="td td-no">\s*(\d+)', r)
            # 500 半全场/进球彩页：队名/联赛是锚文本而非 title
            league_m = re.search(r'class="td td-evt">.*?>\s*([^<]+)</a>', r, re.S)
            league = league_m.group(1).strip() if league_m else ""
            endtime = re.search(r'class="td td-endtime"[^>]*>\s*([^<]+)', r)
            home_m = re.search(r'class="team-l"[^>]*>\s*([^<]+)<', r, re.S)
            away_m = re.search(r'class="team-r"[^>]*>\s*([^<]+)<', r, re.S)
            home = home_m.group(1).strip() if home_m else ""
            away = away_m.group(1).strip() if away_m else ""
            if not (no and home and away and league):
                continue
            kickoff = ""
            if endtime:
                try:
                    md = endtime.group(1).strip()[:10]
                    kickoff = f"{year}-{md[:2]}-{md[3:5]} {md[6:]}"
                except Exception:
                    kickoff = endtime.group(1).strip()
            matches.append({
                "num": no.group(1).strip(),
                "league": league,
                "home": home,
                "away": away,
                "kickoff": kickoff,
                "euro_odds": None,
            })
        except Exception:  # noqa: BLE001
            continue
    return issue, matches


def fetch_zucai_500():
    """6场半全场(87) / 4场进球(88) 备用源：500.com 真实期号与赛程。"""
    issues, errs = [], []
    for url, gno, gname, limit in ((Z500_BQC, 87, "6场半全场", 6), (Z500_JQC, 88, "4场进球", 4)):
        try:
            html = http_get(url, ua=UA_DESKTOP, encoding="gb18030")
            issue, matches = _parse_500_zucai_page(html)
            if not issue:
                raise SourceError(f"{gname}: 未找到期号")
            if len(matches) < limit:
                raise SourceError(f"{gname}: 比赛不足（{len(matches)}<{limit}）")
            issues.append({
                "game_no": gno, "game_name": gname, "issue": issue,
                "sale_end": "", "draw_time": "", "matches": matches[:limit],
            })
        except Exception as e:  # noqa: BLE001
            errs.append(f"{gname}: {e}")
    if not issues:
        raise SourceError("500.com 半全场/进球彩失败: " + "; ".join(errs))
    return issues, "500com"


# ---------------- 演示数据 ----------------

def load_demo():
    with open(DEMO_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return data


# ---------------- 统一入口 ----------------

def fetch_all(preferred: str = "auto"):
    """preferred: auto | official | fallback | demo。返回归一化数据。"""
    result = {
        "generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "demo": False,
        "sources": {},
        "jczq": {"matches": []},
        "zucai": {"issues": []},
    }

    # ---- 竞彩足球 ----
    jczq_done = False
    if preferred in ("auto", "official"):
        try:
            ms, src = fetch_jczq_official()
            result["jczq"]["matches"] = ms
            result["sources"]["jczq"] = {"source": src, "ok": True, "error": None}
            jczq_done = True
        except Exception as e:  # noqa: BLE001
            result["sources"]["jczq"] = {"source": None, "ok": False, "error": str(e)}
    if not jczq_done and preferred in ("auto", "fallback"):
        try:
            ms, src = fetch_jczq_500()
            result["jczq"]["matches"] = ms
            result["sources"]["jczq"] = {"source": src, "ok": True, "error": None}
            jczq_done = True
        except Exception as e:  # noqa: BLE001
            err = result["sources"].get("jczq", {}).get("error") or ""
            result["sources"]["jczq"] = {"source": None, "ok": False,
                                         "error": (err + " | 500.com: " + str(e)).strip(" |")}
    if not jczq_done:
        result["sources"]["jczq"] = {"source": "demo", "ok": True,
                                     "error": "官方与备用源均不可用，已用演示数据"}

    # ---- 传统足彩 ----
    zucai_done = False
    if preferred in ("auto", "official"):
        try:
            issues, src = fetch_zucai_official()
            result["zucai"]["issues"] = issues
            result["sources"]["zucai"] = {"source": src, "ok": True, "error": None}
            zucai_done = True
        except Exception as e:  # noqa: BLE001
            result["sources"]["zucai"] = {"source": None, "ok": False, "error": str(e)}
    if not zucai_done and preferred in ("auto", "fallback"):
        try:
            issues, src = fetch_zucai_okooo()
            # 6场半全场(87)/4场进球(88)：okooo 不提供，用 500.com 真实期号与赛程补齐
            try:
                extra, src2 = fetch_zucai_500()
                issues.extend(extra)
                src = f"{src}+{src2}"
            except Exception as e2:  # noqa: BLE001
                src = f"{src}（87/88备用: {e2}）"
            result["zucai"]["issues"] = issues
            result["sources"]["zucai"] = {"source": src, "ok": True, "error": None}
            zucai_done = True
        except Exception as e:  # noqa: BLE001
            err = result["sources"].get("zucai", {}).get("error") or ""
            result["sources"]["zucai"] = {"source": None, "ok": False,
                                          "error": (err + " | okooo: " + str(e)).strip(" |")}
    if not zucai_done:
        result["sources"]["zucai"] = {"source": "demo", "ok": True,
                                      "error": "官方与备用源均不可用，已用演示数据"}

    # ---- 合并演示数据补齐缺失部分 ----
    if not result["jczq"]["matches"] or not result["zucai"]["issues"]:
        demo = load_demo()
        if not result["jczq"]["matches"]:
            result["jczq"]["matches"] = demo["jczq"]["matches"]
            result["sources"]["jczq"] = {"source": "demo", "ok": True, "error": "该部分已用演示数据"}
        if not result["zucai"]["issues"]:
            result["zucai"]["issues"] = demo["zucai"]["issues"]
            result["sources"]["zucai"] = {"source": "demo", "ok": True, "error": "该部分已用演示数据"}
        result["demo"] = True

    # 任九若官方未单独返回比赛，沿用胜负彩同期的 14 场
    z85 = next((i for i in result["zucai"]["issues"] if i.get("game_no") == 85), None)
    if z85:
        for i in result["zucai"]["issues"]:
            if i.get("game_no") == 86 and (not i.get("matches") or len(i.get("matches", [])) < 14):
                i["matches"] = z85["matches"]

    # 传统足彩某玩法缺失时用演示数据补齐，并标记部分覆盖
    if result["zucai"]["issues"]:
        demo = load_demo()
        have = {i.get("game_no") for i in result["zucai"]["issues"]}
        for gno in (85, 86, 87, 88):
            if gno not in have:
                di = next((i for i in demo["zucai"]["issues"] if i.get("game_no") == gno), None)
                if di:
                    di = dict(di)
                    di["demo_fill"] = True
                    result["zucai"]["issues"].append(di)
        partial = len(have) < 4
        if partial:
            src = result["sources"].get("zucai", {})
            src["partial"] = True
            src["error"] = (src.get("error") or "") + " | 部分玩法（6场半全场/4场进球）当前源未提供，已用演示数据"
            result["sources"]["zucai"] = src

    # ---- 87/88 比赛补真实欧指：按队名相似度匹配竞彩胜平负赔率或胜负彩欧指 ----
    def _sim(a, b):
        return difflib.SequenceMatcher(None, a or "", b or "").ratio()

    def _find_odds(home, away, pool):
        best, best_score = None, 0.0
        for j in pool:
            jh, ja = j.get("home"), j.get("away")
            if not jh or not ja:
                continue
            s = (_sim(home, jh) + _sim(away, ja)) / 2
            if s > best_score:
                best_score, best = s, j
        return best if best_score >= 0.62 else None

    jczq_had = [m for m in result["jczq"]["matches"] if (m.get("odds") or {}).get("had")]
    z85 = next((i for i in result["zucai"]["issues"] if i.get("game_no") == 85), None)
    z85_euro = [m for m in (z85.get("matches") or []) if m.get("euro_odds")]
    for i in result["zucai"]["issues"]:
        if i.get("game_no") not in (87, 88):
            continue
        for mm in i.get("matches") or []:
            j = _find_odds(mm.get("home"), mm.get("away"), jczq_had)
            if j:
                mm["euro_odds"] = j["odds"]["had"]
                continue
            z = _find_odds(mm.get("home"), mm.get("away"), z85_euro)
            if z:
                mm["euro_odds"] = z["euro_odds"]
    return result


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "auto"
    print(f"== fetch_all(preferred={mode}) ==")
    r = fetch_all(mode)
    print(json.dumps({k: r[k] for k in ("demo", "sources")}, ensure_ascii=False, indent=1))
    print("jczq matches:", len(r["jczq"]["matches"]))
    for m in r["jczq"]["matches"][:2]:
        print("  ", m["id"], m["league"], m["home"], "vs", m["away"], "| had:", m["odds"].get("had"), "| pools:", list(m["odds"].keys()))
    for i in r["zucai"]["issues"]:
        print("  zucai", i["game_no"], i["game_name"], "期", i["issue"], "比赛数", len(i["matches"]))
