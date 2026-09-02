#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""足彩方案助手 · 本地 Web 服务

启动:  python3 server.py            # 默认 http://127.0.0.1:8456
参数:  --port 8456  --no-browser  --pref auto|official|fallback|demo

功能:
  * 定时同步中国体彩官方公开接口（失败自动降级 500.com/okooo/演示数据）
  * 内置分析引擎自动生成九种玩法的投注方案
  * 历史记录（SQLite）与盈亏统计
  * 可选大模型深度分析（Key 仅存浏览器本地，直连你配置的服务）
仅绑定 127.0.0.1，仅供本机使用。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import engine
import review
import sources

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
CACHE_FILE = os.path.join(CACHE_DIR, "state.json")
DB_FILE = os.path.join(DATA_DIR, "zucai.db")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

REFRESH_INTERVAL = 600  # 秒
MAX_BODY = 1024 * 1024
ODDS_HISTORY_FILE = os.path.join(CACHE_DIR, "odds_history.jsonl")
ODDS_HISTORY_LIMIT = 2000  # 保留最近 N 条快照

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

# ---------------- 全局状态 ----------------

_state = {
    "data": None,
    "plan": None,
    "updated_at": None,
    "source_pref": "auto",
    "refreshing": False,
    "last_error": None,
}
_state_lock = threading.Lock()
_shutdown = threading.Event()


def load_settings() -> dict:
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save_settings(s: dict):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)


# ---------------- 数据库 ----------------

def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute("""CREATE TABLE IF NOT EXISTS bets(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT, bet_date TEXT, game_type TEXT, issue TEXT,
        title TEXT, selections TEXT, stake REAL, odds TEXT,
        status TEXT DEFAULT 'pending', profit REAL DEFAULT 0, note TEXT
    )""")
    # 预测快照：每次生成方案(一键推荐/今日投注分析/采用推荐)自动存档，用于复盘训练
    conn.execute("""CREATE TABLE IF NOT EXISTS snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT, bet_date TEXT, budget REAL,
        source TEXT, plan TEXT, summary TEXT
    )""")
    # 赛果：以"比赛id+日期"为键的最终比分（含半场），用于复盘比对
    conn.execute("""CREATE TABLE IF NOT EXISTS results(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bet_date TEXT, match_key TEXT, league TEXT, home TEXT, away TEXT,
        hs INTEGER, ha INTEGER, fs_h INTEGER, fs_a INTEGER,
        UNIQUE(bet_date, match_key)
    )""")
    conn.commit()
    conn.close()


def db_exec(sql, args=()):
    conn = sqlite3.connect(DB_FILE)
    try:
        cur = conn.execute(sql, args)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def db_query(sql, args=()):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, args)]
    finally:
        conn.close()


# ---------------- 数据刷新 ----------------

def refresh_data(pref: str | None = None):
    pref = pref or _state.get("source_pref") or "auto"
    with _state_lock:
        _state["refreshing"] = True
        _state["last_error"] = None
    t0 = time.time()
    try:
        data = sources.fetch_all(pref)
        engine.enrich_jczq_pools(data)  # 缺失的 比分/总进球/半全场 用胜平负推导估算
        with _state_lock:
            _state["data"] = data
            _state["source_pref"] = pref
            _state["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            _state["plan"] = engine.build_full_plan(data, budget=_default_budget())
            _state["refreshing"] = False
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({"data": data, "updated_at": _state["updated_at"],
                       "source_pref": pref, "plan": _state["plan"]}, f,
                      ensure_ascii=False, indent=1)
        snapshot_odds(data)
        print(f"[sync] 刷新完成 {time.time() - t0:.1f}s | 竞彩 {len(data['jczq']['matches'])} 场 | "
              f"传统足彩 {len(data['zucai']['issues'])} 个玩法 | 源: "
              f"jczq={data['sources']['jczq']['source']} zucai={data['sources']['zucai']['source']}")
    except Exception as e:  # noqa: BLE001
        with _state_lock:
            _state["refreshing"] = False
            _state["last_error"] = str(e)
        print(f"[sync] 刷新失败: {e}")


def _default_budget():
    s = load_settings()
    try:
        return float(s.get("budget", 100))
    except (TypeError, ValueError):
        return 100.0


# ---------------- 赔率快照记录（初盘→临场变化，价值回测用） ----------------

_last_odds = {}   # mid -> {had:{...}, hhad:{...}}
_moves = {}       # mid -> {had: {h:{prev,now,dir}, d:{...}, a:{...}}, ...}


def snapshot_odds(data):
    """每次数据刷新后，把当天在售竞彩赔率追加进历史文件，并计算相对上次的变化。"""
    global _last_odds, _moves
    matches = (data.get("jczq") or {}).get("matches") or []
    if not matches:
        return
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    record = {"ts": ts, "matches": []}
    moves = {}
    for m in matches:
        odds = m.get("odds") or {}
        had, hhad = odds.get("had"), odds.get("hhad")
        mid = m.get("id")
        if not mid:
            continue
        entry = {}
        if isinstance(had, dict):
            entry["had"] = {k: float(v) for k, v in had.items() if k in ("h", "d", "a") and isinstance(v, (int, float))}
        if isinstance(hhad, dict):
            e = {k: float(v) for k, v in hhad.items() if k in ("h", "d", "a") and isinstance(v, (int, float))}
            if e:
                entry["hhad"] = e
        if not entry:
            continue
        record["matches"].append({"id": mid, "home": m.get("home"), "away": m.get("away"), "odds": entry})
        # 变化
        prev = _last_odds.get(mid, {})
        md = {}
        for pool in ("had", "hhad"):
            cur = entry.get(pool)
            old = prev.get(pool)
            if not cur or not old:
                continue
            pd = {}
            for k in ("h", "d", "a"):
                if k in cur and k in old and old[k] > 0:
                    d = round((cur[k] - old[k]) / old[k] * 100, 1)
                    pd[k] = {"prev": old[k], "now": cur[k], "dir": "up" if d > 0.3 else ("down" if d < -0.3 else "flat"),
                             "pct": d}
            if pd:
                md[pool] = pd
        if md:
            moves[mid] = md
    _moves = moves
    _last_odds = {x["id"]: x["odds"] for x in record["matches"]}
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(ODDS_HISTORY_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        # 裁剪文件行数
        with open(ODDS_HISTORY_FILE, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) > ODDS_HISTORY_LIMIT:
            with open(ODDS_HISTORY_FILE, "w", encoding="utf-8") as f:
                f.writelines(lines[-ODDS_HISTORY_LIMIT:])
    except Exception:  # noqa: BLE001
        pass


def odds_moves():
    return _moves


def odds_history(mid=None, limit=300):
    out = []
    if not os.path.exists(ODDS_HISTORY_FILE):
        return out
    with open(ODDS_HISTORY_FILE, encoding="utf-8") as f:
        lines = f.readlines()
    for ln in lines[-limit:]:
        try:
            rec = json.loads(ln)
        except Exception:  # noqa: BLE001
            continue
        if mid:
            hit = next((x for x in rec.get("matches", []) if x.get("id") == mid), None)
            if hit:
                out.append({"ts": rec["ts"], "had": hit["odds"].get("had"),
                            "hhad": hit["odds"].get("hhad")})
        else:
            out.append({"ts": rec["ts"], "count": len(rec.get("matches", []))})
    return out


def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, encoding="utf-8") as f:
                c = json.load(f)
            with _state_lock:
                _state["data"] = c.get("data")
                _state["plan"] = c.get("plan")
                _state["updated_at"] = c.get("updated_at")
                _state["source_pref"] = c.get("source_pref", "auto")
            return True
        except Exception as e:  # noqa: BLE001
            print(f"[cache] 缓存读取失败: {e}")
    return False


def background_refresh():
    while not _shutdown.is_set():
        _shutdown.wait(REFRESH_INTERVAL)
        if _shutdown.is_set():
            break
        refresh_data()


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ZucaiDashboard/1.0"

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write(f"[http] {self.address_string()} {fmt % args}\n")

    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _serve_static(self, path: str):
        rel = path.lstrip("/") or "index.html"
        fp = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not fp.startswith(WEB_DIR) or not os.path.isfile(fp):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        ext = os.path.splitext(fp)[1].lower()
        with open(fp, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p in ("/", "/index.html"):
            self._serve_static("index.html")
        elif p in ("/app.js", "/style.css"):
            self._serve_static(p[1:])
        elif p == "/api/state":
            self._json(self._state_snapshot())
        elif p == "/api/history":
            self._json({"ok": True, "bets": db_query(
                "SELECT * FROM bets ORDER BY id DESC LIMIT 500"),
                "summary": self._history_summary()})
        elif p == "/api/settings":
            self._json({"ok": True, "settings": load_settings(),
                        "defaults": {"budget": 100, "weights": engine.DEFAULT_WEIGHTS}})
        elif p == "/api/snapshots":
            date = parse_qs(u.query).get("date", [""])[0]
            rows = db_query("SELECT * FROM snapshots WHERE bet_date=? ORDER BY id DESC",
                            (date,)) if date else db_query("SELECT * FROM snapshots ORDER BY id DESC LIMIT 30")
            self._json({"ok": True, "snapshots": rows})
        elif p == "/api/results":
            date = parse_qs(u.query).get("date", [""])[0]
            rows = db_query("SELECT * FROM results WHERE bet_date=? ORDER BY id", (date,)) if date \
                else db_query("SELECT * FROM results ORDER BY bet_date DESC, id LIMIT 200")
            self._json({"ok": True, "results": rows})
        elif p == "/api/review":
            date = parse_qs(u.query).get("date", [""])[0]
            self._json(self._do_review(date))
        elif p == "/api/budgets":
            s = load_settings()
            self._json({"ok": True, "budgets": {k: s.get(k, 100 if k == "daily" else 0)
                                                for k in ("daily", "monthly", "yearly")}})
        elif p == "/api/odds-moves":
            self._json({"ok": True, "moves": odds_moves(), "ts": time.strftime("%Y-%m-%d %H:%M:%S")})
        elif p == "/api/odds-history":
            mid = parse_qs(u.query).get("mid", [""])[0]
            self._json({"ok": True, "history": odds_history(mid or None),
                        "msg": "每10分钟自动记录一次赔率，积累初盘→临场变化，供价值回测"})
        elif not p.startswith("/api/"):
            # 其余静态资源（qr 收款码等图片、前端文件）
            self._serve_static(p[1:] or "index.html")
        else:
            self._json({"ok": False, "error": "404"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        body = self._read_body()
        if p == "/api/refresh":
            pref = body.get("source") or body.get("pref") or "auto"
            threading.Thread(target=refresh_data, args=(pref,), daemon=True).start()
            self._json({"ok": True, "msg": "正在刷新…"})
        elif p == "/api/plan":
            budget = float(body.get("budget", 100) or 100)
            weights = body.get("weights")
            mode = body.get("mode", "normal")
            with _state_lock:
                data = _state["data"]
            if not data:
                self._json({"ok": False, "error": "数据尚未就绪，请先刷新"})
                return
            plan = engine.build_full_plan(data, budget=budget, weights=weights, mode=mode)
            self._json({"ok": True, "plan": plan})
        elif p == "/api/bet":
            self._save_bet(body)
        elif p == "/api/result":
            bid = body.get("id")
            status = body.get("status", "pending")
            profit = float(body.get("profit") or 0)
            if bid is None:
                self._json({"ok": False, "error": "缺少 id"}, 400)
                return
            db_exec("UPDATE bets SET status=?, profit=? WHERE id=?",
                    (status, profit, bid))
            self._json({"ok": True})
        elif p == "/api/clear-history":
            db_exec("DELETE FROM bets")
            self._json({"ok": True, "msg": "历史已清空"})
        elif p == "/api/settings":
            cur = load_settings()
            for k in ("budget", "weights", "source_pref"):
                if k in body:
                    cur[k] = body[k]
            save_settings(cur)
            self._json({"ok": True, "settings": cur})
        elif p == "/api/budgets":
            cur = load_settings()
            for k in ("daily", "monthly", "yearly"):
                if k in body:
                    try:
                        cur[k] = float(body[k])
                    except (TypeError, ValueError):
                        pass
            save_settings(cur)
            self._json({"ok": True, "budgets": {k: cur.get(k, 0) for k in ("daily", "monthly", "yearly")}})
        elif p == "/api/allocation":
            self._json({"ok": True, "allocation": self._allocation(body)})
        elif p == "/api/snapshot":
            rid = db_exec(
                "INSERT INTO snapshots(created_at, bet_date, budget, source, plan, summary)"
                " VALUES(?,?,?,?,?,?)",
                (time.strftime("%Y-%m-%d %H:%M:%S"), body.get("date", ""),
                 float(body.get("budget") or 0), body.get("source", "manual"),
                 json.dumps(body.get("plan", {}), ensure_ascii=False),
                 json.dumps(body.get("summary", {}), ensure_ascii=False)))
            self._json({"ok": True, "id": rid})
        elif p == "/api/results":
            date = body.get("date", "")
            n = 0
            for r in body.get("results", []):
                try:
                    db_exec("INSERT OR REPLACE INTO results(bet_date, match_key, league, home, away, hs, ha, fs_h, fs_a)"
                            " VALUES(?,?,?,?,?,?,?,?,?)",
                            (date, review.match_key(r.get("home", ""), r.get("away", "")),
                             r.get("league", ""), r.get("home", ""), r.get("away", ""),
                             r.get("hs"), r.get("ha"), r.get("fs_h"), r.get("fs_a")))
                    n += 1
                except Exception:  # noqa: BLE001
                    continue
            self._json({"ok": True, "saved": n})
        elif p == "/api/review":
            self._json(self._do_review(body.get("date", "")))
        elif p == "/api/llm-review":
            self._llm_review(body)
        elif p == "/api/form":
            matches = body.get("matches") or []
            try:
                forms = sources.fetch_match_forms(matches)
            except Exception as e:  # noqa: BLE001
                self._json({"ok": False, "error": f"战绩抓取失败: {e}"})
                return
            self._json({"ok": True, "forms": forms})
        elif p == "/api/analyze-today":
            self._analyze_today(body)
        elif p == "/api/llm":
            self._llm(body)
        else:
            self._json({"ok": False, "error": "404"}, 404)

    # ---- 业务 ----

    def _state_snapshot(self):
        with _state_lock:
            return {
                "data": _state["data"],
                "plan": _state["plan"],
                "updated_at": _state["updated_at"],
                "source_pref": _state["source_pref"],
                "refreshing": _state["refreshing"],
                "last_error": _state["last_error"],
                "defaults": {"budget": 100, "weights": engine.DEFAULT_WEIGHTS},
                "server_time": time.strftime("%Y-%m-%d %H:%M:%S"),
            }

    def _save_bet(self, body):
        try:
            stake = float(body.get("stake") or 0)
        except (TypeError, ValueError):
            stake = 0
        rid = db_exec(
            "INSERT INTO bets(created_at, bet_date, game_type, issue, title, selections, stake, odds, note)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (time.strftime("%Y-%m-%d %H:%M:%S"), body.get("bet_date", ""),
             body.get("game_type", ""), body.get("issue", ""),
             body.get("title", ""), json.dumps(body.get("selections", []), ensure_ascii=False),
             stake, body.get("odds", ""), body.get("note", "")))
        self._json({"ok": True, "id": rid})

    def _history_summary(self):
        rows = db_query("SELECT status, SUM(stake) AS s, SUM(profit) AS p, COUNT(*) AS n "
                        "FROM bets GROUP BY status")
        total_stake = sum(r["s"] or 0 for r in rows)
        total_profit = sum(r["p"] or 0 for r in rows)
        return {
            "total_stake": round(total_stake, 2),
            "total_profit": round(total_profit, 2),
            "by_status": {r["status"]: {"count": r["n"], "stake": round(r["s"] or 0, 2),
                                        "profit": round(r["p"] or 0, 2)} for r in rows},
        }

    def _llm_review(self, body):
        cfg = {"api_key": body.get("api_key", ""), "base_url": body.get("base_url", ""),
               "model": body.get("model", "")}
        date = body.get("date", "")
        ev = self._do_review(date)
        rows = []
        for pool, st in (ev.get("pools") or {}).items():
            for r in st.get("rows", []):
                if r.get("correct") is not None:
                    rows.append({"玩法": pool, "场次": r.get("mid") or r.get("num"),
                                 "对阵": f"{r.get('home')}vs{r.get('away')}",
                                 "我选": r.get("option") or "/".join(r.get("options", [])),
                                 "赛果": r.get("actual"), "对错": "中" if r.get("correct") else "错"})
        stats = ev.get("stats") or []
        system = ("你是足彩复盘分析专家。根据'预测 vs 赛果'数据，找出每次猜错的原因"
                  "（实力差距/冷门/红黄牌少打一人/状态/伤停/教练战术/运气等），"
                  "并给出下次改进的具体建议。只输出 JSON。")
        user = (f"复盘日期：{date}\n各玩法命中率：{json.dumps(stats, ensure_ascii=False)}\n"
                f"逐场明细：{json.dumps(rows, ensure_ascii=False)}\n"
                "输出 JSON：{\"summary\":\"本期复盘总结\","
                "\"lessons\":[{\"match\":\"周六001 主vs客\",\"prediction\":\"胜\",\"actual\":\"平\","
                "\"cause\":\"可能原因\",\"improve\":\"下次改进\"}],"
                "\"model_notes\":\"对模型的修正建议（如某玩法偏差、阈值调整）\"}")
        result = engine.llm_chat_json(cfg, system, user)
        self._json(result)

    def _llm(self, body):
        cfg = {"api_key": body.get("api_key", ""), "base_url": body.get("base_url", ""),
               "model": body.get("model", "")}
        budget = float(body.get("budget") or 100)
        with _state_lock:
            data, plan = _state["data"], _state["plan"]
        if not data:
            self._json({"ok": False, "error": "数据尚未就绪，请先刷新"})
            return
        result = engine.llm_analyze(cfg, data, plan, budget=budget)
        self._json(result)

    # ---- 复盘：预测快照 vs 赛果 ----

    def _do_review(self, date):
        snaps = db_query("SELECT * FROM snapshots WHERE bet_date=? ORDER BY id DESC LIMIT 5", (date,)) \
            if date else db_query("SELECT * FROM snapshots ORDER BY id DESC LIMIT 5")
        if not snaps:
            return {"ok": True, "date": date, "stats": [], "detail": None,
                    "msg": "该日期还没有预测快照（先做一次 推荐/今日分析 再复盘）"}
        snap = snaps[0]
        try:
            snap_plan = json.loads(snap["plan"])
        except Exception:  # noqa: BLE001
            snap_plan = {}
        # 取赛果（该日期 + 顺延2天，覆盖晚场比赛）
        res_rows = db_query("SELECT * FROM results WHERE bet_date IN (?,?,?)",
                            (date, self._next_day(date), self._next_day(date, 2)))
        results = {}
        for r in res_rows:
            results[review.match_key(r["home"], r["away"])] = {
                "hs": r["hs"], "ha": r["ha"], "h": r["fs_h"], "a": r["fs_a"]}
        ev = review.evaluate_snapshot(snap_plan, results) if snap_plan else \
            {"pools": {}, "summary": []}
        return {"ok": True, "date": date, "stats": ev["summary"],
                "pools": ev["pools"], "detail": snap_plan.get("meta"),
                "snapshot_id": snap["id"], "snapshot_time": snap["created_at"],
                "evaluated_count": sum(len(v.get("rows", [])) for v in ev["pools"].values()),
                "note": "命中统计只含已录入赛果的场次；半全场类玩法需录入半场比分才能判定。"}

    @staticmethod
    def _next_day(date, n=1):
        try:
            d = dt.date.fromisoformat(date) + dt.timedelta(days=n)
            return d.isoformat()
        except Exception:  # noqa: BLE001
            return date

    # ---- 资金方案 ----

    def _allocation(self, body):
        daily = float(body.get("daily") or 0)
        monthly = float(body.get("monthly") or 0)
        yearly = float(body.get("yearly") or 0)
        # 池玩法每期成本上限经验值（各玩法建议占比，和为 100）
        plan = engine.DEFAULT_WEIGHTS
        alloc = {}
        if daily > 0:
            alloc["daily"] = {k: round(daily * w, 2) for k, w in plan.items()}
        if monthly > 0:
            # 每月约 26 个投注日，先按每日均摊再按玩法
            alloc["monthly_daily_avg"] = round(monthly / 26, 2)
        if yearly > 0:
            alloc["yearly_monthly_avg"] = round(yearly / 12, 2)
        advice = [
            "1) 单注按 1/4 凯利、下限 2 元；单期任九/14场复式成本 ≤ 当日预算的 10%。",
            "2) 串关只玩 2串1 以内（返奖率按 0.69^n 指数衰减），禁止 3+ 串。",
            "3) 比分/半全场/4场进球属高赔娱乐，分配最小额度；主战场放 胜平负/任九。",
            "4) 设月度亏损红线（如月预算 30%），到线即停，不追号、不梭哈。",
        ]
        return {"budgets": {"daily": daily, "monthly": monthly, "yearly": yearly},
                "allocation": alloc, "advice": advice,
                "weights": plan}

    # ---- 一键今日投注分析：内置引擎 + 可选 DeepSeek 统筹 ----

    def _analyze_today(self, body):
        cfg = {"api_key": body.get("api_key", ""), "base_url": body.get("base_url", ""),
               "model": body.get("model", "")}
        daily = float(body.get("daily") or body.get("budget") or 100)
        monthly = float(body.get("monthly") or 0)
        yearly = float(body.get("yearly") or 0)
        mode = body.get("mode", "normal")
        with _state_lock:
            data = _state["data"]
        if not data:
            self._json({"ok": False, "error": "数据尚未就绪，请先刷新"})
            return
        base_plan = engine.build_full_plan(data, budget=daily, mode=mode)
        # 近期战绩/交锋：从内置方案涉及的场次里取（限6场），带球队ID时才抓
        forms = []
        form_note = ""
        jczq_map = {m.get("id"): m for m in (data.get("jczq") or {}).get("matches", [])}
        picked = set()
        for pool in ("had", "ttg", "crs", "hafu"):
            for p in (base_plan.get("plans", {}).get(pool, {})).get("picks", []):
                if len(picked) >= 6:
                    break
                m = jczq_map.get(p.get("id"))
                if m and (m.get("home_id") or m.get("away_id")) and p.get("id") not in picked:
                    picked.add(p.get("id"))
        if picked:
            try:
                ms = [{"home": jczq_map[i]["home"], "away": jczq_map[i]["away"],
                       "home_id": jczq_map[i].get("home_id"), "away_id": jczq_map[i].get("away_id")}
                      for i in picked]
                forms = sources.fetch_match_forms(ms)
                form_note = "\n".join(
                    f"{f['home']} vs {f['away']}：\n" + "\n".join(f["text"]) for f in forms if f.get("text"))
                if form_note:
                    form_note = "两队近期战绩（近X场 胜平负，最新在前）参考：\n" + form_note
            except Exception:  # noqa: BLE001
                forms, form_note = [], ""
        result = {"ok": True, "plan": base_plan,
                  "allocation": self._allocation({"daily": daily, "monthly": monthly, "yearly": yearly}),
                  "forms": forms, "moves": odds_moves()}
        if cfg.get("api_key"):
            # DeepSeek 统筹：传结构化比赛/赔率/近期战绩/赔率变化与预算，补场外因素并给最终分配
            moves_note = ""
            mv = odds_moves()
            if mv:
                lines = []
                for mid, mm in list(mv.items())[:8]:
                    bits = []
                    for pool, d in mm.items():
                        for k, v in d.items():
                            bits.append(f"{pool}.{k} {v['prev']}→{v['now']} ({v['dir']})")
                    if bits:
                        lines.append(f"{mid}: " + "；".join(bits))
                if lines:
                    moves_note = "赔率变化（相对上次刷新）：\n" + "\n".join(lines)
            extra = "\n".join(x for x in (form_note, moves_note) if x)
            llm = engine.llm_analyze(cfg, data, base_plan, budget=daily, extra_note=extra)
            result["llm"] = llm
            if llm.get("ok") and isinstance(llm.get("result"), dict):
                result["llm_plan"] = llm["result"]
        self._json(result)


def main():
    ap = argparse.ArgumentParser(description="足彩方案助手")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8456")))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--pref", default=None,
                    help="数据源: auto|official|fallback|demo（默认 auto）")
    args = ap.parse_args()

    init_db()
    settings = load_settings()
    pref = args.pref or settings.get("source_pref") or "auto"

    if not load_cache():
        refresh_data(pref)
    else:
        _state["source_pref"] = pref
        if pref != "auto":
            threading.Thread(target=refresh_data, args=(pref,), daemon=True).start()

    threading.Thread(target=background_refresh, daemon=True).start()

    try:
        srv = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print(f"端口 {args.port} 无法使用: {e}\n请用 --port 指定其他端口，如: python3 server.py --port 9000")
        sys.exit(1)

    url = f"http://{args.host}:{args.port}"
    print("=" * 60)
    print("  足彩方案助手已启动")
    print(f"  浏览器打开: {url}")
    print("  数据源偏好: " + (pref if pref != "auto" else "自动（官方→备用→演示）"))
    print("  按 Ctrl+C 停止")
    print("=" * 60)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _shutdown.set()
        srv.server_close()
        print("\n已停止")


if __name__ == "__main__":
    main()
