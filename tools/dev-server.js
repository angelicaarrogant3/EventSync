const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('serve-handler');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'serve.json'), 'utf8'));
const port = Number(process.env.PORT) || 8080;

const server = http.createServer((req, res) => handler(req, res, { public: root, ...config }));
server.listen(port, '127.0.0.1', () => {
  console.log(`\n  EventSync local test server:\n  - Local: http://localhost:${port}\n`);
});
