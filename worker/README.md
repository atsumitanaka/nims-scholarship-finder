# nims-scholarship-trigger Worker

サイト内の「最新情報に更新」ボタンから GitHub Actions の `workflow_dispatch` を
叩くための Cloudflare Worker プロキシ。

GitHub PAT は Cloudflare Workers Secret に保管され、クライアントには公開されない。

## デプロイ手順

### 1. 前提

- Cloudflare アカウント（無料）
- GitHub Fine-grained PAT（`Actions: Read and write`、対象リポジトリのみ）
- Node.js 18 以上（ローカル）

### 2. wrangler のインストール

```bash
npm install -g wrangler
```

### 3. Cloudflare へログイン

```bash
wrangler login
```

ブラウザが開いて Cloudflare アカウントへのアクセスを承認します。

### 4. PAT を Secret として登録

```bash
cd worker
wrangler secret put GITHUB_TOKEN
```

プロンプトが出るので、新しく発行した PAT (`github_pat_...`) を貼り付けて Enter。
**この時点で初めて PAT が必要になります。**

### 5. (任意) Turnstile Secret を登録

ボット対策で Cloudflare Turnstile を使う場合：

```bash
wrangler secret put TURNSTILE_SECRET
```

設定しなければ Turnstile 検証はスキップされます。

### 6. デプロイ

```bash
wrangler deploy
```

デプロイ後、`https://nims-scholarship-trigger.<your-subdomain>.workers.dev/trigger`
のような URL が表示されます。これをフロント側で使います。

### 7. 動作確認

```bash
curl -X POST https://nims-scholarship-trigger.<your-subdomain>.workers.dev/trigger \
  -H "Content-Type: application/json" \
  -d '{}'
```

`{"ok":true,"run":{...}}` が返れば成功。GitHub Actions の Runs ページで新しい
run が表示されます。

## アーキテクチャ

```
[フロント (GitHub Pages)]
        ↓ POST /trigger
[Cloudflare Worker]
        ↓ POST /repos/.../actions/workflows/.../dispatches
[GitHub Actions]
        ↓ python scripts/update_schedules.py
[data/scholarships.json 更新 → commit & push]
        ↓
[GitHub Pages 再デプロイ → フロントに反映]
```

## トラブルシューティング

- **403 from GitHub**: PAT の権限不足。Fine-grained PAT で `Actions: Read and write` が
  対象リポジトリに付与されているか確認
- **GitHub Pages 再デプロイが走らない**: リポジトリ Settings → Pages → Build and
  deployment を確認。`gh-pages` ブランチや GitHub Actions 経由の場合は別途設定要
