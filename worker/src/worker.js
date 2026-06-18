/**
 * NIMS Scholarship Finder - 手動更新トリガー Worker
 *
 * フロントエンドからの POST /trigger を受け、GitHub Actions の
 * workflow_dispatch を叩く軽量プロキシ。
 * GitHub PAT と Turnstile Secret は Cloudflare Workers Secret に保管し、
 * クライアント側には一切公開しない。
 *
 * 必要な環境変数（wrangler secret put で設定）:
 *   GITHUB_TOKEN       - Fine-grained PAT (Actions: Read and write)
 *   TURNSTILE_SECRET   - (任意) Turnstile シークレット
 *
 * wrangler.toml の [vars] で設定:
 *   GITHUB_OWNER       - リポオーナー名
 *   GITHUB_REPO        - リポ名
 *   WORKFLOW_FILE      - 起動するワークフローファイル名
 *   ALLOWED_ORIGIN     - CORS 許可する Origin
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return jsonResponse({ error: "Not found" }, 404, request, env);
    }

    // 任意: Turnstile 検証（TURNSTILE_SECRET が設定されている場合のみ有効化）
    let body = {};
    try {
      body = await request.json();
    } catch {
      // ボディなしでも許容
    }

    if (env.TURNSTILE_SECRET) {
      const token = body.turnstileToken;
      if (!token) {
        return jsonResponse({ error: "Turnstile token required" }, 400, request, env);
      }
      const verifyResp = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET,
            response: token,
            remoteip: request.headers.get("CF-Connecting-IP") || "",
          }),
        },
      );
      const verifyJson = await verifyResp.json();
      if (!verifyJson.success) {
        return jsonResponse(
          { error: "Turnstile verification failed", detail: verifyJson["error-codes"] },
          403,
          request,
          env,
        );
      }
    }

    // workflow_dispatch を叩く
    const dispatchResp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "nims-scholarship-trigger-worker",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (!dispatchResp.ok) {
      const text = await dispatchResp.text();
      return jsonResponse(
        { error: "GitHub dispatch failed", status: dispatchResp.status, detail: text },
        502,
        request,
        env,
      );
    }

    // workflow_dispatch は 204 を返すので、少し待ってから最新ランを返す
    await new Promise((r) => setTimeout(r, 2500));

    const runsResp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "nims-scholarship-trigger-worker",
        },
      },
    );

    const runsJson = await runsResp.json();
    const run = runsJson.workflow_runs?.[0];

    return jsonResponse(
      {
        ok: true,
        run: run ? { id: run.id, url: run.html_url, status: run.status } : null,
      },
      200,
      request,
      env,
    );
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin === allowed ? origin : allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}
