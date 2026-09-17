// functions/api/views.js
//
// Cloudflare Pages Functions で動く簡易プロキシ。
// Neocities公式APIの /api/info を裏で叩いて、
// views(総閲覧数)だけをCORS付きで返す。
//
// デプロイ後は https://idoko.org/api/views で叩ける。

const SITENAME = "yuinoid";
const ALLOWED_ORIGIN = "https://yuinoid.neocities.org";

export async function onRequestGet(context) {
  try {
    const res = await fetch(
      `https://neocities.org/api/info?sitename=${SITENAME}`
    );

    if (!res.ok) {
      return jsonResponse({ error: "neocities api error" }, 502);
    }

    const data = await res.json();

    if (data.result !== "success" || !data.info) {
      return jsonResponse({ error: "unexpected response" }, 502);
    }

    return jsonResponse({
      sitename: data.info.sitename,
      views: data.info.views,
      hits: data.info.hits,
    });
  } catch (err) {
    return jsonResponse({ error: "fetch failed" }, 500);
  }
}

// ブラウザからのプリフライト(OPTIONS)対応
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      // 5分キャッシュしてneocities APIを叩きすぎないようにする
      "Cache-Control": "public, max-age=300",
    },
  });
}