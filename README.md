# BoostHub Backend — Stripe PromptPay

Backend รับชำระเงินผ่าน **Stripe PromptPay (QR)** แล้วเติมเครดิตให้ผู้ใช้ เงินเข้าบัญชี Stripe ของคุณจริง

## ติดตั้ง

```bash
cd backend
cp .env.example .env      # ใส่คีย์จริงลงใน .env
npm install
npm start
```

เซิร์ฟเวอร์จะรันที่ `http://localhost:4242`

## ตั้งค่าคีย์ (`.env`)

| ตัวแปร | เอามาจาก |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys (`sk_live_...`) |
| `STRIPE_PUBLISHABLE_KEY` | หน้าเดียวกัน (`pk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Dashboard → Developers → Webhooks → endpoint (`whsec_...`) |

> ⚠️ **ต้องเปิดใช้ PromptPay** ใน Stripe Dashboard → Settings → Payment methods ก่อน (บัญชีต้องเป็นประเทศไทย / สกุลเงิน THB)

## Endpoints

| Method | Path | หน้าที่ |
|---|---|---|
| POST | `/api/promptpay/create` | สร้าง PaymentIntent + คืน clientSecret |
| GET | `/api/promptpay/status/:id` | เช็คสถานะการจ่าย (poll) |
| POST | `/api/webhook` | Stripe ยิงมาเมื่อจ่ายสำเร็จ → เติมเครดิต |
| GET | `/api/balance/:userId` | ดูยอดเครดิต |

## ตั้งค่า Webhook (สำคัญที่สุด — จุดที่เติมเครดิตจริง)

1. Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://your-backend.example.com/api/webhook`
3. เลือก event: `payment_intent.succeeded`
4. เอา signing secret (`whsec_...`) ใส่ใน `.env`

ทดสอบ local ด้วย Stripe CLI:
```bash
stripe listen --forward-to localhost:4242/api/webhook
stripe trigger payment_intent.succeeded
```

## เชื่อมกับหน้าเว็บ

ดู `frontend-integration.example.js` — โหลด `https://js.stripe.com/v3/` แล้วเรียก `confirmPromptPayPayment()` ด้วย publishable key เพื่อรับ QR จริงจาก Stripe

## ⚠️ ก่อน production

- เปลี่ยน in-memory store (`balances`, `processed`) เป็น **ฐานข้อมูลจริง** (Postgres / Mongo / Firebase)
- ใส่ระบบ auth (JWT / session) — อย่าเชื่อ `userId` ที่ส่งมาจาก client ตรง ๆ
- ตั้ง `FRONTEND_ORIGIN` เป็นโดเมนจริง (ไม่ใช่ `*`)
- **Revoke คีย์เก่าที่เคยรั่ว** ทั้งหมด
