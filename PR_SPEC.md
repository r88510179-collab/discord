# PR_SPEC.md

## Title
OCR Slip Scanner — extract bets from bet slip images via OCR

## Problem
Users post bet slip screenshots in Discord but the bot can only parse them via expensive multi-modal AI calls. A dedicated OCR pipeline using the free OCR.space API provides a cheaper, faster first pass for text extraction from slip images.

## Why it matters
Adding a dedicated `SLIP_FEED_CHANNEL_ID` with OCR-first processing reduces AI API costs, enables a dedicated slip intake workflow, and routes all OCR-extracted bets through the War Room for admin review before confirmation.

## Scope
1. **OCR Service** — `services/ocr.js`: `extractTextFromImage(imageUrl)` calls the OCR.space API (`https://api.ocr.space/parse/imageurl`) and returns the extracted `ParsedText`
2. **Slip Feed Handler** — `handlers/messageHandler.js`: messages in `SLIP_FEED_CHANNEL_ID` with image attachments trigger OCR → `parseBetText()` → `createBetWithLegs()` → `sendStagingEmbed()` (all bets from slips route to War Room as `needs_review`)
3. **Environment Variables** — `OCR_SPACE_API_KEY` (required for OCR) and `SLIP_FEED_CHANNEL_ID` (channel to watch for slip images)
4. **Tests** — `tests/ocr-scanner.test.js`: 5 tests covering the full OCR → parse → War Room pipeline, no-image handling, OCR failure, non-slip channel isolation, and module shape

## Non-goals
- Do not replace the existing multi-modal AI slip scanning (it remains as fallback for picks channels)
- Do not add OCR.space as a paid tier dependency
- Do not auto-confirm OCR-scanned bets (always route to War Room)

## Environment variables required
- `OCR_SPACE_API_KEY` — Free API key from https://ocr.space/ocrapi
- `SLIP_FEED_CHANNEL_ID` — Discord channel ID where slip images are posted

## Files touched
- `services/ocr.js` — NEW: extractTextFromImage using OCR.space API
- `handlers/messageHandler.js` — handleSlipFeed function, imported OCR service
- `tests/ocr-scanner.test.js` — NEW: 5 tests for OCR slip pipeline
- `tests/message-handler.integration.js` — added OCR mock to prevent import errors
- `package.json` — added ocr.js to check, ocr-scanner.test.js to test:reliability

## Required validation
- `npm run check`
- `npm run test:reliability`

## Acceptance criteria
- [ ] `services/ocr.js` calls OCR.space API and returns ParsedText
- [ ] Images in SLIP_FEED_CHANNEL_ID trigger OCR → parse → War Room flow
- [ ] All OCR-scanned bets saved with `review_status: 'needs_review'`
- [ ] Bot reacts with magnifying glass emoji on processed slips
- [ ] Non-slip channels are unaffected
- [ ] Missing OCR_SPACE_API_KEY gracefully skips OCR
- [ ] `npm run check` and `npm run test:reliability` pass
