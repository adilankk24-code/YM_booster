/**
 * BoostHub SMM Panel — Backend
 * ────────────────────────────────────────────────────────────
 * รับชำระเงินผ่าน Stripe PromptPay (QR) แล้วเติมเครดิตให้ผู้ใช้
 *
 * รันจริง:
 *   1) cp .env.example .env  แล้วใส่คีย์จริง
 *   2) npm install
 *   3) npm start
 *
 * ⚠️ Secret key อยู่ในไฟล์นี้ผ่าน process.env เท่านั้น
 *    ห้ามส่ง secret key ไปฝั่งหน้าเว็บเด็ดขาด
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));

/* ───────────────────────────────────────────────────────────
 * ⚠️ Webhook ต้องอ่าน raw body — ประกาศ "ก่อน" express.json()
 * ─────────────────────────────────────────────────────────── */
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ ตรวจสอบลายเซ็น webhook ไม่ผ่าน:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // เงินเข้าสำเร็จจริง → เติมเครดิตตรงนี้ (จุดที่เชื่อถือได้ที่สุด)
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const userId = pi.metadata.userId;
    const credits = Number(pi.metadata.credits || 0);
    creditUser(userId, credits, pi.id);
    console.log(`✅ ชำระสำเร็จ: user=${userId} +${credits} เครดิต (pi=${pi.id})`);
  }

  res.json({ received: true });
});

// route อื่น ๆ ใช้ JSON body ปกติ
app.use(express.json());

/* ───────────────────────────────────────────────────────────
 * ฐานข้อมูลจำลอง (in-memory) — ของจริงให้เปลี่ยนเป็น DB เช่น
 * PostgreSQL / MongoDB / Firebase
 * ─────────────────────────────────────────────────────────── */
const balances = new Map();          // userId -> credits
const processed = new Set();         // กัน webhook ยิงซ้ำ (idempotency)

function creditUser(userId, credits, piId) {
  if (!userId || processed.has(piId)) return;   // เติมซ้ำไม่ได้
  processed.add(piId);
  balances.set(userId, (balances.get(userId) || 0) + credits);
}

/* ───────────────────────────────────────────────────────────
 * 1) สร้าง PaymentIntent แบบ PromptPay → คืน clientSecret ให้หน้าเว็บ
 *    หน้าเว็บจะเอา clientSecret ไปเรียก stripe.confirmPromptPayPayment()
 *    เพื่อให้ Stripe คืน QR จริงมาแสดง
 * ─────────────────────────────────────────────────────────── */
app.post('/api/promptpay/create', async (req, res) => {
  try {
    const { amountBaht, userId } = req.body;
    const amount = Math.round(Number(amountBaht) * 100); // Stripe คิดเป็นสตางค์

    if (!amount || amount < 2000) {           // ขั้นต่ำ 20 บาท
      return res.status(400).json({ error: 'ยอดขั้นต่ำ 20 บาท' });
    }
    if (!userId) return res.status(400).json({ error: 'ไม่พบผู้ใช้' });

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'thb',
      payment_method_types: ['promptpay'],
      metadata: {
        userId,
        credits: String(Math.round(Number(amountBaht))),  // 1 บาท = 1 เครดิต
      },
    });

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────────────────────────────────────────────────
 * 2) ตรวจสถานะการชำระ (ให้หน้าเว็บ poll ระหว่างรอผู้ใช้สแกน QR)
 *    สถานะ succeeded = จ่ายแล้ว
 * ─────────────────────────────────────────────────────────── */
app.get('/api/promptpay/status/:id', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.id);
    res.json({ status: pi.status });   // requires_action | processing | succeeded | canceled
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────────────────────────────────────────────────
 * 3) ดูยอดเครดิตของผู้ใช้
 * ─────────────────────────────────────────────────────────── */
app.get('/api/balance/:userId', (req, res) => {
  res.json({ credits: balances.get(req.params.userId) || 0 });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 BoostHub backend ทำงานที่พอร์ต ${PORT}`));
