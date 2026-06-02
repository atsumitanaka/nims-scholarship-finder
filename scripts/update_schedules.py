#!/usr/bin/env python3
"""
scholarships.json の各 URL を取得し、Claude API で最新のスケジュール情報を抽出する。
GitHub Actions から毎日実行され、変更があれば自動コミット・プッシュする。

環境変数:
    ANTHROPIC_API_KEY  必須
    CLAUDE_MODEL       任意（既定: claude-opus-4-7）
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import anthropic
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "scholarships.json"

MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-4-7")
MAX_TEXT_CHARS = 50_000
REQUEST_TIMEOUT = 30
SLEEP_BETWEEN_CALLS = 1.0
USER_AGENT = (
    "nims-scholarship-finder/1.0 "
    "(+https://github.com/atsumitanaka/nims-scholarship-finder)"
)

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

SCHEDULE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "schedules": {
            "type": "array",
            "description": "公式ページに記載されている、現在募集中または今後募集予定のスケジュール",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    name: {"type": "string", "description": desc}
                    for name, desc in SCHEDULE_FIELDS
                },
                "required": ["intake"],
            },
        },
        "extraction_notes": {
            "type": "string",
            "description": "抽出時の補足コメント（PDFへの誘導しか無い場合・該当無し等）",
        },
    },
    "required": ["schedules", "extraction_notes"],
}


def fetch_page_text(url: str) -> str | None:
    """URL から HTML を取得し、ノイズを除いたテキストに整形して返す。"""
    try:
        resp = requests.get(
            url, timeout=REQUEST_TIMEOUT, headers={"User-Agent": USER_AGENT}
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"  ⚠️ fetch failed: {e}", file=sys.stderr)
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "iframe", "svg"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    lines = [line for line in (line.strip() for line in text.splitlines()) if line]
    text = "\n".join(lines)
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS] + "\n...[truncated]"
    return text


def extract_schedules(
    client: anthropic.Anthropic, program: dict, page_text: str, today: str
) -> dict | None:
    """Claude を使ってページから schedule を抽出する。"""
    existing = json.dumps(
        program.get("application_schedule", []), ensure_ascii=False, indent=2
    )

    system = (
        "あなたは日本の奨学金・大学院・研究員制度の公式募集ページから"
        "「現在募集中、または今後募集予定のスケジュール情報」を抽出する専門家です。"
        "以下を厳守してください:\n"
        f"1. 今日の日付は {today}。これより前に締切が過ぎたスケジュールは含めない\n"
        "2. ページに明示的に記載されている日付・期間のみを抽出する（推測・補完しない）\n"
        "3. PDF / 別ページにしか情報がない場合は schedules を空配列で返し、"
        "extraction_notes に理由を書く\n"
        "4. intake は『2027年4月入学』『2026年度 第1次公募』のように"
        "既存データの表現に合わせる\n"
        "5. note フィールドに対象プログラム・条件等の補足を記載する\n"
        "6. 値が見つからないフィールドは省略する（空文字列は入れない）"
    )

    user = (
        f"## 制度名\n{program['name']} ({program.get('organization', '')})\n\n"
        f"## 既存のスケジュール（参考: 同じ書式で返してください）\n"
        f"```json\n{existing}\n```\n\n"
        f"## 公式ページの本文 ({program['url']})\n```\n{page_text}\n```\n\n"
        "本文から最新のスケジュール情報を抽出してください。"
    )

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={
                "format": {"type": "json_schema", "schema": SCHEDULE_SCHEMA}
            },
        )
    except anthropic.APIError as e:
        print(f"  ⚠️ API error: {e}", file=sys.stderr)
        return None

    if response.stop_reason == "refusal":
        print(f"  ⚠️ refused", file=sys.stderr)
        return None

    text_block = next((b for b in response.content if b.type == "text"), None)
    if not text_block:
        print(f"  ⚠️ no text block in response", file=sys.stderr)
        return None

    try:
        return json.loads(text_block.text)
    except json.JSONDecodeError as e:
        print(f"  ⚠️ JSON parse failed: {e}", file=sys.stderr)
        return None


def main() -> int:
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY is not set", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    today = datetime.now().strftime("%Y-%m-%d")

    changed = False
    summary: list[str] = []

    for program in data["programs"]:
        url = program.get("url")
        if not url:
            continue

        print(f"\n=== {program['id']}: {program['name']} ===")
        page_text = fetch_page_text(url)
        if not page_text:
            summary.append(f"❌ {program['id']}: fetch failed")
            continue

        result = extract_schedules(client, program, page_text, today)
        if not result:
            summary.append(f"❌ {program['id']}: extraction failed")
            continue

        new_schedules = result.get("schedules", [])
        notes = result.get("extraction_notes", "")
        print(f"  → {len(new_schedules)} schedule(s). notes: {notes}")

        if not new_schedules:
            summary.append(f"⏭ {program['id']}: no schedules extracted ({notes})")
            continue

        if program.get("application_schedule") != new_schedules:
            program["application_schedule"] = new_schedules
            changed = True
            summary.append(
                f"✏️ {program['id']}: updated ({len(new_schedules)} schedules)"
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

    return 0


if __name__ == "__main__":
    sys.exit(main())
