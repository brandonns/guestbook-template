/*
====================================
HOW TO USE (Cloudflare Dashboard)
====================================
This is a super-simple guestbook Worker template for beginners. Edit the
CONFIG block near the top — then deploy. No colors, no fancy layout.

1) Create a Worker
   - Cloudflare Dashboard → Workers & Pages → Create → Worker.

2) Add a D1 Database
   - Dashboard → D1 → Create Database (name it anything).
   - Open the DB → Query console → Run this SQL ONCE to create the table:

     CREATE TABLE guestbook_entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       email TEXT,
       website TEXT,
       message TEXT NOT NULL,
       created_at TEXT NOT NULL,
       approved INTEGER NOT NULL DEFAULT 0,
       ip_address TEXT
     );

3) Bind the D1 to your Worker
   - Worker → Settings → Bindings → D1 Databases → Add binding
     • Binding name: DB  (exactly DB)
     • Select your database

4) Add Environment Variables (for admin login + moderation)
   - Worker → Settings → Variables → Add variable
     • ADMIN_USERNAME = youradmin
     • ADMIN_PASSWORD = yourpassword
     • REQUIRE_MODERATION = true  (or false to auto-approve)

5) (Optional) Favicon proxy
   - Edit CONFIG.assets["/favicon.ico"].url to your icon URL, or remove the asset entirely.

6) Deploy + Visit
   - View /  → the guestbook
   - View /admin → admin page (uses Basic Auth with the env vars above)

7) Customize
   - Change CONFIG.site.title
   - Edit the minimal CSS in getMinimalCss()
   - Edit the minimal HTML at the VERY BOTTOM in renderHome()/renderAdmin()


*/

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // =========================
    // EDIT THESE VARIABLES
    // =========================
    const CONFIG = {
      site: {
        title: "My Guestbook", // Page <title> and H1
      },
      auth: {
        realm: "Admin",           // Basic auth realm label
        userEnv: "ADMIN_USERNAME", // Set in Worker env
        passEnv: "ADMIN_PASSWORD", // Set in Worker env
      },
      db: {
        table: "guestbook_entries", // D1 table name
        selectLimit: 100,             // Max entries to return
      },
      api: {
        requireModerationEnv: "REQUIRE_MODERATION", // "true" to require approval
        badWords: ["spam"],                           // Simple text filter list
      },
      assets: {
        "/favicon.ico": { url: "https://example.com/favicon.ico", type: "image/x-icon" },
      },
    };

    // =========================
    // Favicon proxy (optional)
    // =========================
    if (CONFIG.assets[path]) {
      const { url: upstreamUrl, type } = CONFIG.assets[path];
      return proxyAsset(upstreamUrl, type);
    }

    // =========================
    // Minimal public assets
    // =========================
    if (path === "/styles.css") return new Response(getMinimalCss(), { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (path === "/guestbook.js") return new Response(getClientJs(), { headers: { "Content-Type": "application/javascript; charset=utf-8" } });

    // =========================
    // Admin (basic auth)
    // =========================
    if (path.startsWith("/admin")) {
      const ok = await isAuthenticated(request.headers.get("Authorization") || "", env, CONFIG);
      if (!ok) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": `Basic realm="${CONFIG.auth.realm}"` } });

      if (path === "/admin/moderate" && request.method === "POST") {
        const formData = await request.formData();
        const id = formData.get("id");
        const action = formData.get("action");
        if (action === "delete") {
          await env.DB.prepare(`DELETE FROM ${CONFIG.db.table} WHERE id = ?`).bind(id).run();
        } else {
          const approve = action === "approve" ? 1 : 0;
          await env.DB.prepare(`UPDATE ${CONFIG.db.table} SET approved = ? WHERE id = ?`).bind(approve, id).run();
        }
        return Response.redirect(new URL("/admin", url), 302);
      }

      const entries = await getEntries(env.DB, CONFIG.db, { approvedOnly: false });
      return html(renderAdmin(entries, CONFIG));
    }

    // =========================
    // API
    // =========================
    if (path === "/api/submit" && request.method === "POST") {
      try {
        const form = await request.formData();
        const entry = {
          name: (form.get("name") || "").toString().trim(),
          email: (form.get("email") || "").toString().trim(),
          website: (form.get("website") || "").toString().trim(),
          message: (form.get("message") || "").toString().trim(),
          created_at: new Date().toISOString(),
          ip_address: request.headers.get("CF-Connecting-IP") || "",
        };
        if (!entry.name || !entry.message) return json({ success: false, error: "Name and message are required" }, 400);
        if (containsBadWords(entry.message, CONFIG.api.badWords)) return json({ success: false, error: "Message contains inappropriate content" }, 400);
        const requiresModeration = (env[CONFIG.api.requireModerationEnv] || "false").toString() === "true";
        await addEntry(env.DB, CONFIG.db, entry, !requiresModeration);
        return json({ success: true, message: requiresModeration ? "Submitted for approval" : "Added" });
      } catch {
        return json({ success: false, error: "Failed to process request" }, 500);
      }
    }

    if (path === "/api/entries") {
      const entries = await getEntries(env.DB, CONFIG.db, { approvedOnly: true });
      return json(entries);
    }

    // =========================
    // Pages
    // =========================
    if (path === "/" || path === "/index.html") {
      const entries = await getEntries(env.DB, CONFIG.db, { approvedOnly: true });
      return html(renderHome(entries, CONFIG));
    }

    return new Response("Not Found", { status: 404 });
  },
};

// =========================
// Helpers
// =========================
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } }); }
function html(markup, status = 200) { return new Response(markup, { status, headers: { "Content-Type": "text/html; charset=utf-8" } }); }
async function proxyAsset(upstreamUrl, contentType) {
  const resp = await fetch(upstreamUrl, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!resp.ok) return new Response("Upstream asset not found", { status: 502 });
  const body = await resp.arrayBuffer();
  return new Response(body, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=1800" } });
}

// =========================
// DB
// =========================
async function getEntries(db, dbCfg, { approvedOnly }) {
  const where = approvedOnly ? " WHERE approved = 1" : "";
  const cols = approvedOnly ? "id, name, email, website, message, created_at" : "id, name, email, website, message, created_at, approved";
  const q = `SELECT ${cols} FROM ${dbCfg.table}${where} ORDER BY created_at DESC LIMIT ${dbCfg.selectLimit}`;
  try { const { results } = await db.prepare(q).all(); return results; } catch { return []; }
}
async function addEntry(db, dbCfg, entry, approved = false) {
  const sql = `INSERT INTO ${dbCfg.table} (name, email, website, message, created_at, approved, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  try { await db.prepare(sql).bind(entry.name, entry.email, entry.website, entry.message, entry.created_at, approved ? 1 : 0, entry.ip_address).run(); return true; } catch { return false; }
}

// =========================
// Auth / Filters
// =========================
async function isAuthenticated(authHeader, env, CONFIG) {
  if (!authHeader.startsWith("Basic ")) return false;
  let decoded = ""; try { decoded = atob(authHeader.slice(6)); } catch { return false; }
  const [u, p] = decoded.split(":");
  return u === env[CONFIG.auth.userEnv] && p === env[CONFIG.auth.passEnv];
}
function containsBadWords(text, list) { const t = (text || "").toLowerCase(); return list.some(w => t.includes(w.toLowerCase())); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

// =========================
// CSS
// =========================
function getMinimalCss() {
  return `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Arial,sans-serif;line-height:1.4}
.container{max-width:720px;margin:0 auto;padding:16px}
.header{padding:8px 0;border-bottom:1px solid currentColor}
.main{padding:16px 0}
.form{display:grid;gap:8px;margin-bottom:16px}
.input,.textarea{width:100%;padding:8px;border:1px solid currentColor}
.button{padding:8px 12px;border:1px solid currentColor;background:transparent;cursor:pointer}
.list{display:grid;gap:12px}
.item{padding:12px;border:1px solid currentColor}
.itemHead{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid currentColor;padding-bottom:6px;margin-bottom:8px}
.small{font-size:.9em}
.status{margin:8px 0;padding:8px;border:1px solid currentColor;display:none}
`;
}

// =========================
// Client JS
// =========================
function getClientJs() {
  return `
addEventListener('DOMContentLoaded', function(){
  var form = document.getElementById('gb-form');
  var entriesEl = document.getElementById('gb-entries');
  var statusEl = document.getElementById('gb-status');

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var fd = new FormData(form);
    var name = String(fd.get('name')||'').trim();
    var message = String(fd.get('message')||'').trim();
    if(!name || !message){ show('Please add a name and message'); return; }
    fetch('/api/submit', { method:'POST', body: fd })
      .then(function(r){ return r.json(); })
      .then(function(json){
        show(json.success ? json.message : (json.error||'Error'));
        if(json.success && String(json.message||'').indexOf('approval') === -1){ form.reset(); load(); }
      })
      .catch(function(){ show('Network error'); });
  });

  function show(msg){ statusEl.textContent = msg; statusEl.style.display='block'; setTimeout(function(){ statusEl.style.display='none'; }, 4000); }

  function link(u){ var x=String(u||''); return /^https?:\/\//i.test(x)?x:'https://'+x; }

  function addItem(e){
    var d = new Date(e.created_at).toLocaleString();
    var item = document.createElement('div'); item.className='item';
    var head = document.createElement('div'); head.className='itemHead';
    var strong = document.createElement('strong'); strong.textContent = e.name || '';
    var when = document.createElement('span'); when.className='small'; when.textContent = d;
    head.appendChild(strong); head.appendChild(when);
    var msg = document.createElement('div'); msg.textContent = e.message || '';
    var meta = document.createElement('div'); meta.className='small';
    if(e.website){ var a=document.createElement('a'); a.href=link(e.website); a.target='_blank'; a.rel='noopener'; a.textContent=e.website; meta.appendChild(a); if(e.email){ meta.appendChild(document.createTextNode(' | ')); } }
    if(e.email){ meta.appendChild(document.createTextNode(e.email)); }
    item.appendChild(head); item.appendChild(msg); item.appendChild(meta);
    entriesEl.appendChild(item);
  }

  function load(){
    fetch('/api/entries')
      .then(function(r){ return r.json(); })
      .then(function(data){
        entriesEl.innerHTML='';
        if(!data.length){ var p=document.createElement('p'); p.className='small'; p.textContent='No entries yet.'; entriesEl.appendChild(p); return; }
        data.forEach(addItem);
      })
      .catch(function(){ entriesEl.innerHTML='<p class="small">Failed to load entries.</p>'; });
  }

  load();
});
`;
}

// =========================
// HTML EDIT ME!!!
// =========================
function renderHome(entries, CONFIG){
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(CONFIG.site.title)}</title>
  <link rel="icon" href="/favicon.ico">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container">
    <header class="header"><h1>${escapeHtml(CONFIG.site.title)}</h1></header>
    <main class="main">
      <div id="gb-status" class="status"></div>
      <form id="gb-form" class="form">
        <input class="input" type="text" name="name" placeholder="Your name" required>
        <input class="input" type="email" name="email" placeholder="Email (optional)">
        <input class="input" type="url" name="website" placeholder="Website (optional)">
        <textarea class="textarea" name="message" rows="4" placeholder="Say something" required></textarea>
        <button class="button" type="submit">Submit</button>
      </form>
      <section>
        <h2 class="small">Recent entries</h2>
        <div id="gb-entries" class="list">
          ${entries.map(e => `
            <div class="item">
              <div class="itemHead"><strong>${escapeHtml(e.name)}</strong><span class="small">${new Date(e.created_at).toLocaleString()}</span></div>
              <div>${escapeHtml(e.message)}</div>
              <div class="small">${e.website ? `<a href="${/^(https?:)?\/\//.test(e.website)? e.website : 'https://'+e.website}" target="_blank" rel="noopener">${escapeHtml(e.website)}</a> | `:''}${e.email?escapeHtml(e.email):''}</div>
            </div>`).join("")}
        </div>
      </section>
    </main>
  </div>
  <script src="/guestbook.js"></script>
</body>
</html>`;
}

function renderAdmin(entries, CONFIG){
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(CONFIG.site.title)} — Admin</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container">
    <header class="header"><h1>Manage entries</h1></header>
    <main class="main">
      ${entries.map(e=>`
        <div class="item">
          <div class="itemHead"><strong>${escapeHtml(e.name)}</strong><span class="small">${new Date(e.created_at).toLocaleString()}</span></div>
          <div>${escapeHtml(e.message)}</div>
          <form method="POST" action="/admin/moderate" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
            <input type="hidden" name="id" value="${e.id}">
            ${e.approved ? `<input type="hidden" name="action" value="disapprove"><button class="button" type="submit">Remove</button>` : `<input type="hidden" name="action" value="approve"><button class="button" type="submit">Approve</button>`}
            <button class="button" name="action" value="delete" type="submit">Delete</button>
          </form>
        </div>`).join("") || '<p class="small">No entries.</p>'}
    </main>
  </div>
</body>
</html>`;
}
