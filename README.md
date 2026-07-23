# NIMS 奨学金・制度検索 / Scholarship & Program Finder

NIMS が募集する奨学金・研究員制度・インターンシップ等を、条件で横断検索できる静的サイトです。

- 公開URL: <https://atsumitanaka.github.io/nims-scholarship-finder/>
- 対象: 学部生〜ポスドク、日本人・外国人の双方
- UI: 日本語 / 英語 バイリンガル

## 特徴

- **条件検索**: 国籍・最終学歴・希望進路・入学/採用時期・筑波大NIMS連携大学院の受験予定などで絞り込み
- **締切近い順に自動ソート**: 検索結果は直近の締切日で並び替え
- **スケジュール比較**: 気になる制度にチェックを入れると、複数制度のスケジュールを横並びで比較できるタイムラインを表示
- **募集要項の自動抽出**: 各制度の公式ページ HTML と、そこにリンクされている **募集要項 PDF** を Gemini（`gemini-3.1-flash-lite`）にマルチモーダル入力として渡し、日程・支援内容・必要書類を構造化して取得
- **完全静的**: フロントは HTML / CSS / バニラ JS のみ。GitHub Pages で配信、バックエンド不要

## アーキテクチャ

```
[フロント (GitHub Pages)]  ─── data/scholarships.json を fetch
        │
        ├─ (任意) 「データを更新」ボタン
        │        ↓ POST /trigger
        │   [Cloudflare Worker]  ─── GITHUB_TOKEN を保持
        │        ↓ workflow_dispatch
        └───→ [GitHub Actions: update-schedules.yml]
                   ├─ 日次 cron (18:00 UTC = 03:00 JST 翌日)
                   └─ 手動 (workflow_dispatch)
                        ↓
                 [scripts/update_schedules.py]
                        ↓ HTML + PDF をマルチモーダル入力
                 [Gemini API]
                        ↓
                 data/scholarships.json を更新 → commit & push
                        ↓
                 GitHub Pages 再デプロイ → フロントに反映
```

## ディレクトリ構成

```
.
├── index.html                        # フロントのエントリポイント
├── static/
│   ├── css/style.css
│   └── js/main.js                    # 検索・ソート・タイムライン UI
├── data/
│   └── scholarships.json             # 制度データ（Actions で自動更新）
├── scripts/
│   ├── update_schedules.py           # Gemini スクレイパー
│   └── requirements.txt
├── worker/                           # Cloudflare Worker (任意)
│   ├── src/worker.js                 # workflow_dispatch を叩くプロキシ
│   ├── wrangler.toml
│   └── README.md                     # デプロイ手順
├── .github/workflows/
│   └── update-schedules.yml          # 日次スケジューラ + 手動トリガ
└── legacy/                           # 旧 Flask 版（参考のため残置）
```

## データ更新

### 自動更新
`.github/workflows/update-schedules.yml` が **毎日 03:00 JST** に走り、`data/scholarships.json` に差分があれば `github-actions[bot]` として commit & push します。

### 手動更新（管理者）
1. GitHub リポジトリの **Actions** タブを開く
2. **Update Scholarship Schedules** ワークフローを選択
3. **Run workflow** ボタンを押す

サイト右下フッタの「🔄 データを更新（管理者用）」リンクからも同じ Actions ページに飛べます。

### Worker 経由の手動トリガ（任意）
Cloudflare Worker（`worker/`）をデプロイすると、`workers.dev` の URL 経由でも `workflow_dispatch` を叩けます。GitHub PAT は Worker Secret に保管されるため、クライアント側に露出しません。手順は [`worker/README.md`](worker/README.md) を参照。

> **注**: `*.workers.dev` はネットワーク環境によってはブロックされる場合があります（例: 一部の職場ネットワークで未分類ドメインとして遮断）。その場合は Actions タブから直接手動実行するか、Worker に独自ドメインを割り当てて回避してください。

## スクレイパーの挙動

`scripts/update_schedules.py` は各プログラムの `url` / `additional_urls` を巡回し、次を Gemini に投げて JSON を抽出します。

| 抽出フィールド | 内容 |
| --- | --- |
| `application_schedule` | 募集開始・締切・選考・結果発表など日程一式 |
| `benefits` | 支援金額・支援内容 |
| `required_documents` | 必要書類リスト |

### セーフガード
- HTML 加えて **最大 3 件・各 8MB まで** の PDF をマルチモーダル入力
- 既存件数の **半分未満** しか抽出できなかった場合は既存値を維持（サイト構造変更等での上書き事故を防止）
- **半数以上の制度で抽出失敗** した場合は workflow を `exit 1` で失敗扱いにする

### 環境変数
| 名前 | 必須 | デフォルト | 説明 |
| --- | :---: | --- | --- |
| `GEMINI_API_KEY` | ✓ | — | Google AI Studio で発行した API キー |
| `GEMINI_MODEL` | | `gemini-3.1-flash-lite` | 使用モデル |

GitHub Actions では **Repository Settings → Secrets and variables → Actions** の `GEMINI_API_KEY` から注入されます。

## ローカル実行

### フロントのみプレビュー
```bash
python3 -m http.server 8000
# → http://localhost:8000
```

### スクレイパーを手元で試す
```bash
cd scripts
pip install -r requirements.txt
export GEMINI_API_KEY=xxx
python3 update_schedules.py
```

`data/scholarships.json` が更新されます（差分は git で確認してください）。

## 制度の追加・編集

`data/scholarships.json` の `programs` 配列にエントリを追加し、最低限次のフィールドを埋めてから push してください。次回の Actions 実行時に `benefits` / `required_documents` / `application_schedule` が自動で補完されます。

```json
{
  "id": "program-id",
  "name": "制度の正式名称",
  "name_en": "English name",
  "organization": "実施機関",
  "description": "1〜2行の説明",
  "target_nationality": ["japanese", "foreign"],
  "current_education": ["bachelor", "master", "doctor"],
  "desired_path": ["master", "doctor", "postdoc", "intern"],
  "tsukuba_related": false,
  "url": "https://..."
}
```

## 免責

各制度の最新情報・正確な条件は **必ず公式サイトでご確認ください**。本サイトは公式情報の整理・比較を補助する非公式ツールです。

## ライセンス

MIT
