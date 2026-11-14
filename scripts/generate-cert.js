#!/usr/bin/env node

/**
 * EventSync: Standalone Certificate Generator CLI
 * Generates Root CA and SAN-enabled Server Certificate for LAN HTTPS deployment.
 */

const path = require('path');
module.paths.push(path.resolve(__dirname, '../server/node_modules'));

const { getOrGenerateCertificates, CERTS_DIR } = require('../server/src/utils/cert');

console.log('Generating EventSync certificates in:', CERTS_DIR);
const result = getOrGenerateCertificates();
console.log('Certificates ready for HTTPS on port 3000!');

