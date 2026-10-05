// One-time migration: converts plaintext passwords in users.password to bcrypt hashes.
// Idempotent — rows already holding a bcrypt hash are skipped.
//
// Run: node migrate-password-hashes.js
require('dotenv').config();
const { query, run } = require('./mysql');
const { hashPassword } = require('./auth');

const BCRYPT_PREFIX = /^\$2[aby]\$\d{2}\$/;

(async () => {
  const users = await query(
    "SELECT id, email, password FROM users WHERE password IS NOT NULL AND password <> ''"
  );

  let migrated = 0;
  let skipped  = 0;

  for (const user of users) {
    if (BCRYPT_PREFIX.test(user.password)) {
      console.log(`  skip  ${user.email} (already hashed)`);
      skipped++;
      continue;
    }

    const hash = await hashPassword(user.password);
    await run('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);
    console.log(`  done  ${user.email} → ${hash.slice(0, 12)}…`);
    migrated++;
  }

  console.log(`\nMigrated ${migrated}, skipped ${skipped}.`);
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
