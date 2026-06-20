# 멀티 CLI 코딩 에이전트 오케스트레이션 프레임워크 구현 계획

## 1. 제안 검토

### 문제와 사용자는 명확하다

Codex CLI, Claude Code, Gemini CLI를 함께 쓰는 개발자는 이미 각 도구의 장단점에 따라 작업을 수동으로 나누고 있다. 이 프로젝트는 그 수동 작업을 자동화하고, 동일한 설명과 저장소 내용을 매번 각 에이전트에 다시 전달하면서 생기는 토큰 낭비를 줄이는 데 의미가 있다.

다만 초기 타깃은 **여러 CLI를 이미 설치하고 인증한 개인 개발자 또는 소규모 팀**으로 좁히는 것이 좋다. 각 서비스의 계정, 인증, 사용량 정책까지 대신 관리하는 SaaS는 범위와 운영 리스크가 크게 늘어난다.

### 핵심 가치는 단순 라우팅이 아니다

"계획은 Gemini, 구현은 Codex, 디버깅은 Claude"처럼 모델별 역할을 고정하면 이해하기 쉽지만 다음 문제가 있다.

- 모델과 CLI의 성능, 가격, 제한은 계속 바뀐다.
- 작업 난이도와 저장소 상태에 따라 가장 적합한 에이전트가 달라진다.
- 여러 에이전트를 호출하는 것 자체가 오히려 토큰과 시간을 더 쓸 수 있다.
- 한 에이전트의 긴 출력을 다음 에이전트에 그대로 전달하면 비용 절감 효과가 사라진다.

따라서 핵심 가치는 **교체 가능한 에이전트 어댑터**, **작업별 정책 기반 라우팅**, **최소 컨텍스트 전달**, **측정 가능한 비용/품질 관리**여야 한다. 기본 역할 프리셋은 제공하되 사용자가 설정으로 바꿀 수 있어야 한다.

### 제품의 올바른 형태

초기 형태는 백그라운드 서비스보다 로컬에서 실행되는 **CLI 기반 에이전트 하네스(orchestrator/harness)**가 적합하다. 로컬 저장소와 기존 CLI 인증을 그대로 이용할 수 있고, 비밀정보를 별도 서버에 보내지 않으며, 구현과 검증도 빠르다.

장기적으로는 다음처럼 확장할 수 있다.

- 로컬 CLI: 개인 개발자의 진입점
- 데몬/로컬 API: IDE 및 다른 도구와의 연동
- CI 실행기: 자동 리뷰, 테스트, 수정 제안
- 선택적 웹 UI: 실행 이력, 비용, 승인 대기 작업 시각화

### 성공 기준을 먼저 수치화해야 한다

목표는 "여러 에이전트를 사용한다"가 아니라 **같은 품질의 결과를 더 적은 비용과 재작업으로 얻는다**이다. 다음 지표를 기록해야 한다.

- 작업 완료율과 사용자 승인율
- 에이전트별 호출 수, 입력/출력 토큰 또는 추정 비용
- 최초 요청부터 테스트 통과까지 걸린 시간
- 재시도 횟수와 에이전트 간 핸드오프 횟수
- 전달된 컨텍스트의 크기
- 단일 에이전트 실행 대비 비용과 성공률

CLI가 정확한 토큰 사용량을 제공하지 않으면 문자 수 기반 추정치와 실행 시간부터 기록하고, 사용 가능한 경우 실제 사용량을 추가 수집한다.

## 2. 제품 원칙

1. **Local-first**: 소스 코드, 인증 정보, 실행 기록은 기본적으로 로컬에 둔다.
2. **Provider-agnostic**: 특정 모델 이름이나 CLI 출력 형식을 코어 로직에 넣지 않는다.
3. **Budget-aware**: 모든 실행은 호출 수, 시간, 컨텍스트 크기, 비용 예산을 가진다.
4. **Minimal context**: 전체 대화 대신 작업 명세, 관련 파일, diff, 테스트 결과만 전달한다.
5. **Artifact-based handoff**: 에이전트끼리 자유 형식 대화를 중계하지 않고 구조화된 산출물로 인계한다.
6. **Verify before continue**: 테스트, 린트, 타입 검사 등 결정론적 도구를 에이전트 호출보다 우선한다.
7. **Human control**: 위험한 명령, 큰 변경, 예산 초과, 외부 전송에는 승인 지점을 둔다.
8. **Observable and resumable**: 모든 단계의 입력, 결과, 변경 사항과 실패 원인을 기록하고 중단 지점부터 재개한다.

## 3. 제안 아키텍처

```text
User / CI / IDE
       |
       v
CLI & Local API
       |
       v
Workflow Engine ---- Policy / Budget Engine
       |                       |
       |                       v
       |                Usage & Cost Ledger
       v
Task Context Manager ---- Artifact Store
       |
       v
Agent Adapter Interface
   |          |          |
Codex     Claude      Gemini
Adapter   Adapter     Adapter
       |
       v
Workspace Manager ---- Verification Runner
                              |
                    test / lint / typecheck
```

### 주요 컴포넌트

#### 3.1 CLI 및 설정

- `caris init`: 프로젝트 설정 파일과 기본 워크플로 생성
- `caris run "요청"`: 요청 분해, 실행, 검증
- `caris plan "요청"`: 코드 변경 없이 계획 산출
- `caris resume <run-id>`: 실패하거나 승인 대기 중인 실행 재개
- `caris inspect <run-id>`: 단계별 산출물, 비용, 로그 확인
- `caris doctor`: 설치된 에이전트 CLI, 버전, 인증 가능 여부, 필수 도구 확인

프로젝트 설정 예시는 다음과 같다.

```yaml
version: 1
agents:
  planner: gemini
  implementer: codex
  debugger: claude
  reviewer: gemini

budgets:
  max_agent_calls: 8
  max_wall_time_minutes: 30
  max_context_chars_per_call: 60000
  max_retries_per_step: 2

approvals:
  before_write: false
  before_shell_risk: true
  before_budget_overrun: true

verification:
  commands:
    - "npm test"
    - "npm run lint"
```

역할 이름은 사용자 경험을 위한 별칭이며, 내부에서는 각 단계가 요구하는 capability와 정책을 기준으로 에이전트를 선택한다.

#### 3.2 Agent Adapter

각 CLI의 차이를 하나의 인터페이스로 감싼다.

```text
detect() -> 설치 및 버전 정보
capabilities() -> 계획, 편집, 리뷰, 비대화식 실행 등 지원 기능
buildInvocation(task, context, policy) -> 안전한 프로세스 실행 명세
execute(invocation) -> stdout/stderr/exit code/usage 이벤트 스트림
parseResult(raw) -> 공통 AgentResult
cancel() -> 실행 중단
```

어댑터는 셸 문자열을 조합하기보다 인자 배열로 프로세스를 실행하고, CLI 버전별 출력 차이를 테스트 fixture로 관리한다. 인증 정보는 읽거나 저장하지 않고 각 CLI의 기존 인증 메커니즘에 맡긴다.

#### 3.3 Workflow Engine

워크플로는 단계와 전이 조건을 가진 상태 머신으로 구현한다.

```text
RECEIVED -> SCOPED -> PLANNED -> IMPLEMENTED -> VERIFIED
                                      |            |
                                      v            v
                                  DEBUGGING <--- FAILED
                                      |
                                      v
                                   REVIEWED -> DONE
```

각 단계는 다음을 선언한다.

- 필요한 capability
- 입력 artifact 목록
- 성공 조건과 검증 명령
- 최대 재시도 횟수 및 예산
- 실패 시 다음 단계
- 사람 승인이 필요한 조건

초기 버전은 YAML 워크플로를 해석하는 범용 DSL보다 코드로 정의된 2~3개 프리셋을 제공하는 편이 안전하다. 동작이 안정된 뒤 제한된 스키마의 선언형 워크플로를 추가한다.

#### 3.4 Context Manager와 Artifact Store

토큰 절감의 핵심이다. 실행별 디렉터리에 다음 구조화된 artifact를 저장한다.

- `request.md`: 사용자의 원 요청과 완료 조건
- `repo-summary.md`: 언어, 빌드 도구, 주요 모듈 요약
- `plan.json`: 작업 단계, 대상 파일, 위험, 검증 방법
- `changes.patch`: 현재 단계에서 만들어진 변경
- `verification.json`: 명령, 종료 코드, 핵심 오류
- `handoff.json`: 다음 에이전트가 알아야 할 사실과 미해결 항목
- `usage.jsonl`: 호출별 시간, 컨텍스트 크기, 토큰/비용 추정치

다음 에이전트에는 전체 로그가 아니라 원 요청, 현재 단계, 관련 파일 조각, 최신 diff, 실패한 검증 결과만 전달한다. 저장소 요약과 파일 해시는 캐시해 변경이 없으면 재생성하지 않는다.

#### 3.5 Workspace Manager

- 최초에는 사용자의 현재 작업 트리에서 실행하되 시작 전 dirty 상태를 기록한다.
- 변경 전후 diff를 단계별로 캡처한다.
- 에이전트가 사용자의 기존 변경을 되돌리지 못하도록 보호 규칙을 둔다.
- 병렬 구현을 도입할 때는 에이전트별 git worktree를 사용하고 마지막에 충돌을 명시적으로 병합한다.
- 삭제, 외부 네트워크, 시스템 경로 변경 등 위험 작업은 정책 엔진을 거친다.

MVP에서는 여러 에이전트가 같은 작업 트리를 동시에 수정하지 않도록 순차 실행한다.

#### 3.6 Verification Runner

테스트와 정적 분석은 가능한 한 에이전트가 아니라 프레임워크가 직접 실행한다. 실패 결과는 전체 로그 대신 명령, 종료 코드, 관련 오류 주변, 영향 파일로 압축해 디버거에게 넘긴다. 동일한 실패가 반복되면 무한 루프를 중단하고 사람에게 인계한다.

## 4. 기본 실행 시나리오

1. 사용자가 `caris run "로그인 API에 rate limit 추가"`를 실행한다.
2. 시스템이 저장소 상태, 관련 설정, 변경된 파일을 수집하고 예산을 확정한다.
3. Planner가 구조화된 `plan.json`과 완료 조건을 만든다.
4. 프레임워크가 계획의 파일 경로와 검증 명령을 검사한다.
5. Implementer가 계획과 필요한 파일만 받아 변경한다.
6. Verification Runner가 테스트, 린트, 타입 검사를 직접 실행한다.
7. 실패하면 Debugger가 diff와 축약된 실패 정보만 받아 수정한다.
8. 검증 통과 후 Reviewer가 요구사항 충족, 회귀 위험, 불필요한 변경을 확인한다.
9. 최종 diff, 검증 결과, 사용량 및 비용 비교를 사용자에게 보여준다.

리뷰나 디버깅이 필요 없으면 해당 호출을 생략한다. 호출을 생략할 수 있는 판단이 비용 절감에 중요하다.

## 5. 구현 로드맵

### Phase 0: 기술 검증과 기준선 (약 1주)

- 세 CLI의 비대화식 실행, 종료 코드, 출력 형식, 취소 동작을 작은 spike로 검증
- 동일한 10~20개 작업을 각 CLI 단독으로 실행해 비용, 시간, 성공률 기준선 수집
- 공통 `AgentResult`, `Task`, `Artifact`, `UsageRecord` 스키마 정의
- 프로세스 실행 시 보안 경계와 사용자 승인 정책 결정

**완료 조건:** 세 CLI가 동일한 샘플 작업을 공통 인터페이스로 실행하고 결과가 JSONL 실행 기록에 남는다.

### Phase 1: 순차 실행 MVP (약 2~3주)

- `init`, `doctor`, `run`, `inspect`, `resume` 명령 구현
- Codex, Claude, Gemini 어댑터 구현
- `plan -> implement -> verify -> debug -> review` 상태 머신 구현
- 실행별 artifact 저장 및 단계 체크포인트 구현
- 호출 수, 시간, 컨텍스트 크기 예산과 재시도 제한 구현
- 사용자 지정 검증 명령 실행

**완료 조건:** 실제 저장소에서 한 요청을 끝까지 수행하고, 중단 후 재개하며, 최종 diff와 사용량 보고서를 생성한다.

### Phase 2: 토큰 최적화와 신뢰성 (약 2주)

- 저장소 요약 및 파일 내용 해시 캐시
- 관련 파일 선택과 diff 중심 컨텍스트 패킹
- 중복 오류와 무진전 반복 감지
- 단계별 에이전트 생략 규칙 및 fallback 정책
- 단일 에이전트 기준선과 멀티 에이전트 실행을 비교하는 benchmark 명령
- CLI 버전별 golden fixture 및 어댑터 계약 테스트

**완료 조건:** 벤치마크 작업군에서 품질을 유지하면서 기준선 대비 컨텍스트 또는 추정 비용이 의미 있게 감소하고, 실패 이유를 재현할 수 있다.

### Phase 3: 확장 가능한 워크플로 (약 2~3주)

- 제한된 YAML 워크플로 스키마와 정적 검증
- capability 기반 라우팅과 사용자별 역할 프리셋
- git worktree 기반 격리 및 독립 작업의 선택적 병렬 처리
- 승인 UI 또는 TUI, 실행 이벤트 스트리밍
- 플러그인 가능한 신규 CLI 어댑터 SDK

**완료 조건:** 코어 수정 없이 새 어댑터와 워크플로를 추가하고, 독립 작업을 격리된 환경에서 병렬 실행한다.

### Phase 4: 팀 및 서비스화 (선택 사항)

- 로컬 데몬과 IDE 연동
- CI provider 연동
- 팀 정책, 공유 워크플로, 익명화된 비용 대시보드
- 원격 실행이 필요할 경우 비밀정보 관리, 테넌트 격리, 감사 로그 설계

서비스화는 로컬 하네스에서 반복 가능한 가치와 비용 절감이 검증된 뒤 결정한다.

## 6. 권장 초기 기술 선택

CLI 생태계와 프로세스 제어, 배포 편의성을 고려하면 **TypeScript + Node.js**를 우선 제안한다.

- CLI: `commander` 또는 `oclif`
- 프로세스 실행: `execa` 계열 API 또는 Node `child_process.spawn`
- 스키마 검증: `zod`
- 로컬 메타데이터: 초기 JSONL, 이후 조회 요구가 커지면 SQLite
- 테스트: `vitest`
- 로그: 구조화 JSONL + 사람이 읽는 콘솔 렌더러
- 패키징: npm 패키지와 단일 실행 진입점

예상 모듈 구조는 다음과 같다.

```text
src/
  cli/
  core/
    workflow/
    policy/
    context/
    artifacts/
    workspace/
    verification/
  adapters/
    codex/
    claude/
    gemini/
  presets/
  telemetry/
tests/
  contract/
  fixtures/
  integration/
```

언어 선택보다 중요한 것은 코어가 CLI별 옵션과 출력 파싱에 의존하지 않도록 어댑터 계약을 유지하는 것이다.

## 7. 주요 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| CLI 버전/출력 변경 | 파싱 실패, 자동화 중단 | 버전 감지, capability negotiation, fixture 기반 계약 테스트 |
| 멀티 에이전트 호출 증가 | 비용 절감 목표 역행 | 생략 규칙, 호출/시간 예산, 단일 에이전트 fallback |
| 컨텍스트 손실 | 잘못된 구현과 반복 수정 | 구조화 handoff, 완료 조건 유지, 필요한 원문 파일 첨부 |
| 같은 작업 트리 동시 수정 | 충돌과 사용자 변경 손실 | MVP 순차 실행, 이후 worktree 격리 |
| 위험한 셸 명령 | 데이터 손실/보안 사고 | 명령 정책, 승인 게이트, 실행 경로 제한, 감사 로그 |
| 정확한 비용 정보 부재 | 절감 효과 입증 곤란 | 문자/시간 추정치 기록, 가능한 provider usage 병합 |
| 에이전트 간 무한 핑퐁 | 시간과 비용 폭증 | 최대 재시도, 동일 실패 fingerprint, 무진전 감지 |
| 민감 코드 외부 전송 | 보안/규정 위반 | local-first, 전송 대상 표시, exclude 규칙, 승인 정책 |

## 8. MVP에서 의도적으로 제외할 것

- 자체 LLM gateway 또는 계정/결제 대행
- 여러 에이전트의 자유 형식 실시간 토론
- 완전 자율적인 장시간 무감독 실행
- 범용 그래프 워크플로 편집기
- 웹 대시보드와 조직 단위 권한 관리
- 첫 버전부터의 병렬 코드 수정

이 기능들은 흥미롭지만 토큰 절감이라는 핵심 가치를 검증하기 전에 복잡도를 크게 높인다.

## 9. 첫 번째 개발 마일스톤

가장 먼저 만들 수직 단면은 다음 하나다.

> 설치된 세 CLI를 감지하고, 하나의 요청을 `계획 -> 구현 -> 로컬 테스트 -> 실패 시 1회 디버깅`으로 실행한 뒤, 단계별 artifact와 추정 비용을 남긴다.

구현 순서는 다음과 같다.

1. TypeScript 프로젝트와 공통 도메인 타입 구성
2. 안전한 프로세스 실행기와 취소/타임아웃 구현
3. `doctor` 및 세 CLI의 최소 어댑터 구현
4. artifact 저장소와 실행 상태 체크포인트 구현
5. 하드코딩된 기본 워크플로 구현
6. 검증 명령과 1회 디버깅 루프 연결
7. 샘플 저장소 기반 통합 테스트 및 단일 에이전트 기준선 비교

이 마일스톤이 성공하면 프레임워크의 가장 큰 기술적 불확실성인 CLI 제어, 핸드오프 품질, 실제 비용 절감 가능성을 한 번에 검증할 수 있다.

## 10. 핵심 설계 요약

이 프로젝트의 정체성은 "세 AI를 한 화면에서 쓰는 도구"보다 **예산과 검증 조건 안에서 코딩 작업을 완수하는 로컬 멀티 에이전트 실행기**에 가깝다. 초기에는 역할을 고정한 단순한 순차 파이프라인으로 시작하되, 내부 설계는 에이전트 교체와 단계 생략이 가능해야 한다.

가장 중요한 우선순위는 다음 세 가지다.

1. 공통 어댑터 계약과 안정적인 프로세스 제어
2. 구조화 artifact를 이용한 최소 컨텍스트 핸드오프
3. 단일 에이전트 대비 비용과 성공률을 보여주는 측정 체계

이 세 가지가 증명되기 전에는 복잡한 에이전트 토론, 병렬 수정, SaaS 기능을 추가하지 않는 것이 좋다.

## 11. Chat Interface 검토 및 제안

### 결론

CARIS는 **Chat interface를 갖는 것이 좋다.** 사용자의 요청이 처음부터 완전한 작업 명세인 경우는 드물고, 계획 확인, 범위 조정, 실행 승인, 실패 후 추가 지시처럼 작업 중간의 상호작용이 필요하기 때문이다. 여러 에이전트를 하나의 시스템처럼 느끼게 만드는 데도 일관된 대화형 진입점이 유용하다.

다만 Chat을 시스템의 본체로 만들면 안 된다. 권장 구조는 다음과 같다.

- **Chat/TUI:** 사람이 탐색하고 지시하는 기본 인터페이스
- **One-shot CLI:** 스크립트, CI, 반복 실행을 위한 비대화식 인터페이스
- **Workflow Engine:** 두 인터페이스가 공통으로 호출하는 실제 실행 코어

즉, `caris`를 실행하면 대화형 세션에 들어가고 `caris run`, `caris plan`, `caris inspect`는 동일한 코어를 직접 호출하도록 한다. Chat은 오케스트레이터의 UI이지 에이전트 간 대화를 그대로 중계하는 채팅방이 아니다.

### 제안한 요청 흐름에 대한 리뷰

제안한 흐름은 기본 방향이 맞다.

```text
사용자 요청
  -> CARIS가 의도, 범위, 위험, 완료 조건 분석
  -> 필요한 Role과 실행 단계 결정
  -> Role 정책에 따라 CLI 선택
  -> 선택 이유와 실행 계획 표시
  -> 필요 시 사용자 승인
  -> CLI 실행 및 결정론적 검증
  -> 결과, diff, 검증 상태, 사용량 반환
  -> 후속 대화 또는 종료
```

여기에 두 가지 구분을 추가해야 한다.

1. **Role 선택과 CLI 선택을 분리한다.** `planner`, `implementer`, `debugger`, `reviewer`는 작업 책임이고 Codex, Claude, Gemini는 그 책임을 수행하는 provider다.
2. **모든 요청을 LLM으로 라우팅하지 않는다.** `/status`, 설정 조회, diff 표시, 테스트 재실행처럼 결정론적으로 처리할 수 있는 요청은 CARIS 코어가 직접 수행한다.

이 구분이 있어야 사용자가 역할 구성을 쉽게 바꾸고, 향후 새 CLI를 추가하며, 불필요한 토큰 사용도 피할 수 있다.

### 대화형 세션 예시

```text
$ caris
CARIS ready · project: my-app · profile: default

> 로그인 API에 rate limit을 추가해줘

CARIS
범위: API middleware, 설정, 테스트
경로: planner(gemini) -> implementer(codex) -> verify(local)
예산: 최대 4 agent calls / 20분
위험: public API 동작 변경

실행할까요? [Y/n/edit]

> edit
> planner 없이 Codex가 바로 구현하고 Claude가 리뷰하게 해줘

CARIS
이번 작업에만 경로를 변경합니다.
implementer(codex) -> verify(local) -> reviewer(claude)
```

실행 중에는 에이전트의 원시 로그 전체보다 현재 단계, 변경 파일, 검증 진행, 누적 예산을 간결하게 보여준다. 상세 로그는 `/log`로 열람한다.

### Slash Command 설계

Slash command는 LLM 프롬프트로 보내지 않고 CARIS가 직접 파싱하는 제어 명령이어야 한다. 그러면 동작이 예측 가능하고 토큰도 소비하지 않는다.

#### 관찰 명령

| 명령 | 동작 |
|---|---|
| `/status` | 현재 단계, 실행 중인 CLI, 변경 파일, 검증 상태, 누적 사용량 표시 |
| `/plan` | 현재 작업 계획과 단계별 담당 Role/CLI 표시 |
| `/roles` | Role과 CLI 매핑, fallback 목록 표시 |
| `/budget` | 호출 수, 시간, 컨텍스트 및 비용 예산 표시 |
| `/diff` | 현재 실행이 만든 변경 표시 |
| `/log [step]` | 단계별 상세 로그 표시 |
| `/artifacts` | 계획, handoff, 검증 결과 등 산출물 목록 표시 |

#### 설정 명령

| 명령 | 동작 |
|---|---|
| `/role set planner gemini` | Planner의 기본 CLI 지정 |
| `/role set debugger claude --fallback codex` | 기본 CLI와 fallback 지정 |
| `/role auto reviewer` | Reviewer를 capability/정책 기반 자동 선택으로 전환 |
| `/profile use cheap` | 저장된 역할 및 예산 프로필 적용 |
| `/budget calls 5` | 현재 세션의 최대 에이전트 호출 수 변경 |
| `/verify add "npm test"` | 현재 프로젝트의 검증 명령 추가 |

#### 실행 제어 명령

| 명령 | 동작 |
|---|---|
| `/run` | 작성된 계획 실행 또는 일시 정지된 실행 재개 |
| `/pause` | 현재 단계 완료 후 중지 |
| `/cancel` | 현재 프로세스를 취소하고 실행 상태 보존 |
| `/retry [step]` | 지정 단계 재실행 |
| `/approve` | 대기 중인 위험 작업 또는 예산 변경 승인 |
| `/rollback step` | CARIS가 해당 단계에서 만든 변경만 되돌리도록 요청 |

`/rollback`은 사용자의 기존 변경을 건드릴 위험이 있으므로 단계별 patch와 시작 시점의 작업 트리 상태를 검사한 뒤 수행해야 한다.

### Role 설정의 범위

역할 설정은 적용 범위를 명확히 보여줘야 한다.

```text
이번 요청만:  /role set implementer claude --scope task
현재 세션:    /role set implementer claude --scope session
현재 프로젝트: /role set implementer claude --scope project
사용자 기본값: /role set implementer claude --scope global
```

우선순위는 `task > session > project > global > built-in default`로 한다. 명령에서 scope를 생략하면 안전하게 **현재 세션**에만 적용하고, 프로젝트나 전역 설정을 바꿀 때는 변경 위치를 명시적으로 출력한다.

설정 파일은 CLI 이름을 Role 안에 직접 박아 넣기보다 정책을 표현할 수 있어야 한다.

```yaml
roles:
  planner:
    provider: gemini
    fallback: [codex]
  implementer:
    provider: codex
    fallback: [claude]
  debugger:
    provider: claude
  reviewer:
    provider: auto
    constraints:
      different_from: implementer
```

`auto`는 초기 MVP에서 복잡한 AI 라우터로 구현하지 않는다. CLI 사용 가능 여부, capability, 남은 예산, 사용자가 정한 우선순위를 평가하는 결정론적 규칙으로 시작한다.

### 자연어와 제어 명령의 경계

사용자는 자연어로도 역할을 바꿀 수 있다.

```text
> 이번 작업은 계획 없이 Codex로 구현하고 Claude로 리뷰해줘
```

CARIS는 이를 바로 영구 설정으로 저장하지 않고 **이번 작업의 실행 초안**으로 해석해 확인 화면에 표시한다. 반면 `/role set ...`은 명시적인 시스템 설정 변경으로 처리한다. 이 원칙은 대화 중 우연한 표현이 전역 동작을 바꾸는 것을 막는다.

다음 요청은 구분해 처리한다.

- 작업 요청: LLM을 이용해 의도와 완료 조건을 구조화할 수 있음
- 설정/상태 요청: CARIS 코어가 직접 처리
- 모호하지만 비용이 낮은 요청: 기본 정책으로 실행 후 결과 제시
- 파괴적이거나 비용이 큰 요청: 실행 전에 확인

### 세션과 컨텍스트 관리

Chat history 전체를 매번 하위 CLI에 전달하면 비용 절감 목표와 충돌한다. 대화 기록과 실행 컨텍스트를 분리해야 한다.

- `Conversation Log`: 사용자와 CARIS 사이의 전체 대화
- `Task Spec`: 현재 요청, 완료 조건, 제약을 압축한 구조화 문서
- `Execution State`: 단계, Role/CLI, 예산, 승인, 재시도 정보
- `Agent Context`: 해당 CLI에 필요한 Task Spec, 관련 파일, diff, 오류만 포함

사용자가 후속 요청을 하면 CARIS는 기존 대화를 그대로 전달하지 않고 `Task Spec`을 갱신한다. 사용자가 "아까 변경한 API"처럼 이전 내용을 참조할 때만 필요한 artifact를 연결한다.

### Chat MVP 범위

첫 대화형 버전에는 다음만 포함하는 것이 적절하다.

1. REPL 형태의 텍스트 입력과 스트리밍 상태 출력
2. 자연어 요청을 기존 순차 워크플로로 실행
3. `/status`, `/plan`, `/roles`, `/role set`, `/budget`, `/diff`, `/log`
4. 실행 전 계획/담당 CLI/예산 확인 및 수정
5. `/pause`, `/cancel`, `/retry`, `/approve`
6. 종료 후 같은 run-id로 세션 재개

처음부터 풀스크린 TUI, 다중 창, 에이전트별 채팅 탭을 만들 필요는 없다. 단순 REPL로 사용자 흐름과 명령 체계를 검증한 뒤 렌더링 계층만 발전시키는 편이 좋다.

### Chat 도입 시 추가 위험

| 위험 | 대응 |
|---|---|
| 대화가 길어져 컨텍스트 비용 증가 | Chat history와 Agent Context 분리, Task Spec 지속 갱신 |
| 사용자가 CARIS와 하위 에이전트를 혼동 | 응답에 현재 단계와 담당 CLI를 명확히 표시 |
| 자연어 설정 변경의 범위가 불명확 | 자연어는 task override, slash command는 명시적 scope 적용 |
| 여러 CLI의 원시 출력이 화면을 압도 | 기본은 요약된 이벤트, `/log`에서 원문 제공 |
| Chat에 종속되어 CI 자동화가 어려움 | 모든 동작을 공통 Core API로 제공하고 one-shot CLI 유지 |
| 세션 중 설정 변경으로 재현성 저하 | 실행 시작 시 effective config snapshot 저장 |

### 권장 인터페이스 우선순위

1. Workflow Engine과 공통 Core API
2. One-shot CLI로 실행 신뢰성 검증
3. 동일 Core API 위에 REPL Chat 추가
4. 사용 패턴이 확인된 뒤 풀스크린 TUI 또는 IDE UI 검토

결론적으로 Chat은 CARIS의 사용성을 크게 높이는 **주요 인터페이스**가 될 수 있지만, 아키텍처의 중심은 아니다. 중심은 계속해서 재현 가능한 워크플로, Role과 provider의 분리, 최소 컨텍스트, 검증 및 예산 통제여야 한다.

## 12. 종합 결론

CARIS의 기본 사용자 경험은 대화형이어도 좋다. 사용자는 하나의 Chat에서 작업을 요청하고 계획, 담당 Role/CLI, 예산을 확인하거나 수정한 뒤 결과를 받는다. 동시에 동일 기능을 `caris run` 같은 비대화식 명령으로 제공해 CI와 자동화를 보장한다.

구현 관점에서는 Chat보다 Workflow Engine을 먼저 완성하고, Chat을 그 위의 얇은 상태 기반 인터페이스로 만든다. 이렇게 하면 편리한 상호작용과 재현 가능한 실행을 함께 얻으면서도 대화 기록 중복으로 인한 토큰 낭비를 막을 수 있다.
