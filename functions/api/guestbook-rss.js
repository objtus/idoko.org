function escXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822Date(isoOrSql) {
  const d = new Date(isoOrSql);
  if (Number.isNaN(d.getTime())) return new Date().toUTCString();
  return d.toUTCString();
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const selfLink = `${origin}/api/guestbook-rss`;

  let rows = [];
  try {
    const q = await env.idoko_guestbook.prepare(
      "SELECT id, name, subject, message, created_at FROM comments ORDER BY created_at DESC LIMIT 50"
    ).all();
    rows = q.results || [];
  } catch (e1) {
    try {
      const q = await env.idoko_guestbook.prepare(
        "SELECT id, name, message, created_at FROM comments ORDER BY created_at DESC LIMIT 50"
      ).all();
      rows = (q.results || []).map((r) => ({ ...r, subject: null }));
    } catch (e2) {
      return new Response("Feed unavailable", { status: 500 });
    }
  }

  const items = rows
    .map((r) => {
      const titleSub = r.subject && String(r.subject).trim() ? String(r.subject).trim() : "(no subject)";
      const from = (r.name && String(r.name).trim()) ? String(r.name).trim() : "Anonymous";
      const title = `#${r.id} ${from}: ${titleSub}`;
      const link = `${origin}/#${r.id}`;
      const desc = escXml(String(r.message || ""));
      const pub = rfc822Date(r.created_at);
      return `
    <item>
      <title>${escXml(title)}</title>
      <link>${escXml(link)}</link>
      <guid isPermaLink="false">${escXml(`guestbook-${r.id}`)}</guid>
      <pubDate>${escXml(pub)}</pubDate>
      <description>${desc}</description>
    </item>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml("idoko.org guestbook")}</title>
    <link>${escXml(`${origin}/`)}</link>
    <description>${escXml("Guestbook messages")}</description>
    <language>ja</language>
    <atom:link href="${escXml(selfLink)}" rel="self" type="application/rss+xml" />
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
