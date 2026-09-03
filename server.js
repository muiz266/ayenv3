const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const http = require("http");
let WebSocketServer = null;
try { WebSocketServer = require("ws").WebSocketServer; } catch (_) { console.warn("ws tidak dipasang"); }
let webpush = null;
try { webpush = require("web-push"); } catch (_) { console.warn("web-push tidak dipasang — push terhad"); }

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ADMIN_PIN = String(process.env.AYEN_ADMIN_PIN || process.env.ADMIN_PIN || "");
const ADMIN_SECRET = String(process.env.AYEN_ADMIN_SECRET || "");
const MERCHANT_PHONE = String(process.env.MERCHANT_PHONE || "601111041587");
const RIDER_PIN = String(process.env.AYEN_RIDER_PIN || process.env.AYEN_ADMIN_PIN || process.env.ADMIN_PIN || "6996");

// ===== Tetapan kedai (pre-order, slot, harga, diskaun) =====
const DEFAULT_PRICES = {
  "1": { id: 1, name: "Ketam Saiz A", desc: "Isi paling padat & besar", price: 55 },
  "2": { id: 2, name: "Ketam Saiz B", desc: "Segar & sederhana besar", price: 45 },
  "3": { id: 3, name: "Ketam Saiz C", desc: "Manis & berpatutan", price: 35 },
  "4": { id: 4, name: "Campur Saiz (A, B & C)", desc: "Ikut stok harian", price: 45 }
};
const DEFAULT_SLOT_DEFS = [
  { id: "slot1", name: "11:00 - 13:00", maxCapacity: 5 },
  { id: "slot2", name: "13:00 - 15:00", maxCapacity: 5 },
  { id: "slot3", name: "15:00 - 17:00", maxCapacity: 3 }
];

async function ensureShopSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const defaults = {
    is_open: true,
    preorder_days: 7,
    cutoff_hours: 2,
    discount_percent: 0,
    discount_label: "",
    prices: DEFAULT_PRICES,
    slot_defs: DEFAULT_SLOT_DEFS,
    cod_enabled: false
  };
  for (const [k, v] of Object.entries(defaults)) {
    await pool.query(
      `INSERT INTO shop_settings(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [k, JSON.stringify(v)]
    );
  }
}

async function getSetting(key, fallback) {
  try {
    const r = await pool.query(`SELECT value FROM shop_settings WHERE key=$1`, [key]);
    if (r.rows[0]) return r.rows[0].value;
  } catch (_) {}
  return fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO shop_settings(key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function getShopSettings() {
  await ensureShopSettingsTable();
  const isOpen = await getSetting("is_open", true);
  const preorderDays = Number(await getSetting("preorder_days", 7)) || 7;
  const cutoffHours = Number(await getSetting("cutoff_hours", 2)) || 2;
  const discountPercent = Number(await getSetting("discount_percent", 0)) || 0;
  const discountLabel = String(await getSetting("discount_label", "") || "");
  const prices = (await getSetting("prices", DEFAULT_PRICES)) || DEFAULT_PRICES;
  const slotDefs = (await getSetting("slot_defs", DEFAULT_SLOT_DEFS)) || DEFAULT_SLOT_DEFS;
  const codEnabled = false; // pre-order: COD dimatikan
  return {
    isOpen: Boolean(isOpen === true || isOpen === "true"),
    preorderDays: Math.min(30, Math.max(1, preorderDays)),
    cutoffHours: Math.min(48, Math.max(0, cutoffHours)),
    discountPercent: Math.min(50, Math.max(0, discountPercent)),
    discountLabel,
    prices,
    slotDefs,
    codEnabled: false,
    paymentMethods: ["qr"]
  };
}


/** Parse jam mula slot dari nama "11:00 - 13:00" → {h, m} */
function parseSlotStart(slotName) {
  const m = String(slotName || "").match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) return { h: 11, m: 0 };
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

/**
 * Timeout pre-order: tempahan mesti dibuat sekurang-kurangnya cutoffHours
 * sebelum masa mula slot pada tarikh penghantaran.
 * return { ok, reason, slotStart, deadline }
 */
function checkPreorderTimeout(deliveryDate, slotName, cutoffHours) {
  const { h, m } = parseSlotStart(slotName);
  const parts = String(deliveryDate || "").split("-").map(Number);
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) {
    return { ok: false, reason: "Tarikh penghantaran tidak sah." };
  }
  const slotStart = new Date(parts[0], parts[1] - 1, parts[2], h, m, 0, 0);
  const deadline = new Date(slotStart.getTime() - Number(cutoffHours || 0) * 3600 * 1000);
  const now = new Date();
  if (now > slotStart) {
    return {
      ok: false,
      reason: "Slot ini sudah berlalu. Sila pilih tarikh/slot lain.",
      slotStart: slotStart.toISOString(),
      deadline: deadline.toISOString()
    };
  }
  if (now > deadline) {
    return {
      ok: false,
      reason:
        "Timeout pre-order: tempahan mesti dibuat sekurang-kurangnya " +
        cutoffHours +
        " jam sebelum slot (" +
        String(slotName || "") +
        "). Sila pilih slot/tarikh kemudian.",
      slotStart: slotStart.toISOString(),
      deadline: deadline.toISOString()
    };
  }
  return {
    ok: true,
    slotStart: slotStart.toISOString(),
    deadline: deadline.toISOString(),
    hoursLeft: Math.max(0, (deadline - now) / 3600000)
  };
}

function slotStillOpenForPreorder(deliveryDate, slotName, cutoffHours) {
  return checkPreorderTimeout(deliveryDate, slotName, cutoffHours).ok;
}

function listPreorderDates(days) {
  const out = [];
  const now = new Date();
  // mula esok (pre-order) — hari ini optional ikut cutoff
  for (let i = 0; i <= days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}




// Web Push (notifikasi kekal sehingga dibuka)
let VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
let VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@ayen-ketam-nipah.local";
if (webpush) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    try {
      const keys = webpush.generateVAPIDKeys();
      VAPID_PUBLIC = keys.publicKey;
      VAPID_PRIVATE = keys.privateKey;
      console.log("[push] VAPID auto-generated (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY di Render untuk kekal)");
    } catch (e) {
      console.warn("VAPID generate gagal:", e.message);
    }
  }
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
      console.log("[push] Web Push aktif");
    } catch (e) {
      console.warn("VAPID setup gagal:", e.message);
    }
  }
}

// Real-time SSE clients: phone -> Set of response objects
const sseClients = new Map(); // customer phone -> Set
const sseOpsClients = new Map(); // "admin" | "rider:ID" -> Set
// WebSocket rooms: phone key | "admin" | "rider:ID" -> Set of ws
const wsClients = new Map();

function wsSend(ws, event, data) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ event, data, ts: Date.now() })); } catch (_) {}
}

function wsBroadcastRoom(room, event, data) {
  const set = wsClients.get(room);
  if (!set) return;
  for (const ws of set) wsSend(ws, event, data);
}

function wsJoin(room, ws) {
  if (!wsClients.has(room)) wsClients.set(room, new Set());
  wsClients.get(room).add(ws);
  if (!ws._rooms) ws._rooms = new Set();
  ws._rooms.add(room);
}

function wsLeaveAll(ws) {
  if (!ws._rooms) return;
  for (const room of ws._rooms) {
    const set = wsClients.get(room);
    if (set) {
      set.delete(ws);
      if (!set.size) wsClients.delete(room);
    }
  }
  ws._rooms.clear();
}



function normalizePhoneKey(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-10) : d;
}

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {}
}

function broadcastOps(event, data) {
  for (const [, set] of sseOpsClients) {
    for (const res of set) sseSend(res, event, data);
  }
  wsBroadcastRoom("admin", event, data);
  // semua rider rooms juga (tawaran / status)
  for (const room of wsClients.keys()) {
    if (String(room).startsWith("rider:")) wsBroadcastRoom(room, event, data);
  }
}

function broadcastToRider(riderId, event, data) {
  const key = "rider:" + String(riderId);
  const set = sseOpsClients.get(key);
  if (set) {
    for (const res of set) sseSend(res, event, data);
  }
  wsBroadcastRoom(key, event, data);
}

function broadcastRealtime(phone, event, data) {
  const key = normalizePhoneKey(phone);
  if (key) {
    const set = sseClients.get(key);
    if (set) {
      for (const res of set) sseSend(res, event, data);
    }
    wsBroadcastRoom(key, event || "order_update", data);
    sendPushToPhone(phone, {
      title: data.title || "AYEN KETAM NIPAH",
      body: data.body || data.message || "Kemaskini pesanan",
      orderId: data.orderId,
      tag: data.tag || (data.orderId ? "akn-" + data.orderId : "akn-order"),
      url: data.url || "/?open=history"
    }).catch(() => {});
  }
  // Admin + semua ops nampak order update
  broadcastOps(event || "order_update", data);
  if (data.assignedRiderId) {
    broadcastToRider(data.assignedRiderId, event || "order_update", data);
  }
}

/** Notifikasi penuh 3 pihak selepas perubahan order */

/** Mesej mesra mengikut kategori status order */
function statusCategoryMessage(orderId, status, extra = {}) {
  const id = orderId || "";
  const st = String(status || "");
  const map = {
    "Sedang Diproses": "Pesanan " + id + " sedang diproses.",
    "Mencari rider": "Pesanan " + id + " mencari rider.",
    "Disahkan": "Rider telah menerima pesanan " + id + ".",
    "Dalam penghantaran": "Rider telah mengambil pesanan. Sedang dihantar kepada anda.",
    "Selesai": "Pesanan " + id + " telah selesai dihantar. Terima kasih!",
    "Ditolak": "Pesanan " + id + " ditolak" + (extra.reason ? (": " + extra.reason) : ".")
  };
  if (map[st]) return map[st];
  return "Pesanan " + id + ": " + st;
}

function chatProofMessage(kind, lat, lng) {
  if (kind === "pickup" || kind === "Dalam penghantaran") {
    return "[BUKTI_PICKUP] Rider telah mengambil pesanan.";
  }
  if (kind === "delivery" || kind === "Selesai") {
    let t = "[BUKTI_HANTAR] Rider telah menghantar pesanan. Terima kasih!";
    if (lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
      t += " Lokasi: https://maps.google.com/?q=" + lat + "," + lng;
    }
    return t;
  }
  return "";
}

async function notifyAllParties(orderId, extra = {}) {
  try {
    const r = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [orderId]);
    if (!r.rows[0]) return;
    const o = r.rows[0];
    const payload = {
      title: "AYEN KETAM NIPAH",
      body: extra.body || statusCategoryMessage(o.order_id, o.status, extra),
      message: extra.body || statusCategoryMessage(o.order_id, o.status, extra),
      orderId: o.order_id,
      status: o.status,
      assignedRiderId: o.assigned_rider_id,
      assignedRiderName: o.assigned_rider_name,
      riderAccepted: o.rider_accepted,
      customerPhone: o.customer_phone,
      tag: "akn-" + o.order_id,
      url: "/?open=history",
      ...extra
    };
    broadcastRealtime(o.customer_phone, extra.event || "order_update", payload);
    // Push ke semua rider bila order baru / masih mencari rider
    try {
      const st = String(o.status || "");
      const ev = String(extra.event || "");
      if (ev === "order_new" || st === "Mencari rider") {
        sendPushToAllRiders({
          title: "Ayen Rider — Order baharu",
          body: extra.body || (`Order ${o.order_id} · ${o.total_price || ""} · ${String(o.address || "").slice(0, 60)}`),
          orderId: o.order_id,
          tag: "ayen-rider-" + o.order_id,
          url: "/rider.html"
        }).catch(() => {});
      } else if (o.assigned_rider_id && (ev === "order_update" || st === "Disahkan")) {
        // Optional: could target one rider by phone — broadcast ops already via WS
      }
    } catch (_) {}
  } catch (e) {
    console.error("notifyAllParties", e.message);
  }
}



async function ensurePushTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_push_phone ON push_subscriptions(phone);
  `);
}

async function sendPushToPhone(phone, payload) {
  if (!webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return { sent: 0, skipped: true };
  const p = String(phone || "").replace(/\D/g, "");
  if (!p) return { sent: 0 };
  try {
    await ensurePushTable();
    const r = await pool.query(
      `SELECT * FROM push_subscriptions WHERE phone LIKE $1 OR phone LIKE $2`,
      ["%" + p.slice(-9), p]
    );
    const body = JSON.stringify({
      title: payload.title || "AYEN KETAM NIPAH",
      body: payload.body || "Kemaskini pesanan",
      url: payload.url || "/?open=history",
      tag: payload.tag || "akn-order",
      orderId: payload.orderId || null
    });
    let sent = 0;
    for (const row of r.rows) {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth }
          },
          body,
          { TTL: 86400, urgency: "high" }
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [row.id]);
        }
      }
    }
    return { sent };
  } catch (e) {
    console.error("push", e);
    return { sent: 0, error: e.message };
  }
}


async function sendPushToAllRiders(payload) {
  if (!webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return { sent: 0, skipped: true };
  try {
    await ensurePushTable();
    const r = await pool.query(
      `SELECT * FROM push_subscriptions WHERE phone LIKE 'rider:%' OR phone LIKE 'RIDER:%'`
    );
    const body = JSON.stringify({
      title: payload.title || "Ayen Rider",
      body: payload.body || "Order baharu tersedia",
      url: payload.url || "/rider.html",
      tag: payload.tag || "ayen-rider-order",
      orderId: payload.orderId || null
    });
    let sent = 0;
    for (const row of r.rows) {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth }
          },
          body,
          { TTL: 3600, urgency: "high" }
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [row.id]);
        }
      }
    }
    return { sent };
  } catch (e) {
    console.error("push riders", e);
    return { sent: 0, error: e.message };
  }
}


async function sendPushToRider(riderId, payload) {
  if (!webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return { sent: 0, skipped: true };
  try {
    await ensurePushTable();
    let phone = null;
    if (riderId) {
      const r = await pool.query(`SELECT phone FROM riders WHERE id=$1 LIMIT 1`, [riderId]);
      if (r.rows[0]) phone = String(r.rows[0].phone || "").replace(/\D/g, "");
    }
    const keys = [];
    if (phone) keys.push("rider:" + phone);
    keys.push("rider:rider");
    const r2 = await pool.query(
      `SELECT * FROM push_subscriptions WHERE phone = ANY($1::text[]) OR phone LIKE 'rider:%'`,
      [keys]
    );
    // Prefer exact rider phone matches first
    const rows = r2.rows.filter((row) => {
      if (!phone) return String(row.phone).startsWith("rider:");
      return row.phone === ("rider:" + phone) || row.phone === phone;
    });
    const list = rows.length ? rows : r2.rows.filter((row) => String(row.phone).startsWith("rider:"));
    const body = JSON.stringify({
      title: payload.title || "Ayen Rider",
      body: payload.body || "Mesej baharu",
      url: payload.url || "/rider.html",
      tag: payload.tag || "ayen-rider-chat",
      orderId: payload.orderId || null
    });
    let sent = 0;
    for (const row of list) {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          { TTL: 3600, urgency: "high" }
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [row.id]);
        }
      }
    }
    return { sent };
  } catch (e) {
    console.error("push rider", e);
    return { sent: 0, error: e.message };
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres perlukan SSL
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5,
});

app.set("trust proxy", 1);
// PENTING: Helmet default menghantar Content-Security-Policy yang menyekat SEMUA
// inline <script>/onclick dan inline style — app ini (index.html, admin.html,
// rider.html) ditulis sepenuhnya sebagai inline script/handler dalam satu fail HTML,
// jadi CSP default akan "diam-diam" menyekat semua JS daripada berjalan langsung
// (punca menu/troli/sejarah pesanan kelihatan kosong walaupun HTML/DB betul).
// Konfigurasi CSP secara eksplisit di bawah supaya ia benarkan apa yang app ini
// perlukan, tanpa terus mematikan semua perlindungan Helmet yang lain.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https:", "wss:", "ws:"],
      mediaSrc: ["'self'", "data:", "blob:"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)),
});

function clean(value, max = 250) { return String(value ?? "").trim().slice(0, max); }

function isGoogleMapsHost(urlStr) {
  try {
    const u = new URL(urlStr);
    const h = String(u.hostname || "").toLowerCase();
    return (
      h === "maps.google.com" ||
      h === "www.google.com" ||
      h === "google.com" ||
      h === "maps.app.goo.gl" ||
      h === "goo.gl" ||
      h === "g.co" ||
      h.endsWith(".google.com") ||
      h.endsWith(".google.com.my")
    );
  } catch (_) {
    return false;
  }
}

function extractLatLngFromMapsUrl(s) {
  let lat = null, lng = null;
  let m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  if (lat == null) {
    m = s.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  }
  if (lat == null) {
    m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  }
  if (lat == null) {
    m = s.match(/[?&](?:ll|center)=(-?\d+\.\d+),(-?\d+\.\d+)/i);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  }
  if (lat == null) {
    m = s.match(/\/search\/\s*(-?\d+\.\d+)\s*,\s*(-\d+\.\d+)/);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  }
  if (lat == null) {
    m = s.match(/place\/[^/]+\/(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  }
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return null;
}

function parseMapsLink(link) {
  const s = String(link || "").trim();
  if (!s) return { ok: false, error: "Pautan Google Maps wajib." };
  if (!/^https?:\/\//i.test(s)) {
    return { ok: false, error: "Pautan Maps mesti bermula dengan https://" };
  }
  if (!isGoogleMapsHost(s)) {
    return {
      ok: false,
      error: "Pautan mestilah dari Google Maps (maps.google.com / maps.app.goo.gl)."
    };
  }
  // Elak pautan pendek tanpa koordinat — rider & caj jarak perlukan lokasi tepat
  const coords = extractLatLngFromMapsUrl(s);
  if (!coords) {
    return {
      ok: false,
      error: "Pautan tidak mengandungi koordinat. Di Google Maps: pin lokasi rumah → Kongsi → Salin pautan (bukan pautan pendek kosong)."
    };
  }
  const v = validateMapCoordinates(coords.lat, coords.lng);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, link: s.slice(0, 500), lat: coords.lat, lng: coords.lng, distanceKm: v.distanceKm };
}

/** Validasi koordinat peta: nombor sah, dalam MY, dalam radius hantar SP */
function validateMapCoordinates(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) {
    return { ok: false, error: "Koordinat peta tidak sah." };
  }
  if (Math.abs(la) < 1e-6 && Math.abs(ln) < 1e-6) {
    return { ok: false, error: "Koordinat 0,0 tidak diterima. Sila pilih lokasi sebenar di peta." };
  }
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) {
    return { ok: false, error: "Koordinat di luar julat peta dunia (lat ±90, lng ±180)." };
  }
  // Malaysia (semenanjung + Malaysia Timur kasar)
  if (la < 0.5 || la > 7.8 || ln < 99.0 || ln > 120.0) {
    return { ok: false, error: "Koordinat di luar Malaysia. Sila pilih alamat penghantaran yang betul." };
  }
  const shopLat = typeof SHOP_LAT === "number" ? SHOP_LAT : 5.6437;
  const shopLng = typeof SHOP_LNG === "number" ? SHOP_LNG : 100.4890;
  const maxKm = typeof DELIVERY_RADIUS_KM === "number" ? DELIVERY_RADIUS_KM : 12;
  // haversineKm ditakrif kemudian — guna formula tempatan jika belum ada
  let distanceKm = null;
  try {
    if (typeof haversineKm === "function") {
      distanceKm = haversineKm(shopLat, shopLng, la, ln);
    } else {
      const R = 6371;
      const dLat = (la - shopLat) * Math.PI / 180;
      const dLng = (ln - shopLng) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(shopLat*Math.PI/180)*Math.cos(la*Math.PI/180)*Math.sin(dLng/2)**2;
      distanceKm = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
  } catch (_) {
    distanceKm = null;
  }
  if (distanceKm != null && distanceKm > maxKm) {
    return {
      ok: false,
      error: "Koordinat di luar kawasan hantar Sungai Petani (maks " + maxKm + " km). Jarak: " + (Math.round(distanceKm * 10) / 10) + " km dari kedai.",
      distanceKm: Math.round(distanceKm * 10) / 10
    };
  }
  return {
    ok: true,
    lat: la,
    lng: ln,
    distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null
  };
}

/** Ikut redirect pautan pendek Google Maps untuk dapatkan URL penuh + koordinat */
async function resolveShortMapsLink(link) {
  const s = String(link || "").trim();
  if (!s) return { ok: false, error: "Pautan Google Maps wajib." };
  // Jika sudah ada koordinat, terus parse
  const direct = parseMapsLink(s);
  if (direct.ok) return direct;

  // Cuba expand short link (maps.app.goo.gl / goo.gl)
  let hostOk = false;
  try {
    const u = new URL(s);
    const h = String(u.hostname || "").toLowerCase();
    hostOk = h === "maps.app.goo.gl" || h === "goo.gl" || h === "g.co" || h.includes("google");
  } catch (_) {
    return { ok: false, error: "Pautan tidak sah." };
  }
  if (!hostOk) return direct; // ralat asal dari parseMapsLink

try {
    const UA = "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    let current = s;
    let res = null;
    // Ikut redirect secara manual (maks 6 lompatan) — lebih stabil vs redirect:follow sahaja
    for (let hop = 0; hop < 6; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ms-MY,ms;q=0.9,en;q=0.8"
        }
      });
      clearTimeout(timer);
      const loc = res.headers.get("location") || res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && loc) {
        try {
          current = new URL(loc, current).toString();
        } catch (_) {
          current = loc;
        }
        continue;
      }
      break;
    }
    const finalUrl = String((res && res.url) || current || s);

    // Pautan pendek tidak wujud / luput
    if (res && (res.status === 404 || res.status === 410)) {
      return {
        ok: false,
        error: "Pautan Google Maps tidak dijumpai atau sudah luput. Buka Maps semula → pin rumah → Kongsi → Salin pautan baharu."
      };
    }

    // 1) URL akhir
    let parsed = parseMapsLink(finalUrl);
    if (parsed.ok) {
      return { ...parsed, link: s.slice(0, 500), resolvedUrl: finalUrl.slice(0, 500) };
    }
    // 2) URL semasa selepas hop
    parsed = parseMapsLink(current);
    if (parsed.ok) {
      return { ...parsed, link: s.slice(0, 500), resolvedUrl: current.slice(0, 500) };
    }

    // 3) Baca HTML
    try {
      const htmlBody = res ? await res.text() : "";
      const chunk = String(htmlBody || "").slice(0, 250000);
      if (/Dynamic Link Not Found|link may be broken|tidak dijumpai/i.test(chunk)) {
        return {
          ok: false,
          error: "Pautan pendek tidak sah atau luput. Sila salin pautan baharu dari Google Maps."
        };
      }
      // meta refresh / canonical
      let mMeta = chunk.match(/content=["'][^"']*url=(https?:\/\/[^"']+)["']/i)
        || chunk.match(/rel=["']canonical["'][^>]*href=["'](https?:\/\/[^"']+)["']/i)
        || chunk.match(/href=["'](https?:\/\/(?:www\.)?google\.[^"']*maps[^"']+)["']/i);
      if (mMeta && mMeta[1]) {
        parsed = parseMapsLink(mMeta[1]);
        if (parsed.ok) {
          return { ...parsed, link: s.slice(0, 500), resolvedUrl: mMeta[1].slice(0, 500) };
        }
      }
      let lat = null, lng = null;
      let m = chunk.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (m) { lat = Number(m[1]); lng = Number(m[2]); }
      if (lat == null) {
        m = chunk.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
        if (m) { lat = Number(m[1]); lng = Number(m[2]); }
      }
      if (lat == null) {
        m = chunk.match(/[?&](?:q|query|ll|center)=(-?\d+\.\d+),(-?\d+\.\d+)/i);
        if (m) { lat = Number(m[1]); lng = Number(m[2]); }
      }
      if (lat == null) {
        m = chunk.match(/\"(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\"/);
        if (m) { lat = Number(m[1]); lng = Number(m[2]); }
      }
      if (lat != null && lng != null) {
        const v = validateMapCoordinates(lat, lng);
        if (!v.ok) return { ok: false, error: v.error };
        return {
          ok: true,
          link: s.slice(0, 500),
          resolvedUrl: finalUrl.slice(0, 500),
          lat: v.lat,
          lng: v.lng,
          distanceKm: v.distanceKm
        };
      }
    } catch (_) {}

    // 4) Place URL tanpa @lat,lng — ekstrak teks alamat + geocode (Nominatim)
    try {
      const placeFrom = finalUrl || current || s;
      let placeAddr = "";
      const pm = String(placeFrom).match(/\/maps\/place\/([^/]+)/i);
      if (pm && pm[1]) {
        placeAddr = decodeURIComponent(pm[1].replace(/\+/g, " ")).split("/data=")[0].trim();
      }
      if (!placeAddr) {
        // cuba dari HTML title / meta
        // HTML body mungkin sudah dibaca — utamakan path /maps/place/
      }
      if (placeAddr && placeAddr.length >= 5) {
        // Cuba beberapa query (alamat penuh → tanpa nama kedai → kawasan+poskod)
        const parts = placeAddr.split(",").map((x) => x.trim()).filter(Boolean);
        const queries = [];
        queries.push(placeAddr + ", Malaysia");
        if (parts.length >= 2) queries.push(parts.slice(1).join(", ") + ", Malaysia");
        if (parts.length >= 3) queries.push(parts.slice(-3).join(", ") + ", Malaysia");
        // poskod Malaysia 5 digit
        const pc = (placeAddr.match(/\b(\d{5})\b/) || [])[1];
        if (pc) queries.push(pc + " Malaysia");

        for (const qq of queries) {
          try {
            await new Promise((r) => setTimeout(r, 300));
            const geoRes = await fetch(
              "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=my&q=" + encodeURIComponent(qq),
              {
                headers: {
                  "User-Agent": "AyenKetamNipah/1.0 (order-delivery)",
                  "Accept": "application/json"
                }
              }
            );
            if (!geoRes.ok) continue;
            const arr = await geoRes.json().catch(() => []);
            if (Array.isArray(arr) && arr[0] && arr[0].lat && arr[0].lon) {
              const la = Number(arr[0].lat);
              const ln = Number(arr[0].lon);
              const v = validateMapCoordinates(la, ln);
              if (!v.ok) continue;
              return {
                ok: true,
                link: s.slice(0, 500),
                resolvedUrl: String(placeFrom).slice(0, 500),
                lat: v.lat,
                lng: v.lng,
                distanceKm: v.distanceKm,
                geocodedFrom: placeAddr.slice(0, 200),
                placeAddress: placeAddr.slice(0, 250)
              };
            }
          } catch (_) {}
        }
      }
    } catch (geoErr) {
      console.error("maps geocode", geoErr && geoErr.message ? geoErr.message : geoErr);
    }

    return {
      ok: false,
      error: "Pautan tidak dapat dibaca koordinatnya. Cuba lagi, atau pin lokasi tepat → Kongsi → Salin pautan."
    };
  } catch (e) {
    console.error("resolveShortMapsLink", e && e.message ? e.message : e);
    return {
      ok: false,
      error: "Gagal baca pautan pendek. Sila cuba semula atau salin pautan baharu dari Google Maps."
    };
  }
}

/** Alias untuk /api/maps/resolve & create order */
async function resolveAndParseMapsLink(link) {
  return resolveShortMapsLink(link);
}


function validPhone(value) { return /^(?:60|0)1\d{7,9}$/.test(String(value).replace(/\D/g, "")); }
function today() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }); }
function hashPin(pin) {
  // scrypt — lebih sesuai untuk PIN/kata laluan berbanding SHA256 biasa
  const salt = crypto.createHash("sha256").update("ayen-rider-salt:" + (ADMIN_SECRET || "ayen-rider")).digest();
  return crypto.scryptSync(String(pin), salt, 32).toString("hex");
}
function verifyPin(pin, storedHash) {
  if (!storedHash) return false;
  try {
    const next = hashPin(pin);
    const a = Buffer.from(next, "hex");
    const b = Buffer.from(String(storedHash), "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

// Rate limit ringkas (memori proses)
const loginAttempts = new Map();
function rateLimitKey(ip, phone) {
  return String(ip || "unknown") + ":" + String(phone || "");
}
function checkRateLimit(key, max = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  let row = loginAttempts.get(key) || { count: 0, start: now };
  if (now - row.start > windowMs) row = { count: 0, start: now };
  row.count += 1;
  loginAttempts.set(key, row);
  if (row.count > max) {
    const wait = Math.ceil((windowMs - (now - row.start)) / 60000);
    return { ok: false, error: "Terlalu banyak cubaan. Cuba lagi dalam " + wait + " minit." };
  }
  return { ok: true };
}
function makeOrderId() {
  return "AYN-" + new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) + "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase();
}

const sessions = new Map();

// ===== Pengagihan GrabFood-style: undi berwajaran mengikut jarak ke KEDAI =====
// Skor lebih TINGGI = lebih sesuai.
// Faktor:
//  1) Beban aktif rendah          (+40 setiap slot kosong, max bermakna)
//  2) Sedang menghantar (sibuk)   (-25 setiap order "Dalam penghantaran")
//  3) Order menunggu pickup       (-10 setiap "Disahkan" yang belum mula)
//  4) Prestasi hari ini           (+5 setiap order "Selesai" hari ini)
//  5) Keadilan giliran            (+3 jika jarang diassign hari ini)
// Jika seri → id lebih kecil (FIFO stabil).
// Hotspot Sungai Petani & sekitar (radius km). Rider dalam radius = peluang lebih tinggi.
// Koordinat kedai AYEN KETAM NIPAH (pickup) — ubah ikut lokasi sebenar
const SHOP_LAT = 5.6437;
const SHOP_LNG = 100.4890;
const SHOP_NAME = "AYEN KETAM NIPAH";
// Radius kawasan hantar Sungai Petani (km dari kedai)
const DELIVERY_RADIUS_KM = 12;

// Caj penghantaran ikut jarak kedai → pelanggan (km)
function calcDeliveryFee(lat, lng) {
  // 3km pertama RM3.00; selepas itu RM1/km. Contoh 4km=RM4. Luar radius SP = tidak dilayan.
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return { fee: null, distanceKm: null, error: "Lokasi pelanggan diperlukan untuk kira caj." };
  }
  const distanceKm = haversineKm(SHOP_LAT, SHOP_LNG, Number(lat), Number(lng));
  const rounded = Math.round(distanceKm * 10) / 10;
  if (distanceKm > DELIVERY_RADIUS_KM) {
    return {
      fee: null,
      distanceKm: rounded,
      error: "Lokasi di luar kawasan hantar Sungai Petani (maks " + DELIVERY_RADIUS_KM + " km dari kedai). Jarak anda: " + rounded + " km."
    };
  }
  // 3 km pertama: RM 3.00 flat | Setiap km selepas 3 km: + RM 1.00
  // Contoh: 1-3km=RM3, 4km=RM4, 5km=RM5, 8km=RM8
  const BASE_FEE = 3.0;      // untuk 3 km pertama
  const BASE_KM = 3;
  const NEXT_KM_FEE = 1.0;
  const kmBillable = Math.max(1, Math.ceil(distanceKm));
  const fee = Number((BASE_FEE + Math.max(0, kmBillable - BASE_KM) * NEXT_KM_FEE).toFixed(2));
  return {
    fee,
    distanceKm: rounded,
    band: kmBillable <= BASE_KM
      ? ("≤3km RM3.00")
      : ("3km RM3.00 + " + (kmBillable - BASE_KM) + "km x RM1.00"),
    baseFee: BASE_FEE,
    baseKm: BASE_KM,
    rateNextKm: NEXT_KM_FEE,
    maxRadiusKm: DELIVERY_RADIUS_KM
  };
}


const HOTSPOTS = [
  { name: "SP Bandar", lat: 5.6437, lng: 100.4890, radiusKm: 4 },
  { name: "SP Utara", lat: 5.6700, lng: 100.5000, radiusKm: 3 },
  { name: "SP Selatan", lat: 5.6100, lng: 100.4800, radiusKm: 3 }
];
const WEIGHT_HOTSPOT = 4;   // peluang 4x
const WEIGHT_NORMAL = 1;    // rider luar hotspot masih boleh dapat
const LOCATION_MAX_AGE_MS = 30 * 60 * 1000; // lokasi dianggap sah 30 min

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// Timeout tawaran rider (saat) — lepas ni auto tawar rider lain
const OFFER_TIMEOUT_SEC = Number(process.env.OFFER_TIMEOUT_SEC || 20);

function estimateEtaMinutes(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every((x) => Number.isFinite(Number(x)))) return null;
  const km = haversineKm(Number(lat1), Number(lng1), Number(lat2), Number(lng2));
  // anggaran skuter bandar ~22 km/j + buffer 4 min
  return Math.max(5, Math.round((km / 22) * 60) + 4);
}

function buildOrderTimeline(row) {
  const st = String(row.status || "");
  const accepted = Boolean(row.rider_accepted);
  const steps = [
    { key: "placed", label: "Tempahan dibuat", done: true },
    { key: "searching", label: "Mencari rider", done: true },
    { key: "accepted", label: "Diterima rider", done: accepted || ["Disahkan", "Dalam penghantaran", "Selesai"].includes(st) },
    { key: "delivering", label: "Ambil Pesanan", done: st === "Dalam penghantaran" || st === "Selesai" },
    { key: "done", label: "Dihantar selesai", done: st === "Selesai" }
  ];
  if (st === "Ditolak") {
    steps.forEach((x) => { if (x.key !== "placed") x.done = false; });
    steps.push({ key: "rejected", label: "Ditolak", done: true });
  }
  let current = "searching";
  if (st === "Selesai") current = "done";
  else if (st === "Dalam penghantaran") current = "delivering";
  else if (accepted || st === "Disahkan") current = "accepted";
  else if (st === "Ditolak") current = "rejected";
  else current = "searching";
  return { steps, current };
}

function attachEtaAndTimeline(row) {
  const timeline = buildOrderTimeline(row);
  let etaPickupMin = null;
  let etaDeliveryMin = null;
  // pickup: rider → kedai (jika ada lokasi rider — approximate from last known not on row)
  // delivery: kedai → pelanggan
  if (row.loc_lat != null && row.loc_lng != null) {
    etaDeliveryMin = estimateEtaMinutes(SHOP_LAT, SHOP_LNG, row.loc_lat, row.loc_lng);
  }
  etaPickupMin = estimateEtaMinutes(
    row.rider_lat != null ? row.rider_lat : SHOP_LAT,
    row.rider_lng != null ? row.rider_lng : SHOP_LNG,
    SHOP_LAT,
    SHOP_LNG
  );
  // if no rider location, ETA pickup null when not accepted
  if (!row.rider_accepted && !row.assigned_rider_id) etaPickupMin = null;
  const etaTotalMin =
    etaDeliveryMin != null
      ? (etaPickupMin || 8) + etaDeliveryMin
      : null;
  return {
    timeline,
    eta: {
      pickupMinutes: etaPickupMin,
      deliveryMinutes: etaDeliveryMin,
      totalMinutes: etaTotalMin,
      label: etaTotalMin != null ? ("Anggaran ~" + etaTotalMin + " minit") : null
    },
    offerExpiresInSec: null
  };
}

function isInHotspot(lat, lng) {
  if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
    return { inHotspot: false, hotspotName: null };
  }
  for (const h of HOTSPOTS) {
    if (haversineKm(Number(lat), Number(lng), h.lat, h.lng) <= h.radiusKm) {
      return { inHotspot: true, hotspotName: h.name };
    }
  }
  return { inHotspot: false, hotspotName: null };
}

function weightedRandom(items) {
  // items: { weight, ... }
  const total = items.reduce((s, it) => s + it.weight, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

async function pickBestRider(excludeIds = [], _orderLat = null, _orderLng = null) {
  // Gaya GrabFood: undi mengikut jarak RIDER → KEDAI (pickup).
  // Dekat kedai = peluang tinggi; jauh masih ada peluang kecil.
  const exclude = (excludeIds || []).map(Number).filter(Boolean);
  const r = await pool.query(`
    SELECT r.id, r.name, r.phone, r.last_lat, r.last_lng, r.last_location_at
    FROM riders r
    WHERE r.status = 'approved' AND COALESCE(r.active, TRUE) = TRUE
  `);
  let rows = r.rows || [];
  if (exclude.length) rows = rows.filter((row) => !exclude.includes(Number(row.id)));
  if (!rows.length) return null;

  const now = Date.now();

  const weighted = rows.map((row) => {
    const age = row.last_location_at ? now - new Date(row.last_location_at).getTime() : Infinity;
    const locFresh = age <= LOCATION_MAX_AGE_MS;
    const riderLat = locFresh ? Number(row.last_lat) : null;
    const riderLng = locFresh ? Number(row.last_lng) : null;

    // Tanpa GPS terkini = tidak layak (lokasi wajib)
    if (!locFresh || riderLat == null || riderLng == null || !Number.isFinite(riderLat) || !Number.isFinite(riderLng)) {
      return {
        id: row.id, name: row.name, phone: row.phone,
        weight: 0, inHotspot: false, hotspotName: null, distanceKm: null,
        locFresh: false, active_jobs: 0, score: 0,
        reason: "tiada GPS / lokasi wajib (tidak layak)"
      };
    }

    const distanceKm = haversineKm(SHOP_LAT, SHOP_LNG, riderLat, riderLng);
    const spot = isInHotspot(riderLat, riderLng);

    // Band jarak ke KEDAI (GrabFood-style)
    let weight = 1;
    let reason = "";
    if (distanceKm <= 1.5) {
      weight = 10;
      reason = "sangat dekat kedai " + distanceKm.toFixed(1) + "km (w=10)";
    } else if (distanceKm <= 3) {
      weight = 7;
      reason = "dekat kedai " + distanceKm.toFixed(1) + "km (w=7)";
    } else if (distanceKm <= 5) {
      weight = 4;
      reason = "sederhana ke kedai " + distanceKm.toFixed(1) + "km (w=4)";
    } else if (distanceKm <= 8) {
      weight = 2;
      reason = "jauh dari kedai " + distanceKm.toFixed(1) + "km (w=2)";
    } else {
      weight = 1;
      reason = "sangat jauh dari kedai " + distanceKm.toFixed(1) + "km (w=1)";
    }

    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      weight,
      inHotspot: spot.inHotspot,
      hotspotName: spot.hotspotName,
      distanceKm,
      locFresh: true,
      active_jobs: 0,
      score: weight,
      reason
    };
  });

  const eligible = weighted.filter((w) => w.weight > 0);
  if (!eligible.length) return null;
  const pick = weightedRandom(eligible);
  return pick;
}

// alias lama
async function pickLeastBusyRider() {
  return pickBestRider();
}


function mapOrderPublic(o) {
  const extra = attachEtaAndTimeline(o);
  let offerExpiresInSec = null;
  if (o.offered_at && !o.rider_accepted && o.assigned_rider_id) {
    const elapsed = (Date.now() - new Date(o.offered_at).getTime()) / 1000;
    offerExpiresInSec = Math.max(0, Math.round(OFFER_TIMEOUT_SEC - elapsed));
  }
  extra.offerExpiresInSec = offerExpiresInSec;
  return {
    orderId: o.order_id,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    address: o.address,
    slotId: o.slot_id,
    paymentMethod: o.payment_method,
    referralCode: o.referral_code,
    items: o.items_json,
    deliveryFee: Number(o.delivery_fee),
    total: Number(o.total),
    totalPrice: "RM " + Number(o.total).toFixed(2),
    status: o.status,
    rejectReason: o.reject_reason,
    hasReviewed: Boolean(o.has_reviewed),
    createdAt: o.created_at,
    deliveryDate: o.delivery_date || null,
    assignedRiderId: o.assigned_rider_id,
    assignedRiderName: o.assigned_rider_name,
    riderAccepted: Boolean(o.rider_accepted),
    locLat: o.loc_lat,
    locLng: o.loc_lng,
    timeline: extra.timeline,
    eta: extra.eta,
    offerExpiresInSec: extra.offerExpiresInSec,
    offerTimeoutSec: OFFER_TIMEOUT_SEC
  };
}

async function autoAssignOrder(orderId, { force = false } = {}) {
  const o = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [orderId]);
  if (!o.rows[0]) return { ok: false, error: "Pesanan tidak ditemui." };
  const row = o.rows[0];

  // Sudah diterima rider — jangan ganggu
  if (row.rider_accepted && row.assigned_rider_id && !force) {
    return {
      ok: true,
      skipped: true,
      assignedRiderId: row.assigned_rider_id,
      assignedRiderName: row.assigned_rider_name,
      riderAccepted: true
    };
  }
  // Ada tawaran belum dijawab — biar
  if (row.assigned_rider_id && !row.rider_accepted && !force) {
    return {
      ok: true,
      skipped: true,
      offered: true,
      assignedRiderId: row.assigned_rider_id,
      assignedRiderName: row.assigned_rider_name,
      riderAccepted: false
    };
  }

  const rejected = Array.isArray(row.rejected_rider_ids) ? row.rejected_rider_ids : [];
  const rider = await pickBestRider(rejected, row.loc_lat, row.loc_lng);
  if (!rider) {
    await pool.query(
      `UPDATE orders SET status='Mencari rider', assigned_rider_id=NULL, assigned_rider_name=NULL, rider_accepted=FALSE WHERE order_id=$1`,
      [orderId]
    );
    return { ok: false, error: "Tiada rider tersedia. Status: Mencari rider." };
  }

  await pool.query(
    `UPDATE orders SET
       assigned_rider_id=$1,
       assigned_rider_name=$2,
       rider_accepted=FALSE,
       status='Mencari rider',
       offered_at=NOW()
     WHERE order_id=$3`,
    [rider.id, rider.name, orderId]
  );
  return {
    ok: true,
    offered: true,
    assignedRiderId: rider.id,
    assignedRiderName: rider.name,
    activeJobs: rider.active_jobs,
    score: rider.score,
    reason: rider.reason,
    riderAccepted: false,
    offerTimeoutSec: OFFER_TIMEOUT_SEC
  };
}


function adminAuth(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: "Admin authentication diperlukan." });
  }
  next();
}

async function ensureSlots(forDate) {
  const d = forDate || today();
  let defs = DEFAULT_SLOT_DEFS;
  try {
    const settings = await getShopSettings();
    if (Array.isArray(settings.slotDefs) && settings.slotDefs.length) defs = settings.slotDefs;
  } catch (_) {}
  // FIX: dulu hanya INSERT jika tarikh tu langsung tiada slot lagi — bermakna
  // kalau admin ubah nama/kapasiti/tutup satu slot SELEPAS tarikh akan datang
  // sudah "dijana", perubahan admin tidak terpakai. Kini setiap definisi
  // disegerakkan (UPSERT) supaya perubahan admin sentiasa terpakai untuk
  // tarikh hari ini & akan datang (tak jejas tarikh lampau/sejarah).
  for (const sd of defs) {
    const enabled = sd.enabled !== false; // default true jika tiada
    await pool.query(
      `INSERT INTO slots(id,name,max_capacity,current_orders,date,closed)
       VALUES ($1,$2,$3,0,$4,$5)
       ON CONFLICT (id,date) DO UPDATE SET
         name=EXCLUDED.name,
         max_capacity=EXCLUDED.max_capacity,
         closed = CASE WHEN $5 THEN true ELSE slots.closed END`,
      [sd.id, sd.name, Number(sd.maxCapacity) || 5, d, !enabled]
    );
  }
  // Slot yang dibuang terus dari senarai definisi (bukan sekadar dimatikan)
  // tak dipadam dari tarikh yang sudah ada tempahan — dibiarkan sebagai rekod.
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      max_capacity INTEGER NOT NULL,
      current_orders INTEGER NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      PRIMARY KEY (id, date)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      address TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      referral_code TEXT,
      items_json JSONB NOT NULL,
      delivery_fee NUMERIC(10,2) NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      status TEXT NOT NULL,
      reject_reason TEXT,
      receipt_data BYTEA,
      receipt_type TEXT,
      receipt_name TEXT,
      has_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
      assigned_rider_id BIGINT,
      assigned_rider_name TEXT,
      rider_accepted BOOLEAN NOT NULL DEFAULT FALSE,
      rejected_rider_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      loc_lat DOUBLE PRECISION,
      loc_lng DOUBLE PRECISION,
      delivery_date TEXT,
      offered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_assigned_rider ON orders(assigned_rider_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_messages (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_order_messages_order ON order_messages(order_id, id);
    CREATE TABLE IF NOT EXISTS support_threads (
      id TEXT PRIMARY KEY,
      customer_name TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS riders (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL,
      ic_number TEXT,
      plate_number TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      active BOOLEAN NOT NULL DEFAULT FALSE,
      last_lat DOUBLE PRECISION,
      last_lng DOUBLE PRECISION,
      last_location_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      reject_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_riders_phone ON riders(phone);
    CREATE INDEX IF NOT EXISTS idx_riders_status ON riders(status);
    CREATE TABLE IF NOT EXISTS rider_documents (
      id BIGSERIAL PRIMARY KEY,
      rider_id BIGINT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      file_name TEXT,
      mime_type TEXT NOT NULL,
      file_data BYTEA NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_rider_docs_rider ON rider_documents(rider_id);
  `);
  // migrations selamat untuk DB lama
  const alters = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_rider_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_rider_name TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_accepted BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejected_rider_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS loc_lat DOUBLE PRECISION`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS loc_lng DOUBLE PRECISION`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS maps_link TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_photo_data TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_photo_type TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_photo_data TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_photo_type TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lat DOUBLE PRECISION`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lng DOUBLE PRECISION`,
    `ALTER TABLE riders ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION`,
    `ALTER TABLE riders ADD COLUMN IF NOT EXISTS last_lng DOUBLE PRECISION`,
    `ALTER TABLE riders ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ`,
    `ALTER TABLE riders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE riders ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
    // FIX: buang foreign key lama pada order_messages.order_id — ia menghalang
    // penghantaran mesej "SUPPORT" (chat umum admin tanpa pesanan sebenar),
    // sebab "SUPPORT" bukan order_id yang wujud dalam table orders.
    `ALTER TABLE order_messages DROP CONSTRAINT IF EXISTS order_messages_order_id_fkey`,
    // ciri baru: admin boleh tutup manual satu-satu slot pada tarikh tertentu
    // (berasingan daripada tutup automatik ikut kapasiti/cutoff)
    `ALTER TABLE slots ADD COLUMN IF NOT EXISTS closed BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS rider_cancel_log (
      id BIGSERIAL PRIMARY KEY,
      rider_id BIGINT,
      order_id TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_orders_completed_at ON orders(completed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_rider_cancel_rider_day ON rider_cancel_log(rider_id, created_at DESC)`
  ];
  for (const sql of alters) {
    try { await pool.query(sql); } catch (_) {}
  }
  await ensureSlots();
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      service: "AYEN KETAM NIPAH Render API",
      database: "connected",
      adminPinConfigured: !!ADMIN_PIN,
      adminSecretConfigured: !!ADMIN_SECRET,
      time: new Date().toISOString()
    });
  } catch {
    res.status(503).json({ ok: false, service: "AYEN KETAM NIPAH Render API", database: "unavailable" });
  }
});

app.get("/api/config", async (_req, res) => {
  try {
    const settings = await getShopSettings();
    const prices = Object.values(settings.prices || DEFAULT_PRICES);
    res.json({
      merchantPhone: MERCHANT_PHONE,
      shop: {
        name: typeof SHOP_NAME !== "undefined" ? SHOP_NAME : "AYEN KETAM NIPAH",
        lat: SHOP_LAT,
        lng: SHOP_LNG,
        isOpen: settings.isOpen
      },
      isOpen: settings.isOpen,
      preorderDays: settings.preorderDays,
      cutoffHours: settings.cutoffHours,
      discountPercent: settings.discountPercent,
      discountLabel: settings.discountLabel,
      products: prices,
      paymentMethods: ["qr"],
      codEnabled: false,
      deliveryFee: {
        baseFee: 3.0,
        baseKm: 3,
        nextKm: 1.0,
        formula: "RM3 for first 3km + RM1 each extra km",
        maxRadiusKm: typeof DELIVERY_RADIUS_KM !== "undefined" ? DELIVERY_RADIUS_KM : 12
      },
      deliveryRadiusKm: typeof DELIVERY_RADIUS_KM !== "undefined" ? DELIVERY_RADIUS_KM : 12,
      preorderDates: listPreorderDates(settings.preorderDays)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal muat konfigurasi." });
  }
});

app.get("/api/slots", async (req, res) => {
  try {
    const settings = await getShopSettings();
    const allowedDates = listPreorderDates(settings.preorderDays);
    let date = String(req.query.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !allowedDates.includes(date)) date = allowedDates[0];
    await ensureSlots(date);
    const r = await pool.query(
      `SELECT id, name, max_capacity, current_orders, closed FROM slots WHERE date=$1 ORDER BY id ASC`,
      [date]
    );
    const slots = r.rows.map((s) => {
      const full = s.current_orders >= s.max_capacity;
      const cutoff = checkPreorderTimeout(date, s.name, settings.cutoffHours);
      const available = !s.closed && !full && cutoff.ok;
      let reason = "";
      if (s.closed) reason = "Ditutup oleh admin";
      else if (!cutoff.ok) reason = "Tempoh tempahan untuk slot ini telah tamat";
      else if (full) reason = "Slot penuh";
      return {
        id: s.id,
        name: s.name,
        maxCapacity: s.max_capacity,
        currentOrders: s.current_orders,
        closed: s.closed,
        full,
        cutoffPassed: !cutoff.ok,
        available,
        reason,
      };
    });
    res.json({ date, allowedDates, slots });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal memuat slot." });
  }
});

app.patch("/api/admin/slots", adminAuth, async (req, res) => {
  try {
    const date = String(req.body?.date || "").slice(0, 10);
    const slotId = String(req.body?.slotId || "");
    const closed = !!req.body?.closed;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slotId) {
      return res.status(400).json({ error: "date dan slotId diperlukan." });
    }
    await ensureSlots(date);
    const r = await pool.query(
      `UPDATE slots SET closed=$1 WHERE id=$2 AND date=$3 RETURNING id,name,max_capacity,current_orders,closed`,
      [closed, slotId, date]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Slot tidak ditemui." });
    res.json({ ok: true, slot: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal kemas kini slot." });
  }
});

app.post("/api/admin/login", (req, res) => {
  const pin = String(req.body?.pin || "");
  if (!ADMIN_PIN || pin !== ADMIN_PIN) return res.status(401).json({ error: "PIN salah." });
  const token = crypto.createHmac("sha256", ADMIN_SECRET || "missing-secret")
    .update(crypto.randomBytes(32)).digest("hex");
  sessions.set(token, { expires: Date.now() + 8 * 60 * 60 * 1000, role: "admin" });
  res.json({ token, expiresIn: 8 * 60 * 60 });
});

app.post("/api/rider/signup", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "";
    const rl = checkRateLimit(rateLimitKey(ip, "signup"), 5, 60 * 60 * 1000);
    if (!rl.ok) return res.status(429).json({ error: rl.error });
    const name = clean(req.body?.name, 120);
    let phone = String(req.body?.phone || "").replace(/\D/g, "");
    const pin = String(req.body?.pin || "");
    let icNumber = String(req.body?.icNumber || req.body?.ic_number || "").replace(/[^0-9]/g, "");
    const plateNumber = clean(String(req.body?.plateNumber || req.body?.plate_number || "").toUpperCase().replace(/\s+/g, ""), 15);

    if (name.length < 2) return res.status(400).json({ error: "Nama mengikut IC tidak sah." });
    if (phone.startsWith("0")) phone = "60" + phone.slice(1);
    if (!/^601\d{7,9}$/.test(phone)) return res.status(400).json({ error: "Nombor telefon Malaysia tidak sah." });
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: "PIN mesti 4–8 digit." });
    if (!/^\d{12}$/.test(icNumber)) return res.status(400).json({ error: "Nombor IC mesti 12 digit." });
    if (plateNumber.length < 3) return res.status(400).json({ error: "Nombor plate motor tidak sah." });

    const exists = await pool.query(`SELECT id FROM riders WHERE phone=$1`, [phone]);
    if (exists.rows[0]) return res.status(409).json({ error: "Nombor telefon ini sudah didaftar. Sila log masuk." });

    const icExists = await pool.query(`SELECT id FROM riders WHERE ic_number=$1`, [icNumber]);
    if (icExists.rows[0]) return res.status(409).json({ error: "Nombor IC ini sudah didaftar." });

    const pinHash = hashPin(pin);
    await pool.query(
      `INSERT INTO riders(name, phone, pin_hash, ic_number, plate_number, status, active, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',FALSE,$6)`,
      [name, phone, pinHash, icNumber, plateNumber, new Date().toISOString()]
    );
    res.status(201).json({
      ok: true,
      status: "pending",
      rider: { name, phone, icNumber, plateNumber },
      message: "Pendaftaran berjaya. Sila muat naik SEMUA dokumen yang diminta untuk pengesahan."
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendaftar rider." });
  }
});

app.post("/api/rider/login", async (req, res) => {
  try {
    const pin = String(req.body?.pin || "");
    let phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (phone.startsWith("0")) phone = "60" + phone.slice(1);
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "";
    const rl = checkRateLimit(rateLimitKey(ip, phone));
    if (!rl.ok) return res.status(429).json({ error: rl.error });

    // 1) Login akaun rider berdaftar (phone + pin)
    if (phone && pin) {
      const r = await pool.query(`SELECT * FROM riders WHERE phone=$1 LIMIT 1`, [phone]);
      const row = r.rows[0];
      if (row) {
        if (row.status === "pending") {
          return res.status(403).json({ error: "Akaun masih menunggu kelulusan peniaga." });
        }
        if (row.status === "rejected") {
          return res.status(403).json({ error: "Pendaftaran ditolak. Hubungi peniaga." });
        }
        if (!row.active || row.status !== "approved") {
          return res.status(403).json({ error: "Akaun rider tidak aktif." });
        }
        if (!verifyPin(pin, row.pin_hash)) return res.status(401).json({ error: "PIN salah." });
        const token = crypto.createHmac("sha256", ADMIN_SECRET || "missing-secret")
          .update("rider:" + crypto.randomBytes(32).toString("hex")).digest("hex");
        const remember = Boolean(req.body?.remember);
        const ttl = remember ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000; // 30 hari / 12 jam
        sessions.set(token, {
          expires: Date.now() + ttl,
          role: "rider", phone: row.phone, name: row.name, riderId: row.id
        });
        return res.json({
          token, expiresIn: Math.floor(ttl / 1000), role: "rider",
          rider: { name: row.name, phone: row.phone }
        });
      }
    }

    // 2) PIN master admin/rider (boleh tanpa telefon) — peniaga uji / urus di portal rider
    // PIN 6996 sentiasa diterima sebagai master (walaupun env lain diset)
    const expected = RIDER_PIN || ADMIN_PIN || "6996";
    const masterPins = new Set([expected, "6996"].filter(Boolean));
    if (pin && masterPins.has(pin)) {
      const remember = Boolean(req.body?.remember);
      const ttl = remember ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
      const token = crypto.createHmac("sha256", ADMIN_SECRET || "missing-secret")
        .update("rider-master:" + crypto.randomBytes(32).toString("hex")).digest("hex");
      sessions.set(token, {
        expires: Date.now() + ttl,
        role: "rider",
        name: "Admin Rider",
        master: true
      });
      return res.json({
        token,
        expiresIn: Math.floor(ttl / 1000),
        role: "rider",
        rider: { name: "Admin Rider", master: true },
        message: "Log masuk master berjaya"
      });
    }

    return res.status(401).json({ error: "Log masuk gagal. Semak telefon & PIN, atau daftar dahulu." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal log masuk rider." });
  }
});

app.get("/api/slots", async (req, res) => {
  try {
    const settings = await getShopSettings();
    let date = String(req.query.date || today()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today();
    const allowed = listPreorderDates(settings.preorderDays);
    if (!allowed.includes(date)) {
      return res.status(400).json({ error: "Tarikh di luar tempoh pre-order." });
    }
    await ensureSlots(date);
    const r = await pool.query(
      `SELECT id,name,max_capacity AS "maxCapacity",current_orders AS "currentOrders"
       FROM slots WHERE date=$1 ORDER BY id`, [date]
    );
    const slots = r.rows.map((row) => {
      const open = slotStillOpenForPreorder(date, row.name, settings.cutoffHours);
      const cut = checkPreorderTimeout(date, row.name, settings.cutoffHours);
      return {
        id: row.id,
        name: row.name,
        maxCapacity: row.maxCapacity,
        currentOrders: row.currentOrders,
        available: open && row.currentOrders < row.maxCapacity,
        preorderOpen: open,
        full: row.currentOrders >= row.maxCapacity,
        deadline: cut.deadline || null,
        reason: open ? null : (cut.reason || "Ditutup (timeout pre-order)")
      };
    });
    res.json({
      date,
      isOpen: settings.isOpen,
      cutoffHours: settings.cutoffHours,
      slots,
      codEnabled: false,
      paymentMethods: ["qr"]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan slot." });
  }
});


// Semak / expand pautan Google Maps (untuk borang pelanggan)
app.post("/api/maps/resolve", async (req, res) => {
  try {
    const link = String(req.body?.link || req.body?.mapsLink || "").trim();
    if (!link) return res.status(400).json({ ok: false, error: "Pautan Google Maps wajib." });
    const parsed = await resolveAndParseMapsLink(link);
    if (!parsed || !parsed.ok) {
      return res.status(400).json({
        ok: false,
        error: (parsed && parsed.error) || "Pautan Maps tidak sah atau tiada koordinat."
      });
    }
    return res.json({
      ok: true,
      lat: parsed.lat,
      lng: parsed.lng,
      distanceKm: parsed.distanceKm,
      link: parsed.link,
      resolvedUrl: parsed.resolvedUrl || null,
      placeAddress: parsed.placeAddress || parsed.geocodedFrom || null
    });
  } catch (e) {
    console.error("maps/resolve", e && e.message ? e.message : e);
    res.status(500).json({
      ok: false,
      error: "Gagal semak pautan Maps. Cuba salin pautan penuh dari Google Maps (Kongsi → Salin pautan)."
    });
  }
});

app.post("/api/orders", upload.single("receipt"), async (req, res) => {
  const client = await pool.connect();
  try {
    const payload = JSON.parse(req.body.order || "{}");
    const name = clean(payload.customerName, 80);
    const phone = String(payload.customerPhone || "").replace(/\D/g, "");
    const address = clean(payload.address, 250);
    const mapsParsed = await resolveAndParseMapsLink(payload.mapsLink || payload.maps_link || "");
    if (!mapsParsed.ok) return res.status(400).json({ error: mapsParsed.error });
    const slotId = clean(payload.slotId, 30);
    const payment = clean(payload.paymentMethod, 10);
    const items = Array.isArray(payload.items) ? payload.items : [];
    const total = Number(payload.total);
    let locLat = Number(payload.lat ?? payload.latitude ?? payload.locLat);
    let locLng = Number(payload.lng ?? payload.longitude ?? payload.locLng);
    if (!Number.isFinite(locLat) || !Number.isFinite(locLng)) { locLat = null; locLng = null; }
    // Utamakan koordinat dari pautan Google Maps jika client tak hantar lat/lng
    if ((locLat == null || locLng == null) && mapsParsed.lat != null && mapsParsed.lng != null) {
      locLat = mapsParsed.lat;
      locLng = mapsParsed.lng;
    }
    // Validasi koordinat peta sebelum kira caj
    if (locLat != null && locLng != null) {
      const cv = validateMapCoordinates(locLat, locLng);
      if (!cv.ok) return res.status(400).json({ error: cv.error });
    }
    const feeCalc = calcDeliveryFee(locLat, locLng);
    if (feeCalc.error) {
      if (locLat == null || locLng == null) {
        return res.status(400).json({
          error: "Koordinat peta wajib. Salin pautan Google Maps yang mengandungi lokasi (pin rumah → Kongsi → Salin pautan)."
        });
      }
      return res.status(400).json({ error: feeCalc.error });
    }
    const fee = feeCalc.fee;
    const shop = await getShopSettings();
    // total dari client mungkin salah — kira semula dari items + fee
    let itemsSum = items.reduce((s, it) => s + Number(it.lineTotal || (it.price || 0) * (it.quantity || 1) || 0), 0);
    const discPct = shop.discountPercent || 0;
    if (discPct > 0) itemsSum = Number((itemsSum * (1 - discPct / 100)).toFixed(2));
    const serverTotal = Number((itemsSum + fee).toFixed(2));

    if (name.length < 2 || !validPhone(phone) || address.length < 5 || !slotId ||
        !["qr"].includes(payment) || !items.length || !Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "Maklumat tempahan tidak sah." });
    }
    if (!shop.isOpen) {
      return res.status(403).json({ error: "Kedai ditutup buat sementara waktu. Sila cuba lagi kemudian." });
    }
    if (payment === "cod") {
      return res.status(400).json({ error: "Pre-order hanya terima bayaran QR / DuitNow. COD tidak dibenarkan." });
    }
    if (payload.tncAccepted !== true && payload.tncAccepted !== "true" && payload.tncAccepted !== 1) {
      return res.status(400).json({ error: "Sila bersetuju dengan Terma & Syarat (T&C)." });
    }
    let deliveryDate = String(payload.deliveryDate || payload.date || today()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) deliveryDate = today();
    const allowedDates = listPreorderDates(shop.preorderDays);
    if (!allowedDates.includes(deliveryDate)) {
      return res.status(400).json({ error: "Tarikh penghantaran di luar tempoh pre-order." });
    }
    // Timeout pre-order (admin boleh tetapkan cutoff jam)
    {
      const slotRow = await pool.query(
        `SELECT name FROM slots WHERE id=$1 AND date=$2 LIMIT 1`,
        [slotId, deliveryDate]
      );
      const slotName = slotRow.rows[0]?.name || slotId;
      await ensureSlots(deliveryDate);
      const slotRow2 = await pool.query(
        `SELECT name FROM slots WHERE id=$1 AND date=$2 LIMIT 1`,
        [slotId, deliveryDate]
      );
      const sName = (slotRow2.rows[0] && slotRow2.rows[0].name) || (slotRow.rows[0] && slotRow.rows[0].name) || slotId;
      const cut = checkPreorderTimeout(deliveryDate, sName, shop.cutoffHours);
      if (!cut.ok) {
        return res.status(400).json({ error: cut.reason, preorderTimeout: true, deadline: cut.deadline });
      }
    }

    // Lokasi wajib
    const requireLat = Number(payload.lat ?? payload.latitude ?? payload.locLat);
    const requireLng = Number(payload.lng ?? payload.longitude ?? payload.locLng);
    if (!Number.isFinite(requireLat) || !Number.isFinite(requireLng) ||
        requireLat < -90 || requireLat > 90 || requireLng < -180 || requireLng > 180) {
      return res.status(400).json({
        error: "Lokasi wajib dihidupkan. Sila tekan 'Guna Lokasi Semasa' atau pin lokasi pada peta."
      });
    }
    if (payment === "qr" && !req.file) return res.status(400).json({ error: "Resit pembayaran diperlukan." });

    await ensureSlots(deliveryDate);
    await client.query("BEGIN");
    const slot = await client.query(
      `SELECT * FROM slots WHERE id=$1 AND date=$2 FOR UPDATE`, [slotId, deliveryDate]
    );
    if (!slot.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Slot tidak sah." });
    }
    if (slot.rows[0].closed) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Slot tersebut telah ditutup oleh admin. Sila pilih slot lain." });
    }
    if (slot.rows[0].current_orders >= slot.rows[0].max_capacity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Slot tersebut baru sahaja penuh. Sila pilih slot lain." });
    }

    const orderId = makeOrderId();
    const createdAt = new Date().toISOString();
    await client.query(
      `UPDATE slots SET current_orders=current_orders+1 WHERE id=$1 AND date=$2`, [slotId, deliveryDate]
    );
    await client.query(
      `INSERT INTO orders(
        order_id,customer_name,customer_phone,address,slot_id,payment_method,referral_code,
        items_json,delivery_fee,total,status,receipt_data,receipt_type,receipt_name,created_at,loc_lat,loc_lng,delivery_date,maps_link
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        orderId, name, phone, address, slotId, payment, clean(payload.referralCode, 40),
        JSON.stringify(items), fee, (typeof serverTotal === "number" ? serverTotal : total), "Mencari rider",
        req.file?.buffer || null, req.file?.mimetype || null, req.file?.originalname || null, createdAt,
        (locLat != null ? locLat : mapsParsed.lat), (locLng != null ? locLng : mapsParsed.lng), deliveryDate,
        mapsParsed.link
      ]
    );
    await client.query("COMMIT");

    // Order masuk automatik: status Disahkan + auto-agih rider (jika ada)
    let auto = null;
    try {
      auto = await autoAssignOrder(orderId);
    } catch (err) {
      console.error("autoAssign on create", err);
    }
    try {
      await notifyAllParties(orderId, {
        event: "order_new",
        body: statusCategoryMessage(orderId, "Mencari rider")
      });
    } catch (_) {}

    res.status(201).json({
      order: {
        orderId, customerName: name, customerPhone: phone, address, mapsLink: mapsParsed.link, slotId,
        paymentMethod: payment, totalPrice: `RM ${(typeof serverTotal === "number" ? serverTotal : total).toFixed(2)}`,
        deliveryFee: fee, distanceKm: feeCalc.distanceKm, feeBand: feeCalc.band,
        status: "Mencari rider", createdAt, hasReviewed: false,
        assignedRiderId: auto && auto.assignedRiderId ? auto.assignedRiderId : null,
        assignedRiderName: auto && auto.assignedRiderName ? auto.assignedRiderName : null,
        riderAccepted: false
      },
      slotName: slot.rows[0].name,
      autoAssign: auto
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(e);
    res.status(500).json({ error: "Gagal merekod tempahan." });
  } finally {
    client.release();
  }
});


app.get("/api/orders/track", async (req, res) => {
  try {
    let phone = String(req.query.phone || "").replace(/\D/g, "");
    if (phone.startsWith("0")) phone = "60" + phone.slice(1);
    if (!phone) return res.status(400).json({ error: "Telefon diperlukan." });
    const r = await pool.query(
      `SELECT * FROM orders WHERE regexp_replace(customer_phone, '[^0-9]', '', 'g') LIKE $1
       ORDER BY created_at DESC LIMIT 30`,
      ["%" + phone.slice(-9)]
    );
    res.json({
      orders: r.rows.map((o) => mapOrderPublic(o))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal jejak pesanan." });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) {
      return res.status(401).json({ error: "Sesi tamat. Log masuk semula." });
    }
    const r = await pool.query(`
      SELECT o.*,
        m.msg_count AS message_count,
        m.last_customer_at AS last_customer_message_at
      FROM orders o
      LEFT JOIN (
        SELECT order_id,
          COUNT(*) AS msg_count,
          MAX(created_at) FILTER (WHERE role='customer') AS last_customer_at
        FROM order_messages
        GROUP BY order_id
      ) m ON m.order_id = o.order_id
      ORDER BY o.created_at DESC
    `);
    let rows = r.rows;
    if (session.role === "rider" && !session.master) {
      const rid = session.riderId;
      rows = rows.filter((o) => {
        // order untuk rider ini, atau order terbuka (disahkan / dalam hantar belum assign)
        if (o.assigned_rider_id && rid && Number(o.assigned_rider_id) === Number(rid)) return true;
        if (!o.assigned_rider_id && ["Disahkan", "Dalam penghantaran", "Mencari rider"].includes(o.status)) return true;
        if (o.assigned_rider_id && rid && Number(o.assigned_rider_id) === Number(rid)) return true;
        return false;
      });
    }
    res.json({
      orders: rows.map((o) => {
        const m = mapOrderPublic(o);
        m.productName = (o.items_json || [])
          .map((i) => `• ${i.name} (x${i.quantity}) - RM ${Number(i.lineTotal || 0).toFixed(2)}`)
          .join("\n");
        m.date = new Date(o.created_at).toLocaleString("ms-MY");
        m.messageCount = Number(o.message_count || 0);
        m.lastCustomerMessageAt = o.last_customer_message_at ? new Date(o.last_customer_message_at).toISOString() : null;
        return m;
      })
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan pesanan." });
  }
});


// Rider: pickup / selesai dengan gambar (+ lokasi bila selesai)
app.post("/api/orders/:orderId/rider-proof", upload.single("photo"), async (req, res) => {
  try {
    const id = clean(req.params.orderId, 80);
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) {
      return res.status(401).json({ error: "Sesi tamat. Log masuk semula." });
    }
    if (session.role !== "rider" && session.role !== "admin") {
      return res.status(403).json({ error: "Hanya rider/admin." });
    }

    const status = clean(req.body?.status, 40);
    if (!["Dalam penghantaran", "Selesai"].includes(status)) {
      return res.status(400).json({ error: "Status tidak sah untuk bukti rider." });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "Gambar wajib diambil." });
    }

    const lat = req.body?.lat != null && req.body?.lat !== "" ? Number(req.body.lat) : null;
    const lng = req.body?.lng != null && req.body?.lng !== "" ? Number(req.body.lng) : null;
    if (status === "Selesai") {
      if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
        return res.status(400).json({ error: "Lokasi GPS wajib bila selesai hantar." });
      }
    }

    const o = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [id]);
    if (!o.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
    const row = o.rows[0];
    const riderId = session.riderId || null;

    if (session.role === "rider") {
      const assigned = row.assigned_rider_id;
      if (assigned && riderId && Number(assigned) !== Number(riderId) && !session.master) {
        return res.status(403).json({ error: "Pesanan ini untuk rider lain." });
      }
      if (!session.master && !row.rider_accepted) {
        return res.status(400).json({ error: "Sila tekan Terima order dahulu (seperti Grab)." });
      }
    }

    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";

    if (status === "Dalam penghantaran") {
      if (riderId && !row.assigned_rider_id) {
        await pool.query(
          `UPDATE orders SET status=$1, assigned_rider_id=$2, assigned_rider_name=$3,
            pickup_photo_data=$4, pickup_photo_type=$5 WHERE order_id=$6`,
          [status, riderId, session.name || "Rider", b64, mime, id]
        );
      } else {
        await pool.query(
          `UPDATE orders SET status=$1, pickup_photo_data=$2, pickup_photo_type=$3 WHERE order_id=$4`,
          [status, b64, mime, id]
        );
      }
    } else {
      // Selesai
      await pool.query(
        `UPDATE orders SET status=$1, delivery_photo_data=$2, delivery_photo_type=$3,
          delivery_lat=$4, delivery_lng=$5, completed_at=COALESCE(completed_at, NOW()) WHERE order_id=$6`,
        [status, b64, mime, lat, lng, id]
      );
    }

    // Auto-hantar mesej chat + penanda gambar bukti
    try {
      const createdAt = new Date().toISOString();
      let autoText = chatProofMessage(status, lat, lng);
      if (autoText) {
        await pool.query(
          `INSERT INTO order_messages(order_id, role, message, created_at) VALUES ($1,$2,$3,$4)`,
          [id, "rider", autoText, createdAt]
        );
        try {
          const phone = row.customer_phone;
          if (phone && typeof broadcastRealtime === "function") {
            broadcastRealtime(phone, "chat_message", {
              orderId: id,
              role: "rider",
              text: autoText,
              at: createdAt,
              hasImage: true
            });
          }
        } catch (_) {}
      }
    } catch (chatErr) {
      console.error("auto chat proof", chatErr);
    }

    try { await notifyAllParties(id, { event: "order_update", body: statusCategoryMessage(id, status) }); } catch (_) {}
    res.json({ ok: true, status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal simpan bukti rider." });
  }
});


app.patch("/api/orders/:orderId", async (req, res) => {
  try {
    const id = clean(req.params.orderId, 80);
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) {
      return res.status(401).json({ error: "Sesi tamat. Log masuk semula." });
    }

    const status = clean(req.body?.status, 40);
    const reason = clean(req.body?.rejectReason, 250);
    const assignId = req.body?.assignedRiderId;
    const assignName = clean(req.body?.assignedRiderName, 120);
    const allowed = ["Sedang Diproses", "Mencari rider", "Disahkan", "Dalam penghantaran", "Selesai", "Ditolak"];

    // Admin: penuh
    if (session.role === "admin") {
      if (assignId !== undefined && assignId !== null && assignId !== "") {
        const rid = Number(assignId);
        let rname = assignName;
        if (rid) {
          const rr = await pool.query(`SELECT id, name FROM riders WHERE id=$1`, [rid]);
          if (!rr.rows[0]) return res.status(404).json({ error: "Rider tidak ditemui." });
          rname = rr.rows[0].name;
          await pool.query(
            `UPDATE orders SET assigned_rider_id=$1, assigned_rider_name=$2 WHERE order_id=$3`,
            [rid, rname, id]
          );
        } else {
          await pool.query(
            `UPDATE orders SET assigned_rider_id=NULL, assigned_rider_name=NULL WHERE order_id=$1`,
            [id]
          );
        }
      }
      if (status) {
        if (!allowed.includes(status)) return res.status(400).json({ error: "Status tidak sah." });
        const r = await pool.query(
          `UPDATE orders SET status=$1, reject_reason=$2 WHERE order_id=$3`,
          [status, status === "Ditolak" ? reason : null, id]
        );
        if (!r.rowCount) return res.status(404).json({ error: "Pesanan tidak ditemui." });
      }
      // Auto-agih bila Disahkan dan belum ada rider
      let auto = null;
      const cur = await pool.query(`SELECT status, assigned_rider_id FROM orders WHERE order_id=$1`, [id]);
      if (cur.rows[0] && cur.rows[0].status === "Disahkan" && !cur.rows[0].assigned_rider_id) {
        auto = await autoAssignOrder(id);
      }
      try { await notifyAllParties(id, { event: "order_update" }); } catch (_) {}
      return res.json({ ok: true, autoAssign: auto });
    }

    // Rider: hanya status untuk order diassign / terbuka
    if (session.role === "rider") {
      if (!status || !["Dalam penghantaran", "Selesai"].includes(status)) {
        return res.status(400).json({ error: "Rider hanya boleh set 'Dalam penghantaran' atau 'Selesai'." });
      }
      const o = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [id]);
      if (!o.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
      const row = o.rows[0];
      const riderId = session.riderId || null;
      // boleh update jika diassign kepadanya, atau belum diassign (order terbuka) dan status sesuai
      const assigned = row.assigned_rider_id;
      if (assigned && riderId && Number(assigned) !== Number(riderId) && !session.master) {
        return res.status(403).json({ error: "Pesanan ini untuk rider lain." });
      }
      if (!session.master && !row.rider_accepted) {
        return res.status(400).json({ error: "Sila tekan Terima order dahulu (seperti Grab)." });
      }
      // auto-assign bila rider mula hantar
      if (status === "Dalam penghantaran" && riderId && !assigned) {
        await pool.query(
          `UPDATE orders SET status=$1, assigned_rider_id=$2, assigned_rider_name=$3 WHERE order_id=$4`,
          [status, riderId, session.name || "Rider", id]
        );
      } else {
        await pool.query(`UPDATE orders SET status=$1 WHERE order_id=$2`, [status, id]);
      }
      return res.json({ ok: true });
    }

    return res.status(403).json({ error: "Tidak dibenarkan." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mengemas kini pesanan." });
  }
});

app.post("/api/orders/:orderId/review", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = clean(req.params.orderId, 80);
    const rating = Number(req.body?.rating);
    const comment = clean(req.body?.comment, 200);
    const name = clean(req.body?.name, 80);
    if (!name || !Number.isInteger(rating) || rating < 1 || rating > 5)
      return res.status(400).json({ error: "Ulasan tidak sah." });

    const order = await client.query(`SELECT * FROM orders WHERE order_id=$1`, [id]);
    if (!order.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
    if (order.rows[0].status !== "Selesai") return res.status(409).json({ error: "Ulasan hanya selepas pesanan selesai." });
    if (order.rows[0].has_reviewed) return res.status(409).json({ error: "Pesanan ini sudah mempunyai ulasan." });

    await client.query("BEGIN");
    await client.query(`UPDATE orders SET has_reviewed=TRUE WHERE order_id=$1`, [id]);
    await client.query(
      `INSERT INTO reviews(order_id,name,rating,comment,created_at) VALUES($1,$2,$3,$4,$5)`,
      [id, name, rating, comment, new Date().toISOString()]
    );
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(e);
    res.status(500).json({ error: "Gagal menyimpan ulasan." });
  } finally {
    client.release();
  }
});

app.get("/api/reviews", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT order_id AS "orderId",name,rating,comment,created_at AS "createdAt"
       FROM reviews ORDER BY id DESC`
    );
    res.json({ reviews: r.rows });
  } catch { res.json({ reviews: [] }); }
});

app.get("/api/admin/stats", adminAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::numeric AS sales
       FROM orders WHERE (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=$1 AND status!='Ditolak'`,
      [today()]
    );
    res.json({ orders: r.rows[0].orders, sales: Number(r.rows[0].sales) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan statistik." });
  }
});


app.get("/api/orders/:orderId/messages", async (req, res) => {
  try {
    const id = clean(req.params.orderId, 80);
    const r = await pool.query(
      `SELECT role, message AS text, created_at AS "createdAt"
       FROM order_messages WHERE order_id=$1 ORDER BY id ASC LIMIT 100`,
      [id]
    );
    // Ambil bukti gambar pickup/hantar jika ada (untuk paparan dalam chat)
    let pickupData = null, pickupType = null, deliveryData = null, deliveryType = null;
    try {
      const ord = await pool.query(
        `SELECT pickup_photo_data, pickup_photo_type, delivery_photo_data, delivery_photo_type
         FROM orders WHERE order_id=$1`,
        [id]
      );
      if (ord.rows[0]) {
        pickupData = ord.rows[0].pickup_photo_data;
        pickupType = ord.rows[0].pickup_photo_type || "image/jpeg";
        deliveryData = ord.rows[0].delivery_photo_data;
        deliveryType = ord.rows[0].delivery_photo_type || "image/jpeg";
      }
    } catch (_) {}

    res.json({
      messages: r.rows.map((m) => {
        const text = String(m.text || "");
        let image = null;
        const isPickupProof =
          text.includes("[BUKTI_PICKUP]") ||
          /di-pickup|telah di-pickup|bukti pickup/i.test(text);
        const isDeliveryProof =
          text.includes("[BUKTI_HANTAR]") ||
          /telah dihantar|bukti hantar|selesai hantar/i.test(text);
        if (isPickupProof && pickupData) {
          image = "data:" + pickupType + ";base64," + pickupData;
        } else if (isDeliveryProof && deliveryData) {
          image = "data:" + deliveryType + ";base64," + deliveryData;
        }
        // Teks mesra tanpa penanda teknikal
        const display = text
          .replace("[BUKTI_PICKUP]", "")
          .replace("[BUKTI_HANTAR]", "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          role: m.role,
          text: display,
          at: m.createdAt,
          createdAt: m.createdAt,
          image: image,
        };
      }),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan mesej." });
  }
});

app.get("/api/support/threads", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now() || session.role !== "admin") {
      return res.status(401).json({ error: "Sesi admin diperlukan." });
    }
    const r = await pool.query(`
      SELECT st.id, st.customer_name, st.updated_at,
        lm.last_text, lm.last_role, lm.last_at,
        lc.last_customer_at
      FROM support_threads st
      LEFT JOIN LATERAL (
        SELECT message AS last_text, role AS last_role, created_at AS last_at
        FROM order_messages WHERE order_id = st.id ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_customer_at
        FROM order_messages WHERE order_id = st.id AND role = 'customer'
      ) lc ON true
      ORDER BY st.updated_at DESC
    `);
    res.json({
      threads: r.rows.map((t) => ({
        id: t.id,
        customerName: t.customer_name || "Pelanggan",
        lastText: t.last_text || "",
        lastRole: t.last_role || "",
        lastAt: t.last_at ? new Date(t.last_at).toISOString() : null,
        lastCustomerMessageAt: t.last_customer_at ? new Date(t.last_customer_at).toISOString() : null,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan senarai chat." });
  }
});

app.post("/api/orders/:orderId/messages", async (req, res) => {
  try {
    const id = clean(req.params.orderId, 80);
    const text = clean(req.body?.text || req.body?.message, 400);
    let role = clean(req.body?.role || req.body?.sender || "customer", 20).toLowerCase();
    if (!["customer", "rider", "admin", "system"].includes(role)) role = "customer";
    if (!text) return res.status(400).json({ error: "Mesej kosong." });

    // SUPPORT-xxxx = chat admin umum per-pelanggan (tanpa pesanan sebenar)
    const isSupportThread = id === "SUPPORT" || id.startsWith("SUPPORT-");
    if (!isSupportThread) {
      const order = await pool.query(`SELECT order_id FROM orders WHERE order_id=$1`, [id]);
      if (!order.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
    }

    // Admin/rider posts need auth
    if (role === "rider" || role === "admin") {
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const session = sessions.get(token);
      if (!session || session.expires < Date.now()) {
        return res.status(401).json({ error: "Log masuk admin/rider diperlukan untuk balas." });
      }
      // kekalkan role admin untuk SUPPORT; rider kekal rider
      if (role === "admin" && session.role === "admin") role = "admin";
      else role = "rider";
    }

    const createdAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO order_messages(order_id, role, message, created_at) VALUES ($1,$2,$3,$4)`,
      [id, role, text, createdAt]
    );

    // Realtime + push: pelanggan <-> rider
    try {
      if (!isSupportThread) {
        const ord = await pool.query(
          `SELECT customer_phone, assigned_rider_id, order_id FROM orders WHERE order_id=$1`,
          [id]
        );
        const row = ord.rows[0];
        const payload = {
          orderId: id,
          role,
          text,
          at: createdAt,
          body: text.slice(0, 120),
          title: role === "customer" ? "Mesej pelanggan" : "Mesej rider"
        };
        if (role === "customer") {
          // ke rider yang diassign + bilik ops
          if (row && row.assigned_rider_id) {
            broadcastToRider(row.assigned_rider_id, "chat_message", payload);
            sendPushToRider(row.assigned_rider_id, {
              title: "Mesej pelanggan",
              body: text.slice(0, 120),
              orderId: id,
              tag: "ayen-chat-" + id,
              url: "/rider.html"
            }).catch(() => {});
          } else {
            // tiada assign — semua rider ops
            broadcastOps("chat_message", payload);
            sendPushToAllRiders({
              title: "Mesej pelanggan",
              body: text.slice(0, 120),
              orderId: id,
              tag: "ayen-chat-" + id,
              url: "/rider.html"
            }).catch(() => {});
          }
        } else if (role === "rider" || role === "admin") {
          if (row && row.customer_phone) {
            broadcastRealtime(row.customer_phone, "chat_message", {
              ...payload,
              title: "Mesej rider",
              body: text.slice(0, 120)
            });
          }
        }
        broadcastOps("chat_message", payload);
      } else if (role === "customer") {
        broadcastOps("chat_message", { orderId: id, role, text, at: createdAt });
      }
    } catch (rtErr) {
      console.error("chat realtime", rtErr.message);
    }

    // ciri baru: rekod/kemas kini nama pelanggan bagi thread SUPPORT, supaya
    // admin nampak "siapa" di sebalik setiap perbualan chat umum, bukan cuma ID.
    if (isSupportThread && role === "customer") {
      const customerName = clean(req.body?.customerName, 80) || null;
      await pool.query(
        `INSERT INTO support_threads(id, customer_name, updated_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET
           customer_name = COALESCE(EXCLUDED.customer_name, support_threads.customer_name),
           updated_at = EXCLUDED.updated_at`,
        [id, customerName, createdAt]
      );
    }
    res.status(201).json({ ok: true, message: { role, text, at: createdAt } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal menghantar mesej." });
  }
});



const DOC_TYPES = new Set([
  "ic_front", "ic_back",
  "license_front", "license_back",
  "roadtax_front", "roadtax_back",
  "selfie_ic", "motor_full"
]);

app.post("/api/rider/documents", upload.single("file"), async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    // Allow upload right after signup using phone+pin in body if no session
    let riderId = session?.riderId || null;
    if (!riderId) {
      let phone = String(req.body?.phone || "").replace(/\D/g, "");
      if (phone.startsWith("0")) phone = "60" + phone.slice(1);
      const pin = String(req.body?.pin || "");
      if (!phone || !pin) return res.status(401).json({ error: "Sila log masuk atau berikan telefon & PIN." });
      const r = await pool.query(`SELECT * FROM riders WHERE phone=$1`, [phone]);
      if (!r.rows[0] || !verifyPin(pin, r.rows[0].pin_hash)) {
        return res.status(401).json({ error: "Telefon atau PIN tidak sah." });
      }
      riderId = r.rows[0].id;
      if (r.rows[0].status === "rejected") {
        return res.status(403).json({ error: "Akaun ditolak. Hubungi peniaga." });
      }
    }

    const docType = clean(req.body?.docType || req.body?.type, 30);
    if (!DOC_TYPES.has(docType)) {
      return res.status(400).json({ error: "Jenis dokumen tidak sah. Guna: ic_front, ic_back, license, selfie." });
    }
    if (!req.file) return res.status(400).json({ error: "Fail dokumen diperlukan (JPG/PNG/WEBP, max 5MB)." });

    // Replace existing same type
    await pool.query(`DELETE FROM rider_documents WHERE rider_id=$1 AND doc_type=$2`, [riderId, docType]);
    await pool.query(
      `INSERT INTO rider_documents(rider_id, doc_type, file_name, mime_type, file_data, file_size, status, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
      [
        riderId, docType, req.file.originalname || docType, req.file.mimetype,
        req.file.buffer, req.file.size, new Date().toISOString()
      ]
    );

    // If had docs and still pending, keep pending (docs_submitted optional status)
    const count = await pool.query(
      `SELECT COUNT(DISTINCT doc_type)::int AS c FROM rider_documents WHERE rider_id=$1`,
      [riderId]
    );
    const docsCount = count.rows[0].c;
    if (docsCount >= 2) {
      await pool.query(
        `UPDATE riders SET status=CASE WHEN status='approved' THEN status ELSE 'pending' END WHERE id=$1`,
        [riderId]
      );
    }

    res.status(201).json({
      ok: true,
      docType,
      docsUploaded: docsCount,
      message: "Dokumen dimuat naik. Menunggu semakan peniaga."
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal muat naik dokumen." });
  }
});

app.get("/api/rider/documents", async (req, res) => {
  try {
    let phone = String(req.query.phone || "").replace(/\D/g, "");
    if (phone.startsWith("0")) phone = "60" + phone.slice(1);
    const pin = String(req.query.pin || "");
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    let riderId = session?.riderId;
    if (!riderId) {
      if (!phone || !pin) return res.status(401).json({ error: "Tidak dibenarkan." });
      const r = await pool.query(`SELECT * FROM riders WHERE phone=$1`, [phone]);
      if (!r.rows[0] || !verifyPin(pin, r.rows[0].pin_hash)) {
        return res.status(401).json({ error: "Tidak dibenarkan." });
      }
      riderId = r.rows[0].id;
    }
    const docs = await pool.query(
      `SELECT id, doc_type AS "docType", file_name AS "fileName", mime_type AS "mimeType",
              file_size AS "fileSize", status, uploaded_at AS "uploadedAt"
       FROM rider_documents WHERE rider_id=$1 ORDER BY uploaded_at DESC`,
      [riderId]
    );
    res.json({ documents: docs.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan dokumen." });
  }
});

app.get("/api/admin/riders/:id/documents", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const docs = await pool.query(
      `SELECT id, doc_type AS "docType", file_name AS "fileName", mime_type AS "mimeType",
              file_size AS "fileSize", status, uploaded_at AS "uploadedAt"
       FROM rider_documents WHERE rider_id=$1 ORDER BY doc_type`,
      [id]
    );
    res.json({ documents: docs.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan dokumen rider." });
  }
});

app.get("/api/admin/rider-documents/:docId", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.docId);
    const r = await pool.query(
      `SELECT mime_type, file_data, file_name FROM rider_documents WHERE id=$1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Dokumen tidak ditemui." });
    res.setHeader("Content-Type", r.rows[0].mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${r.rows[0].file_name || "document"}"`);
    res.send(r.rows[0].file_data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal memaparkan dokumen." });
  }
});


app.get("/api/admin/riders", adminAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.id, r.name, r.phone, r.ic_number AS "icNumber", r.plate_number AS "plateNumber",
              r.status, r.active,
              r.created_at AS "createdAt", r.approved_at AS "approvedAt", r.reject_reason AS "rejectReason",
              (SELECT COUNT(DISTINCT d.doc_type)::int FROM rider_documents d WHERE d.rider_id=r.id) AS "docsCount"
       FROM riders r ORDER BY
         CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         r.id DESC`
    );
    res.json({ riders: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendapatkan senarai rider." });
  }
});

app.patch("/api/admin/riders/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const action = clean(req.body?.action || req.body?.status, 20).toLowerCase();
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID tidak sah." });

    let status, active;
    if (action === "approve" || action === "approved") {
      const docs = await pool.query(
        `SELECT COUNT(DISTINCT doc_type)::int AS c FROM rider_documents WHERE rider_id=$1`,
        [id]
      );
      const required = ["ic_front","ic_back","license_front","license_back","roadtax_front","roadtax_back","selfie_ic","motor_full"];
      const have = await pool.query(
        `SELECT doc_type FROM rider_documents WHERE rider_id=$1`,
        [id]
      );
      const haveSet = new Set(have.rows.map((x) => x.doc_type));
      const missing = required.filter((t) => !haveSet.has(t));
      if (missing.length) {
        return res.status(400).json({
          error: "Dokumen belum lengkap. Kekurangan: " + missing.join(", "),
          missing
        });
      }
      status = "approved"; active = true;
    } else if (action === "reject" || action === "rejected") {
      status = "rejected"; active = false;
    } else if (action === "disable" || action === "deactivate") {
      status = "approved"; active = false; // approved but disabled
    } else if (action === "enable" || action === "activate") {
      status = "approved"; active = true;
    } else {
      return res.status(400).json({ error: "Tindakan tidak sah. Guna approve/reject/enable/disable." });
    }

    const approvedAt = status === "approved" && active ? new Date().toISOString() : null;
    const r = await pool.query(
      `UPDATE riders SET status=$1, active=$2, approved_at=COALESCE($3, approved_at) WHERE id=$4
       RETURNING id, name, phone, status, active`,
      [status, active, approvedAt, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Rider tidak ditemui." });
    res.json({ ok: true, rider: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mengemas kini rider." });
  }
});


app.post("/api/admin/orders/:orderId/auto-assign", adminAuth, async (req, res) => {
  try {
    const id = clean(req.params.orderId, 80);
    const result = await autoAssignOrder(id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal auto-assign." });
  }
});

app.post("/api/admin/auto-assign-pending", adminAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT order_id FROM orders
       WHERE assigned_rider_id IS NULL
         AND status IN ('Disahkan', 'Dalam penghantaran')
       ORDER BY created_at ASC`
    );
    const results = [];
    for (const row of r.rows) {
      results.push({ orderId: row.order_id, ...(await autoAssignOrder(row.order_id)) });
    }
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal auto-agih pukal." });
  }
});


// Grab-style: rider terima / tolak tawaran
app.post("/api/orders/:orderId/accept", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now() || session.role !== "rider") {
      return res.status(401).json({ error: "Log masuk rider diperlukan." });
    }
    const id = clean(req.params.orderId, 80);
    const o = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [id]);
    if (!o.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
    const row = o.rows[0];
    const rid = session.riderId;
    const assigned = row.assigned_rider_id != null ? Number(row.assigned_rider_id) : null;
    const openPool =
      !assigned &&
      ["Mencari rider", "Disahkan"].includes(String(row.status || "")) &&
      !row.rider_accepted;
    // Master, tawaran khusus, atau order terbuka (pool) boleh diambil
    if (!session.master && !openPool && assigned !== Number(rid)) {
      return res.status(403).json({ error: "Order ini tidak tersedia untuk anda." });
    }
    if (row.rider_accepted && assigned && assigned !== Number(rid) && !session.master) {
      return res.status(409).json({ error: "Order sudah diterima rider lain." });
    }
    // Claim atomik: elak dua rider ambil serentak
    const claim = await pool.query(
      `UPDATE orders SET
         rider_accepted=TRUE,
         status='Disahkan',
         assigned_rider_id=COALESCE(assigned_rider_id, $1),
         assigned_rider_name=$2
       WHERE order_id=$3
         AND (
           rider_accepted IS NOT TRUE
           OR assigned_rider_id IS NULL
           OR assigned_rider_id=$1
         )
         AND status IN ('Mencari rider', 'Disahkan')
       RETURNING order_id`,
      [rid || null, session.name || row.assigned_rider_name || "Rider", id]
    );
    if (!claim.rows[0]) {
      return res.status(409).json({ error: "Order sudah diterima rider lain. Pilih order lain." });
    }
    try {
      await notifyAllParties(id, { body: statusCategoryMessage(id, "Disahkan"), event: "order_update" });
    } catch (_) {}
    res.json({ ok: true, status: "Disahkan", message: "Order diterima." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal terima order." });
  }
});

app.post("/api/orders/:orderId/reject", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now() || session.role !== "rider") {
      return res.status(401).json({ error: "Log masuk rider diperlukan." });
    }
    const id = clean(req.params.orderId, 80);
    const o = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [id]);
    if (!o.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
    const row = o.rows[0];
    const rid = session.riderId || 0;
    if (!session.master && Number(row.assigned_rider_id) !== Number(rid)) {
      return res.status(403).json({ error: "Tawaran ini bukan untuk anda." });
    }
    const rejected = Array.isArray(row.rejected_rider_ids) ? row.rejected_rider_ids.map(Number) : [];
    if (rid && !rejected.includes(Number(rid))) rejected.push(Number(rid));
    await pool.query(
      `UPDATE orders SET
         assigned_rider_id=NULL,
         assigned_rider_name=NULL,
         rider_accepted=FALSE,
         rejected_rider_ids=$1::jsonb,
         status='Mencari rider'
       WHERE order_id=$2`,
      [JSON.stringify(rejected), id]
    );
    const next = await autoAssignOrder(id, { force: true });
    try { await notifyAllParties(id, { body: statusCategoryMessage(id, "Mencari rider") }); } catch (_) {}
    res.json({ ok: true, message: "Order ditolak. Mencari rider lain...", next });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal tolak order." });
  }
});



// Rider batal selepas terima (lepas order semula ke pool)
app.post("/api/orders/:orderId/rider-cancel", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now() || session.role !== "rider") {
      return res.status(401).json({ error: "Log masuk rider diperlukan." });
    }
    const id = clean(req.params.orderId, 80);
    const ALLOWED_REASONS = [
      "Pelanggan tidak menjawab",
      "Alamat tidak jumpa",
      "Kenderaan bermasalah",
      "Terlalu jauh / trafik teruk",
      "Pesanan dibatalkan pelanggan",
      "Sebab lain"
    ];
    let reason = clean(req.body?.reason || "", 200);
    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: "Sila pilih sebab batal." });
    }
    if (!ALLOWED_REASONS.includes(reason) && reason.length < 5) {
      return res.status(400).json({ error: "Sebab batal tidak sah." });
    }
    const rid = session.riderId || 0;
    // Had batal harian (elak abuse)
    const MAX_CANCEL_PER_DAY = 5;
    if (rid && !session.master) {
      const cnt = await pool.query(
        `SELECT COUNT(*)::int AS c FROM rider_cancel_log
         WHERE rider_id=$1 AND created_at >= (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
           AND created_at < ((NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date + INTERVAL '1 day')`,
        [rid]
      );
      // Fallback tanpa TZ cast issues
      let c = cnt.rows[0]?.c || 0;
      if (c === 0) {
        const cnt2 = await pool.query(
          `SELECT COUNT(*)::int AS c FROM rider_cancel_log
           WHERE rider_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`,
          [rid]
        );
        c = cnt2.rows[0]?.c || 0;
      }
      if (c >= MAX_CANCEL_PER_DAY) {
        return res.status(429).json({
          error: "Had batal harian tercapai (" + MAX_CANCEL_PER_DAY + "). Hubungi admin."
        });
      }
    }
    const o = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [id]);
    if (!o.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
    const row = o.rows[0];
    if (!session.master && Number(row.assigned_rider_id) !== Number(rid)) {
      return res.status(403).json({ error: "Order ini bukan tugasan anda." });
    }
    if (row.status === "Selesai") {
      return res.status(400).json({ error: "Order sudah selesai, tidak boleh dibatal." });
    }
    if (row.status === "Ditolak") {
      return res.status(400).json({ error: "Order sudah ditolak." });
    }
    const rejected = Array.isArray(row.rejected_rider_ids) ? row.rejected_rider_ids.map(Number) : [];
    if (rid && !rejected.includes(Number(rid))) rejected.push(Number(rid));
    await pool.query(
      `UPDATE orders SET
         assigned_rider_id=NULL,
         assigned_rider_name=NULL,
         rider_accepted=FALSE,
         rejected_rider_ids=$1::jsonb,
         status='Mencari rider',
         reject_reason=$2
       WHERE order_id=$3`,
      [JSON.stringify(rejected), "Batal rider: " + reason, id]
    );
    try {
      await pool.query(
        `INSERT INTO rider_cancel_log(rider_id, order_id, reason) VALUES ($1,$2,$3)`,
        [rid || null, id, reason]
      );
    } catch (_) {}
    try {
      await pool.query(
        `INSERT INTO order_messages(order_id, role, message, created_at) VALUES ($1,'system',$2,NOW())`,
        [id, "Rider membatalkan tugasan (" + reason + "). Mencari rider lain."]
      );
    } catch (_) {}
    try { await autoAssignOrder(id, { force: true }); } catch (_) {}
    try { await notifyAllParties(id, { body: statusCategoryMessage(id, "Mencari rider"), event: "order_update" }); } catch (_) {}
    res.json({ ok: true, message: "Order dibatalkan. Dicari rider lain.", reason });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal batal order." });
  }
});


// Jejak live rider untuk pelanggan (semasa dalam penghantaran)
app.get("/api/orders/:orderId/live", async (req, res) => {
  try {
    const id = clean(req.params.orderId, 80);
    const r = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Pesanan tidak ditemui." });
    const o = r.rows[0];
    let riderLat = null, riderLng = null, riderName = o.assigned_rider_name || null;
    if (o.assigned_rider_id && ["Disahkan", "Dalam penghantaran"].includes(o.status)) {
      const rr = await pool.query(
        `SELECT name, last_lat, last_lng, last_location_at FROM riders WHERE id=$1`,
        [o.assigned_rider_id]
      );
      if (rr.rows[0]) {
        riderName = rr.rows[0].name || riderName;
        const age = rr.rows[0].last_location_at
          ? Date.now() - new Date(rr.rows[0].last_location_at).getTime()
          : Infinity;
        if (age < 15 * 60 * 1000 && rr.rows[0].last_lat != null) {
          riderLat = Number(rr.rows[0].last_lat);
          riderLng = Number(rr.rows[0].last_lng);
        }
      }
    }
    res.json({
      ok: true,
      orderId: o.order_id,
      status: o.status,
      riderName,
      riderLat,
      riderLng,
      customerLat: o.loc_lat != null ? Number(o.loc_lat) : null,
      customerLng: o.loc_lng != null ? Number(o.loc_lng) : null,
      timeline: buildOrderTimeline(o)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal jejak." });
  }
});

app.post("/api/rider/location", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.get(token);
    if (!session || session.expires < Date.now() || session.role !== "rider") {
      return res.status(401).json({ error: "Log masuk rider diperlukan." });
    }
    if (session.master && !session.riderId) {
      return res.json({ ok: true, skipped: true, message: "Master tiada profil rider." });
    }
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "Koordinat tidak sah." });
    }
    const riderId = session.riderId;
    if (!riderId) return res.status(400).json({ error: "Profil rider tidak lengkap." });
    await pool.query(
      `UPDATE riders SET last_lat=$1, last_lng=$2, last_location_at=NOW() WHERE id=$3`,
      [lat, lng, riderId]
    );
    const spot = isInHotspot(lat, lng);
    // Siar lokasi ke pelanggan order aktif rider ini
    try {
      const active = await pool.query(
        `SELECT order_id, customer_phone, status FROM orders
         WHERE assigned_rider_id=$1 AND status IN ('Disahkan','Dalam penghantaran')
         ORDER BY created_at DESC LIMIT 5`,
        [riderId]
      );
      for (const row of active.rows) {
        if (row.customer_phone) {
          broadcastRealtime(row.customer_phone, "rider_location", {
            orderId: row.order_id,
            status: row.status,
            riderLat: lat,
            riderLng: lng,
            at: new Date().toISOString()
          });
        }
      }
    } catch (_) {}
    res.json({
      ok: true,
      inHotspot: spot.inHotspot,
      hotspotName: spot.hotspotName,
      weight: spot.inHotspot ? WEIGHT_HOTSPOT : WEIGHT_NORMAL
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal kemaskini lokasi." });
  }
});


// ===== Admin: kawalan kedai =====
app.get("/api/admin/shop", adminAuth, async (_req, res) => {
  try {
    const settings = await getShopSettings();
    res.json({ settings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal muat tetapan kedai." });
  }
});

app.patch("/api/admin/shop", adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.isOpen === "boolean") await setSetting("is_open", body.isOpen);
    if (body.preorderDays != null) await setSetting("preorder_days", Math.min(30, Math.max(1, Number(body.preorderDays) || 7)));
    if (body.cutoffHours != null) await setSetting("cutoff_hours", Math.min(48, Math.max(0, Number(body.cutoffHours) || 0)));
    if (body.discountPercent != null) await setSetting("discount_percent", Math.min(50, Math.max(0, Number(body.discountPercent) || 0)));
    if (typeof body.discountLabel === "string") await setSetting("discount_label", String(body.discountLabel).slice(0, 80));
    if (body.prices && typeof body.prices === "object") await setSetting("prices", body.prices);
    if (Array.isArray(body.slotDefs)) {
      const cleaned = body.slotDefs.map((sd, i) => ({
        id: String(sd.id || ("slot" + (i + 1))).slice(0, 20),
        name: String(sd.name || "Slot").slice(0, 40),
        maxCapacity: Math.min(50, Math.max(1, Number(sd.maxCapacity) || 5))
      }));
      await setSetting("slot_defs", cleaned);
    }
    // kemaskini max_capacity slot hari ini & tarikh preorder jika diminta
    if (Array.isArray(body.slotDefs)) {
      const settings = await getShopSettings();
      for (const date of listPreorderDates(settings.preorderDays)) {
        for (const sd of body.slotDefs) {
          await pool.query(
            `UPDATE slots SET max_capacity=$1, name=$2 WHERE id=$3 AND date=$4`,
            [Math.min(50, Math.max(1, Number(sd.maxCapacity) || 5)), String(sd.name || "").slice(0, 40), sd.id, date]
          );
        }
      }
    }
    const settings = await getShopSettings();
    res.json({ ok: true, settings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal simpan tetapan kedai." });
  }
});




// Real-time stream (SSE) — status pesanan & badge

// Real-time untuk admin & rider
app.get("/api/events/ops", (req, res) => {
  const token = String(req.query.token || req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: "Sesi diperlukan." });
  }
  let channel = "admin";
  if (session.role === "rider") {
    channel = session.master ? "admin" : ("rider:" + String(session.riderId || "0"));
  } else if (session.role !== "admin" && !session.master) {
    // treat admin sessions
    channel = "admin";
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  sseSend(res, "connected", { ok: true, channel, role: session.role || "admin" });
  if (!sseOpsClients.has(channel)) sseOpsClients.set(channel, new Set());
  sseOpsClients.get(channel).add(res);
  // admin also listens on "admin"
  if (session.role === "admin" || session.master) {
    if (!sseOpsClients.has("admin")) sseOpsClients.set("admin", new Set());
    sseOpsClients.get("admin").add(res);
  }
  const hb = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) {}
  }, 25000);
  req.on("close", () => {
    clearInterval(hb);
    for (const [, set] of sseOpsClients) {
      set.delete(res);
    }
  });
});


app.get("/api/events", (req, res) => {
  const phone = normalizePhoneKey(req.query.phone || "");
  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: "phone diperlukan" });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  sseSend(res, "connected", { ok: true, phone });

  if (!sseClients.has(phone)) sseClients.set(phone, new Set());
  sseClients.get(phone).add(res);

  const hb = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) {}
  }, 25000);

  req.on("close", () => {
    clearInterval(hb);
    const set = sseClients.get(phone);
    if (set) {
      set.delete(res);
      if (!set.size) sseClients.delete(phone);
    }
  });
});


app.get("/api/push/vapid-public", (_req, res) => {
  res.json({
    publicKey: VAPID_PUBLIC || null,
    enabled: Boolean(webpush && VAPID_PUBLIC && VAPID_PRIVATE)
  });
});

app.post("/api/push/subscribe", async (req, res) => {
  try {
    await ensurePushTable();
    let phone = String(req.body?.phone || "").replace(/\D/g, "");
    const role = String(req.body?.role || "customer").toLowerCase();
    const sub = req.body?.subscription;
    // Rider / admin master: benarkan telefon pendek atau tag khas
    if (role === "rider") {
      if (!phone || phone.length < 4) phone = "rider";
      phone = "rider:" + phone;
    } else if (!phone || phone.length < 9) {
      return res.status(400).json({ error: "Nombor telefon diperlukan untuk notifikasi." });
    }
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: "Subscription tidak sah." });
    }
    await pool.query(
      `INSERT INTO push_subscriptions(phone, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET phone=$1, p256dh=$3, auth=$4`,
      [phone, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true, message: "Notifikasi diaktifkan. Akan kekal sehingga anda buka." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal daftar notifikasi." });
  }
});

app.post("/api/push/test", async (req, res) => {
  try {
    const role = String(req.body?.role || "").toLowerCase();
    if (role === "rider") {
      const r = await sendPushToAllRiders({
        title: "Ayen Rider — Ujian",
        body: "Notifikasi push rider berjaya.",
        tag: "ayen-rider-test",
        url: "/rider.html"
      });
      return res.json({ ok: true, ...r });
    }
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const r = await sendPushToPhone(phone, {
      title: "AYEN KETAM NIPAH",
      body: "Ini notifikasi ujian — kekal sehingga anda buka.",
      tag: "akn-test"
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/rider", (_req, res) => res.sendFile(path.join(__dirname, "public", "rider.html")));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith("sw-rider.js") || filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Service-Worker-Allowed", "/");
    } else if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    } else if (/\.(svg|png|jpg|jpeg|webp|woff2)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
  }
}));


async function processExpiredOffers() {
  try {
    const r = await pool.query(
      `SELECT order_id, assigned_rider_id, rejected_rider_ids, customer_phone
       FROM orders
       WHERE rider_accepted = FALSE
         AND assigned_rider_id IS NOT NULL
         AND status = 'Mencari rider'
         AND offered_at IS NOT NULL
         AND offered_at < NOW() - make_interval(secs => $1)`,
      [OFFER_TIMEOUT_SEC]
    );
    for (const row of r.rows) {
      const rejected = Array.isArray(row.rejected_rider_ids)
        ? row.rejected_rider_ids.map(Number)
        : [];
      const rid = Number(row.assigned_rider_id);
      if (rid && !rejected.includes(rid)) rejected.push(rid);
      await pool.query(
        `UPDATE orders SET
           assigned_rider_id=NULL,
           assigned_rider_name=NULL,
           rider_accepted=FALSE,
           rejected_rider_ids=$1::jsonb,
           offered_at=NULL,
           status='Mencari rider'
         WHERE order_id=$2`,
        [JSON.stringify(rejected), row.order_id]
      );
      const next = await autoAssignOrder(row.order_id, { force: true });
      try {
        if (row.customer_phone && typeof broadcastRealtime === "function") {
          broadcastRealtime(row.customer_phone, "order_update", {
            title: "AYEN KETAM NIPAH",
            body: "Mencari rider lain untuk pesanan " + row.order_id,
            orderId: row.order_id,
            status: "Mencari rider",
            tag: "akn-" + row.order_id
          });
        }
      } catch (_) {}
      console.log("[offer-timeout]", row.order_id, "next=", next && next.assignedRiderId);
    }
  } catch (e) {
    console.error("processExpiredOffers", e.message);
  }
}

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error("FATAL: DATABASE_URL tidak diset. Tambah di Render Environment.");
    process.exit(1);
  }
  if (!ADMIN_PIN) {
    console.warn("[amaran] AYEN_ADMIN_PIN / ADMIN_PIN tidak diset — /api/admin/login akan sentiasa gagal (PIN salah) dan dashboard admin akan kelihatan kosong walaupun ada tempahan di database. Tambah env var ini di Render.");
  }
  if (!ADMIN_SECRET) {
    console.warn("[amaran] AYEN_ADMIN_SECRET tidak diset — token sesi admin akan guna secret fallback. Set env var ini untuk keselamatan lebih baik.");
  }
  await initDb();
  setInterval(processExpiredOffers, 8000);
  setTimeout(processExpiredOffers, 3000);

  const server = http.createServer(app);
  if (WebSocketServer) {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws, req) => {
      try {
        const url = new URL(req.url || "/ws", "http://localhost");
        const role = String(url.searchParams.get("role") || "customer");
        const phone = normalizePhoneKey(url.searchParams.get("phone") || "");
        const token = String(url.searchParams.get("token") || "");

        if (role === "customer" && phone.length >= 9) {
          wsJoin(phone, ws);
          wsSend(ws, "connected", { ok: true, role: "customer", transport: "websocket" });
        } else if (role === "admin" || role === "rider") {
          const session = sessions.get(token);
          if (!session || session.expires < Date.now()) {
            wsSend(ws, "error", { error: "Sesi tidak sah" });
            try { ws.close(); } catch (_) {}
            return;
          }
          if (role === "admin" || session.role === "admin" || session.master) {
            wsJoin("admin", ws);
          }
          if (session.role === "rider" && session.riderId) {
            wsJoin("rider:" + String(session.riderId), ws);
          }
          if (session.master) wsJoin("admin", ws);
          wsSend(ws, "connected", {
            ok: true,
            role: session.role || role,
            transport: "websocket"
          });
        } else {
          wsSend(ws, "error", { error: "Parameter tidak lengkap" });
          try { ws.close(); } catch (_) {}
          return;
        }

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === "ping") wsSend(ws, "pong", { t: Date.now() });
          } catch (_) {}
        });
        ws.on("close", () => wsLeaveAll(ws));
        ws.on("error", () => wsLeaveAll(ws));
      } catch (e) {
        console.error("ws connection", e.message);
        try { ws.close(); } catch (_) {}
      }
    });
    console.log("[ws] WebSocket aktif pada /ws");
  } else {
    console.warn("[ws] modul ws tiada — guna SSE sahaja");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`AYEN KETAM NIPAH listening on 0.0.0.0:${PORT} (HTTP + WS)`);
  });
}
start().catch(err => { console.error("Startup failed:", err); process.exit(1); });

