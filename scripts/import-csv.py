#!/usr/bin/env python3
"""Import articles from Framer CMS CSV export into the SEO engine."""

import csv
import json
import sys
import urllib.request

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "/Users/asby/Downloads/articles.csv"
API_URL = sys.argv[2] if len(sys.argv) > 2 else "https://framer-seobot-internal-production.up.railway.app"
API_KEY = sys.argv[3] if len(sys.argv) > 3 else ""

if not API_KEY:
    print("Usage: python3 import-csv.py <csv_path> <api_url> <api_key>")
    sys.exit(1)

articles = []
with open(CSV_PATH, encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        articles.append({
            "title": row["Title"],
            "slug": row["Slug"],
            "summary": row.get("Short Description", ""),
            "category": row.get("Category", "guides").lower(),
            "content": row.get("Content", ""),
            "image_url": row.get("Image", ""),
        })

print(f"Found {len(articles)} articles to import:")
for a in articles:
    print(f"  - {a['slug']} ({len(a['content'])} chars)")

payload = json.dumps({"articles": articles}).encode("utf-8")

req = urllib.request.Request(
    f"{API_URL}/api/articles/import",
    data=payload,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        print(f"\nSuccess: {result}")
except urllib.error.HTTPError as e:
    print(f"\nError {e.code}: {e.read().decode()}")
