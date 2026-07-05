/**
 * BoostHub SMM Panel — Backend
 * ────────────────────────────────────────────────────────────
 * รากฐานระบบหลังบ้าน (ของจริง ใช้งานได้):
 *   • ฐานข้อมูล SQLite จริง (db.js) — เครดิต/ออเดอร์/ledger ไม่หายเมื่อรีสตาร์ท
 *   • Auth: สมัคร/ล็อกอิน/JWT (auth.js) — ไม่เชื่อ userId จาก client
 *   • สั่งซื้อ: ตัดเครดิตแบบ atomic + คำนวณราคาที่เซิร์ฟเวอร์ (services.js)
 *   • เติมเงิน: Stripe (PromptPay/บัตร) อัตโนมัติ + TrueMoney (แอดมินอนุมัติสลิป)
 *   • ledger: บันทึกเครดิตเข้า-ออกทุกครั้ง
 *
 * รันจริง:  cp .env.example .env → ใส่คีย์ → npm install → npm start
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const { users, orders, deposits, ledger } = require('./db');
const { register, login, forgotPassword, resetPassword, verify2fa, setup2fa, enable2fa, disable2fa, requireAuth, requireAdmin, optionalAuth, publicUser } = require('./auth');
const { CATALOG, priceOrder } = require('./services');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ── สร้างบัญชีแอดมินตัวแรกอัตโนมัติตอนเริ่มระบบ (เผื่อ deploy บนที่ที่รัน `npm run seed` เองไม่ได้ เช่น Render free tier) ──
// ตั้งอีเมล/รหัสผ่านผ่าน ADMIN_EMAIL / ADMIN_PASSWORD ใน .env — ถ้ามีแอดมินอยู่แล้วจะข้ามไปเฉยๆ ไม่ทำอะไรซ้ำ
(async () => {
  try {
    const bcrypt = require('bcryptjs');
    const email = (process.env.ADMIN_EMAIL || 'admin@boosthub.local').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'admin1234';
    if (!users.byEmail(email)) {
      const password_hash = await bcrypt.hash(password, 10);
      users.create({ email, password_hash, name: 'Admin', is_admin: 1 });
      console.log('✅ สร้างบัญชีแอดมินอัตโนมัติ:', email, '(เปลี่ยนรหัสผ่านทันทีหลังล็อกอินครั้งแรก)');
    }
  } catch (e) {
    console.error('สร้างแอดมินอัตโนมัติล้มเหลว:', e.message);
  }
})();

const app = express();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));

// helper ส่ง error ให้เป็นรูปแบบเดียวกัน
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message || 'เกิดข้อผิดพลาด' });
});

/* ═══════════════════════════════════════════════════════════
 * WEBHOOK — ต้องอ่าน raw body ก่อน express.json()
 * เงินเข้า Stripe สำเร็จจริง → เติมเครดิตผ่าน DB (จุดที่เชื่อถือได้สุด)
 * ═══════════════════════════════════════════════════════════ */
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ ตรวจสอบลายเซ็น webhook ไม่ผ่าน:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const userId = pi.metadata.userId;
    const credits = Number(pi.metadata.credits || 0);
    const email = pi.metadata.email || '';
    const method = pi.payment_method_types?.[0] === 'promptpay' ? 'พร้อมเพย์ QR (Stripe)' : 'บัตร (Stripe)';
    try {
      const dep = deposits.creditFromStripe(userId, credits, pi.id, method, email);   // กันซ้ำในตัว + สร้าง guest ถ้ายังไม่มี
      if (dep) console.log(`✅ เติมเครดิต: user=${userId} +${credits} (pi=${pi.id})`);
    } catch (e) {
      console.error('เติมเครดิตล้มเหลว:', e.message);
    }
  }
  res.json({ received: true });
});

app.use(express.json());

/* ═══════════════════════════════════════════════════════════
 * AUTH
 * ═══════════════════════════════════════════════════════════ */
app.post('/api/auth/register', wrap(async (req, res) => res.json(await register(req.body))));
app.post('/api/auth/login',    wrap(async (req, res) => res.json(await login(req.body))));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// ลืมรหัสผ่าน — ส่งลิงก์รีเซ็ตเข้าอีเมล (ตอบ ok เสมอ ไม่บอกว่าอีเมลมีจริงไหม)
app.post('/api/auth/forgot', wrap(async (req, res) => res.json(await forgotPassword(req.body, process.env.FRONTEND_URL))));
// ตั้งรหัสใหม่ด้วย token จากลิงก์ในอีเมล
app.post('/api/auth/reset',  wrap(async (req, res) => res.json(await resetPassword(req.body))));

// ── 2FA (Google Authenticator) ──
// ขั้นที่ 2 ของล็อกอิน: ยืนยันรหัส 6 หลัก {tempToken, code}
app.post('/api/auth/2fa/verify', wrap(async (req, res) => res.json(verify2fa(req.body))));
// เริ่มตั้งค่า 2FA (ต้องล็อกอินอยู่) → คืน QR ให้สแกน
app.post('/api/auth/2fa/setup',  requireAuth, wrap(async (req, res) => res.json(await setup2fa(req.user))));
// ยืนยันโค้ดเพื่อเปิด 2FA จริง {code}
app.post('/api/auth/2fa/enable', requireAuth, wrap(async (req, res) => res.json(enable2fa(req.user, req.body.code))));
// ปิด 2FA — ยืนยันด้วยรหัสผ่าน {password}
app.post('/api/auth/2fa/disable', requireAuth, wrap(async (req, res) => res.json(await disable2fa(req.user, req.body.password))));

/* ═══════════════════════════════════════════════════════════
 * บริการ + สั่งซื้อ (ลูกค้า)
 * ═══════════════════════════════════════════════════════════ */
app.get('/api/services', (req, res) => res.json({ catalog: CATALOG }));

// สั่งซื้อ — ตัดเครดิตจากบัญชีของ "ผู้ใช้ที่ล็อกอิน" (ไม่ใช่ค่าจาก body)
app.post('/api/orders', requireAuth, wrap(async (req, res) => {
  const priced = priceOrder(req.body);        // คำนวณราคาที่เซิร์ฟเวอร์ + validate
  const order = orders.create(req.user.id, priced);   // atomic: เครดิตไม่พอ = throw
  res.json({ order, balance: users.byId(req.user.id).credits });
}));

app.get('/api/orders', requireAuth, (req, res) => res.json({ orders: orders.forUser(req.user.id) }));
app.get('/api/ledger', requireAuth, (req, res) => res.json({ ledger: ledger.forUser(req.user.id) }));
app.get('/api/balance', requireAuth, (req, res) => res.json({ credits: req.user.credits }));

/* ═══════════════════════════════════════════════════════════
 * เติมเงิน — Stripe PromptPay / บัตร (คืน clientSecret ให้หน้าเว็บ)
 * userId มาจาก token (requireAuth) ไม่ใช่จาก body
 * ═══════════════════════════════════════════════════════════ */
async function createIntent(req, res, method) {
  const amountBaht = Number(req.body.amountBaht);
  const amount = Math.round(amountBaht * 100);         // สตางค์
  if (!amount || amount < 2000) return res.status(400).json({ error: 'ยอดขั้นต่ำ 20 บาท' });

  // ลูกค้าที่ล็อกอินแล้ว → ผูกกับบัญชีจริง / ยังไม่ล็อกอิน → ใช้ id ที่ส่งมา (guest)
  const userId = req.user ? req.user.id : String(req.body.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'ไม่พบผู้ใช้' });
  const email = req.user ? req.user.email : (req.body.email || '');

  const intent = await stripe.paymentIntents.create({
    amount, currency: 'thb', payment_method_types: [method],
    metadata: { userId, email, credits: String(Math.round(amountBaht)) },  // 1 บาท = 1 เครดิต
  });
  res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
}
app.post('/api/promptpay/create',  optionalAuth, wrap((req, res) => createIntent(req, res, 'promptpay')));
app.post('/api/card/create-intent', optionalAuth, wrap((req, res) => createIntent(req, res, 'card')));
app.get('/api/promptpay/status/:id', wrap(async (req, res) => {
  const pi = await stripe.paymentIntents.retrieve(req.params.id);
  res.json({ status: pi.status });
}));
app.get('/api/config', (req, res) => res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY }));

/* ═══════════════════════════════════════════════════════════
 * เติมเงิน — TrueMoney Wallet (โอนมือ + แนบสลิป → แอดมินอนุมัติ)
 * ═══════════════════════════════════════════════════════════ */
app.post('/api/deposits/truemoney', requireAuth, wrap(async (req, res) => {
  const amount = Math.floor(Number(req.body.amount));
  if (!amount || amount < 20) return res.status(400).json({ error: 'ยอดขั้นต่ำ 20 บาท' });
  const dep = deposits.create({ user_id: req.user.id, method: 'TrueMoney Wallet', amount, slip_url: req.body.slipUrl || null });
  res.json({ deposit: dep });
}));

/* ═══════════════════════════════════════════════════════════
 * ADMIN — ต้อง is_admin
 * ═══════════════════════════════════════════════════════════ */
app.get('/api/admin/overview', requireAuth, requireAdmin, (req, res) => {
  const allUsers = users.all();
  const allOrders = orders.all();
  res.json({
    users: allUsers.map(publicUser),
    orders: allOrders,
    pendingDeposits: deposits.pending(),
    depositHistory: deposits.history(),
    recentLedger: ledger.recent(50),
    stats: {
      revenueToday: allOrders.filter(o => o.status !== 'ยกเลิก').reduce((a, o) => a + o.price, 0),
      totalUsers: allUsers.length,
      pendingOrders: allOrders.filter(o => o.status === 'รอดำเนินการ').length,
      circulatingCredits: allUsers.reduce((a, u) => a + u.credits, 0),
    },
  });
});

// อัปเดตสถานะออเดอร์ (เริ่มทำ / เสร็จ / ฯลฯ)
app.patch('/api/admin/orders/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { status, progress } = req.body;
  res.json({ order: orders.setStatus(req.params.id, status, progress) });
}));

// ยกเลิก + คืนเครดิต (atomic, กันคืนซ้ำ)
app.post('/api/admin/orders/:id/refund', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json({ order: orders.refund(req.params.id) });
}));

// เติมเครดิตให้ผู้ใช้ (แอดมิน) — บันทึก ledger type 'admin'
app.post('/api/admin/users/:id/credit', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { _move } = require('./db');
  const amount = Math.floor(Number(req.body.amount));
  if (!amount) return res.status(400).json({ error: 'จำนวนไม่ถูกต้อง' });
  const bal = _move(req.params.id, amount, 'admin', null, 'แอดมินปรับเครดิต');
  res.json({ user: publicUser(users.byId(req.params.id)), balance: bal });
}));

// ระงับ / ปลดระงับ
app.post('/api/admin/users/:id/ban', requireAuth, requireAdmin, wrap(async (req, res) => {
  users.setBanned(req.params.id, !!req.body.banned);
  res.json({ user: publicUser(users.byId(req.params.id)) });
}));

// อนุมัติ / ปฏิเสธ สลิป TrueMoney
app.post('/api/admin/deposits/:id/approve', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json({ deposit: deposits.approve(req.params.id) });
}));
app.post('/api/admin/deposits/:id/reject', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json({ deposit: deposits.reject(req.params.id) });
}));

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 BoostHub backend ทำงานที่พอร์ต ${PORT}`));
