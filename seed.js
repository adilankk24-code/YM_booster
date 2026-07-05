/**
 * BoostHub — สร้างบัญชีแอดมินตัวแรก + ข้อมูลตัวอย่าง (ไม่บังคับ)
 * รัน:  node seed.js
 * ตั้งอีเมล/รหัสแอดมินใน .env:  ADMIN_EMAIL, ADMIN_PASSWORD
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { users } = require('./db');

async function main() {
  const email = (process.env.ADMIN_EMAIL || 'admin@boosthub.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin1234';

  if (users.byEmail(email)) {
    console.log('ℹ️  มีแอดมินอยู่แล้ว:', email);
  } else {
    const password_hash = await bcrypt.hash(password, 10);
    users.create({ email, password_hash, name: 'Admin', is_admin: 1 });
    console.log('✅ สร้างแอดมินแล้ว');
    console.log('   อีเมล:', email);
    console.log('   รหัส :', password, '  (เปลี่ยนทันทีหลังล็อกอินครั้งแรก)');
  }
  process.exit(0);
}
main();
