# Haen Extension — Pre-ship Audit Report

## What Was Fixed

### Accessibility
- **Focus rings** — Added `:focus-visible` outline (`2px solid var(--color-border-focus)`) to every interactive element: `.btn-translate`, `.result-tab`, `.btn-copy`, `.btn-copy-mini`, `.btn-retry`, `.btn-go-settings`, `.btn-icon-sm`, `.btn-save`, `.hdr-icon`, `.seg-ctrl button`, `.toggle`. Previously only `<textarea>` and `.api-input` had focus styles.

### i18n / Locale
- **`pref_dark_hint` fallback mismatch** — `popup.html` fallback text said "시스템 설정 따름" but `ko.json` value was "어두운 테마 사용". Fixed to match.

### Edge Cases
- **Whitespace-only input** — Translate button was enabled when input was all spaces (raw `length > 0`). Now checks `trim().length === 0` to keep button disabled.
- **AbortController (popup)** — `doTranslate()` now creates an `AbortController` per request and calls `abort()` before starting a new one. The port is disconnected on abort, preventing stale callbacks from firing.
- **AbortController (background)** — `background.js` streaming handler creates an `AbortController` tied to `port.onDisconnect`. Fetch is cancelled when popup closes mid-request; chunk/done messages are suppressed after abort.
- **SSE chunk boundary bug** — `_handleStream` previously reset `accumulated = ''` after each read, silently dropping partial SSE lines that spanned two TCP packets. Fixed to use a `lineBuffer` that retains trailing incomplete lines across reads.
- **30-second client timeout** — `apiClient.js` now wraps every fetch with a 30s `AbortController` timeout. Previously fetch could hang indefinitely if Groq stalled.
- **`AbortSignal.any()`** — Caller signal and timeout signal are combined so whichever fires first wins.

## Known Limitations

| Area | Issue |
|---|---|
| Contrast | `--color-ink-300` used for placeholders, char counter, hints, and secondary labels is likely below WCAG AA 4.5:1 on white backgrounds. These are decorative/secondary elements so WCAG allows AA Large (3:1), but borderline cases exist. |
| Rate limit | 429 error shows generic "Too many requests" with no retry-after countdown. Groq returns a `retry-after` header but we don't surface it in the UI. |
| Offline detection | Network errors from `fetch()` throw `NetworkError`, but navigator.onLine is not checked proactively. The error message is correct but appears only after the request fails, not instantly. |
| Locale keys | 6 keys defined in both locale files but unused in code: `app_name`, `app_tagline`, `btn_back`, `btn_translating`, `error_empty_input`, `error_too_long`. Dead weight but harmless. |
| CSP | No explicit `content_security_policy` in manifest.json. MV3 defaults restrict eval and inline scripts, which is sufficient, but an explicit policy would be more defensive. |
| `AbortSignal.any()` | Chrome 116+ only. Earlier Chrome versions will throw. Extension targets modern Chrome so this is acceptable. |

## Recommended Next Steps Before Shipping

1. **Contrast audit** — Run the final palette through a contrast checker (e.g. Colour Contrast Analyser). Raise `--color-ink-300` slightly in light mode if it fails 3:1 for the hint/counter text.

2. **Retry-after for 429** — Parse the `Retry-After` response header in `apiClient.js` and include it in `RateLimitError`. Expose it in the error UI: "Rate limit hit. Try again in Xs."

3. **Clean up unused locale keys** — Remove `app_name`, `app_tagline`, `btn_back`, `btn_translating`, `error_empty_input`, `error_too_long` from both locale files to reduce confusion when adding future strings.

4. **Add explicit CSP to manifest.json**:
   ```json
   "content_security_policy": {
     "extension_pages": "script-src 'self'; object-src 'none';"
   }
   ```
   This makes the restriction explicit and future-proof.

5. **E2E smoke test** — Before publishing to Chrome Web Store, verify the full flow:
   - Fresh install → no API key → enter key in Settings → translate → copy
   - Switch KO ↔ EN and confirm nuance language changes
   - Dark mode toggle persists across popup reopen
   - 500-char paste attempt is blocked
   - Offline: translate shows network error, retry works when back online
