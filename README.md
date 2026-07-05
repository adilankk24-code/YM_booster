# BoostHub Backend — SQLite + Auth + Orders + Stripe

ระบบหลังบ้านจริงของเว็บ SMM: ฐานข้อมูล SQLite, สมัคร/ล็อกอิน (JWT), สั่งซื้อตัดเครดิตแบบ atomic, บันทึก ledger ทุกการเคลื่อนไหว, และรับเงินผ่าน Stripe (PromptPay/บัตร) + TrueMoney (อนุมัติสลิปเอง)

## ติดตั้ง

```bash
cd backend
cp .env.example .env      # ใส่คีย์จริง + JWT_SECRET
npm install
npm run seed             # สร้างบัญชีแอดมินตัวแรก
npm start                # http://localhost:4242
```

## สถาปัตยกรรม

| ไฟล์ | หน้าที่ |
|---|---|
| `db.js` | ฐานข้อมูล SQLite — users, orders, ledger, deposits + ทุกการเคลื่อนไหวเครดิตแบบ transaction |
| `auth.js` | สมัคร/ล็อกอิน, hash รหัสด้วย bcrypt, ออก JWT, middleware `requireAuth` / `requireAdmin` |
| `services.js` | แคตตาล็อกบริการ + เรตราคา → คำนวณราคาที่เซิร์ฟเวอร์ (ไม่เชื่อราคาจาก client) |
| `server.js` | รวม API ทั้งหมด |
| `seed.js` | สร้างแอดมินตัวแรก |

## Endpoints

### Auth
| Method | Path | |
|---|---|---|
| POST | `/api/auth/register` | สมัคร → คืน `{token, user}` |
| POST | `/api/auth/login` | ล็อกอิน → คืน `{token, user}` |
| POST | `/api/auth/forgot` | ลืมรหัส → ส่งลิงก์รีเซ็ตเข้าอีเมล `{email}` (ตอบ ok เสมอ) |
| POST | `/api/auth/reset` | ตั้งรหัสใหม่ `{token, password}` → ล็อกอินให้เลย |
| GET | `/api/auth/me` | ข้อมูลตัวเอง (ต้องมี token) |

แนบ token ทุก request ที่ต้องล็อกอิน: `Authorization: Bearer <token>`

### ลูกค้า (ต้องล็อกอิน)
| Method | Path | |
|---|---|---|
| GET | `/api/services` | แคตตาล็อก + เรตราคา |
| POST | `/api/orders` | สั่งซื้อ `{platform, serviceId, qty, link}` → ตัดเครดิต atomic |
| GET | `/api/orders` | ออเดอร์ของตัวเอง |
| GET | `/api/ledger` | ประวัติเครดิตเข้า-ออก |
| GET | `/api/balance` | ยอดเครดิตคงเหลือ |

### เติมเงิน (ล็อกอินหรือ guest ก็ได้)
ลูกค้าที่ล็อกอินแล้ว (แนบ token) เครดิตจะผูกกับบัญชีจริง — ถ้ายังไม่ได้ต่อระบบล็อกอิน จะใช้ id ที่หน้าเว็บส่งมา (guest) และระบบสร้าง user row ให้อัตโนมัติเมื่อเงินเข้า
| Method | Path | |
|---|---|---|
| POST | `/api/promptpay/create` | สร้าง PaymentIntent พร้อมเพย์ QR `{amountBaht, userId?, email?}` |
| POST | `/api/card/create-intent` | สร้าง PaymentIntent บัตรเครดิต/เดบิต `{amountBaht, userId?, email?}` |
| GET | `/api/promptpay/status/:id` | poll สถานะ |
| POST | `/api/deposits/truemoney` | แจ้งโอน TrueMoney + สลิป → เข้าคิวรออนุมัติ (ต้องล็อกอิน) |
| POST | `/api/webhook` | Stripe ยิงมาเมื่อจ่ายสำเร็จ → เติมเครดิตอัตโนมัติ (กันซ้ำด้วย pi_id) |

### แอดมิน (ต้อง `is_admin`)
| Method | Path | |
|---|---|---|
| GET | `/api/admin/overview` | สมาชิก + ออเดอร์ + สลิป + สถิติ |
| PATCH | `/api/admin/orders/:id` | อัปเดตสถานะ `{status, progress}` |
| POST | `/api/admin/orders/:id/refund` | ยกเลิก + คืนเครดิต |
| POST | `/api/admin/users/:id/credit` | เติมเครดิตให้ผู้ใช้ `{amount}` |
| POST | `/api/admin/users/:id/ban` | ระงับ/ปลด `{banned}` |
| POST | `/api/admin/deposits/:id/approve` | อนุมัติสลิป TrueMoney |
| POST | `/api/admin/deposits/:id/reject` | ปฏิเสธสลิป |

## ที่ยังต้องทำต่อ (เฟสถัดไป)

- **ต่อ SMM provider จริง** — ตอนนี้ออเดอร์เลื่อนสถานะเอง ต้องยิง API ไป supplier แล้ว sync กลับ
- **เช็คสลิปอัตโนมัติ** (SlipOK/EasySlip) กันสลิปปลอม
- **Realtime** (WebSocket/SSE) แจ้งหน้าเว็บเมื่อเครดิต/ออเดอร์เปลี่ยน
- **แจ้งเตือน** อีเมล/LINE, **คูปอง/โปรโมชั่น**, **affiliate/referral**
- ขึ้น production: ตั้ง `FRONTEND_ORIGIN` เป็นโดเมนจริง, `JWT_SECRET` สุ่มยาว, พิจารณาย้าย SQLite → Postgres เมื่อโตขึ้น

## Stripe Webhook (จุดที่เติมเครดิตจริง)

```bash
stripe listen --forward-to localhost:4242/api/webhook
stripe trigger payment_intent.succeeded
```
Dashboard → Webhooks → Add endpoint → event `payment_intent.succeeded` → เอา `whsec_...` ใส่ `.env`
