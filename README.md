# Haen (하엔)

**문화적 맥락을 이해하는 한국어-영어 AI 번역기**  
A Korean ↔ English AI translator that bridges the cultural gap, not just the language gap.

A modern Chrome Extension (Manifest V3) integrated directly into the browser's Side Panel, powered by advanced LLMs via Groq, OpenRouter, and Google AI Studio.

---

## 🎯 Why Haen?

Literal translations are easy, but they often strip away the cultural context, tone, and nuances that make communication natural. 
Haen goes beyond simple word-for-word translation by explaining the **cultural nuance behind the expression**, adapting its explanation based on the user's primary language:

- **English-Primary Users**: Answers in English, explaining the cultural context of Korean expressions.
- **Korean-Primary Users**: Answers in Korean, explaining the cultural context of English expressions.

---

## 🚀 Key Engineering Highlights

Built with a focus on performance, reliability, and user experience, Haen showcases several modern web and extension development practices:

- **Progressive Rendering (Streaming)**: Implemented field-by-field progressive rendering of streamed JSON responses, drastically reducing perceived latency.
- **Resilient API Architecture**: Features local response caching to serve repeated translations instantly, automatic retry logic for transient network failures, and precise HTTP-level error mapping.
- **Modern Chrome Extension APIs (MV3)**: Fully integrated into the Chrome Side Panel for a persistent user workflow, strictly adhering to Manifest V3 Content Security Policy (CSP) with a modular architecture.
- **Robust Design System & A11y**: Built a custom token-based theme engine enforcing accessibility contrast standards, with seamless 3-way theme control (Light/Dark/System) and smooth transitions.
- **Multi-Provider LLM Support**: Dynamically handles APIs from Groq, OpenRouter, and Google (Gemini), automatically adjusting payload parameters based on provider requirements.

---

## ✨ Features

- **Side Panel Integration** — Persistent, easily accessible UI that opens automatically upon browser action clicks.
- **Smart Translation Modes**:
  - **Idiomatic (자연스러운 표현)** — The headline result is always an idiomatic, natural translation.
  - **Literal (직역)** — Optional secondary note for word-for-word meaning.
  - **Nuance (뉘앙스)** — Explains the context, mood, and emotion of the expression.
  - **Alternatives (대체표현)** — Provides 2~4 situational alternatives (e.g., casual, formal).
- **Auto Language Detection & Direction** — Set to KO→EN, EN→KO, or Auto.
- **Translation History** — Automatically saves the last 50 translations locally.
- **Bilingual UI** — Toggle UI language between Korean and English.
- **Keyboard Shortcut** — `Cmd+Shift+T` (Mac) / `Ctrl+Shift+T` (Windows/Linux).
- **Auto-copy** — Automatically copies the result to the clipboard (optional).

---

## 🛠 Project Structure

```text
haen-extension/
├── manifest.json        # Chrome Extension Manifest (MV3)
├── panel.html           # Side Panel UI (Replaced popup)
├── background.js        # Service Worker (State & Panel management)
├── styles/              # Token-based CSS design system
│   ├── base.css
│   ├── components.css
│   └── tokens.css
├── src/
│   ├── apiClient.js     # Multi-provider API client (Streaming, Retry, Caching)
│   ├── theme.js         # CSP-compliant theme module
│   ├── popup.js         # Side panel controller logic
│   ├── i18n.js          # Locale loader
│   ├── prompts.js       # Context-aware translation prompts
│   └── storage.js       # chrome.storage.local wrapper
└── locales/             # ko.json, en.json
```

---

## ⚙️ Getting Started

### 1. Get an API key
- **Google AI Studio**: Gemini models (`AIza...`)
- **Groq**: Llama / Qwen models (`gsk_...`)
- **OpenRouter**: Access to various models (`sk-or-...`)

Haen automatically detects which provider to use based on your key prefix.

### 2. Load the extension
1. Open `chrome://extensions` in your browser.
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked** and select the `haen-extension` directory.

### 3. Configure
1. Click the Haen extension icon to open the Side Panel.
2. Go to **⚙ Settings**.
3. Paste your API key and set your **Main Language** (KO or EN).

---

## 🧠 Supported Models

| Provider | Recommended Models | Notes |
|---|---|---|
| **Google AI Studio** | Gemini 2.5 Flash / Pro | Excellent for nuance and idiomatic expressions. |
| **Groq / OpenRouter** | Llama 3.3 70B, Qwen3 32B | Fast and highly accurate multilingual models. |

---

## 🎨 Design

Built with a custom token-based design system featuring a **Warm Slate** palette. The UI is designed for readability with a system font stack, an `ae` ligature logo, and strictly enforced contrast ratios for accessibility.

---

*Haen v0.2.0 · Made with ♥ by Chae*
