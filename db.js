/**
 * BoostHub — Database layer (SQLite / better-sqlite3)
 * ────────────────────────────────────────────────────────────
 * ไฟล์เดียวจบ ไม่ต้องติดตั้งเซิร์ฟเวอร์ DB แยก เก็บที่ boosthub.db
 * ย้ายขึ้น Postgres ทีหลังได้ (โครง schema เหมือนกัน)
 *
 * ทุกฟังก์ชันที่แตะเครดิตทำงานแบบ "transaction" (atomic)
 * เครดิตติดลบไม่ได้ และทุกการเคลื่อนไหวถูกบันทึกลง ledger เสมอ
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// บน Render ต้องชี้ DB_PATH ไปที่ Persistent Disk (เช่น /data/boosthub.db)
// ไม่งั้นไฟล์ DB จะถูกล้างทุกครั้งที่ deploy/restart
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'boosthub.db');
// สร้างโฟลเดอร์ปลายทางให้แน่ใจว่ามีอยู่ (กัน crash ตอน mount disk ครั้งแรก)
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
console.log('[db] ใช้ฐานข้อมูลที่:', DB_PATH);
db.pragma('journal_mode = WAL');   // อ่าน/เขียนพร้อมกันได้ดีขึ้น
db.pragma('foreign_keys = ON');

/* ───────────────────────────── schema ───────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    credits       INTEGER NOT NULL DEFAULT 0,   -- 1 บาท = 1 เครดิต
    is_admin      INTEGER NOT NULL DEFAULT 0,
    banned        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    platform      TEXT NOT NULL,                -- facebook | instagram | youtube | tiktok
    service_id    TEXT NOT NULL,
    service_name  TEXT NOT NULL,
    link          TEXT NOT NULL,
    qty           INTEGER NOT NULL,
    price         INTEGER NOT NULL,             -- เครดิตที่ตัดจริง
    status        TEXT NOT NULL DEFAULT 'รอดำเนินการ',
    progress      INTEGER NOT NULL DEFAULT 0,
    provider_id   TEXT,                         -- id ฝั่ง supplier (เผื่อต่อ API จริง)
    created_at    TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    type          TEXT NOT NULL,                -- deposit | order | refund | admin
    amount        INTEGER NOT NULL,             -- +เข้า / -ออก
    balance_after INTEGER NOT NULL,
    ref           TEXT,                         -- pi_id / order_id / deposit_id
    note          TEXT,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    method        TEXT NOT NULL,                -- promptpay | card | truemoney
    amount        INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    slip_url      TEXT,
    ref           TEXT,                         -- pi_id ของ Stripe (กันซ้ำ)
    created_at    TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,          -- sha256 ของ token (ไม่เก็บ token ตรง ๆ)
    user_id    TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_ledger_user   ON ledger(user_id);
  CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
`);

/* ── migration: เพิ่มคอลัมน์ 2FA ให้ตาราง users ที่มีอยู่แล้ว (ถ้ายังไม่มี) ── */
const _userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!_userCols.includes('totp_secret'))  db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
if (!_userCols.includes('totp_enabled')) db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);

const now = () => new Date().toISOString();
const genId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ───────────────────────────── users ───────────────────────────── */
const createUser = db.prepare(
  `INSERT INTO users (id,email,password_hash,name,credits,is_admin,created_at)
   VALUES (@id,@email,@password_hash,@name,0,@is_admin,@created_at)`
);
const getUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
const getUserById    = db.prepare(`SELECT * FROM users WHERE id = ?`);
const listUsers      = db.prepare(`SELECT * FROM users ORDER BY created_at DESC`);
const setBanned      = db.prepare(`UPDATE users SET banned = ? WHERE id = ?`);
const _setPassword   = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);
const _setTotpSecret = db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`);
const _setTotpEnabled= db.prepare(`UPDATE users SET totp_enabled = ? WHERE id = ?`);

const users = {
  create({ email, password_hash, name, is_admin = 0 }) {
    const id = genId('u_');
    createUser.run({ id, email, password_hash, name, is_admin: is_admin ? 1 : 0, created_at: now() });
    return getUserById.get(id);
  },
  byEmail: (email) => getUserByEmail.get(email),
  byId:    (id)    => getUserById.get(id),
  all:     ()      => listUsers.all(),
  setBanned: (id, banned) => setBanned.run(banned ? 1 : 0, id),
  setPassword: (id, hash) => _setPassword.run(hash, id),
  // 2FA (Google Authenticator / TOTP)
  setTotpSecret: (id, secret) => _setTotpSecret.run(secret, id),
  setTotpEnabled: (id, on) => _setTotpEnabled.run(on ? 1 : 0, id),

  /**
   * ทำให้มี user row แน่นอน — ถ้ายังไม่มี (ลูกค้า guest ที่ยังไม่ได้สมัคร) สร้างให้
   * เพื่อให้เครดิตจาก Stripe ถูกบันทึกลง DB ได้ (ผูกกับ id ที่หน้าเว็บส่งมา)
   * เมื่อลูกค้าสมัครจริงทีหลัง ค่อยผูก/ย้ายเครดิตได้
   */
  ensureGuest(id, email) {
    const existing = getUserById.get(id);
    if (existing) return existing;
    createUser.run({ id, email: id + '@guest.local', password_hash: '', name: email || 'ลูกค้า (guest)', is_admin: 0, created_at: now() });
    return getUserById.get(id);
  },
};

/* ─────────────────── ลืมรหัสผ่าน (reset token) ─────────────────── */
const _insReset    = db.prepare(
  `INSERT INTO password_resets (token_hash,user_id,expires_at,used,created_at)
   VALUES (@token_hash,@user_id,@expires_at,0,@created_at)`
);
const _getReset    = db.prepare(`SELECT * FROM password_resets WHERE token_hash = ?`);
const _useReset    = db.prepare(`UPDATE password_resets SET used = 1 WHERE token_hash = ?`);
const _clearUserResets = db.prepare(`DELETE FROM password_resets WHERE user_id = ?`);

const passwordResets = {
  /** ออก token ใหม่ให้ผู้ใช้ (ล้างของเก่าทิ้งก่อน — มีได้ทีละอัน) */
  issue(userId, tokenHash, expiresAt) {
    _clearUserResets.run(userId);
    _insReset.run({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt, created_at: now() });
  },
  get: (tokenHash) => _getReset.get(tokenHash),
  markUsed: (tokenHash) => _useReset.run(tokenHash),
  clearForUser: (userId) => _clearUserResets.run(userId),
};

/* ─────────────────── ledger + การเคลื่อนไหวเครดิต (atomic) ─────────────────── */
const _insLedger = db.prepare(
  `INSERT INTO ledger (user_id,type,amount,balance_after,ref,note,created_at)
   VALUES (@user_id,@type,@amount,@balance_after,@ref,@note,@created_at)`
);
const _setCredits = db.prepare(`UPDATE users SET credits = ? WHERE id = ?`);
const listLedger  = db.prepare(`SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`);
const recentLedger = db.prepare(`SELECT * FROM ledger ORDER BY id DESC LIMIT ?`);

/**
 * ปรับเครดิตแบบปลอดภัย — คืน balance ใหม่ หรือ throw ถ้าเครดิตไม่พอ
 * เรียกภายใน transaction เท่านั้น (ผ่าน db.transaction)
 */
function _move(userId, delta, type, ref, note) {
  const u = getUserById.get(userId);
  if (!u) throw new Error('ไม่พบผู้ใช้');
  const next = u.credits + delta;
  if (next < 0) throw new Error('เครดิตไม่พอ');
  _setCredits.run(next, userId);
  _insLedger.run({ user_id: userId, type, amount: delta, balance_after: next, ref: ref || null, note: note || null, created_at: now() });
  return next;
}

const ledger = {
  forUser: (userId, limit = 100) => listLedger.all(userId, limit),
  recent:  (limit = 100) => recentLedger.all(limit),
};

/* ───────────────────────────── deposits ───────────────────────────── */
const _insDeposit   = db.prepare(
  `INSERT INTO deposits (id,user_id,method,amount,status,slip_url,ref,created_at)
   VALUES (@id,@user_id,@method,@amount,@status,@slip_url,@ref,@created_at)`
);
const getDeposit    = db.prepare(`SELECT * FROM deposits WHERE id = ?`);
const depByRef      = db.prepare(`SELECT * FROM deposits WHERE ref = ?`);
const pendingDeps   = db.prepare(`SELECT * FROM deposits WHERE status = 'pending' ORDER BY created_at DESC`);
const depHistory    = db.prepare(`SELECT * FROM deposits WHERE status != 'pending' ORDER BY created_at DESC LIMIT ?`);
const _setDepStatus = db.prepare(`UPDATE deposits SET status = ? WHERE id = ?`);

const deposits = {
  create({ user_id, method, amount, status = 'pending', slip_url = null, ref = null }) {
    const id = genId('d_');
    _insDeposit.run({ id, user_id, method, amount, status, slip_url, ref, created_at: now() });
    return getDeposit.get(id);
  },
  byId:  (id)  => getDeposit.get(id),
  byRef: (ref) => depByRef.get(ref),
  pending: () => pendingDeps.all(),
  history: (limit = 50) => depHistory.all(limit),

  /** เติมเครดิตอัตโนมัติ (Stripe จ่ายสำเร็จ) — กันซ้ำด้วย ref (pi_id) */
  creditFromStripe: db.transaction((userId, credits, piId, method, email) => {
    if (depByRef.get(piId)) return null;   // เคยเติมแล้ว
    users.ensureGuest(userId, email);      // มี user row แน่นอนก่อนเติม (กัน FK พัง)
    const dep = deposits.create({ user_id: userId, method, amount: credits, status: 'approved', ref: piId });
    _move(userId, +credits, 'deposit', piId, method + ' (อัตโนมัติ)');
    return dep;
  }),

  /** อนุมัติสลิป TrueMoney (แอดมินกดเอง) */
  approve: db.transaction((depId) => {
    const d = getDeposit.get(depId);
    if (!d || d.status !== 'pending') throw new Error('รายการไม่ถูกต้อง');
    _setDepStatus.run('approved', depId);
    _move(d.user_id, +d.amount, 'deposit', depId, d.method + ' (อนุมัติเอง)');
    return getDeposit.get(depId);
  }),

  reject(depId) {
    const d = getDeposit.get(depId);
    if (!d || d.status !== 'pending') throw new Error('รายการไม่ถูกต้อง');
    _setDepStatus.run('rejected', depId);
    return getDeposit.get(depId);
  },
};

/* ───────────────────────────── orders ───────────────────────────── */
const _insOrder     = db.prepare(
  `INSERT INTO orders (id,user_id,platform,service_id,service_name,link,qty,price,status,progress,created_at)
   VALUES (@id,@user_id,@platform,@service_id,@service_name,@link,@qty,@price,'รอดำเนินการ',0,@created_at)`
);
const getOrder      = db.prepare(`SELECT * FROM orders WHERE id = ?`);
const ordersByUser  = db.prepare(`SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`);
const allOrders     = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`);
const _setOrder     = db.prepare(`UPDATE orders SET status = @status, progress = @progress WHERE id = @id`);

const orders = {
  byId:    (id) => getOrder.get(id),
  forUser: (userId) => ordersByUser.all(userId),
  all:     (limit = 200) => allOrders.all(limit),

  /** สั่งซื้อ + ตัดเครดิต atomic — เครดิตไม่พอ = ไม่เกิดออเดอร์ */
  create: db.transaction((userId, o) => {
    const id = genId('o_');
    _move(userId, -o.price, 'order', id, o.service_name + ' ×' + o.qty);
    _insOrder.run({
      id, user_id: userId, platform: o.platform, service_id: o.service_id,
      service_name: o.service_name, link: o.link, qty: o.qty, price: o.price, created_at: now(),
    });
    return getOrder.get(id);
  }),

  setStatus(id, status, progress) {
    const o = getOrder.get(id);
    if (!o) throw new Error('ไม่พบออเดอร์');
    _setOrder.run({ id, status, progress: progress != null ? progress : o.progress });
    return getOrder.get(id);
  },

  /** ยกเลิก + คืนเครดิตเต็มจำนวน (กันคืนซ้ำ) */
  refund: db.transaction((id) => {
    const o = getOrder.get(id);
    if (!o) throw new Error('ไม่พบออเดอร์');
    if (o.status === 'ยกเลิก') throw new Error('ออเดอร์นี้ถูกยกเลิกไปแล้ว');
    _setOrder.run({ id, status: 'ยกเลิก', progress: 0 });
    _move(o.user_id, +o.price, 'refund', id, 'คืนเครดิต ' + o.service_name);
    return getOrder.get(id);
  }),
};

module.exports = { db, users, orders, deposits, ledger, passwordResets, _move, genId, now };
