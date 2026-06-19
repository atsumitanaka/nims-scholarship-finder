#!/usr/bin/env python3
"""
scholarships.json の各 URL を取得し、Gemini API で最新の制度情報を抽出する。
HTML 本文に加え、ページ内の PDF も Gemini にマルチモーダル入力として渡す。
GitHub Actions から日次および手動実行され、変更があれば自動コミット・プッシュする。

抽出対象:
  - application_schedule (各種日付・期間)
  - benefits           (支援金額・支援内容)
  - required_documents (必要書類リスト)

セーフガード:
  - 既存件数の半分未満しか抽出できなかった場合は既存値を維持
  - 半数以上の制度で抽出失敗した場合は Actions を failure 扱いにして exit 1

環境変数:
    GEMINI_API_KEY  必須
    GEMINI_MODEL    任意（既定: gemini-3.1-flash-lite）
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "scholarships.json"

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
MAX_HTML_CHARS = 100_000  # 1M token あるので余裕を持って大きめ
MAX_PDFS_PER_PROGRAM = 3
MAX_PDF_BYTES = 8 * 1024 * 1024
REQUEST_TIMEOUT = 30
SLEEP_BETWEEN_CALLS = 1.0
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
    ("note", "備考（条件・対象プログラム等）"),
]

PROGRAM_SCHEMA = {
    "type": "object",
    "properties": {
        "schedules": {
            "type": "array",
            "description": "公式ページ／PDF に記載されている、現在募集中または今後募集予定のスケジュール",
            "items": {
                "type": "object",
                "properties": {
                    name: {"type": "string", "description": desc}
                    for name, desc in SCHEDULE_FIELDS
                },
                "required": ["intake"],
            },
        },
        "benefits": {
            "type": "array",
            "description": (
                "支援内容（給付額・期間・支援内容）。原文表記を保ったまま、"
                "label と value のペアで返す。例: label='月額', value='20万円'"
            ),
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["label", "value"],
            },
        },
        "required_documents": {
            "type": "array",
            "description": "応募に必要な書類のリスト。原文の表現を保つ",
            "items": {"type": "string"},
        },
        "extraction_notes": {
            "type": "string",
            "description": "抽出時の補足コメント（情報が PDF にしかない・該当なし等）",
        },
    },
    "required": ["schedules", "extraction_notes"],
}


def fetch_html(url: str) -> tuple[str, BeautifulSoup] | None:
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
    if len(text) > MAX_HTML_CHARS:
        text = text[:MAX_HTML_CHARS] + "\n...[truncated]"

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


def fetch_pdf_bytes(url: str) -> bytes | None:
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HTTP_HEADERS)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"    ⚠️ pdf fetch failed: {url} ({e})", file=sys.stderr)
        return None

    content = resp.content
    if len(content) > MAX_PDF_BYTES:
        print(
            f"    ⚠️ pdf too large ({len(content) / 1024 / 1024:.1f}MB): {url}",
            file=sys.stderr,
        )
        return None
    return content


def extract_program_data(
    client: genai.Client,
    program: dict,
    html_text: str,
    pdfs: list[tuple[str, bytes]],
    today: str,
    additional_pages: list[tuple[str, str]] | None = None,
) -> dict | None:
    existing_schedule = json.dumps(
        program.get("application_schedule", []), ensure_ascii=False, indent=2
    )
    existing_benefits = json.dumps(
        program.get("benefits", {}), ensure_ascii=False, indent=2
    )
    existing_docs = json.dumps(
        program.get("required_documents", []), ensure_ascii=False, indent=2
    )

    focus_program = (program.get("focus_program") or "").strip()
    focus_rule = (
        f"\n10. 本制度は **{focus_program}** に絞った情報のみ扱う。"
        "公式ページに他のプログラム（例: 別の学位プログラム、別の研究科）の"
        "スケジュール・支援内容・必要書類が記載されていても、それらは抽出しない。"
        f"{focus_program} に明示的に該当する情報のみを返す。"
        if focus_program else ""
    )

    system_instruction = (
        "あなたは日本の奨学金・大学院・研究員制度の公式募集ページから"
        "最新の制度情報を漏れなく抽出する専門家です。以下を厳守してください:\n"
        f"1. 今日の日付は {today}。これより前に締切が過ぎたスケジュールは含めない\n"
        "2. HTML 本文・添付 PDF に明示的に記載されている情報のみ抽出する（推測・補完しない）\n"
        "3. 情報源が PDF のみの場合も必ず読み込んで抽出する\n"
        "4. intake は『2027年4月入学』『2026年度 第1次公募』のように"
        "既存データの表現に合わせる\n"
        "5. 募集回・日程が複数ある場合はすべて schedules に含める（漏れなく）\n"
        "6. benefits は『label=月額, value=20万円』のように原文表記を保つ。"
        "推定や換算をしない。年額のみ記載があれば label='年額'\n"
        "7. required_documents はリストの各項目を原文の表現で書く。"
        "成績証明書・推薦状・履歴書・志望理由書など、要求されているものを全て列挙\n"
        "8. 値が見つからないフィールドは省略する（空文字列は入れない）\n"
        "9. 該当情報が一切ない場合は extraction_notes に理由を書く"
        + focus_rule
    )

    pdf_list_text = (
        "\n".join(f"- {u}" for u, _ in pdfs) if pdfs else "（添付なし）"
    )
    focus_hint = (
        f"\n注意: 本制度は **{focus_program}** に絞って情報を抽出してください。"
        "公式ページに他のプログラムの情報が混在している場合、それらは無視してください。"
        if focus_program else ""
    )
    additional_section = ""
    if additional_pages:
        additional_section = "\n\n## 補助参考ページ（公式ページからリンクされている詳細情報源）"
        for add_url, add_text in additional_pages:
            additional_section += f"\n\n### {add_url}\n```\n{add_text}\n```"

    user_text = (
        f"## 制度名\n{program['name']} ({program.get('organization', '')})\n"
        f"公式URL: {program['url']}{focus_hint}\n\n"
        f"## 既存スケジュール（書式の参考）\n```json\n{existing_schedule}\n```\n\n"
        f"## 既存 benefits（書式の参考）\n```json\n{existing_benefits}\n```\n\n"
        f"## 既存 required_documents（書式の参考）\n```json\n{existing_docs}\n```\n\n"
        f"## 公式ページ本文（HTML から抽出したテキスト）\n```\n{html_text}\n```"
        f"{additional_section}\n\n"
        f"## 添付 PDF リスト\n{pdf_list_text}\n\n"
        "上記すべての情報源から、最新の schedules / benefits / required_documents を漏れなく抽出してください。"
    )

    parts: list[types.Part] = [types.Part.from_text(text=user_text)]
    for _, pdf_bytes in pdfs:
        parts.append(
            types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf")
        )

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.0,
                response_mime_type="application/json",
                response_schema=PROGRAM_SCHEMA,
            ),
        )
    except Exception as e:
        print(f"  ⚠️ Gemini API error: {e}", file=sys.stderr)
        return None

    text = getattr(response, "text", None)
    if not text:
        print(f"  ⚠️ empty response", file=sys.stderr)
        return None

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"  ⚠️ JSON parse failed: {e}\n  raw: {text[:500]}", file=sys.stderr)
        return None


def benefits_list_to_dict(items: list[dict]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in items:
        label = (item.get("label") or "").strip()
        value = (item.get("value") or "").strip()
        if label and value:
            result[label] = value
    return result


def should_update_field(new_count: int, existing_count: int, field_name: str, program_id: str) -> bool:
    """セーフガード: 新しい件数が既存の半分未満なら更新しない（劣化防止）。"""
    if new_count == 0:
        return False
    if existing_count > 1 and new_count < existing_count / 2:
        print(
            f"  ⚠️ {program_id}: {field_name} の抽出件数が既存より大幅に少ない "
            f"({existing_count} → {new_count})。既存値を維持します。",
            file=sys.stderr,
        )
        return False
    return True


def main() -> int:
    if not os.getenv("GEMINI_API_KEY"):
        print("ERROR: GEMINI_API_KEY is not set", file=sys.stderr)
        return 1

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
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
        pdfs: list[tuple[str, bytes]] = []
        for pdf_url in pdf_urls:
            data_bytes = fetch_pdf_bytes(pdf_url)
            if data_bytes:
                pdfs.append((pdf_url, data_bytes))
                print(f"  📎 pdf: {pdf_url} ({len(data_bytes) / 1024:.0f}KB)")

        # additional_urls: 詳細ページなど補助情報を Gemini への入力に連結
        additional_pages: list[tuple[str, str]] = []
        for add_url in (program.get("additional_urls") or []):
            print(f"  🔗 additional: {add_url}")
            add_fetched = fetch_html(add_url)
            if not add_fetched:
                continue
            add_text, add_soup = add_fetched
            additional_pages.append((add_url, add_text))
            # 補助ページから PDF も収集（重複は除外）
            for pdf_url in collect_pdf_links(add_soup, add_url):
                if any(u == pdf_url for u, _ in pdfs):
                    continue
                if len(pdfs) >= MAX_PDFS_PER_PROGRAM:
                    break
                data_bytes = fetch_pdf_bytes(pdf_url)
                if data_bytes:
                    pdfs.append((pdf_url, data_bytes))
                    print(f"  📎 pdf (additional): {pdf_url} ({len(data_bytes) / 1024:.0f}KB)")

        result = extract_program_data(client, program, html_text, pdfs, today, additional_pages)
        if not result:
            failures += 1
            summary.append(f"❌ {program['id']}: extraction failed")
            time.sleep(SLEEP_BETWEEN_CALLS)
            continue

        new_schedules = result.get("schedules", []) or []
        new_benefits = benefits_list_to_dict(result.get("benefits", []) or [])
        new_docs = [d for d in (result.get("required_documents", []) or []) if d.strip()]
        notes = result.get("extraction_notes", "")

        print(
            f"  → schedules={len(new_schedules)}, "
            f"benefits={len(new_benefits)}, docs={len(new_docs)}. "
            f"notes: {notes}"
        )

        # セーフガード付きで更新判定
        existing_schedules = program.get("application_schedule", [])
        existing_benefits = program.get("benefits", {})
        existing_docs = program.get("required_documents", [])

        program_changed = False
        if (
            should_update_field(len(new_schedules), len(existing_schedules), "schedules", program["id"])
            and existing_schedules != new_schedules
        ):
            program["application_schedule"] = new_schedules
            program_changed = True
        if (
            should_update_field(len(new_benefits), len(existing_benefits), "benefits", program["id"])
            and existing_benefits != new_benefits
        ):
            program["benefits"] = new_benefits
            program_changed = True
        if (
            should_update_field(len(new_docs), len(existing_docs), "required_documents", program["id"])
            and existing_docs != new_docs
        ):
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
