#!/usr/bin/env python3
"""Snapshot competitor sitemaps and report what is new since the last snapshot.

Usage:
    python3 -I scripts/competitor-sitemaps.py [snapshot_root]

snapshot_root defaults to data/competitor-snapshots. It must contain
domains.txt (one domain per line, # comments allowed). Each run writes
<snapshot_root>/<YYYY-MM-DD>/<domain>.tsv (url<TAB>lastmod) and prints, per
domain, the URLs absent from the previous dated snapshot.

Per-entity pages (creator profiles, storefront items, channel catalogs) are
dropped: they are not content and would drown out the posts.
"""
import datetime
import gzip
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
MAX_CHILD_SITEMAPS = 60
SKIP_CHILD = re.compile(r"(creator|profile|user|channel|catalog|image|video|model-|/models?)", re.I)
SKIP_URL = re.compile(r"/(buy|u|catalog|channels?|profile)/|\.md$", re.I)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(30_000_000)
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data.decode("utf-8", "replace")


def sitemap_candidates(domain):
    try:
        robots = fetch(f"https://{domain}/robots.txt")
        found = [l.split(":", 1)[1].strip() for l in robots.splitlines() if l.lower().startswith("sitemap:")]
        if found:
            return found
    except Exception:
        pass
    return [f"https://{domain}/{p}" for p in ("sitemap.xml", "sitemap_index.xml", "sitemap-index.xml")]


def parse(xml):
    out = []
    for kind, body in re.findall(r"<(url|sitemap)>(.*?)</\1>", xml, re.S | re.I):
        loc = re.search(r"<loc>\s*(.*?)\s*</loc>", body, re.S | re.I)
        if loc:
            lm = re.search(r"<lastmod>\s*(.*?)\s*</lastmod>", body, re.S | re.I)
            out.append((kind.lower(), loc.group(1).replace("&amp;", "&"), lm.group(1)[:10] if lm else ""))
    return out


def crawl(domain):
    seen, rows, errors, children = set(), {}, [], 0
    queue = sitemap_candidates(domain)
    while queue:
        sm = queue.pop(0)
        if sm in seen:
            continue
        seen.add(sm)
        try:
            entries = parse(fetch(sm))
        except Exception as e:
            errors.append(f"{sm}: {type(e).__name__}")
            continue
        for kind, loc, lm in entries:
            if kind == "sitemap":
                if not SKIP_CHILD.search(loc.rsplit("/", 1)[-1]) and children < MAX_CHILD_SITEMAPS:
                    children += 1
                    queue.append(loc)
            elif not SKIP_URL.search(loc):
                rows[loc] = lm
    return domain, rows, errors


def load(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return dict(line.rstrip("\n").split("\t", 1) for line in f if "\t" in line)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "data/competitor-snapshots"
    with open(os.path.join(root, "domains.txt")) as f:
        domains = [l.split("#")[0].strip() for l in f if l.split("#")[0].strip()]

    today = datetime.date.today().isoformat()
    previous = sorted(d for d in os.listdir(root) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) and d != today)
    prev_dir = os.path.join(root, previous[-1]) if previous else None
    out_dir = os.path.join(root, today)
    os.makedirs(out_dir, exist_ok=True)

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(crawl, domains))

    print(f"snapshot {today}" + (f", compared with {previous[-1]}" if prev_dir else ", first snapshot"))
    for domain, rows, errors in results:
        if rows:
            with open(os.path.join(out_dir, f"{domain}.tsv"), "w") as f:
                for loc, lm in sorted(rows.items(), key=lambda x: x[1], reverse=True):
                    f.write(f"{loc}\t{lm}\n")
        if not rows:
            print(f"\n== {domain}: no sitemap data {errors[:1]}")
            continue
        if not prev_dir:
            print(f"\n== {domain}: {len(rows)} urls")
            continue
        old = load(os.path.join(prev_dir, f"{domain}.tsv"))
        new = [u for u in rows if u not in old]
        if new:
            print(f"\n== {domain}: {len(new)} new")
            for u in sorted(new, key=lambda u: rows[u], reverse=True):
                print(f"   {rows[u] or '----------'}  {u}")


if __name__ == "__main__":
    main()
