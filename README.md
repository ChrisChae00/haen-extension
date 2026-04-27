# Haen (하엔)

**문화적 맥락을 이해하는 한국어-영어 AI 번역기**  
A Korean ↔ English AI translator that bridges the cultural gap, not just the language gap.

A Chrome Extension (Manifest V3) powered by Groq or OpenRouter AI.

---

## Why Haen?

직역은 쉬워. 하지만 같은 말이라도 한국에서 쓰는 맥락, 분위기, 문화적 배경은 번역기가 알려주지 않아.

Haen은 단순 번역을 넘어 **표현 뒤에 있는 문화적 뉘앙스**를 설명해줘. 그리고 유저의 메인 언어에 따라 설명의 방향이 달라져.

- **영어가 메인인 유저**: 답변은 영어로, 설명은 한국 문화 기준으로 — 한국어 표현이 어떤 맥락에서 쓰이는지 알 수 있도록
- **한국어가 메인인 유저**: 답변은 한국어로, 설명은 영미 문화 기준으로 — 영어 표현이 어떤 상황에서 자연스러운지 알 수 있도록

자기 언어의 뉘앙스는 이미 알아. Haen은 **모르는 쪽 언어의 문화**를 알려줘.

---

## Features

- **Main language setting** — KO / EN 중 하나를 메인 언어로 설정. 답변 언어와 문화적 설명의 기준이 이에 따라 결정됨
- **3 translation modes**
  - **Literal (직역)** — 원문에 가장 가까운 단어 대 단어 번역
  - **Nuance (뉘앙스)** — 이 표현이 실제로 어떤 맥락, 분위기, 감정에서 쓰이는지
  - **Alternatives (대체표현)** — 상황별 (가볍게 / 격식 / 일반적 등) 원어민 표현 2~4개 카테고리
- **Translation direction control** — Auto / KO→EN / EN→KO 선택 가능
- **Auto language detection** — 방향이 Auto일 때 입력 언어 자동 감지
- **Translation history** — 최근 50건 자동 저장
- **Dual API provider support** — Groq (`gsk_`) 또는 OpenRouter (`sk-or-`) API 키 모두 지원
- **Bilingual UI** — 헤더 또는 설정에서 KO / EN UI 전환
- **Keyboard shortcut** — `Cmd+Shift+T` (Mac) / `Ctrl+Shift+T` (Windows/Linux)
- **Dark mode** — 시스템 설정 자동 반영 또는 수동 설정
- **Auto-copy** — 번역 완료 시 결과 자동 복사 (옵션)

---

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
│   ├── apiClient.js     # Groq / OpenRouter API client
│   ├── prompts.js       # Translation prompt templates (KO / EN variants)
│   └── storage.js       # chrome.storage.local wrapper
├── locales/
│   ├── ko.json          # Korean strings
│   └── en.json          # English strings
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Getting Started

### 1. Get an API key

- **Groq**: [console.groq.com](https://console.groq.com) → API key starts with `gsk_`
- **OpenRouter**: [openrouter.ai](https://openrouter.ai) → API key starts with `sk-or-`

Haen automatically detects which provider to use based on your key prefix.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

### 3. Configure

Click the extension icon → **⚙ Settings**:
- Paste your API key → Save
- Set your **Main Language** (KO or EN) — this controls both the response language and the cultural frame of reference

---

## Supported Models

| Model | Provider | Speed | Notes |
|---|---|---|---|
| Llama 4 Scout | Groq / OpenRouter | Fast | Default |
| Llama 3.3 70B | Groq / OpenRouter | Moderate | Higher accuracy |
| Qwen3 32B | Groq / OpenRouter | Moderate | Strong multilingual |
| Gemma 2 9B | Groq / OpenRouter | Stable | Reliable fallback |

---

## i18n

UI language toggles between Korean and English via the `KO / EN` segment in the header or Settings.

To add a new locale, copy `locales/ko.json`, translate the values, and register the language in `src/i18n.js`.

---

## Design

Design tokens follow the **Warm Slate** palette defined in `styles.css`. See `design-system.md` for the full spec (colors, typography, spacing, components).

---

Haen v0.1.0 · Made with ♥ by Chae
