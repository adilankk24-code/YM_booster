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
const rateLimit = require('express-rate-limit');

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

// ⭐ อยู่หลัง reverse proxy ของ Render — ต้องเชื่อ header X-Forwarded-For
// เพื่อให้ req.ip เป็น IP จริงของลูกค้า ไม่ใช่ IP ของ proxy
// (ถ้าไม่ตั้ง: rate limit จะเห็นลูกค้าทุกคนเป็น IP เดียว → ล็อกทั้งเว็บพร้อมกัน)
// ตั้งเป็น 1 = เชื่อ proxy ชั้นเดียว (ของ Render) — อย่าตั้ง true ซึ่งเปิดกว้างเกินไป
app.set('trust proxy', 1);

// ── CORS: อนุญาตเฉพาะโดเมนหน้าเว็บจริงเท่านั้น ──
// FRONTEND_ORIGIN ใส่ได้หลายโดเมนคั่นด้วย comma เช่น
//   https://boosthub.com,https://www.boosthub.com
// ค่าเริ่มต้น '*' = เปิดทุกโดเมน (ใช้ได้ตอน dev แต่ห้ามใช้ตอนเปิดจริง — checkEnv จะเตือน)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const allowedOrigins = FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
const corsOptions = {
  origin(origin, cb) {
    // ไม่มี header origin = เรียกจาก server/มือถือ/curl/health check → ปล่อยผ่าน
    if (!origin) return cb(null, true);
    const ok = allowedOrigins.includes('*') || allowedOrigins.includes(origin);
    cb(null, ok);   // ไม่ผ่าน → ไม่ใส่ CORS header เบราว์เซอร์จะบล็อกเอง
  },
};
app.use(cors(corsOptions));

// helper ส่ง error ให้เป็นรูปแบบเดียวกัน
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message || 'เกิดข้อผิดพลาด' });
});

/* ═══════════════════════════════════════════════════════════
 * WEBHOOK — ต้องอ่าน raw body ก่อน express.json()
 * เงินเข้า Stripe สำเร็จจริง → เติมเครดิตผ่าน DB (จุดที่เชื่อถือได้สุด)
 * ═══════════════════════════════════════════════════════════ */
app.post('/api/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
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

// จำกัดขนาด body 1MB — พอสำหรับสลิปที่ย่อแล้ว (~200KB) แต่กันคนยัด payload ก้อนโตถล่ม DB/หน่วยความจำ
app.use(express.json({ limit: '1mb' }));

/* ═══════════════════════════════════════════════════════════
 * RATE LIMITING — กัน brute-force รหัสผ่าน / โค้ด 2FA / สแปมอีเมลรีเซ็ต
 * ────────────────────────────────────────────────────────────
 * ใช้ express-rate-limit เก็บตัวนับใน memory (ต่อ 1 instance)
 * ⚠️ ถ้าสเกลเป็นหลาย instance ทีหลัง ให้เปลี่ยน store เป็น Redis
 * ⚠️ ต้องมี app.set('trust proxy', 1) ด้านบน ไม่งั้นนับ IP ผิด
 * ═══════════════════════════════════════════════════════════ */
const { ipKeyGenerator } = rateLimit;   // helper รองรับ IPv6 อย่างถูกต้อง

// โรงงานสร้าง limiter — ตอบ 429 เป็น JSON ภาษาไทยให้หน้าเว็บอ่านง่าย
function makeLimiter({ windowMs, limit, message, keyGenerator, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',   // ส่ง header RateLimit-* บอกโควตาคงเหลือให้ client
    legacyHeaders: false,
    skipSuccessfulRequests,       // true = นับเฉพาะครั้งที่ "พลาด"
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

// ── ล็อกอิน: 8 ครั้งพลาด / 15 นาที ต่อ (IP + อีเมล) ──
// คิดต่ออีเมลด้วย → ผู้โจมตีจะเจาะทีละบัญชีไม่ได้ และลูกค้าที่ใช้ NAT ร่วมกันไม่โดนล็อกพร้อมกัน
// ครั้งที่ล็อกอิน "สำเร็จ" ไม่กินโควตา (skipSuccessfulRequests)
const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, limit: 8, skipSuccessfulRequests: true,
  message: 'พยายามเข้าสู่ระบบผิดบ่อยเกินไป กรุณารอ 15 นาทีแล้วลองใหม่',
  keyGenerator: (req) => ipKeyGenerator(req.ip) + '|' + String(req.body?.email || '').trim().toLowerCase(),
});

// ── ยืนยันโค้ด 2FA 6 หลัก: 6 ครั้งพลาด / 15 นาที ต่อ IP ──
// โค้ดมีแค่ 1,000,000 ชุด ต้องล็อกแน่นเป็นพิเศษกัน brute-force
const twofaLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, limit: 6, skipSuccessfulRequests: true,
  message: 'ยืนยันรหัส 2FA ผิดบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
});

// ── สมัครสมาชิก: 5 บัญชี / ชม. ต่อ IP ── กันสร้างบัญชีรัว ๆ / สแปม
const registerLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, limit: 5,
  message: 'สมัครสมาชิกบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
});

// ── ลืมรหัสผ่าน: 5 ครั้ง / ชม. ต่อ IP ── กันยิงอีเมลรีเซ็ตถล่มคนอื่น (email bombing)
const forgotLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, limit: 5,
  message: 'ขอลิงก์รีเซ็ตบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
});

// ── โควตารวมทุก endpoint: 120 req / นาที ต่อ IP ── กันยิงถล่มทั่วไป (DoS เบา ๆ)
// วางไว้ "ใต้" webhook ของ Stripe จึงไม่กระทบ webhook (Stripe retry ได้ตามปกติ)
const apiLimiter = makeLimiter({
  windowMs: 60 * 1000, limit: 120,
  message: 'มีคำขอเข้ามาถี่เกินไป กรุณาชะลอสักครู่',
});
app.use('/api/', apiLimiter);

/* ═══════════════════════════════════════════════════════════
 * AUTH
 * ═══════════════════════════════════════════════════════════ */
app.post('/api/auth/register', registerLimiter, wrap(async (req, res) => res.json(await register(req.body))));
app.post('/api/auth/login',    loginLimiter,    wrap(async (req, res) => res.json(await login(req.body))));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// ลืมรหัสผ่าน — ส่งลิงก์รีเซ็ตเข้าอีเมล (ตอบ ok เสมอ ไม่บอกว่าอีเมลมีจริงไหม)
app.post('/api/auth/forgot', forgotLimiter, wrap(async (req, res) => res.json(await forgotPassword(req.body, process.env.FRONTEND_URL))));
// ตั้งรหัสใหม่ด้วย token จากลิงก์ในอีเมล
app.post('/api/auth/reset',  wrap(async (req, res) => res.json(await resetPassword(req.body))));

// ── 2FA (Google Authenticator) ──
// ขั้นที่ 2 ของล็อกอิน: ยืนยันรหัส 6 หลัก {tempToken, code}
app.post('/api/auth/2fa/verify', twofaLimiter, wrap(async (req, res) => res.json(verify2fa(req.body))));
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

/* ═══════════════════════════════════════════════════════════
 * ตรวจ ENV ก่อนเปิดใช้งาน — เตือนของที่ยังไม่ปลอดภัย
 * บน production (NODE_ENV=production) ถ้าขาดของคอขาดใจ → หยุดทำงาน
 * กันเปิดเว็บแบบ token เดาได้ / เติมเครดิตไม่ได้ โดยไม่รู้ตัว
 * ═══════════════════════════════════════════════════════════ */
function checkEnv() {
  const isProd = process.env.NODE_ENV === 'production';
  const warn = [];   // เตือนเฉย ๆ
  const fatal = [];  // ร้ายแรง — บน production ต้องหยุด

  if (!process.env.JWT_SECRET)
    fatal.push('JWT_SECRET — ยังใช้ค่า dev ที่เดาได้ ใครก็ปลอม token เป็นแอดมินได้ (สุ่ม: openssl rand -hex 32)');
  if (!process.env.STRIPE_WEBHOOK_SECRET)
    fatal.push('STRIPE_WEBHOOK_SECRET — จุดเดียวที่เติมเครดิตจริง ถ้าไม่ตั้ง เงินเข้าแต่เครดิตไม่เข้า!');
  if (!process.env.STRIPE_SECRET_KEY)
    warn.push('STRIPE_SECRET_KEY — ยังไม่ตั้ง ระบบเติมเงิน Stripe จะใช้ไม่ได้');
  if (allowedOrigins.includes('*'))
    warn.push('FRONTEND_ORIGIN — ยังเปิด CORS ทุกโดเมน (*) ควรตั้งเป็นโดเมนเว็บจริง');
  if ((process.env.ADMIN_PASSWORD || 'admin1234') === 'admin1234')
    warn.push('ADMIN_PASSWORD — ยังเป็นรหัส default "admin1234" เปลี่ยนด่วน + เปิด 2FA');

  if (warn.length || fatal.length) {
    console.warn('\n⚠️  ตรวจ ENV ก่อนเปิดจริง:');
    fatal.forEach((m) => console.warn('   🔴 ' + m));
    warn.forEach((m) => console.warn('   🟠 ' + m));
    console.warn('');
  } else {
    console.log('✅ ENV ครบถ้วน พร้อมเปิดใช้งาน');
  }

  if (isProd && fatal.length) {
    console.error('❌ NODE_ENV=production แต่ขาด ENV สำคัญข้างบน — หยุดทำงานเพื่อความปลอดภัย');
    process.exit(1);
  }
}
checkEnv();

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 BoostHub backend ทำงานที่พอร์ต ${PORT}`));
