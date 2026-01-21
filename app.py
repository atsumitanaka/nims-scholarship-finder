"""
NIMS 奨学金・制度検索アプリ
Scholarship and Program Finder for NIMS
"""

from flask import Flask, render_template, jsonify, request
import json
from pathlib import Path
from datetime import datetime
import re

app = Flask(__name__)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # キャッシュ無効化

# データファイルのパス
DATA_PATH = Path(__file__).parent / "data" / "scholarships.json"


def load_scholarships():
    """奨学金データを読み込む"""
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def parse_deadline(deadline_str):
    """締切日文字列から日付を抽出してソート用の値を返す"""
    if not deadline_str:
        return datetime.max

    # 「随時」などの場合は最後に
    if "随時" in deadline_str:
        return datetime.max

    # 年月日のパターンを探す（例：2025年8月20日、2025/8/20）
    patterns = [
        r'(\d{4})年(\d{1,2})月(\d{1,2})日',
        r'(\d{4})年(\d{1,2})月',
        r'(\d{4})/(\d{1,2})/(\d{1,2})',
    ]

    for pattern in patterns:
        match = re.search(pattern, deadline_str)
        if match:
            groups = match.groups()
            year = int(groups[0])
            month = int(groups[1])
            day = int(groups[2]) if len(groups) > 2 else 1
            try:
                return datetime(year, month, day)
            except ValueError:
                pass

    return datetime.max


def get_nearest_deadline(program):
    """プログラムの最も近い締切日を取得"""
    schedules = program.get("application_schedule", [])
    if not schedules:
        return datetime.max

    nearest = datetime.max
    for schedule in schedules:
        deadline = parse_deadline(schedule.get("deadline", ""))
        if deadline < nearest:
            nearest = deadline

    return nearest


def is_deadline_passed(deadline_str):
    """締切日が過ぎているかチェック"""
    if not deadline_str:
        return False

    # 「随時」は常に有効
    if "随時" in deadline_str:
        return False

    deadline_date = parse_deadline(deadline_str)
    if deadline_date == datetime.max:
        return False  # パースできない場合は表示する

    return deadline_date < datetime.now()


def filter_expired_schedules(schedules):
    """締切が過ぎたスケジュールを除外"""
    return [s for s in schedules if not is_deadline_passed(s.get("deadline", ""))]


def filter_programs(programs, nationality=None, current_education=None, desired_path=None, intake_month=None, tsukuba=None):
    """
    条件に基づいてプログラムをフィルタリング

    Args:
        programs: プログラムリスト
        nationality: 'japanese' or 'foreign'
        current_education: 'bachelor', 'master', 'doctor', 'postdoc' (最終学歴)
        desired_path: 'master', 'doctor', 'postdoc', 'intern' (希望進路)
        intake_month: '2025-04', '2025-10', etc. (入学希望時期)
        tsukuba: 'master', 'doctor' (筑波大学受験の有無)
    """
    results = []

    for program in programs:
        # 締切が過ぎていないスケジュールのみ抽出
        active_schedules = filter_expired_schedules(program.get("application_schedule", []))

        # 有効なスケジュールがない場合はスキップ
        if not active_schedules:
            continue

        # プログラムのコピーを作成し、有効なスケジュールのみをセット
        program = dict(program)
        program["application_schedule"] = active_schedules
        # 国籍フィルタ
        if nationality and nationality not in program.get("target_nationality", []):
            continue

        # 最終学歴フィルタ
        if current_education and current_education not in program.get("current_education", []):
            continue

        # 希望進路フィルタ
        if desired_path and desired_path not in program.get("desired_path", []):
            continue

        # 入学希望時期フィルタ
        if intake_month:
            schedules = program.get("application_schedule", [])
            has_matching_intake = False
            for schedule in schedules:
                intake = schedule.get("intake", "")
                adoption_period = schedule.get("adoption_period", "")
                adoption_date = schedule.get("adoption_date", "")
                # 入学時期、採用期間、採用日をチェック
                if (intake_month in intake or
                    check_intake_match(intake, intake_month) or
                    check_intake_match(adoption_period, intake_month) or
                    check_intake_match(adoption_date, intake_month)):
                    has_matching_intake = True
                    break
            if not has_matching_intake:
                continue

        # 筑波大学受験フィルタ
        if tsukuba:
            if not program.get("tsukuba_related", False):
                continue
            if tsukuba not in program.get("tsukuba_degree", []):
                continue

        results.append(program)

    # 締切日が近い順にソート
    results.sort(key=get_nearest_deadline)

    return results


def check_intake_match(intake_str, target_month):
    """入学時期文字列がターゲット月に一致するかチェック"""
    # ターゲットの解析
    parts = target_month.split("-")
    if len(parts) != 2:
        return False

    target_year = int(parts[0])
    target_type = parts[1]  # "04", "10", "first", "second"

    # 前期/後期の判定
    is_first_half = target_type == "first"  # 4-9月
    is_second_half = target_type == "second"  # 10-3月
    is_specific_month = target_type in ["04", "10"]
    target_mon = int(target_type) if is_specific_month else None

    # 随時は常にマッチ
    if "随時" in intake_str:
        return True

    # 年度形式 "2026年度" の場合
    fiscal_year_match = re.search(r'(\d{4})年度', intake_str)
    if fiscal_year_match:
        fiscal_year = int(fiscal_year_match.group(1))
        if fiscal_year == target_year:
            # 前期/後期の場合は年度が一致すればOK
            if is_first_half or is_second_half:
                return True
            # 具体的な月の場合も年度が一致すればOK（年度内に4月も10月も含まれる）
            if is_specific_month:
                return True

    # 採用開始時期の範囲チェック "2026年4月1日〜9月30日開始"
    period_match = re.search(r'(\d{4})年(\d{1,2})月.*?[〜~].*?(\d{1,2})月', intake_str)
    if period_match:
        period_year = int(period_match.group(1))
        start_month = int(period_match.group(2))
        end_month = int(period_match.group(3))

        if period_year == target_year:
            if is_first_half and start_month <= 9:
                return True
            if is_second_half and (start_month >= 10 or end_month >= 10):
                return True
            if is_specific_month and start_month <= target_mon <= end_month:
                return True

    # 入学時期文字列から年月を抽出
    # 例: "2025年4月入学", "April 2025", "2025年10月"
    patterns = [
        r'(\d{4})年(\d{1,2})月',
        r'(April|October)\s*(\d{4})',
    ]

    for pattern in patterns:
        match = re.search(pattern, intake_str)
        if match:
            groups = match.groups()
            if groups[0] in ['April', 'October']:
                # 英語パターン
                mon = 4 if groups[0] == 'April' else 10
                year = int(groups[1])
            else:
                year = int(groups[0])
                mon = int(groups[1])

            if year == target_year:
                if is_specific_month and mon == target_mon:
                    return True
                if is_first_half and 4 <= mon <= 9:
                    return True
                if is_second_half and (mon >= 10 or mon <= 3):
                    return True

    return False


@app.route("/")
def index():
    """メインページ"""
    return render_template("index.html")


@app.route("/api/programs")
def get_programs():
    """プログラム一覧を取得するAPI"""
    data = load_scholarships()

    # クエリパラメータを取得
    nationality = request.args.get("nationality")
    current_education = request.args.get("current_education")
    desired_path = request.args.get("desired_path")
    intake_month = request.args.get("intake_month")
    tsukuba = request.args.get("tsukuba")

    # フィルタリング
    programs = filter_programs(
        data["programs"],
        nationality=nationality if nationality else None,
        current_education=current_education if current_education else None,
        desired_path=desired_path if desired_path else None,
        intake_month=intake_month if intake_month else None,
        tsukuba=tsukuba if tsukuba else None
    )

    return jsonify({
        "programs": programs,
        "count": len(programs),
        "last_updated": data.get("last_updated")
    })


@app.route("/api/program/<program_id>")
def get_program(program_id):
    """特定のプログラム詳細を取得"""
    data = load_scholarships()

    for program in data["programs"]:
        if program["id"] == program_id:
            return jsonify(program)

    return jsonify({"error": "Program not found"}), 404


if __name__ == "__main__":
    app.run(debug=True, port=5001)
