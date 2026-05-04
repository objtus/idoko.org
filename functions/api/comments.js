const NAME_MAX = 50;
const SUBJECT_MAX = 120;
const MESSAGE_MAX = 500;
const RATE_LIMIT_SEC = 45;
const POSTER_HASH_BYTES = 8;

function corsJson(body, init = {}) {
  const h = new Headers(init.headers);
  h.set("Access-Control-Allow-Origin", "*");
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    ...init,
    headers: h,
  });
}

async function verifyTurnstile(token, ip, secret) {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, response: token, remoteip: ip }),
  });
  const data = await res.json();
  return data.success;
}

async function hashPosterId(ip, env) {
  const salt = env.POSTER_ID_SALT || env.TURNSTILE_SECRET || "guestbook-poster-salt";
  const data = new TextEncoder().encode(`${salt}:${ip || "unknown"}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, POSTER_HASH_BYTES * 2);
}

function parseAdminSet(env) {
  const raw = env.ADMIN_NAMES || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function isAdminName(displayName, adminSet) {
  return adminSet.has((displayName || "").trim());
}

async function rateLimitWaitSec(db, ip) {
  if (!ip) return null;
  const row = await db.prepare("SELECT last_post_unix FROM gb_rate_limit WHERE ip = ?").bind(ip).first();
  const now = Math.floor(Date.now() / 1000);
  if (row && now - row.last_post_unix < RATE_LIMIT_SEC) {
    return Math.max(1, RATE_LIMIT_SEC - (now - row.last_post_unix));
  }
  return null;
}

async function touchRateLimit(db, ip) {
  if (!ip) return;
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO gb_rate_limit (ip, last_post_unix) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET last_post_unix = excluded.last_post_unix"
    )
    .bind(ip, now)
    .run();
}

export async function onRequestGet({ env }) {
  let results;
  try {
    const q = await env.idoko_guestbook.prepare(
      "SELECT id, name, subject, message, created_at, reply_to_id, poster_id FROM comments ORDER BY created_at DESC LIMIT 100"
    ).all();
    results = q.results;
  } catch (e) {
    const q = await env.idoko_guestbook.prepare(
      "SELECT id, name, message, created_at FROM comments ORDER BY created_at DESC LIMIT 100"
    ).all();
    results = (q.results || []).map((r) => ({
      ...r,
      subject: null,
      reply_to_id: null,
      poster_id: r.poster_id ?? `legacy-${r.id}`,
    }));
  }

  const adminSet = parseAdminSet(env);
  const enriched = (results || []).map((r) => {
    const displayName = (r.name && String(r.name).trim()) ? String(r.name).trim() : "Anonymous";
    return {
      ...r,
      display_name: displayName,
      is_admin: isAdminName(displayName, adminSet),
    };
  });

  let maxId = 0;
  try {
    const maxRow = await env.idoko_guestbook.prepare("SELECT MAX(id) AS m FROM comments").first();
    maxId = maxRow && maxRow.m != null ? Number(maxRow.m) : 0;
  } catch {
    maxId = enriched.length ? Math.max(...enriched.map((r) => r.id)) : 0;
  }

  return corsJson({ comments: enriched, max_id: maxId });
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    name: rawName,
    subject: rawSubject,
    message,
    turnstileToken,
    reply_to_id: rawReplyId,
    website: honeypot,
  } = body;

  if (honeypot != null && String(honeypot).trim() !== "") {
    return corsJson({ error: "Bad request" }, { status: 400 });
  }
  if (!message || typeof message !== "string" || !turnstileToken) {
    return corsJson({ error: "Missing fields" }, { status: 400 });
  }

  const nameTrim = typeof rawName === "string" ? rawName.trim() : "";
  const storedName = nameTrim.length ? nameTrim.slice(0, NAME_MAX) : "Anonymous";

  let subject = null;
  if (rawSubject != null && String(rawSubject).trim() !== "") {
    subject = String(rawSubject).trim().slice(0, SUBJECT_MAX);
  }

  const msgTrim = message.trim();
  if (!msgTrim.length) {
    return corsJson({ error: "Message required" }, { status: 400 });
  }
  if (msgTrim.length > MESSAGE_MAX) {
    return corsJson({ error: "Too long" }, { status: 400 });
  }

  let replyToId = null;
  if (rawReplyId != null && rawReplyId !== "") {
    const n = Number(rawReplyId);
    if (!Number.isInteger(n) || n < 1) {
      return corsJson({ error: "Invalid reply" }, { status: 400 });
    }
    const row = await env.idoko_guestbook.prepare("SELECT id FROM comments WHERE id = ?").bind(n).first();
    if (!row) {
      return corsJson({ error: "Invalid reply target" }, { status: 400 });
    }
    replyToId = n;
  }

  const valid = await verifyTurnstile(turnstileToken, ip, env.TURNSTILE_SECRET);
  if (!valid) {
    return corsJson({ error: "Turnstile failed" }, { status: 403 });
  }

  try {
    const waitSec = await rateLimitWaitSec(env.idoko_guestbook, ip);
    if (waitSec !== null) {
      return corsJson({ error: `Rate limited; try again in ${waitSec}s` }, { status: 429 });
    }
  } catch (e) {
    console.error("rate_limit", e);
  }

  const posterId = await hashPosterId(ip, env);

  try {
    await env.idoko_guestbook
      .prepare(
        "INSERT INTO comments (name, subject, message, reply_to_id, poster_id) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(storedName, subject, msgTrim, replyToId, posterId)
      .run();
  } catch (e) {
    if (e && String(e.message || "").includes("no such column")) {
      await env.idoko_guestbook
        .prepare("INSERT INTO comments (name, message) VALUES (?, ?)")
        .bind(storedName, msgTrim)
        .run();
    } else {
      console.error("insert", e);
      return corsJson({ error: "Database error" }, { status: 500 });
    }
  }

  try {
    await touchRateLimit(env.idoko_guestbook, ip);
  } catch (e) {
    console.error("touch_rate_limit", e);
  }

  return corsJson({ ok: true });
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
