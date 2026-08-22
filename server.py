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
