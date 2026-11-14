#!/usr/bin/env node

/**
 * EventSync: Create Administrator Account
 * Reads ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD from environment/.env if present,
 * or prompts interactively in the terminal.
 */

const readline = require('readline');

require('../server/src/config');
const { initializeDatabase, closeDatabase } = require('../server/src/db/connection');
const { createAdministrator } = require('../server/src/services/auth.service');

function ask(rl, question, { silent = false } = {}) {
  return new Promise((resolve) => {
    if (!silent || !process.stdin.isTTY) {
      rl.question(question, (answer) => resolve(answer.trim()));
      return;
    }

    const originalWrite = rl._writeToOutput;
    let promptShown = false;
    rl._writeToOutput = function writeMuted(stringToWrite) {
      if (!promptShown) {
        rl.output.write(stringToWrite);
        if (stringToWrite.includes(question)) {
          promptShown = true;
        }
        return;
      }
      if (stringToWrite === '\r\n' || stringToWrite === '\n' || stringToWrite === '\r') {
        rl.output.write(stringToWrite);
        return;
      }
      if (stringToWrite.length > 0) {
        rl.output.write('*');
      }
    };

    rl.question(question, (answer) => {
      rl._writeToOutput = originalWrite;
      rl.output.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  await initializeDatabase();

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
      while (!password || password.length < 8) {
        password = await ask(rl, 'Password (min 8 chars): ', { silent: true });
        if (password.length < 8) {
          console.log('[Error] Password must be at least 8 characters long. Please try again.');
        }
      }
    } finally {
      rl.close();
    }
  }

  const admin = await createAdministrator({
    full_name: fullName || 'System Administrator',
    username,
    email,
    password
  });

  console.log(`\n[Success] Administrator account created:`);
  console.log(`  Username: ${admin.username}`);
  console.log(`  Email:    ${admin.email}`);
  console.log(`  Role:     ${admin.role}\n`);
  await closeDatabase();
}

main().catch((err) => {
  console.error(`\n[Error] Failed to create administrator: ${err.message}\n`);
  process.exit(1);
});
