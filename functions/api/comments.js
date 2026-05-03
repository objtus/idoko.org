const TURNSTILE_SECRET = "あとで環境変数に入れる";

async function verifyTurnstile(token, ip) {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const data = await res.json();
  return data.success;
}

export async function onRequestGet({ env }) {
  const { results } = await env.idoko_guestbook.prepare(
    "SELECT id, name, message, created_at FROM comments ORDER BY created_at DESC LIMIT 100"
  ).all();
  return Response.json(results, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get("CF-Connecting-IP");
  const body = await request.json();
  const { name, message, turnstileToken } = body;

  if (!name || !message || !turnstileToken) {
    return Response.json({ error: "Missing fields" }, { status: 400 });
  }
  if (name.length > 50 || message.length > 500) {
    return Response.json({ error: "Too long" }, { status: 400 });
  }

  const valid = await verifyTurnstile(turnstileToken, ip);
  if (!valid) {
    return Response.json({ error: "Turnstile failed" }, { status: 403 });
  }

  await env.idoko_guestbook.prepare(
    "INSERT INTO comments (name, message) VALUES (?, ?)"
  ).bind(name, message).run();

  return Response.json({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}