// OCR Service — extracts text from bet slip images via OCR.space API
// Downloads image as base64 to avoid Discord CDN expiry issues.
// Requires OCR_SPACE_API_KEY environment variable

const OCR_API_URL = 'https://api.ocr.space/parse/image';

/**
 * Extract text from an image URL using the OCR.space free API.
 * Downloads the image first, converts to base64, and POSTs it.
 * @param {string} imageUrl - URL of the image to scan
 * @returns {Promise<string|null>} Extracted text or null on failure
 */
async function extractTextFromImage(imageUrl) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    console.log('[OCR] OCR_SPACE_API_KEY not set — skipping OCR scan.');
    return null;
  }

  if (!imageUrl) return null;

  try {
    // Step 1: Download image from Discord CDN
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      console.error(`[OCR] Failed to download image: HTTP ${imgRes.status}`);
      return null;
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/png';
    const base64 = `data:${contentType};base64,${buffer.toString('base64')}`;

    console.log(`[OCR] Downloaded image: ${buffer.length} bytes, type: ${contentType}`);

    // Step 2: POST base64 to OCR.space
    const formData = new URLSearchParams({
      apikey: apiKey,
      base64Image: base64,
      language: 'eng',
      isOverlayRequired: 'false',
      detectOrientation: 'true',
      scale: 'true',
      OCREngine: '2',
    });

    const res = await fetch(OCR_API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'BetTracker-Discord/1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!res.ok) {
      console.error(`[OCR] HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
      return null;
    }

    const data = await res.json();

    // Debug: log raw API response
    console.log('[OCR] Raw API response:', JSON.stringify(data).substring(0, 500));

    if (data.IsErroredOnProcessing) {
      console.error(`[OCR] API error: ${data.ErrorMessage || 'Unknown error'}`);
      return null;
    }

    const results = data.ParsedResults;
    if (!results || results.length === 0) {
      console.log('[OCR] No parsed results returned.');
      return null;
    }

    const text = results.map(r => r.ParsedText || '').join('\n').trim();
    if (!text) {
      console.log('[OCR] Empty parsed text.');
      return null;
    }

    console.log(`[OCR] Extracted ${text.length} chars from image.`);
    return text;
  } catch (err) {
    console.error('[OCR] Error:', err.message);
    return null;
  }
}

module.exports = { extractTextFromImage };
