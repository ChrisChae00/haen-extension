# Haen 디자인 전면 개편 — 설계 문서

작성일: 2026-07-28

## 1. 목표

1. 모던하고 깔끔한 비주얼로 전면 개편한다.
2. 라이트/다크 두 모드 모두에서 가독성이 떨어지는 구간이 없게 한다. 전환도 자연스럽게.
3. 로고를 재구성한다.
4. 확장을 열고 페이지의 다른 곳을 클릭해도 닫히지 않게 한다.

## 2. 확정된 결정

| 항목 | 결정 |
|---|---|
| 창 형태 | Chrome Side Panel 단독 전환 |
| 비주얼 톤 | 뉴트럴 미니멀 — 진한 헤더 바 제거, 헤더도 본문과 같은 서피스 |
| 팔레트 온도 | 기존 웜 크림 유지 (`#f7f6f3` / `#161514` 그대로) |
| 액센트 | 보라 계열 (기존 로고 색 승격) |
| 로고 | `æ` 합자 마크 + 소문자 `haen` 워드마크 |
| 한글 폰트 | 시스템 스택 (네트워크 요청 0) |
| 진입점 파일명 | `popup.html` → `panel.html` 리네임 |

## 3. 현재 상태 진단

개편의 근거가 되는 구조적 결함 셋. 표면을 고치는 게 아니라 이 셋을 제거하는 것이 작업의 본질이다.

### 원인 A — 하드코딩된 색이 테마 시스템을 우회함

| 위치 | 문제 |
|---|---|
| `styles.css:120` | 헤더 배경이 `var(--color-ink-900)`. 다크 테마에서 이 토큰은 `#f0ede8`(밝은 크림)이 되어 헤더가 밝아짐 |
| `styles.css:128` | 워드마크 `color:#fff` 고정 → **다크모드에서 밝은 배경 + 흰 글씨로 사실상 안 보임** |
| `styles.css:132,140,143,147` | `#3a3631` `#2a2521` `#888` `#ddd` 고정. 테마 무관하게 항상 동일 |
| `popup.html:18-23` | 로고 SVG `fill="white"`, `stroke="#c4b5fd"` 고정 |
| `popup.html:146-147` | 인라인 `style="color:…;background:…"`가 CSS 특정성에서 이겨 JS 토글 결과를 덮어씀 |

### 원인 B — 텍스트 토큰이 대비 기준을 위반함

`--color-ink-300`(`#a09c96`)은 흰 배경에서 **2.73:1**. WCAG AA 최소 기준 4.5:1에 크게 미달한다. 다크 테마의 대응값 `#635f5a`도 `#1e1c1a` 위에서 **2.68:1**로 동일하게 실패한다.

이 토큰이 쓰이는 곳: 글자 수 카운터(`.char-counter`), 빈 상태 안내(`.result-empty`), 설정 힌트(`.settings-hint`), `.alt-sub`, `.badge-tone`, `.literal-note`, `.tip-label`, `.about-line`, `.settings-section-title`, `.api-input-label`, `.btn-copy-mini`, `.hdr-icon`.

즉 저대비 구간은 국소적 결함이 아니라 **보조 텍스트 전체**다.

### 원인 C — 액센트 토큰 하나가 상반된 두 역할을 겸함

`--color-accent`가 동시에 쓰이는 곳:
- `.btn-translate` 배경 (위에 흰 글씨가 올라감 → **어두워야** 함)
- `.result-tab.active` 글자색 (흰 배경 위에 놓임 → **어두워야** 함)
- `.toggle.on` 배경, `.badge-lang` 글자색

라이트 테마에서는 우연히 양립하지만, 다크 테마에서 `--color-accent`를 밝게 올리는 순간 버튼 위 흰 글씨가 무너진다. 한 토큰으로는 구조적으로 양쪽을 만족시킬 수 없다.

## 4. 컬러 시스템

### 4.1 토큰 명명 규칙

역할 기반으로 재명명한다. `ink-300` 같은 숫자 스케일은 "어디에 써도 되는지"를 알려주지 않아서 원인 B를 유발했다.

```
--surface-base        패널 최외곽 배경
--surface             카드·헤더·입력창 배경
--surface-sunken      눌린 영역 (셀렉트, 팁 카드, 비활성 세그먼트)
--surface-hover       호버 상태

--border              기본 1px 구분선
--border-strong       입력창 테두리 등 강조 경계

--text-primary        본문·번역 결과·제목
--text-secondary      힌트·라벨·카운터 등 모든 보조 텍스트
--nontext-muted       아이콘 획, 장식 글리프, 구분 요소. 텍스트 금지

--fill-accent         액센트 배경 (버튼, 켜진 토글)
--on-accent           --fill-accent 위에 올라가는 글자색
--text-accent         서피스 위 액센트 글자 (활성 탭, 링크)

--fill-success / --on-success / --text-success / --surface-success
--fill-danger  / --on-danger  / --text-danger  / --surface-danger
--fill-warning / --on-warning / --text-warning / --surface-warning
```

### 4.2 대비 규약 (강제)

- `--text-primary`, `--text-secondary`는 놓일 수 있는 **모든** 서피스(`--surface`, `--surface-base`, `--surface-sunken`) 위에서 **4.5:1 이상**.
- `--on-accent`는 `--fill-accent` 위에서 **4.5:1 이상**. 다른 시맨틱 쌍도 동일.
- `--text-accent` 및 시맨틱 텍스트 색은 모든 서피스 위에서 **4.5:1 이상**.
- `--nontext-muted`는 대비 요구 없음. 단 **정보를 단독으로 전달하는 텍스트에 사용 금지**. 이 규칙 위반은 코드 리뷰에서 잡는다.

### 4.3 텍스트 계층이 2단계인 이유

크림 배경 위에서 4.5:1을 만족하려면 회색이 `#6c6863`보다 어두워야 하는데, 이는 현재의 `--color-ink-500`(`#6b6864`)과 사실상 같은 값이다. 따라서 "primary / secondary / tertiary" 3단 색 계층은 크림 팔레트에서 성립하지 않는다 — 아래 둘이 같은 색으로 수렴한다.

**색 계층을 2단으로 줄이고, 그 이하의 위계는 크기·굵기·여백으로 표현한다.** 이는 제약에 대한 타협이 아니라 목표 2에 대한 정직한 해법이다.

### 4.4 라이트 테마 값

```
--surface-base      #f7f6f3
--surface           #ffffff
--surface-sunken    #f0ede8
--surface-hover     #ebe7e1
--border            #e3e0da
--border-strong     #d3cec6

--text-primary      #191817     16.7:1 (on #fff) / 14.2:1 (on sunken)
--text-secondary    #5c5955      6.9:1 (on #fff) /  5.9:1 (on sunken)
--nontext-muted     #a09c96     대비 요구 없음, 텍스트 금지

--fill-accent       oklch(48% 0.17 292)
--on-accent         #ffffff      5.0:1
--text-accent       oklch(45% 0.18 292)   4.9:1 (on sunken, 최악 케이스)
```

### 4.5 다크 테마 값

```
--surface-base      #161514
--surface           #1e1c1a
--surface-sunken    #272421
--surface-hover     #2f2b27
--border            #35322e
--border-strong     #454039

--text-primary      #f0ede8     14.5:1 (on surface) / 12.6:1 (on sunken)
--text-secondary    #9a9690      5.8:1 (on surface) /  5.2:1 (on sunken)
--nontext-muted     #6b6762     대비 요구 없음, 텍스트 금지

--fill-accent       oklch(48% 0.17 292)   ← 라이트와 동일값
--on-accent         #ffffff      5.0:1
--text-accent       oklch(75% 0.13 292)   7.2:1 (on sunken, 최악 케이스)
```

### 4.6 시맨틱 색 (success / danger / warning)

값은 구현 시 확정하되, 액센트와 **동일한 4쌍 구조**(`--fill-*` / `--on-*` / `--text-*` / `--surface-*`)를 따르고 4.2절 대비 규약을 똑같이 적용한다. 별도 예외를 두지 않는다.

현재 코드의 `--color-danger-tint` 등은 `--surface-danger`로, 에러 제목에 쓰이는 `--color-danger`는 `--text-danger`로 매핑된다. `.error-box`처럼 틴트 배경 위에 시맨틱 텍스트가 올라가는 경우, `--text-*`는 해당 `--surface-*` 위에서도 4.5:1을 만족해야 한다.

### 4.7 액센트 값이 테마 간 동일한 이유

`--fill-accent`가 두 테마에서 같은 값인 것은 의도된 것이다. 채우기용 보라는 크림 위에서도 근검정 위에서도 잘 읽힌다. 반면 `--text-accent`는 테마별로 크게 달라야 한다 — 이것이 fill/text 분리의 실질적 이유다.

### 4.8 검증

`scripts/check-contrast.mjs`를 추가한다. `tokens.css`를 파싱해 4.2절 규약을 전부 계산하고, 위반 시 0이 아닌 종료 코드와 함께 위반 쌍·실측 비율을 출력한다. 의존성 없이 Node 내장 모듈만 사용한다.

이 스크립트가 있어야 나중에 토큰을 손댈 때 원인 B가 재발하지 않는다.

## 5. 테마 전환

### 5.1 3단 컨트롤

현재는 2단 온/오프 토글이다. `storage.js:22`의 기본값이 `'auto'`인데도 `popup.js:59-60`이 최초 1회 시스템 값을 읽어 구체값(`'dark'` 또는 `'light'`)으로 덮어쓰기 때문에, **이후로는 시스템 설정 변경을 영원히 따라가지 않는다.**

`시스템 / 라이트 / 다크` 3단 세그먼트 컨트롤로 교체한다.
- 저장값은 `'system' | 'light' | 'dark'`. `'system'`일 때 구체값으로 덮어쓰지 않는다.
- `'system'`이면 `matchMedia('(prefers-color-scheme: dark)')`에 `change` 리스너를 붙여 실시간 반영한다.
- 기존 `'auto'` 저장값은 로드 시 `'system'`으로 마이그레이션한다.

### 5.2 첫 페인트 깜빡임 제거

`chrome.storage`는 비동기라, 패널이 뜬 뒤 JS가 실행되고 나서야 테마가 적용된다. 다크 사용자는 매번 흰 화면 번쩍임을 본다.

테마 값만 `localStorage`에 미러링하고, `panel.html`의 `<head>`에 인라인 스크립트를 넣어 동기적으로 `data-theme`을 세팅한다. `chrome.storage`가 여전히 정본(source of truth)이며, `localStorage`는 첫 페인트 전용 캐시다. 값이 어긋나면 `chrome.storage` 쪽이 이긴다.

### 5.3 전환 애니메이션

- `background-color`, `color`, `border-color`에 **220ms** 이징 (`--ease-out`).
- **`*` 선택자를 쓰지 않는다.** 패널 전 요소에 트랜지션을 걸면 리페인트 비용이 커서 오히려 버벅인다. 컨테이너 레벨 선택자에만 걸고 자식은 색 상속으로 따라오게 한다.
- 초기 로드 시 `<html>`에 `.no-transition`을 붙이고 첫 프레임 후 제거한다. 패널 진입 시 애니메이션이 튀는 것을 막는다.
- `@media (prefers-reduced-motion: reduce)`에서 전환 시간을 0으로 한다.
- `:root`에 `color-scheme: light` / `dark`를 세팅해 스크롤바와 기본 폼 컨트롤까지 테마를 따르게 한다.

## 6. 로고

### 6.1 마크

`æ`는 문자 그대로 a와 e의 합자이며, 두 언어를 하나로 합친다는 제품 컨셉과 직결된다. 또한 `haen`이라는 이름에 이미 들어있는 글자다.

- **SVG 패스로 직접 그린다.** 폰트의 `æ` 글리프에 의존하면 OS마다 모양이 달라진다.
- 모든 색을 `currentColor`로 지정한다. 부모의 `color`를 상속하므로 테마 전환에 자동 대응하며, 원인 A가 재발할 수 없다.
- 헤더 배치: 20px 라운드 타일 안의 마크 + 소문자 `haen` 워드마크.

### 6.2 확장 아이콘

브라우저 툴바는 확장의 테마를 따르지 않으므로 `currentColor`가 작동하지 않는다. 아이콘용은 **`--fill-accent` 배경 + 흰 글리프로 고정**한다.

`icons/icon16.png`, `icon48.png`, `icon128.png`를 마크 단독 구성으로 재생성한다. 16px에서 뭉개지지 않도록 글리프 획 굵기를 크기별로 조정한다.

## 7. Side Panel 전환

### 7.1 변경 지점

- `manifest.json`
  - `permissions`에 `"sidePanel"` 추가
  - `"side_panel": { "default_path": "panel.html" }` 추가
  - `action.default_popup` 제거 (`action`의 아이콘 정의는 유지)
  - `minimum_chrome_version: "114"` 명시
- `background.js`
  - `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
  - 실패 시 조용히 넘어가지 않고 에러를 로깅한다
- `popup.html` → `panel.html` 리네임

`_execute_action` 커맨드(`Cmd+Shift+T`)는 side panel에서도 동작하므로 유지한다.

### 7.2 유동폭

`styles.css:100`의 `html, body { width: 420px }`가 side panel에서는 잘못이다. 사용자가 패널을 드래그로 리사이즈한다.

- `width: 100%`, `min-width: 320px`
- 좌우 패딩을 `clamp()`로 유동 처리
- 320px / 420px / 600px 세 폭에서 레이아웃이 깨지지 않아야 한다

### 7.3 세로 레이아웃 재구성

현재 레이아웃은 짧은 팝업 기준이라, 브라우저 전체 높이의 side panel에서는 아래쪽이 비고 결과 패널이 어정쩡하게 남는다.

```
<html> height: 100%
  <body> height: 100%, display: flex, flex-direction: column
    header        flex-shrink: 0   (고정)
    입력 블록      flex-shrink: 0   (방향 세그먼트 + 텍스트영역 + 번역 버튼)
    결과 패널      flex: 1, min-height: 0, overflow-y: auto   (남은 높이 전부)
```

`min-height: 0`이 없으면 flex 자식이 축소되지 않아 스크롤이 생기지 않는다.

설정 패널도 동일 구조(본문 스크롤 + 푸터 고정)를 따른다.

## 8. 타이포그래피

### 8.1 폰트

Google Fonts CDN 링크(`popup.html:6`)를 제거한다. 패널을 열 때마다 네트워크 요청이 발생하고 FOUT을 유발한다. IBM Plex Sans KR은 한글 글리프 때문에 자체 번들도 부담이 크다.

```
--font-sans: 'Pretendard', -apple-system, BlinkMacSystemFont,
             'Apple SD Gothic Neo', 'Segoe UI', 'Malgun Gothic',
             system-ui, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo,
             Consolas, monospace;
```

모노도 시스템 스택을 쓴다. 숫자·라벨 용도라 시스템 모노로 충분하며 번들 크기가 0이 된다.

### 8.2 스케일

색 계층이 2단이므로 크기와 굵기가 위계의 주된 수단이 된다. 현재 스케일(11/12/14/16/20/24)은 유지하되, 실제 사용에서 11px과 12px이 혼용되는 지점을 정리해 각 크기의 역할을 명확히 한다.

## 9. 파일 구조

`styles.css`는 461줄이며 토큰·리셋·레이아웃·전 컴포넌트가 한 파일에 섞여 있다. 이번 작업으로 더 커지므로 분리한다.

```
styles/tokens.css       디자인 토큰 (라이트/다크 두 벌). 이 파일만 보면 팔레트 전체가 보인다
styles/base.css         리셋, 타이포그래피, 테마 전환, 패널 셸 레이아웃
styles/components.css   버튼·입력·세그먼트·토글·카드·결과 패널·설정
```

`tokens.css`가 독립 파일인 것이 중요하다. 대비 검증 스크립트의 입력이 되고, 팔레트 변경 시 이 파일만 보면 된다.

## 10. JS 변경 범위

`src/popup.js`(428줄)에서 **테마 관련 부분만** 수정한다.

| 위치 | 변경 |
|---|---|
| `popup.js:55-60` | `'auto'` → `'system'` 마이그레이션, `'system'`일 때 구체값 덮어쓰기 제거 |
| `popup.js:73-75` | `applyTheme`가 `localStorage` 미러 갱신 + `color-scheme` 세팅 |
| `popup.js:88-97` | 2단 토글 로직 → 3단 세그먼트 |
| `popup.js:125` | 설정 UI 상태 반영을 3단에 맞게 |
| `popup.js:143-146` | `darkToggle` 리스너 → 세그먼트 리스너 |
| `popup.js:162-171` | 저장 시 3단 값 처리 |
| 신규 | `matchMedia` 변경 리스너 |

`src/storage.js`는 `getTheme` 기본값을 `'system'`으로 바꾼다.

**번역 로직, API 클라이언트, 프롬프트, i18n은 건드리지 않는다.** `src/apiClient.js`, `src/prompts.js`는 변경 없음.

`panel.html`의 **모든 element ID를 그대로 보존**한다(`main-textarea`, `btn-translate`, `result-content` 등). ID가 바뀌면 `popup.js` 전체를 손대야 하고 회귀 위험이 커진다. CSS 클래스명은 내부용이므로 자유롭게 정리한다.

`popup.js` 파일명은 유지한다 — 리네임하면 diff가 커져 실제 변경 내용이 묻힌다.

## 11. 로케일

`locales/ko.json`, `locales/en.json`에 3단 테마 컨트롤용 키를 추가한다: `pref_theme`, `theme_system`, `theme_light`, `theme_dark`.

기존 `pref_dark_mode`, `pref_dark_hint` 키는 제거한다.

## 12. 검증

자동 검증:
- `scripts/check-contrast.mjs` — 4.2절 대비 규약 전수 검사, 위반 시 실패

수동 검증 체크리스트:
- [ ] 라이트/다크 각각에서 모든 화면(메인 빈 상태 / 번역 결과 / 대체표현 탭 / 로딩 / 에러 / 설정)의 스크린샷을 찍어 흰 글씨-흰 배경 같은 구간이 없는지 확인
- [ ] 테마 전환 시 뚝 끊기지 않고 부드럽게 넘어가는지
- [ ] 패널을 닫았다 다시 열 때 첫 페인트에 깜빡임이 없는지 (다크 상태에서 특히)
- [ ] `시스템` 선택 후 OS 테마를 바꿨을 때 패널이 실시간으로 따라오는지
- [ ] 패널 폭 320 / 420 / 600px에서 레이아웃이 깨지지 않는지
- [ ] 페이지 본문·주소창·다른 탭을 클릭해도 패널이 닫히지 않는지
- [ ] 탭을 전환해도 패널이 유지되는지
- [ ] 확장 아이콘이 16px에서 식별 가능한지
- [ ] 키보드만으로 전 컨트롤에 도달 가능하고 포커스 링이 두 테마 모두에서 보이는지
- [ ] `prefers-reduced-motion` 활성화 시 전환 애니메이션이 없는지

## 13. 범위 밖

- 번역 품질, 프롬프트, 모델 선택 로직
- API 클라이언트, 캐싱, 재시도 로직
- 새 기능 추가 (히스토리, 즐겨찾기 등)
- `popup.js`의 테마 외 영역 리팩터링
- Firefox 등 타 브라우저 지원

## 14. 리스크

| 리스크 | 대응 |
|---|---|
| Side Panel은 Chrome 114+ 필요 | 2023년 6월 릴리스로 사실상 전 사용자 커버. `minimum_chrome_version`으로 명시 |
| 기존 사용자가 팝업이 안 열린다고 느낄 수 있음 | side panel이 열리는 것 자체가 즉각적 피드백. 별도 안내 불필요 |
| 시스템 폰트라 OS별 생김새가 다름 | 사용자 선택. 레이아웃은 폰트 폭에 의존하지 않게 유동으로 짠다 |
| 대비 계산값과 실제 렌더링 차이 | 스크립트로 검산하되 수동 스크린샷 확인을 병행 |
