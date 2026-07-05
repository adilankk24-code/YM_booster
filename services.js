/**
 * BoostHub — แคตตาล็อกบริการ + เรตราคา (ฝั่งเซิร์ฟเวอร์)
 * ────────────────────────────────────────────────────────────
 * ⚠️ ราคาต้องคำนวณที่เซิร์ฟเวอร์เสมอ — อย่าเชื่อราคาที่หน้าเว็บส่งมา
 * เรต = เครดิตต่อ 1,000 หน่วย   ราคา = ceil(qty / 1000 * rate)
 */
const CATALOG = {
  facebook: {
    fb_follow:  { name: 'เพิ่มผู้ติดตาม เพจ/โปรไฟล์', rate: 54,   min: 100, max: 1000000 },
    fb_like:    { name: 'เพิ่มไลก์ / เลือกอิโมจิได้',  rate: 47,   min: 100, max: 10000000 },
    fb_view:    { name: 'เพิ่มยอดวิว คลิป',           rate: 6,    min: 100, max: 100000000 },
    fb_share:   { name: 'เพิ่มการแชร์',              rate: 64,   min: 100, max: 1000000 },
    fb_group:   { name: 'เพิ่มสมาชิกในกลุ่ม',         rate: 62,   min: 100, max: 500000 },
    fb_comment: { name: 'เพิ่มคอมเมนต์',             rate: 1500, min: 10,  max: 5000 },
  },
  instagram: {
    ig_follow:  { name: 'เพิ่มผู้ติดตาม',      rate: 42,   min: 100, max: 1000000 },
    ig_like:    { name: 'เพิ่มไลก์',           rate: 23,   min: 100, max: 10000000 },
    ig_view:    { name: 'เพิ่มยอดวิว Reels',   rate: 5,    min: 100, max: 100000000 },
    ig_repost:  { name: 'เพิ่มการรีโพส',       rate: 65,   min: 100, max: 1000000 },
    ig_group:   { name: 'เพิ่มสมาชิกในกลุ่ม',   rate: 74,   min: 100, max: 500000 },
    ig_comment: { name: 'เพิ่มคอมเมนต์',       rate: 1500, min: 10,  max: 5000 },
  },
  youtube: {
    yt_follow:     { name: 'เพิ่มผู้ติดตาม',       rate: 54,   min: 100, max: 1000000 },
    yt_like:       { name: 'เพิ่มไลก์',            rate: 110,  min: 100, max: 10000000 },
    yt_view_long:  { name: 'เพิ่มยอดวิว คลิปยาว',  rate: 65,   min: 100, max: 100000000 },
    yt_share:      { name: 'เพิ่มการแชร์',         rate: 98,   min: 100, max: 1000000 },
    yt_view_short: { name: 'เพิ่มยอดวิว คลิปสั้น', rate: 57,   min: 100, max: 100000000 },
    yt_comment:    { name: 'เพิ่มคอมเมนต์',        rate: 1500, min: 10,  max: 5000 },
  },
  tiktok: {
    tt_follow:  { name: 'เพิ่มผู้ติดตาม เพจ/โปรไฟล์', rate: 152,  min: 100, max: 1000000 },
    tt_like:    { name: 'เพิ่มการกดใจ',             rate: 57,   min: 100, max: 10000000 },
    tt_view:    { name: 'เพิ่มยอดวิว คลิป',          rate: 7,    min: 100, max: 100000000 },
    tt_share:   { name: 'เพิ่มการแชร์',             rate: 27,   min: 100, max: 1000000 },
    tt_repost:  { name: 'เพิ่มการรีโพส',            rate: 75,   min: 100, max: 1000000 },
    tt_comment: { name: 'เพิ่มคอมเมนต์',            rate: 1500, min: 10,  max: 5000 },
  },
};

/**
 * ตรวจ input + คำนวณราคาจากแคตตาล็อก คืน { platform, service_id, service_name, qty, price }
 * throw Error(message) ถ้าไม่ผ่าน
 */
function priceOrder({ platform, serviceId, qty, link }) {
  const group = CATALOG[platform];
  if (!group) throw new Error('ไม่พบแพลตฟอร์ม');
  const svc = group[serviceId];
  if (!svc) throw new Error('ไม่พบบริการ');

  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('จำนวนไม่ถูกต้อง');
  if (qty < svc.min) throw new Error(`ขั้นต่ำ ${svc.min.toLocaleString()} หน่วย`);
  if (qty > svc.max) throw new Error(`สูงสุด ${svc.max.toLocaleString()} หน่วย`);
  if (!String(link || '').trim()) throw new Error('กรุณาใส่ลิงก์');

  const price = Math.ceil((qty / 1000) * svc.rate);
  return { platform, service_id: serviceId, service_name: svc.name, qty, price };
}

module.exports = { CATALOG, priceOrder };
