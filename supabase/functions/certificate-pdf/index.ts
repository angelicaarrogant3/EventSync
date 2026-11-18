// Supabase Edge Function: certificate-pdf
// Generates an A4 landscape PDF certificate on demand from the frozen layout_snapshot
// stored in public.certificates, embedding fonts and drawing the verification QR code.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import QRCode from 'https://esm.sh/qrcode@1.5.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

export const CERTIFICATE_TITLE = 'CERTIFICATE OF PARTICIPATION';

function hexToRgb(hex: string) {
  const m = String(hex || '#1c1917').replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const adminClient = createClient(supabaseUrl, serviceKey);

    const { event_id } = await req.json();
    if (!event_id) {
      return new Response(JSON.stringify({ error: 'event_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Issue or fetch existing certificate via transactional RPC
    const { data: cert, error: rpcErr } = await userClient.rpc('issue_my_certificate', { p_event_id: event_id });
    if (rpcErr) {
      return new Response(JSON.stringify({ error: rpcErr.message }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const snap = cert.layout_snapshot || {};
    const W = Number(snap.width) || 2000;
    const H = Number(snap.height) || 1414;
    const values = snap.values || {};
    const fields = Array.isArray(snap.fields) ? snap.fields : [];

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([W, H]);

    const fontSerifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    const fontSerifItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
    const fontSans = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSansBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontMono = await pdfDoc.embedFont(StandardFonts.CourierBold);

    // Draw uploaded template background (using service role to read private storage bucket) or default system design
    if (snap.file_path && snap.mime_type !== 'system/default') {
      const { data: blob } = await adminClient.storage.from('certificate-templates').download(snap.file_path);
      if (blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (snap.mime_type === 'application/pdf') {
          const tplPdf = await PDFDocument.load(bytes);
          const [embeddedPage] = await pdfDoc.embedPdf(tplPdf, [0]);
          page.drawPage(embeddedPage, { x: 0, y: 0, width: W, height: H });
        } else {
          const img = snap.mime_type === 'image/png'
            ? await pdfDoc.embedPng(bytes)
            : await pdfDoc.embedJpg(bytes);
          page.drawImage(img, { x: 0, y: 0, width: W, height: H });
        }
      }
    } else {
      // Built-in default system design
      page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.99, 0.985, 0.97) });
      page.drawRectangle({ x: 60, y: 60, width: W - 120, height: H - 120, borderColor: rgb(0.6, 0.1, 0.1), borderWidth: 14 });
      page.drawRectangle({ x: 84, y: 84, width: W - 168, height: H - 168, borderColor: rgb(0.7, 0.33, 0.04), borderWidth: 3 });

      const drawCentered = (text: string, yTop: number, font: any, size: number, color: any) => {
        const tw = font.widthOfTextAtSize(text, size);
        page.drawText(text, { x: (W - tw) / 2, y: H - yTop, size, font, color });
      };
      drawCentered('BILIRAN PROVINCE STATE UNIVERSITY — MAIN CAMPUS', 190, fontSerifBold, 30, rgb(0.5, 0.11, 0.11));
      drawCentered(CERTIFICATE_TITLE, 340, fontSerifBold, 66, rgb(0.11, 0.1, 0.09));
      drawCentered('This is to certify that', 450, fontSerifItalic, 28, rgb(0.27, 0.25, 0.24));
      drawCentered('has participated in', 695, fontSerifItalic, 28, rgb(0.27, 0.25, 0.24));
    }

    // Draw each field box from layout_snapshot
    const origin = req.headers.get('origin') || '';
    for (const f of fields) {
      const type = String(f.type || '');
      const bx = Number(f.x) || 0;
      const by = Number(f.y) || 0;
      const bw = Number(f.width) || 400;
      const bh = Number(f.height) || 50;

      if (type === 'qr_code') {
        const verifyUrl = `${origin}/verify/${encodeURIComponent(cert.certificate_code)}`;
        const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: Math.max(bw, 220), margin: 1 });
        const qrBase64 = qrDataUrl.split(',')[1];
        const qrBytes = Uint8Array.from(atob(qrBase64), c => c.charCodeAt(0));
        const qrImg = await pdfDoc.embedPng(qrBytes);
        page.drawImage(qrImg, { x: bx, y: H - by - bh, width: bw, height: bh });
        continue;
      }

      const rawText = String(values[type] ?? '').trim();
      if (!rawText) continue;

      const font = f.font === 'serif' ? fontSerifBold
        : f.font === 'script' ? fontSerifItalic
        : f.font === 'mono' ? fontMono
        : (type === 'participant_name' || type === 'event_name' ? fontSansBold : fontSans);

      let fontSize = Number(f.size) || 28;
      if (f.auto_shrink !== false) {
        while (fontSize > 10 && font.widthOfTextAtSize(rawText, fontSize) > bw - 12) {
          fontSize -= 1;
        }
      }
      const tw = font.widthOfTextAtSize(rawText, fontSize);
      const tx = f.alignment === 'left' ? bx
        : f.alignment === 'right' ? bx + Math.max(bw - tw, 0)
        : bx + Math.max((bw - tw) / 2, 0);
      const ty = H - by - (bh + fontSize * 0.72) / 2;

      page.drawText(rawText, {
        x: tx,
        y: ty,
        size: fontSize,
        font,
        color: hexToRgb(f.color || '#1c1917')
      });
    }

    const pdfBytes = await pdfDoc.save();
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${cert.certificate_code}.pdf"`
      }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Failed to generate certificate PDF' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
