#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""官方接口探测工具：在你的电脑上（中国大陆网络）验证中国体彩官方接口是否可用，
并输出各端点的返回摘要。境外/数据中心网络会被 WAF 拒绝（HTTP 567），属正常现象。

用法:  python3 tools/probe_sporttery.py
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sources  # noqa: E402


def probe(name, url, **kw):
    print(f"\n▶ {name}\n  {url}")
    try:
        text = sources.http_get(url, **kw)
        head = text[:300]
        try:
            obj = json.loads(text)
            print("  ✅ JSON 返回")
            if isinstance(obj, dict):
                v = obj.get("value")
                if isinstance(v, dict):
                    print("  value 字段:", list(v.keys())[:8])
                elif isinstance(v, list):
                    print("  value 是列表，长度:", len(v))
        except Exception:
            print("  ⚠️ 非 JSON（可能是 WAF 挑战页/HTML）:", repr(head[:120]))
    except Exception as e:
        print(f"  ❌ {type(e).__name__}: {e}")


def main():
    print("=" * 64)
    print("  中国体彩官方公开接口探测（请在正常家庭/手机网络下运行）")
    print("=" * 64)
    probe("竞彩足球(全玩法赔率) uniform",
          f"{sources.JCZQ_APIS[0]}?channel=c&poolCode={sources.JCZQ_POOLS}")
    probe("竞彩足球(全玩法赔率) jc",
          f"{sources.JCZQ_APIS[1]}?channel=c&poolCode={sources.JCZQ_POOLS}")
    for gno, name in sources.GAME_NOS.items():
        probe(f"传统足彩 期列表 gameNo={gno} ({name})",
              f"{sources.LOTTERY_BASE}/getIssueListV1.qry?gameNo={gno}&provinceId=0&pageSize=3&isVerify=1&pageNo=1")
        probe(f"传统足彩 当前期 gameNo={gno}",
              f"{sources.LOTTERY_BASE}/getCurrentIssueV1.qry?gameNo={gno}")
    print("\n说明：若上面显示 ✅ 说明官方接口可用（程序会自动使用官方数据源）。\n"
          "若显示 ❌/⚠️，程序会自动降级到 500.com/okooo 备用源或演示数据，不影响使用。\n"
          "如果竞彩(✅)但传统足彩(❌)，请把本输出发给我，我帮你校准传统足彩端点。")


if __name__ == "__main__":
    main()
