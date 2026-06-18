#!/usr/bin/env python3
"""
scholarships.json の各 URL を取得し、GitHub Models（OpenAI 互換 API）で
最新の制度情報を抽出する。完全無料運用のため入力長 8,000 トークン制限内に
HTML 本文と PDF 抽出テキストをキーワードベースで圧縮する。

抽出対象:
  - application_schedule (各種日付・期間)
  - benefits           (支援金額・支援内容)
  - required_documents (必要書類リスト)

環境変数:
    GITHUB_TOKEN     必須（GitHub Actions 内では自動付与、ローカル実行時は手動設定）
    GITHUB_MODEL     任意（既定: gpt-4o-mini）
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from io import BytesIO
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from openai import OpenAI
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "scholarships.json"

GITHUB_MODELS_BASE_URL = "https://models.inference.ai.azure.com"
MODEL = os.getenv("GITHUB_MODEL", "gpt-4o-mini")

# GitHub Models gpt-4o-mini は入力 8,000 tokens / 出力 4,000 tokens 制限
# 日本語は概ね 1 トークン ≒ 1.5 文字。安全マージン込みで 4,500 文字目安に圧縮
MAX_HTML_CHARS = 3_500
MAX_PDF_CHARS_PER_FILE = 1_500
MAX_PDFS_PER_PROGRAM = 2
MAX_PDF_BYTES = 8 * 1024 * 1024
REQUEST_TIMEOUT = 30
SLEEP_BETWEEN_CALLS = 5.0  # 15 RPM 制限を守るための間隔
HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "ja,en;q=0.9",
}

# スコアリングに使うキーワード（日付・金額・募集に関連するもの）
RELEVANT_KEYWORDS = [
    "年", "月", "日", "曜",
    "締切", "募集", "応募", "出願", "受付",
    "採用", "選考", "審査", "面接", "結果", "発表",
    "入学", "進学", "インターン", "実施",
    "月額", "年額", "万円", "千円", "支給", "給付", "支援", "支援内容",
    "提出", "書類", "必着", "期限",
]

SCHEDULE_FIELDS = [
    ("intake", "入学・採用時期（例: '2027年4月入学'、'2026年度 第1次公募'）"),
    ("application_start", "募集開始日"),
    ("web_registration", "Web出願期間"),
    ("deadline", "書類提出締切日"),
    ("document_deadline", "書類必着日"),
    ("university_contact_deadline", "大学連絡期限"),
    ("first_screening", "第1次選考"),
    ("second_screening", "第2次選考"),
    ("document_screening", "書類審査"),
    ("university_recommendation", "大学推薦日"),
    ("exam_date", "試験日"),
    ("interview", "面接日"),
    ("first_result", "1次結果発表"),
    ("second_result", "2次結果発表"),
    ("result", "結果発表"),
    ("enrollment_procedure", "入学手続"),
    ("adoption_date", "採用日"),
    ("adoption_period", "採用開始時期"),
    ("internship_period", "実施期間（インターン用）"),
    ("note", "備考"),
]

# OpenAI strict mode 用 schema（全フィールド required、見つからない場合は空文字を返してもらい後処理で除去）
PROGRAM_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "schedules": {
            "type": "array",
            "description": "現在募集中または今後募集予定のスケジュール（過去締切は含めない）",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    name: {"type": "string", "description": desc}
                    for name, desc in SCHEDULE_FIELDS
                },
                "required": [name for name, _ in SCHEDULE_FIELDS],
            },
        },
        "benefits": {
            "type": "array",
            "description": "支援内容（給付額・期間など）。label/value のペアで原文表記",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "label": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["label", "value"],
            },
        },
        "required_documents": {
            "type": "array",
            "description": "応募に必要な書類のリスト",
            "items": {"type": "string"},
        },
        "extraction_notes": {
            "type": "string",
            "description": "抽出時の補足コメント",
        },
    },
    "required": ["schedules", "benefits", "required_documents", "extraction_notes"],
}


def fetch_html(url: str) -> tuple[str, BeautifulSoup] | None:
    """URL から HTML を取得し、(整形済みテキスト, BeautifulSoup) を返す。"""
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HTTP_HEADERS)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"  ⚠️ fetch failed: {e}", file=sys.stderr)
        return None

    soup_for_text = BeautifulSoup(resp.text, "html.parser")
    for tag in soup_for_text(["script", "style", "noscript", "iframe", "svg"]):
        tag.decompose()
    text = soup_for_text.get_text(separator="\n", strip=True)
    lines = [line for line in (line.strip() for line in text.splitlines()) if line]
    text = "\n".join(lines)

    soup_for_links = BeautifulSoup(resp.text, "html.parser")
    return text, soup_for_links


def collect_pdf_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    base_host = urlparse(base_url).netloc
    pdfs: list[str] = []
    seen: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc != base_host:
            continue
        if not parsed.path.lower().endswith(".pdf"):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        pdfs.append(absolute)
        if len(pdfs) >= MAX_PDFS_PER_PROGRAM:
            break

    return pdfs


def fetch_pdf_text(url: str) -> str | None:
    """PDF を取得してテキスト化する。"""
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HTTP_HEADERS)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"    ⚠️ pdf fetch failed: {url} ({e})", file=sys.stderr)
        return None

    if len(resp.content) > MAX_PDF_BYTES:
        print(f"    ⚠️ pdf too large: {url}", file=sys.stderr)
        return None

    try:
        reader = PdfReader(BytesIO(resp.content))
        pages = [p.extract_text() or "" for p in reader.pages]
        return "\n".join(pages)
    except Exception as e:
        print(f"    ⚠️ pdf parse failed: {url} ({e})", file=sys.stderr)
        return None


def extract_relevant_sections(text: str, max_chars: int) -> str:
    """日付・金額・募集に関連する段落を優先的に抽出して max_chars 以内に圧縮。"""
    if len(text) <= max_chars:
        return text

    lines = [line.strip() for line in text.split("\n") if line.strip()]
    if not lines:
        return ""

    scored: list[tuple[int, int, str]] = []  # (score, original_index, line)
    for i, line in enumerate(lines):
        score = sum(line.count(kw) for kw in RELEVANT_KEYWORDS)
        scored.append((score, i, line))

    # スコア降順で並べ、上位を選んでから元の順序に戻す
    scored.sort(key=lambda x: -x[0])

    selected: list[tuple[int, str]] = []
    total = 0
    for score, idx, line in scored:
        if score == 0 and selected:  # スコア 0 行は最後の埋め草に
            continue
        if total + len(line) + 1 > max_chars:
            continue
        selected.append((idx, line))
        total += len(line) + 1

    selected.sort(key=lambda x: x[0])
    return "\n".join(line for _, line in selected)


def build_combined_text(html_text: str, pdf_texts: list[tuple[str, str]]) -> str:
    """HTML と PDF テキストを圧縮して一つの入力にまとめる。"""
    parts = []
    parts.append("## 公式ページ本文（HTMLから抽出）\n")
    parts.append(extract_relevant_sections(html_text, MAX_HTML_CHARS))

    for url, pdf_text in pdf_texts:
        parts.append(f"\n\n## 添付PDF: {url}\n")
        parts.append(extract_relevant_sections(pdf_text, MAX_PDF_CHARS_PER_FILE))

    return "\n".join(parts)


def extract_program_data(
    client: OpenAI,
    program: dict,
    html_text: str,
    pdf_texts: list[tuple[str, str]],
    today: str,
) -> dict | None:
    """GitHub Models (gpt-4o-mini) で制度情報を抽出する。"""
    combined = build_combined_text(html_text, pdf_texts)

    system_instruction = (
        "あなたは日本の奨学金・大学院・研究員制度の公式情報から"
        "最新の制度情報を抽出する専門家です。\n"
        f"今日の日付は {today}。次のルールを厳守:\n"
        "1. これより前に締切が過ぎたスケジュールは schedules に含めない\n"
        "2. 入力テキストに明示的に記載されている情報のみ抽出（推測・補完しない）\n"
        "3. intake は『2027年4月入学』『2026年度 第1次公募』のような既存表現に合わせる\n"
        "4. benefits は label/value で原文表記を保つ。例: label='月額', value='20万円'\n"
        "5. required_documents は原文の表現で記載\n"
        "6. schedule 内の各フィールドは情報がない場合は空文字列を返す（フィールド自体は省略しない）\n"
        "7. 該当情報がない場合は空配列を返し、extraction_notes に理由を書く"
    )

    user_prompt = (
        f"# 制度名\n{program['name']} ({program.get('organization', '')})\n"
        f"公式URL: {program['url']}\n\n"
        f"# 入力\n{combined}\n\n"
        "上記から最新の schedules / benefits / required_documents を抽出してください。"
    )

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": user_prompt},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "program_data",
                    "schema": PROGRAM_SCHEMA,
                    "strict": True,
                },
            },
            temperature=0.0,
        )
    except Exception as e:
        print(f"  ⚠️ Models API error: {e}", file=sys.stderr)
        return None

    content = response.choices[0].message.content
    if not content:
        print(f"  ⚠️ empty response", file=sys.stderr)
        return None

    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        print(f"  ⚠️ JSON parse failed: {e}", file=sys.stderr)
        return None


def clean_schedules(schedules: list[dict]) -> list[dict]:
    """各 schedule から空文字フィールドを除去。"""
    cleaned = []
    for s in schedules:
        kept = {k: v for k, v in s.items() if isinstance(v, str) and v.strip()}
        if kept.get("intake"):
            cleaned.append(kept)
    return cleaned


def benefits_list_to_dict(items: list[dict]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in items:
        label = (item.get("label") or "").strip()
        value = (item.get("value") or "").strip()
        if label and value:
            result[label] = value
    return result


def main() -> int:
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        print("ERROR: GITHUB_TOKEN is not set", file=sys.stderr)
        return 1

    client = OpenAI(base_url=GITHUB_MODELS_BASE_URL, api_key=token)
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    today = datetime.now().strftime("%Y-%m-%d")

    changed = False
    failures = 0
    summary: list[str] = []
    programs = data.get("programs", [])

    for program in programs:
        url = program.get("url")
        if not url:
            continue

        print(f"\n=== {program['id']}: {program['name']} ===")

        fetched = fetch_html(url)
        if not fetched:
            failures += 1
            summary.append(f"❌ {program['id']}: html fetch failed")
            continue

        html_text, soup = fetched

        pdf_urls = collect_pdf_links(soup, url)
        pdf_texts: list[tuple[str, str]] = []
        for pdf_url in pdf_urls:
            text = fetch_pdf_text(pdf_url)
            if text:
                pdf_texts.append((pdf_url, text))
                print(f"  📎 pdf: {pdf_url} ({len(text)} chars)")

        result = extract_program_data(client, program, html_text, pdf_texts, today)
        if not result:
            failures += 1
            summary.append(f"❌ {program['id']}: extraction failed")
            time.sleep(SLEEP_BETWEEN_CALLS)
            continue

        new_schedules = clean_schedules(result.get("schedules") or [])
        new_benefits = benefits_list_to_dict(result.get("benefits") or [])
        new_docs = [d.strip() for d in (result.get("required_documents") or []) if d.strip()]
        notes = result.get("extraction_notes", "")

        print(
            f"  → schedules={len(new_schedules)}, "
            f"benefits={len(new_benefits)}, docs={len(new_docs)}. "
            f"notes: {notes}"
        )

        program_changed = False
        if new_schedules and program.get("application_schedule") != new_schedules:
            program["application_schedule"] = new_schedules
            program_changed = True
        if new_benefits and program.get("benefits") != new_benefits:
            program["benefits"] = new_benefits
            program_changed = True
        if new_docs and program.get("required_documents") != new_docs:
            program["required_documents"] = new_docs
            program_changed = True

        if program_changed:
            changed = True
            summary.append(
                f"✏️ {program['id']}: updated "
                f"(schedules={len(new_schedules)}, benefits={len(new_benefits)}, docs={len(new_docs)})"
            )
        else:
            summary.append(f"= {program['id']}: no change")

        time.sleep(SLEEP_BETWEEN_CALLS)

    if changed:
        data["last_updated"] = today
        DATA_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"\n✅ scholarships.json updated. last_updated={today}")
    else:
        print("\n= no changes detected")

    print("\n--- summary ---")
    for line in summary:
        print(line)

    if programs and failures >= (len(programs) + 1) // 2:
        print(
            f"\n💀 {failures}/{len(programs)} programs failed — exiting with error",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    sys.exit(main())
