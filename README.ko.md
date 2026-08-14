# choco-pi

[English](README.md)

choco-pi는 [Pi 코딩 에이전트](https://pi.dev/)를 프로젝트 중심으로 운용하기 위한 개인화 설정 저장소입니다. 운용 규칙, 재사용 가능한 작업 절차, 모델·공급자 제어, 서브 에이전트, 독립 대화, 컴팩션, MCP, 웹·브라우저 도구와 Nord 기반 터미널 UI를 한 설정으로 제공합니다.

Git에는 공유 가능한 설정만 저장합니다. OAuth 토큰과 API 키는 Pi의 사용자 전용 인증 저장소에 두며 저장소에 커밋하지 않습니다.

## 요구 사항

- Pi 0.84.1 이상
- Node.js 24 이상
- Git
- 선택 사항: 네이티브 브라우저 자동화를 위한 [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.33.2

저장소를 clone하거나 복사한 뒤 전역 profile을 설치하고 Pi를 실행합니다.

```sh
cd choco-pi
npm run install:profile
pi
```

설치기는 credential과 runtime 상태를 보존하고 checkout 경로를 반영한 `~/.pi/agent/settings.json`을 생성한 뒤 Git으로 추적하는 공개 profile을 `~/.pi/agent`에 연결합니다. 충돌 파일은 교체하지 않고 중단합니다. 파일을 확인한 뒤 `npm run install:profile -- --backup`을 실행하면 기존 파일을 백업하고 추적 버전을 설치합니다.

Pi는 [`.pi/settings.json`](.pi/settings.json)에 고정된 패키지를 설치합니다. npm이 네이티브 설치 스크립트를 보류하면 현재 확장에서 사용하는 두 패키지만 허용합니다.

```sh
cd .pi/npm
npm install-scripts approve --allow-scripts-pin @ast-grep/cli tree-sitter-bash
npm rebuild @ast-grep/cli tree-sitter-bash
```

`.pi` 아래 파일을 바꾼 뒤에는 `/reload`를 실행합니다.

## 전역 profile

현재 checkout은 이 컴퓨터의 `~/.pi/agent` 전역 Pi profile 원본으로도 사용합니다.

- `settings.json`은 같은 고정 버전 패키지를 설치하고 이 checkout의 `extensions`, `skills`, `prompts` 디렉터리를 참조합니다.
- `SYSTEM.md`, 글쓰기·리뷰 정책, 서브 에이전트·Zentui 설정, agent 정의와 공급자 설정 파일은 이 checkout으로 연결한 symbolic link입니다. 로컬 `.pi/mcp.json`이 있으면 함께 연결합니다.
- 따라서 다른 디렉터리에서 Pi를 실행해도 choco-pi가 사용자 기본 설정으로 적용됩니다. 신뢰한 프로젝트에 별도 `.pi` 설정이나 `SYSTEM.md`가 있으면 Pi의 기존 우선순위에 따라 전역 기본값을 덮어쓸 수 있습니다.

전역 profile이 이 checkout을 직접 가리키므로 경로를 옮기거나 삭제하지 마십시오. 원본 파일을 바꾼 뒤 Pi를 다시 시작하거나 `/reload`를 실행합니다.

Git으로 추적하는 [`.pi/zentui.json`](.pi/zentui.json)은 입력창의 모델을 bold, reasoning effort를 italic으로 표시합니다.

## 제공 기능

| 영역 | 동작 |
|---|---|
| 운용 규칙 | [`.pi/SYSTEM.md`](.pi/SYSTEM.md)로 Pi 기본 프롬프트를 교체하고 매 turn 실제 `provider/model`을 주입 |
| 프로젝트 인식 | 시작 시 루트 지침을 읽고, 하위 경로에 접근할 때 해당 경로의 `AGENTS.md`를 추가 적용 |
| 글쓰기 | 별도 스킬 호출 없이 일반 답변과 작성 문서에 저장소 글쓰기 정책 적용 |
| 작업 절차 | 직접 구현, 병렬 구현, 핫픽스, 리뷰, 환경 점검, 로컬 커밋 절차 제공 |
| 에이전트 | 모델을 고정하지 않은 `general`, `planner`, `implementer`, `reviewer`, `handoff` 역할 제공 |
| 독립 대화 | Pi 대화를 생성·조회·대기하고 queue·steer로 상호 제어 |
| 문맥 관리 | 모델별 soft cap, 도구 지연 로딩, `/context` 사용량 분석과 OpenAI Responses 서버 컴팩션 지원 |
| 공급자 | OpenAI Codex OAuth, Anthropic OAuth, Synthetic, 자동 discovery 방식 Callstack Apex 지원 |
| 도구 | BM25 `tool_search`, MCP, 웹 검색, 본문 추출, LSP 진단, 브라우저 자동화, goal, 사이드 대화 추가 |
| 인터페이스 | `nord-dark`, `pi-zentui`, 공급자 usage, effort 제어와 익숙한 세션 별칭 적용 |

## 설치 패키지

버전은 [`.pi/settings.json`](.pi/settings.json)에 고정합니다.

| 패키지 | 버전 | 용도 |
|---|---:|---|
| [`@aliou/pi-synthetic`](https://github.com/aliou/pi-synthetic) | 0.24.3 | Synthetic 공급자와 인증 |
| [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | 0.15.0 | Claude Code 형태의 서브 에이전트, background 실행, steering, resume와 fleet UI |
| [`pi-codex-goal`](https://pi.dev/packages/pi-codex-goal) | 0.2.0 | Codex 형태의 지속형 goal |
| [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) | 2.21.2 | MCP 서버 지연 로딩 |
| [`pi-lens`](https://pi.dev/packages/pi-lens) | 3.8.74 | LSP, lint, AST 진단 |
| [`@howaboua/pi-codex-conversion`](https://pi.dev/packages/@howaboua/pi-codex-conversion) | 3.0.12 | Codex 호환 도구와 OpenAI Responses 컴팩션 |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | 0.20.0 | 웹 검색과 문서 본문 추출 |
| [`pi-btw`](https://pi.dev/packages/pi-btw) | 0.4.1 | 작업 중 사이드 대화 |
| [`pi-zentui`](https://pi.dev/packages/pi-zentui) | 0.18.1 | 편집기, 메시지 프레임과 상태줄 |
| [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native) | 0.3.0 | 네이티브 `agent-browser` 연동 |
| [`@howaboua/pi-markdown-workflows`](https://pi.dev/packages/@howaboua/pi-markdown-workflows) | 0.2.20 | 하위 `AGENTS.md`와 Markdown workflow |
| [`@maddeye/pi-nord`](https://pi.dev/packages/@maddeye/pi-nord?name=nord&type=theme) | 1.0.0 | Nord 테마 |

## 명령

### 세션과 모델 제어

| 명령 | 설명 |
|---|---|
| `/exit` | Pi를 정상 종료. `/quit` 별칭 |
| `/delete` | 확인 후 현재 Pi 세션 기록을 영구 삭제하고 종료 |
| `/clear` | 현재 세션 기록을 보존하고 새 세션 시작. `/new` 별칭 |
| `/effort [level]` | 현재 모델이 지원하는 reasoning effort 선택 또는 직접 지정. 공백 뒤에는 가능한 값 자동 완성 |
| `/fast [on\|off\|status]` | OpenAI Codex Fast mode 제어. 인자 없이 실행하면 현재 상태를 전환 |
| `/context-cap` | 현재 모델에 적용된 soft context cap 확인 |
| `/context [all]` | prompt, active/deferred 도구, MCP, agent, context file, skill, message와 autocompact buffer 사용량 표시 |
| `/rewind` | 선택한 턴으로 현재 대화 branch, 파일과 Git index를 함께 rewind |
| `/usage` | Claude Code, OpenAI Codex, Synthetic 사용량을 한 화면에 표시 |
| `/apex-refresh` | Callstack Apex 모델을 즉시 다시 탐색 |

Fast mode는 OpenAI Codex 요청에만 `service_tier: "priority"`를 추가합니다. Standard보다 사용량이나 API credit을 빠르게 소비할 수 있습니다. Pi에 숨겨진 llama.cpp 공급자는 유지하지만 `/llama` 명령은 choco-pi의 명령 목록과 실행 경로에서 제거합니다.

`Ctrl+S`는 현재 입력, 커서 위치와 접힌 paste를 임시 보관하고 입력창을 비웁니다. 빈 입력창에서 다시 누르면 복원합니다. 이 stash는 현재 Pi 프로세스에서만 유지됩니다.

MCP는 adapter gateway만 모델 context에 넣고 시작하며, cached MCP 도구를 direct tool로 등록하지 않습니다. 모델은 `tool_search`에 자연어 capability를 전달해 compact parameter 요약을 포함한 BM25 상위 결과를 최대 5개만 받습니다. MCP 결과는 `mcp`를 통해 호출하고 Pi 도구는 세션에 additive하게 활성화합니다. 따라서 시작 시 대량 tool schema와 adapter의 direct-tool 경고가 발생하지 않습니다. `/context all`에서 active/deferred 도구 목록을 확인할 수 있습니다.

### 작업 절차 명령

| 명령 | 작업 절차 |
|---|---|
| `/check [범위]` | choco-pi 기본 환경과 작업별 선택 기능 확인 |
| `/task-inline <작업>` | 메인 에이전트가 직접 구현. 기본 수정 절차 |
| `/task <작업>` | 독립 구현 단위를 계획하고 서브 에이전트로 실행 |
| `/task-hotfix <작업>` | 메인 에이전트가 좁은 범위의 긴급 수정 수행 |
| `/review [대상]` | fresh reviewer로 수정 없는 적대적 리뷰 수행 |
| `/commit [지침]` | push 없이 검증된 로컬 커밋 하나 생성 |

`/task`는 서로 독립적이고 병렬 실행의 이점이 있는 구현 단위가 두 개 이상일 때만 사용합니다. 파일 수가 많다는 이유만으로 선택하지 않습니다. 직접 구현과 핫픽스 절차는 구현을 위임하지 않습니다.

모든 커밋은 harness `/commit` 스킬을 따릅니다. 의도한 변경만 stage하고 저장소 고유 정책을 우선합니다. 별도 정책이 없으면 범위를 포함한 conventional subject, 필요한 경우에만 최대 두 개의 짧은 본문 항목, `Assisted-by`, `Signed-off-by` trailer를 사용합니다. 커밋 요청은 push, PR 생성, publish, deploy 권한을 포함하지 않습니다.

### 독립 대화 명령

| 명령 | 설명 |
|---|---|
| `/session-new` | 모델, reasoning effort, 선택적 이름과 초기 사용자 프롬프트로 새 대화 생성 |
| `/sessions [limit]` | 현재 프로젝트의 대화 목록 확인 |
| `/session-send <id> <queue\|steer> <message>` | 다른 대화에 queue 또는 steering 메시지 전달 |
| `/session-read <id> [limit] [include-tools]` | 최근 transcript와 현재 cursor 확인 |
| `/session-wait <id> [seconds] [after-cursor]` | 지정 cursor 이후 진전과 idle 상태를 대기 |

에이전트도 `session_create`, `session_send`, `session_list`, `session_read`, `session_wait` 도구로 같은 기능을 호출할 수 있습니다.

각 대화는 별도 Pi session ID를 가지며 프로젝트 context, extension, skill과 공급자 인증을 다시 불러옵니다. 같은 프로세스의 대화에는 Pi 세션 API로 직접 전달하고, 다른 프로세스에는 `~/.pi/agent/choco-pi/session-bridge/`의 owner별 heartbeat와 순번이 있는 durable mailbox를 사용합니다.

- `steer`는 실행 중인 대상에만 허용하며 Pi의 다음 안전 지점에 전달합니다.
- `queue`는 FIFO이며 대상이 꺼져 있어도 보관합니다.
- 대화 검색과 메시징은 현재 working directory로 제한합니다.
- `session_create`는 대화를 시작한 뒤 즉시 반환하므로 첫 응답 전 cursor는 `null`일 수 있습니다.
- Pi는 첫 assistant 응답 뒤 새 세션 JSONL을 기록합니다. 그 전에 생성 프로세스가 끝나면 아직 영속화되지 않은 세션은 사라질 수 있습니다. 이미 기록된 JSONL과 mailbox queue는 유지됩니다.

## 에이전트 동작과 프로젝트 지침

[`.pi/SYSTEM.md`](.pi/SYSTEM.md)는 모든 프로젝트에 적용하는 공통 운용 규칙을 정의합니다: 대화 방식, 지침 우선순위, 요청 유형별 routing, 권한 경계, 증거 수준, 위임, 리뷰, 연속성, 완료 조건. 특정 저장소의 명령과 도메인 규칙은 해당 저장소의 `AGENTS.md`나 skill에 둡니다.

[`runtime-model-prompt.ts`](.pi/extensions/runtime-model-prompt.ts)는 매 turn `{{PI_CURRENT_MODEL}}`을 실제 `provider/model`로 바꿉니다. 모델을 전환하면 parent와 child 각각 다음 turn부터 자신의 모델 정보를 받습니다. Credential은 프롬프트에 포함하지 않습니다.

[`runtime-writing-prompt.ts`](.pi/extensions/runtime-writing-prompt.ts)는 [`.pi/writing-policy.md`](.pi/writing-policy.md)를 main과 child 프롬프트에 추가합니다.

Pi는 시작 경로의 context file을 읽습니다. `@howaboua/pi-markdown-workflows`는 에이전트가 더 깊은 경로를 읽거나 작업할 때 하위 지침을 추가합니다. 예를 들어 `packages/api/src/service.ts`에 접근하면 다음 파일을 순서대로 적용할 수 있습니다.

```text
packages/AGENTS.md
packages/api/AGENTS.md
packages/api/src/AGENTS.md
```

읽은 지침은 세션에 유지하며 파일이 바뀌면 다시 불러옵니다. 이 패키지는 `/workflows`, `/skills`, `/learn`과 `workflows_create`도 제공합니다.

## 서브 에이전트

패키지 기본 역할은 [`.pi/subagents.json`](.pi/subagents.json)에서 비활성화하고, 알 수 없는 역할은 fallback 없이 거부합니다. [`.pi/agents`](.pi/agents)에는 모델을 고정하지 않은 project-aware leaf role 다섯 개가 있습니다.

| 역할 | 용도 | 쓰기 |
|---|---|---:|
| `general` | 범위가 정해진 범용 작업 | 가능 |
| `planner` | 의존성, 충돌, 검증 계획 | 불가 |
| `implementer` | 할당된 구현 단위 하나 | 가능 |
| `reviewer` | fresh context 기반 근거 중심 리뷰 | 불가 |
| `handoff` | 검증된 상태의 간결한 전달 | 불가 |

`/agents`에서 역할, 실행 중인 agent, transcript, schedule과 운영 기본값을 확인합니다. 역할이 값을 고정하지 않았다면 `Agent` 호출에서 `model`과 `thinking`을 지정할 수 있습니다. 값은 명시적 호출, 역할 설정, parent/runtime 기본값 순서로 결정합니다.

실행 중인 agent는 `steer_subagent`로 현재 tool 이후 방향을 바꾸고, background 결과는 `get_subagent_result`로 가져옵니다. 완료된 agent의 같은 작업 후속 처리는 `resume: <id>`를 포함한 `Agent` 호출을 사용합니다. 새 호출은 fresh conversation으로 시작하며 각 역할 지침은 현재 parent system prompt 뒤에 추가되고 skill을 상속합니다.

모든 custom role은 ambient child extension을 끄므로 선언된 native tool이 모델 adapter에 대체되지 않습니다. 쓰기 역할은 기본적으로 현재 checkout을 사용하며, Orchestrator가 겹치지 않는 direct·indirect ownership 범위를 할당한 경우에만 병렬 실행합니다. `isolation: "worktree"`는 명시적으로 선택할 때만 사용합니다.

## Checkpoint, 리뷰와 Git 경계

[`file-checkpoints.ts`](.pi/extensions/file-checkpoints.ts)는 각 agent turn 시작 시 임시 Git index를 사용해 staged, unstaged, untracked 상태를 기록합니다. 실제 index는 바꾸지 않습니다. `/rewind`는 안전 checkpoint를 만든 뒤 파일과 index를 복원하고, 현재 대화 branch를 선택한 user turn 직전으로 이동해 해당 prompt를 편집기에 돌려놓습니다. 이후 대화는 Pi session tree에서 다시 접근할 수 있으며 ignored file은 건드리지 않습니다. checkpoint object는 `refs/choco-pi/checkpoints/`에 보존합니다.

[`review`](.pi/skills/review/SKILL.md)와 [`.pi/review-policy.md`](.pi/review-policy.md)는 수정 없는 적대적 리뷰 절차입니다. reviewer는 정확한 diff나 revision을 받아 가정을 반증하고, 재현 가능하거나 결정적으로 추적한 finding만 보고합니다. 리뷰 요청만으로 수정 권한이 생기지 않습니다.

수정 절차는 시작 revision과 dirty tree를 기록하고, acceptance ledger와 checkout mutation lease를 사용합니다. 사용자가 worktree를 요청하거나 저장소 정책상 격리가 필요하지 않으면 현재 checkout에서 작업합니다.

## 문맥과 컴팩션

Native context window가 1,000,000 tokens 이상인 모델은 soft cap을 600,000 tokens로 제한하고 550,000 tokens를 넘으면 자동 compaction을 시작합니다. 로컬 fallback summary는 최근 20,000 tokens를 유지합니다.

프로젝트별 값은 [`.pi/extensions/context-cap.json`](.pi/extensions/context-cap.json)에서 설정합니다. 전역 기본값은 `~/.pi/agent/extensions/context-cap.json`에 있으며 프로젝트 설정이 우선합니다.

```json
{
  "defaultCap": 600000,
  "defaultCompactAt": 550000,
  "appliesOver": 999999,
  "models": {
    "provider/model": {
      "cap": 600000,
      "compactAt": 550000
    },
    "provider/model-with-native-window": null
  }
}
```

- 숫자는 해당 모델의 정확한 soft cap을 적용하고 object는 cap과 compaction 임계값을 함께 지정합니다.
- `null`은 해당 모델의 두 override를 모두 끕니다. Object의 개별 필드에도 `null`을 지정할 수 있습니다.
- `/context-cap`은 현재 세션에 적용된 값을 표시합니다.

OpenAI Codex에서는 `/codex openai`로 native Responses compaction을 켭니다. 추적하는 [`.pi/pi-codex-conversion.json`](.pi/pi-codex-conversion.json)은 `npm run install:profile` 실행 시 `~/.pi/agent/pi-codex-conversion.json`에 링크되므로 `/codex` 설정도 프로젝트와 동기화됩니다. Fast mode의 기본값은 꺼짐입니다.

compaction만 지정하는 최소 설정은 다음과 같습니다.

```json
{
  "compaction": {
    "responsesCompaction": true
  }
}
```

OpenAI Codex와 명시적으로 설정한 호환 Responses 공급자는 OpenAI `remote_compaction_v2` checkpoint를 사용합니다. 원격 요청을 지원하지 않거나 실패하면 안전한 경우 Pi compaction으로 전환합니다. 현재 Pi 호환 범위가 맞지 않는 `pi-openai-server-compaction`은 설치하지 않습니다.

## 공급자 인증

Pi는 OAuth token과 API key를 권한 `0600`인 `~/.pi/agent/auth.json`에 저장합니다. 이 파일을 저장소에 복사하지 마십시오.

Pi를 실행하고 공급자별 로그인을 진행합니다.

```text
/login openai-codex
/login anthropic
/login synthetic
```

- `openai-codex`는 지원되는 ChatGPT 계정의 browser OAuth를 사용합니다.
- `anthropic`은 브라우저에서 Claude 계정 인증을 진행합니다.
- `synthetic`은 Synthetic API key를 받습니다.

Synthetic은 `SYNTHETIC_API_KEY` 환경 변수도 지원합니다.

인증 값을 출력하지 않고 상태만 확인합니다.

```sh
pi auth check --provider openai-codex --json
pi auth check --provider anthropic --json
pi --approve --list-models synthetic
```

Pi의 `auth` 하위 명령은 프로젝트에서 정의한 공급자를 불러오지 않습니다. Synthetic과 Callstack Apex는 `pi auth check` 대신 모델 목록으로 확인합니다.

## Callstack Apex 자동 탐색

[`.pi/extensions/apex-provider.json`](.pi/extensions/apex-provider.json)에 OpenAI 호환 API base를 설정하거나 `~/.pi/agent/extensions/apex-provider.json`을 전역 기본값으로 사용합니다. 프로젝트 설정이 우선합니다. `/models`는 제외하고 API prefix까지 포함해야 합니다. 모델 endpoint가 `https://apex.example/v1/models`라면 다음처럼 작성합니다.

```json
{
  "baseUrl": "https://apex.example/v1",
  "api": "openai-completions",
  "defaults": {
    "contextWindow": 128000,
    "maxTokens": 16384,
    "reasoning": false,
    "input": ["text"]
  },
  "overrides": {}
}
```

URL을 Git에 남기지 않으려면 `CALLSTACK_APEX_BASE_URL`을 사용합니다. Key는 `CALLSTACK_APEX_API_KEY`로 전달하거나, base URL을 설정하고 Pi를 다시 시작한 뒤 `/login callstack-apex`로 저장합니다.

Shell에 `CALLSTACK_APEX_BASE_URL`과 `CALLSTACK_APEX_API_KEY`를 설정한 뒤 값을 출력하지 않고 discovery를 확인합니다.

```sh
pi --approve --list-models callstack-apex
```

확장은 `${baseUrl}/models`를 Bearer 인증으로 조회합니다. 표준 OpenAI `{ "data": [...] }`, 배열, `{ "models": [...] }` 형식을 읽습니다. API가 이름, context window, 출력 한도, 입력 modality, reasoning 여부와 지원 기능을 제공하면 자동 반영합니다. 빠진 값에는 `defaults`를 쓰고 `overrides`가 최종 우선합니다.

Apex가 Responses API를 지원한다고 확인하기 전에는 `openai-completions`를 사용합니다. `openai-responses`로 바꾸는 것만으로 server-side compaction이 켜지지는 않습니다. 로그인 직후나 모델 목록이 바뀌면 `/apex-refresh`를 실행합니다. 성공한 탐색 결과는 최대 4시간 재사용합니다.

## MCP, goal, 웹과 사이드 대화

- [`.pi/mcp.example.json`](.pi/mcp.example.json)을 Git에서 제외된 `.pi/mcp.json`으로 복사하고 로컬 OAuth client 설정을 추가합니다. 전역 profile의 `~/.pi/agent/mcp.json`도 이 로컬 파일을 가리키므로 다른 프로젝트에서도 사용할 수 있습니다. `/mcp`에서 설정과 실행 상태를 확인합니다.
- `/create-goal <목표>`로 지속형 goal을 만들고 `/goal`에서 상태와 사용량을 확인합니다.
- `web_search`, `fetch_content`는 `pi-web-access`를 통해 검색과 본문 추출을 수행합니다.
- `/btw <질문>`은 메인 에이전트가 작업 중일 때 별도 대화를 시작합니다.
- `/btw:model`, `/btw:thinking`은 사이드 대화의 모델과 effort를 지정합니다.
- `/btw:inject`, `/btw:summarize`는 선택한 사이드 대화 내용을 메인 세션에 전달합니다.

## TUI와 브라우저 자동화

기본 테마는 `nord-dark`입니다. `pi-zentui`가 편집기, 사용자 메시지 프레임과 상태줄을 제공하며 `/zentui`에서 각 영역을 설정합니다. 사용자 설정은 `~/.pi/agent/zentui.json`에 저장합니다.

`pi-agent-browser-native`는 `agent_browser` 도구를 제공하지만 브라우저 실행 파일을 포함하지 않습니다. 호환 버전을 별도로 설치합니다.

```sh
npm install --global --allow-scripts=agent-browser agent-browser@0.33.2
agent-browser install
agent-browser --version
npm exec --yes --package pi-agent-browser-native@0.3.0 -- pi-agent-browser-doctor
```

설치 후 페이지 열기, interactive snapshot, 클릭, 입력, screenshot과 인증된 browser profile을 사용할 수 있습니다. `ffmpeg`는 WebM 녹화에만 필요합니다. 확장의 선택형 Exa·Brave 검색은 끄고 웹 검색에는 `pi-web-access`를 사용합니다.

## 사용량 조회

`/usage`는 Claude Code, OpenAI Codex, Synthetic을 병렬 조회해 현재 사용률과 reset 또는 regeneration 시각을 보여줍니다. Credential과 공급자의 원문 오류 응답은 출력하지 않습니다.

Claude Code와 OpenAI Codex는 Pi OAuth credential과 각 CLI가 사용하는 usage endpoint에 의존합니다. API key 인증에서는 계정 quota를 가져오지 못할 수 있습니다. Synthetic은 5시간 요청량과 주간 credit 사용률을 제공하며 별도로 구매한 Subscription Credit은 이 quota 응답에 포함되지 않습니다.

## 저장소 구조

```text
.pi/
  SYSTEM.md                 choco-pi 공통 운용 규칙
  mcp.example.json          로컬 credential을 제외한 MCP 설정 예시
  settings.json             패키지, 테마와 compaction 설정
  subagents.json            Sub-agent runtime과 fallback 설정
  agents/                   Project-aware leaf role
  extensions/               공급자, 세션, context, usage, UI 동작
  prompts/                  익숙한 slash command template
  skills/                   작업 절차 구현
  scripts/                  작업 절차 공통 utility
  writing-policy.md         항상 적용하는 글쓰기 규칙
  review-policy.md          공통 적대적 리뷰 규칙
examples/                   사용자 전역 설정 예시
```

설치하거나 설정을 바꾼 뒤 기본 환경을 확인합니다.

```text
/check
```

이 검사는 credential을 읽지 않고 Node·Pi 버전, 설정, 설치 패키지 버전, 필수 harness resource, command alias와 선택형 browser runtime을 확인합니다.

## Q&A

### 왜 이미 좋은 코딩 에이전트들을 두고 choco-pi를 만들었나요?

세 가지가 필요했습니다: 여러 공급자의 모델을 한 세션에서 혼용하는 것, OpenAI server-side compaction을 에이전트 전체에서 쓰는 것, 그리고 제 작업 방식에 맞는 harness를 갖는 것.

- **Codex**는 훌륭한 에이전트지만 멀티 에이전트 시스템이 V1·V2로 나뉘어 있어 OpenAI 외의 모델에서 사용할 때 불편함을 느꼈습니다.
- **Claude Code**에서는 당연히 OpenAI 모델을 쓸 때 server-side compaction을 전달하지 않아 Context Window가 제한되는 ChatGPT 구독에서는 긴 세션이 느린 로컬 compaction이 반복되어 불편함을 느낍니다.
- **OpenCode**는 Pi만큼 확장하기 쉽지 않고, OpenAI server-side compaction을 지원하지 않습니다.

Pi의 확장 모델이 세 문제를 하나의 profile로 해결했습니다. 샌드박스가 없는 점도 장점이었습니다. 시스템 프롬프트에서 제약을 명확히 주면 에이전트가 위험하게 행동하지 않았고, Codex는 YOLO 모드로 Claude Code는 dangerously-skip-permissions를 켜고 써 왔기 때문에 Pi의 신뢰 기반 모델이 맞았습니다.

### 왜 1M context window 모델을 600K로 제한하고 compaction 지점도 변경했나요?

최근 모델은 이전 세대보다 긴 context를 잘 처리하지만 context가 길어질수록 출력 품질은 여전히 떨어집니다. ChatGPT 구독의 입력 상한은 272K(+ 128K output)이므로 600K soft cap은 가장 큰 공급자의 실질 한도를 이미 넘습니다. Server-side compaction이 없는 모델은 로컬 summary fallback에 의존해 느리고 예측이 어렵습니다. 600K는 품질이 유지되는 범위를 지키면서 원격 compaction이 없는 공급자도 수용하는 지점입니다.

### choco-pi가 기존 코딩 에이전트에서 가져온 것은 무엇인가요?

choco-pi는 제 작업 방식에 맞춰 만든 harness지만, Claude Code·Codex 등 기존 에이전트에서 생산성을 높여 준 기능을 그대로 옮기려 했습니다.

- `/context`는 토큰 사용량과 active·deferred 도구, MCP 서버, context와 autocompact 상태를 한 화면에 보여줍니다.
- `/usage`는 Claude Code·OpenAI Codex·Synthetic 등 구독 서비스의 할당량을 나란히 표시해 여러 공급자의 사용량 제한을 한눈에 확인할 수 있습니다.
- choco-pi는 시작 시 모든 도구를 등록하지 않고 BM25 매칭으로 MCP·확장 도구를 lazy load하는 도구 검색 도구를 만들었습니다. 이는 Claude Code나 Codex 등 여러 다른 코딩 에이전트처럼 모델 context를 작게 유지할 수 있게 도와줍니다.
- `/rewind`는 파일, Git index와 대화 branch를 선택한 turn으로 되돌리고 해당 prompt를 편집기에 복원합니다.
- 별도의 독립된 세션도 생성·조회·steer·대기할 수 있어 멀티 세션에서도 다른 에이전트에서 지원하는 세션 간 조율 기능도 그대로 쓸 수 있습니다.

이 편의를 유지하면서 다중 공급자 모델 혼용과 Pi를 활용한 확장성을 얻는 것이 목표였습니다.

## 보안과 권한 경계

- OAuth token, API key, 환경 override, MCP trace, Pi package 설치 결과와 sub-agent runtime data는 Git 밖에 둡니다.
- choco-pi는 신뢰도가 높은 로컬 개발 환경을 전제로 하며 별도 approval workflow를 추가하지 않습니다.
- 작업이 수정을 요구하면 로컬 프로젝트 파일과 명시된 로컬 database를 변경할 수 있습니다.
- 원격 database·service, working folder 밖의 경로, 관련 없는 임시 위치에는 사용자의 명시적 허가 없이 쓰지 않습니다.
- 커밋 요청은 push, PR 생성, deploy, publish나 다른 원격 변경 권한을 포함하지 않습니다.

## 참고 자료

- [Pi](https://pi.dev/)
- [Pi 공급자와 인증](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Pi 패키지 관리](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi 사용자 정의 모델](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Pi compaction](https://pi.dev/docs/latest/compaction)
- [Synthetic 확장](https://github.com/aliou/pi-synthetic)
- [Callstack Apex 소개](https://www.callstack.com/blog/introducing-apex-a-fast-specialized-model-for-react-native)
- [OpenAI Codex source](https://github.com/openai/codex)
