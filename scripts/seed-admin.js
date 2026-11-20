// Create the very first Full Admin, or an emergency one (others are invited from the Admin Panel: POST /admin/admins).
// Each login: password, then a 6-digit code emailed to them.
//   npm run seed:admin -- you@example.org "Strong passphrase 12+ chars" "Your Name"
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { query, pool } = require('../src/db');

async function main() {
  const [email, password, name = ''] = process.argv.slice(2);
  if (!email || !password) { console.error('Usage: npm run seed:admin -- <email> <password (12+ chars)> [name]'); process.exit(1); }
  if (password.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
  const e = email.trim().toLowerCase();
  if ((await query('SELECT 1 FROM admins WHERE email = ?', [e])).length) { console.error('An admin with that email already exists.'); process.exit(1); }
  await query("INSERT INTO admins (email, name, password_hash, role, is_active, activated_at) VALUES (?,?,?, 'full_admin', 1, UTC_TIMESTAMP())", [e, name, await bcrypt.hash(password, config.bcryptRounds)]);
  console.log(`Created Full Admin ${e}. At login they enter their password, then the 6-digit code emailed to this address.`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
