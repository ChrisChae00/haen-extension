# docs — 이 프로젝트의 기록

두 층으로 나뉜다. **커밋되는 것은 "무슨 일이 있었나"**, 커밋 안 되는 것은 **"다음에 뭘 하나"**.

```
docs/                       ← 커밋됨. 오래 남는 기록
  README.md                 이 파일
  RESULTS-LOG.md            성과 요약 · 이력서용 수치 (복습 시작점)
  ENGINEERING-LOG.md        문제 · 원인 · 해결 · 결과 (측정기 결함, 반증된 가설, 개선 기록)
  MEASUREMENT-NOTES.md      측정 정확도 문제의 발견 경위와 판단 근거
  EXTENSION-AUDIT.md        확장 pre-ship 감사 (2026-07, 디자인 개편 이전)
  local/                    ← .gitignore. 세션마다 갱신되는 작업 문서
    HANDOFF.md              **재개 전용** — 지금 상태, 다음 명령, 환경 함정. 끝난 일은
                            ENGINEERING-LOG로 옮겨 길이를 일정하게 유지한다
    FINETUNING.md           개선 트랙 계획서 — 목표, 교사 선정, 학습 절차, 결정 항목
    EVIDENCE.md             저장소 전수 조사 스냅샷 (file:line 근거)
```

저장소 안의 다른 기록:

| 파일 | 내용 | 커밋 |
|---|---|---|
| `bench/REPORT.md` | **모델 비교표의 원본.** `generate_summary_report.py`가 생성 | ✅ |
| `bench/results/<run-id>/` | 원본 예측·metrics·run별 리포트 | ❌ (용량·비용 때문) |
| `bench/README.md` | 하네스 사용법 | ✅ |
| `bench/configs/README.md` | config 필드 의미와 함정 | ✅ |
| `README.md` (루트) | 제품 소개 + 엔지니어링 하이라이트 | ✅ |

## 어디부터 읽나

- **성과·수치가 궁금하면** → `RESULTS-LOG.md`
- **다음에 뭘 할지** → `local/FINETUNING.md` 12.8절
- **뭐가 잘못됐고 어떻게 고쳤는지** → `ENGINEERING-LOG.md`
- **왜 이렇게 쟀는지** → `MEASUREMENT-NOTES.md`(초기 4건 상세)
- **지금 숫자가 얼마인지** → `bench/REPORT.md` ← **충돌하면 항상 이게 최신**

## 규칙

1. **수치의 단일 출처는 `bench/REPORT.md`.** 다른 문서에 숫자를 옮겨 적을 때는 날짜를 붙인다
2. 작업이 끝날 때마다 (a) 왜 했는지 (b) 전/후 수치 (c) 다음 계획을 남긴다.
   수치는 **신뢰 한계**(표본 크기, run 수, CI)까지 같이 적는다 — 그래야 나중에 방어된다
3. `local/`은 커밋하지 않는다. 계획서가 저장소에 영구히 쌓이지 않게 하려는 것이고,
   기록으로 남길 가치가 생기면 `docs/`의 커밋되는 문서로 승격시킨다
