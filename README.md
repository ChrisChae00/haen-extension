# Haen (하엔)

**한국어와 영어를 잇는 AI 번역기**  
Smart AI translator for Korean ↔ English

A Chrome Extension (Manifest V3) that translates between Korean and English with nuance explanation and alternative expressions, powered by Groq AI.

---

## Features

- **3 translation modes** — Literal (직역), Nuance (뉘앙스), Alternatives (대체표현)
- **Auto language detection** — detects Korean or English automatically
- **Bilingual UI** — switch between Korean and English interface
- **Keyboard shortcut** — `Cmd+Shift+T` (Mac) / `Ctrl+Shift+T` (Windows/Linux)
- **Dark mode** — follows system setting
- **Auto-copy** — optionally copies result on completion

## Project Structure

```
haen-extension/
├── manifest.json        # Chrome Extension manifest (MV3)
├── popup.html           # Popup UI
├── background.js        # Service worker
├── styles.css           # Design tokens + component styles
├── src/
│   ├── popup.js         # Popup controller (event wiring, state)
│   ├── i18n.js          # Locale loader + t() helper
│   ├── apiClient.js     # Groq API client
│   ├── prompts.js       # Translation prompt templates
│   └── storage.js       # chrome.storage.local wrapper
├── locales/
│   ├── ko.json          # Korean strings
│   └── en.json          # English strings
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Getting Started

### 1. Get a Groq API key

Sign up at [console.groq.com](https://console.groq.com) and create an API key (starts with `gsk_`).

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

### 3. Configure

Click the extension icon → **⚙ Settings** → paste your Groq API key → Save.

## Supported Models

| Model         | Speed    | Notes             |
| ------------- | -------- | ----------------- |
| Llama 4 Scout | Fast     | Default           |
| Qwen3 32B     | Moderate | Higher accuracy   |
| Gemma 2 9B    | Stable   | Reliable fallback |

## i18n

UI language can be toggled between Korean and English via the `KO / EN` segment in the header or in Settings.

To add a new locale, copy `locales/ko.json`, translate the values, and add the language to `src/i18n.js`.

## Design

Design tokens follow the **Warm Slate** palette defined in `styles.css`. See `design-system.md` for the full spec (colors, typography, spacing, components).

---

Haen v0.1.0 · Made with ♥ by Chae
