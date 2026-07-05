/**
 * ตัวอย่างการเชื่อมหน้าเว็บเข้ากับ backend (วางในหน้าเติมเงินจริง)
 * ต้องโหลด Stripe.js ก่อน:  <script src="https://js.stripe.com/v3/"></script>
 *
 * flow:
 *   สร้าง PaymentIntent (backend) → confirmPromptPayPayment (Stripe.js)
 *   → Stripe คืน QR จริง → ผู้ใช้สแกน → poll สถานะ → succeeded → เติมเครดิต
 */

const API = 'https://your-backend.example.com';   // ← โดเมน backend ของคุณ

async function payWithPromptPay(amountBaht, userId, qrContainerEl) {
  // 1) ขอ PaymentIntent จาก backend
  const r = await fetch(`${API}/api/promptpay/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountBaht, userId }),
  });
  const { clientSecret, paymentIntentId, publishableKey } = await r.json();

  // 2) ให้ Stripe สร้าง QR จริง
  const stripe = Stripe(publishableKey);
  const { error, paymentIntent } = await stripe.confirmPromptPayPayment(clientSecret, {
    payment_method: { billing_details: { name: userId } },
  });

  if (error) { console.error(error.message); return; }

  // Stripe แสดง QR ให้อัตโนมัติผ่าน next_action — หรือดึง URL รูป QR เองได้:
  const qrUrl = paymentIntent?.next_action?.promptpay_display_qr_code?.image_url_png;
  if (qrUrl && qrContainerEl) {
    qrContainerEl.innerHTML = `<img src="${qrUrl}" alt="PromptPay QR" style="width:220px">`;
  }

  // 3) poll สถานะจนกว่าจะจ่าย (webhook ฝั่ง backend คือจุดเติมเครดิตจริง)
  const poll = setInterval(async () => {
    const s = await fetch(`${API}/api/promptpay/status/${paymentIntentId}`).then(x => x.json());
    if (s.status === 'succeeded') {
      clearInterval(poll);
      const bal = await fetch(`${API}/api/balance/${userId}`).then(x => x.json());
      console.log('✅ เติมเครดิตสำเร็จ ยอดใหม่:', bal.credits);
      // TODO: อัปเดต UI ยอดเครดิตตรงนี้
    }
  }, 3000);
}
