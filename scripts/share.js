#!/usr/bin/env node

/**
 * EventSync: Public Share Tunnel
 * Starts EventSync (if not already running on PORT) and opens a public HTTPS tunnel
 * so any device on mobile data or a different Wi-Fi can access EventSync.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { copyToClipboard } = require('../server/src/utils/network');

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = path.resolve(__dirname, '..');

function isServerHealthy(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerHealthy(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function findCloudflared() {
  const check = spawnSync('cloudflared', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (check.status === 0) return 'cloudflared';

  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe')
    ];
    for (const exe of candidates) {
      if (exe && fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function printPublicBox(publicUrl, port, copied, note = null) {
  const lines = [
    '',
    'EventSync Public Share is live!',
    'Works on any device, mobile data, or different Wi-Fi.',
    '',
    `- Public:   ${publicUrl}`,
    `- Local:    http://localhost:${port}`,
    ...(copied ? ['', 'Copied public link to clipboard!'] : []),
    ...(note ? ['', note] : []),
    '',
    'Press Ctrl+C to stop sharing.',
    ''
  ];

  const width = Math.max(54, ...lines.map((l) => l.length));
  const border = '─'.repeat(width + 4);
  console.log('');
  console.log(`   ┌${border}┐`);
  for (const line of lines) {
    console.log(`   │   ${line.padEnd(width)} │`);
  }
  console.log(`   └${border}┘`);
  console.log('');
}

async function main() {
  let serverProc = null;
  let tunnelProc = null;

  const cleanup = () => {
    if (tunnelProc && !tunnelProc.killed) {
      tunnelProc.kill('SIGINT');
    }
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGINT');
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const alreadyRunning = await isServerHealthy(PORT);
  if (!alreadyRunning) {
    console.log(`[Share] Starting EventSync on port ${PORT}...`);
    serverProc = spawn(process.execPath, [path.join(ROOT_DIR, 'server/src/index.js')], {
      cwd: ROOT_DIR,
      env: { ...process.env, PORT: String(PORT), EVENTSYNC_NO_CLIPBOARD: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    serverProc.on('exit', (code) => {
      if (code && code !== 0) {
        console.error(`[Share] EventSync server exited with code ${code}.`);
        cleanup();
        process.exit(code);
      }
    });

    const ready = await waitForServer(PORT);
    if (!ready) {
      console.error(`[Share] Timed out waiting for EventSync on port ${PORT}.`);
      cleanup();
      process.exit(1);
    }
  } else {
    console.log(`[Share] Using running EventSync server on port ${PORT}.`);
  }

  const cloudflaredBin = findCloudflared();
  let announced = false;

  if (cloudflaredBin) {
    console.log('[Share] Opening Cloudflare Quick Tunnel (HTTPS)...');
    tunnelProc = spawn(cloudflaredBin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !announced) {
        announced = true;
        const copied = copyToClipboard(match[0]);
        printPublicBox(match[0], PORT, copied);
      }
    };
    tunnelProc.stdout.on('data', handleOutput);
    tunnelProc.stderr.on('data', handleOutput);
  } else {
    console.log('[Share] cloudflared not found; falling back to localtunnel...');
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    tunnelProc = spawn(npxCmd, ['--yes', 'localtunnel', '--port', String(PORT)], {
      cwd: ROOT_DIR,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[^\s]+/);
      if (match && !announced) {
        announced = true;
        const copied = copyToClipboard(match[0]);
        printPublicBox(
          match[0],
          PORT,
          copied,
          'Tip: Install cloudflared (winget install Cloudflare.cloudflared) for faster tunnels.'
        );
      }
    };
    tunnelProc.stdout.on('data', handleOutput);
    tunnelProc.stderr.on('data', (chunk) => {
      handleOutput(chunk);
      const msg = chunk.toString().trim();
      if (msg && !announced) process.stderr.write(msg + '\n');
    });
  }

  tunnelProc.on('exit', (code) => {
    if (!announced) {
      console.error(`[Share] Tunnel exited early (code ${code}). Check your internet connection.`);
    }
    cleanup();
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error('[Share] Error:', err.message);
  process.exit(1);
});
