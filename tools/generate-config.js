// Writes js/config.js from environment variables (used by Vercel/Netlify builds).
// If the variables are not set, the committed placeholder config is left untouched.
const fs = require('fs');
const path = require('path');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log('[generate-config] SUPABASE_URL / SUPABASE_ANON_KEY not set - keeping js/config.js as is.');
  process.exit(0);
}
const out = `export const CONFIG = {\n  SUPABASE_URL: ${JSON.stringify(url)},\n  SUPABASE_ANON_KEY: ${JSON.stringify(key)}\n};\n`;
fs.writeFileSync(path.join(__dirname, '..', 'js', 'config.js'), out);
console.log('[generate-config] js/config.js written from environment.');
