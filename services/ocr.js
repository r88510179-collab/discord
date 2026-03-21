// OCR Service — extracts text from bet slip images via OCR.space API
// Requires OCR_SPACE_API_KEY environment variable

const OCR_API_URL = 'https://api.ocr.space/parse/imageurl';

/**
 * Extract text from an image URL using the OCR.space free API.
 * @param {string} imageUrl - Public URL of the image to scan
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
    const params = new URLSearchParams({
      apikey: apiKey,
      url: imageUrl,
      language: 'eng',
      isOverlayRequired: 'false',
      detectOrientation: 'true',
      scale: 'true',
      OCREngine: '2',
    });

    const res = await fetch(`${OCR_API_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'BetTracker-Discord/1.0' },
    });

    if (!res.ok) {
      console.error(`[OCR] HTTP ${res.status}: ${(await res.text()).substring(0, 100)}`);
      return null;
    }

    const data = await res.json();

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
