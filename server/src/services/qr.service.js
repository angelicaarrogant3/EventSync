const QRCode = require('qrcode');
const { generateSignedQrToken, verifySignedQrToken } = require('../utils/crypto');

/**
 * Generate a Base64 PNG Data URL for a QR token
 */
async function generateQrDataUrl(qrToken) {
  try {
    return await QRCode.toDataURL(qrToken, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 8,
      color: {
        dark: '#0f172a',  // Slate 900
        light: '#ffffff'
      }
    });
  } catch (err) {
    throw new Error('Failed to generate QR Code image: ' + err.message);
  }
}

/**
 * Creates a signed token and its corresponding QR image Data URL
 */
async function createSignedQrCode(registrationId, eventId) {
  const qrToken = generateSignedQrToken(registrationId, eventId);
  const qrDataUrl = await generateQrDataUrl(qrToken);
  return { qrToken, qrDataUrl };
}

module.exports = {
  createSignedQrCode,
  generateQrDataUrl,
  verifySignedQrToken
};

