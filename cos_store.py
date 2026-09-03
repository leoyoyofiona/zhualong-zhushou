#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""腾讯云 COS 私有桶读写（stdlib-only，实现 COS V5 签名）。

用途：把"建议弹幕"的数据以单个 JSON 对象持久化到私有 COS 桶，
任何访问者都能通过 server 代理提交/点赞，密钥只存在于服务端。

配置来源（优先级从高到低）：
  1. 环境变量 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION
  2. 本地文件 data/cos_config.json {secret_id, secret_key, bucket, region}

对外只暴露：
  list_buckets(secret_id, secret_key)      -> [{name, region}]  （探测用）
  get_config() / save_config(dict) / is_configured()
  cos_get_json(key)   -> obj | None
  cos_put_json(key, obj) -> True | raise
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
CONFIG_FILE = os.path.join(DATA_DIR, "cos_config.json")

# 环境变量优先（Render 部署用），其次本地配置文件
def get_config() -> dict:
    cfg = {}
    if os.environ.get("COS_SECRET_ID") and os.environ.get("COS_SECRET_KEY"):
        cfg = {
            "secret_id": os.environ["COS_SECRET_ID"],
            "secret_key": os.environ["COS_SECRET_KEY"],
            "bucket": os.environ.get("COS_BUCKET", ""),
            "region": os.environ.get("COS_REGION", ""),
            "admin_code": os.environ.get("COS_ADMIN_CODE", ""),
            "from_env": True,
        }
        return cfg
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            c = json.load(f)
        if c.get("secret_id") and c.get("secret_key"):
            c["from_env"] = False
            return c
    except Exception:  # noqa: BLE001
        pass
    return {}


def save_config(cfg: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    keep = {k: cfg.get(k, "") for k in ("secret_id", "secret_key", "bucket", "region", "admin_code")}
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(keep, f, ensure_ascii=False, indent=1)


def is_configured() -> bool:
    c = get_config()
    return bool(c.get("secret_id") and c.get("secret_key") and c.get("bucket"))


def _sign(method: str, host: str, path: str, query: str, secret_id: str, secret_key: str,
          now: int | None = None) -> str:
    """COS V5 签名（只签 host，路径/参数参与 HttpString）。返回 Authorization 头值。"""
    now = now or int(time.time())
    start, end = now - 60, now + 3600
    key_time = f"{start};{end}"

    def _enc(v: str) -> str:
        return urllib.parse.quote(str(v), safe="-_.~")

    # HttpParameters/UrlParamList：query 参数全部参与签名
    if query:
        pairs = sorted(urllib.parse.parse_qsl(query, keep_blank_values=True))
        http_params = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in pairs)
        url_param_list = ";".join(k for k, _ in pairs)
    else:
        http_params, url_param_list = "", ""
    # Headers：只签 host（小写）
    headers = f"host={_enc(host)}"
    http_string = f"{method.lower()}\n{path}\n{http_params}\n{headers}\n"
    sign_key = hmac.new(secret_key.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n"
    signature = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    return (f"q-sign-algorithm=sha1&q-ak={_enc(secret_id)}&q-sign-time={key_time}"
            f"&q-key-time={key_time}&q-header-list=host&q-url-param-list={url_param_list}"
            f"&q-signature={signature}")


def _request(method: str, host: str, path: str, query: str = "", body: bytes | None = None,
             secret_id: str = "", secret_key: str = "", timeout: float = 20.0):
    auth = _sign(method, host, path, query, secret_id, secret_key)
    url = f"https://{host}{path}" + (f"?{query}" if query else "")
    headers = {
        "Host": host,
        "Authorization": auth,
        "User-Agent": "zucai-dashboard/1.0",
    }
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def list_buckets(secret_id: str, secret_key: str):
    """列出账号下所有桶（探测用，不需要知道桶名/地域）。"""
    host = "service.cos.myqcloud.com"
    _, raw = _request("GET", host, "/", secret_id=secret_id, secret_key=secret_key)
    root = ET.fromstring(raw)
    out = []
    for b in root.iter():
        if b.tag.endswith("Bucket"):
            name = None
            loc = None
            for ch in b:
                if ch.tag.endswith("Name"):
                    name = ch.text
                elif ch.tag.endswith("Location"):
                    loc = ch.text
            if name:
                out.append({"name": name, "region": loc})
    return out


def cos_get_json(key: str):
    """GET 对象；不存在返回 None；其他错误抛异常。"""
    cfg = get_config()
    if not is_configured():
        raise RuntimeError("COS 未配置")
    host = f"{cfg['bucket']}.cos.{cfg['region']}.myqcloud.com"
    try:
        status, raw = _request("GET", host, "/" + key,
                               secret_id=cfg["secret_id"], secret_key=cfg["secret_key"])
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    if status != 200:
        return None
    return json.loads(raw.decode("utf-8", errors="replace"))


def cos_put_json(key: str, obj) -> None:
    """PUT 对象（全量覆盖）。"""
    cfg = get_config()
    if not is_configured():
        raise RuntimeError("COS 未配置")
    host = f"{cfg['bucket']}.cos.{cfg['region']}.myqcloud.com"
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    status, _ = _request("PUT", host, "/" + key, body=body,
                         secret_id=cfg["secret_id"], secret_key=cfg["secret_key"])
    if status not in (200, 204):
        raise RuntimeError(f"COS PUT 失败 HTTP {status}")


if __name__ == "__main__":
    import sys
    sid = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("COS_SECRET_ID", "")
    sk = os.environ.get("COS_SECRET_KEY", "")
    if sid and sk:
        for b in list_buckets(sid, sk):
            print(f"桶: {b['name']}  地域: {b['region']}")
    else:
        print("用法: python3 cos_store.py <SecretId>  (SecretKey 用环境变量 COS_SECRET_KEY)")
