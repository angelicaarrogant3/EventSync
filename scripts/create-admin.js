#!/usr/bin/env node

/**
 * EventSync: Create Administrator Account
 * Reads ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD from environment/.env if present,
 * or prompts interactively in the terminal.
 */

const path = require('path');
const readline = require('readline');
module.paths.push(path.resolve(__dirname, '../server/node_modules'));

require('../server/src/config');
const { initializeDatabase } = require('../server/src/db/connection');
const { createAdministrator } = require('../server/src/services/auth.service');

function ask(rl, question, { silent = false } = {}) {
  return new Promise((resolve) => {
    if (!silent || !process.stdin.isTTY) {
      rl.question(question, (answer) => resolve(answer.trim()));
      return;
    }

    const onData = (char) => {
      char = char + '';
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          process.stdin.removeListener('data', onData);
          break;
        default:
          process.stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
          break;
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  initializeDatabase();

  let username = process.env.ADMIN_USERNAME ? process.env.ADMIN_USERNAME.trim() : '';
  let email = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.trim() : '';
  let password = process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.trim() : '';
  let fullName = process.env.ADMIN_FULL_NAME ? process.env.ADMIN_FULL_NAME.trim() : '';

  if (!username || !email || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\n=== EventSync: Create Administrator Account ===');
      if (!fullName) fullName = (await ask(rl, 'Full Name (e.g. System Administrator): ')) || 'System Administrator';
      if (!username) username = await ask(rl, 'Username (3-32 chars): ');
      if (!email) email = await ask(rl, 'Email: ');
      if (!password) password = await ask(rl, 'Password (min 8 chars): ', { silent: true });
    } finally {
      rl.close();
    }
  }

  const admin = createAdministrator({
    full_name: fullName || 'System Administrator',
    username,
    email,
    password
  });

  console.log(`\n[Success] Administrator account created:`);
  console.log(`  Username: ${admin.username}`);
  console.log(`  Email:    ${admin.email}`);
  console.log(`  Role:     ${admin.role}\n`);
}

main().catch((err) => {
  console.error(`\n[Error] Failed to create administrator: ${err.message}\n`);
  process.exit(1);
});
