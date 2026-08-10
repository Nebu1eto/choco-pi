# choco-pi

개인 취향에 맞춘 [Pi 코딩 에이전트](https://pi.dev/) 설정 저장소입니다. 플러그인과 공유 가능한 설정만 Git으로 관리하고, OAuth 토큰과 API 키는 Pi의 사용자 전용 인증 저장소에 둡니다. 현재 기준은 Pi 0.84.1과 Node.js 24 이상입니다.

## 시작하기

저장소 루트에서 `pi`를 실행하고 프로젝트를 신뢰하면 [`.pi/settings.json`](.pi/settings.json)에 버전을 고정한 패키지를 설치합니다. npm이 보류한 네이티브 보조 패키지는 내용을 확인한 뒤 다음처럼 허용합니다.

```sh
cd .pi/npm
npm install-scripts approve --allow-scripts-pin @ast-grep/cli tree-sitter-bash
npm rebuild @ast-grep/cli tree-sitter-bash
```

설정 변경 뒤에는 Pi에서 `/reload`를 실행합니다.

## 기본 플러그인

| 기능 | 패키지 | 버전 |
|---|---|---:|
| Synthetic provider | [`@aliou/pi-synthetic`](https://github.com/aliou/pi-synthetic) | 0.24.3 |
| 서브 에이전트·steering·queue | [`pi-subagents`](https://github.com/nicobailon/pi-subagents) | 0.45.2 |
| Codex형 goal | [`pi-codex-goal`](https://pi.dev/packages/pi-codex-goal) | 0.2.0 |
| 지연 로딩 MCP | [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) | 2.21.2 |
| LSP·lint·AST 진단 | [`pi-lens`](https://pi.dev/packages/pi-lens) | 3.8.74 |
| Codex 도구·OpenAI compaction | [`@howaboua/pi-codex-conversion`](https://pi.dev/packages/@howaboua/pi-codex-conversion) | 3.0.12 |
| 웹 검색·문서 추출 | [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | 0.20.0 |
| 작업 중 사이드 대화 | [`pi-btw`](https://pi.dev/packages/pi-btw) | 0.4.1 |
| Starship형 상태줄·TUI | [`pi-zentui`](https://pi.dev/packages/pi-zentui) | 0.18.1 |
| 네이티브 브라우저 자동화 | [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native) | 0.3.0 |
| 하위 `AGENTS.md`·Markdown workflow | [`@howaboua/pi-markdown-workflows`](https://pi.dev/packages/@howaboua/pi-markdown-workflows) | 0.2.20 |

## 서브 에이전트

패키지 내장 역할은 비활성화했습니다. 대신 [`.pi/agents/general.md`](.pi/agents/general.md)를 시작점으로 복사하거나 `/subagents`에서 원하는 역할을 만듭니다. agent를 만들거나 편집할 때 `model`과 `thinking`을 지정할 수 있고, 실행할 때는 `model`을 다시 덮어쓸 수 있습니다.

- `/subagents`: agent·model·thinking 설정
- `/subagents-fleet`: 실행 중인 child 조회, transcript 확인, steering과 중지. `s`로 메시지를 쓰고 Tab으로 `steer`·`follow_up`·`auto`를 선택
- 메인 에이전트에 “다음 turn에 전달해”라고 요청하거나 Fleet에서 `follow_up` 선택: FIFO queue에 적재
- 즉시 방향 전환 요청: `steer` 모드로 다음 안전 지점에 전달

프로젝트 agent는 `.pi/agents/**/*.md`, 프로젝트 skill은 `.pi/skills/**/SKILL.md`에 둡니다. `general`은 프로젝트 문맥과 skill을 상속하지만 모델과 thinking 기본값은 고정하지 않습니다.

## 시스템 프롬프트

프로젝트의 [`runtime-model-prompt.ts`](.pi/extensions/runtime-model-prompt.ts)는 매 turn의 시스템 프롬프트 끝에 현재 `provider/model`을 추가합니다. 모델을 전환하면 다음 turn부터 새 값이 들어가며, API 키나 OAuth 정보는 포함하지 않습니다.

정적인 규칙을 추가할 때는 Pi 기본 prompt를 유지하는 `.pi/APPEND_SYSTEM.md`를 우선 사용합니다. `.pi/SYSTEM.md`는 기본 prompt 전체를 교체해야 할 때만 사용합니다.

### 하위 `AGENTS.md`

Pi 자체는 시작 디렉터리에서 상위로 올라가며 context file을 읽고, 하위 디렉터리는 미리 재귀 탐색하지 않습니다. `@howaboua/pi-markdown-workflows`는 에이전트가 파일 읽기, read-like shell 명령 또는 Code Mode 작업으로 하위 경로에 들어갈 때 해당 경로까지의 `AGENTS.md` 체인을 넓은 범위부터 구체적인 범위 순서로 추가합니다. 위 시작 절차처럼 저장소 루트에서 Pi를 실행하면 루트 `AGENTS.md`는 Pi가 이미 읽으므로 다시 넣지 않습니다.

예를 들어 저장소 루트에서 Pi를 실행한 뒤 `packages/api/src/service.ts`를 읽으면 다음 파일 중 존재하는 항목이 순서대로 적용됩니다.

```text
packages/AGENTS.md
packages/api/AGENTS.md
packages/api/src/AGENTS.md
```

이미 읽은 내용은 세션에 유지되고, 파일이 바뀌면 최대 10회의 대상 작업 안에 갱신됩니다. 이 패키지는 `/workflows`, `/skills`, `/learn` 명령과 확인 후 `.pi/workflows/`에 절차를 기록하는 `workflows_create` 도구도 제공합니다.

## Compaction

기본 soft context cap은 200,000 tokens입니다. Pi의 `reserveTokens`가 16,384이므로 자동 compaction은 대략 183,616 tokens에서 시작하고, Pi fallback summary는 최근 20,000 tokens를 유지합니다.

모델별 값은 [`.pi/extensions/context-cap.json`](.pi/extensions/context-cap.json)에서 조정합니다.

```json
{
  "defaultCap": 200000,
  "appliesOver": 200000,
  "models": {
    "openai-codex/gpt-5.6-sol": 180000,
    "anthropic/claude-opus-4-6": 160000,
    "provider/model-with-native-window": null
  }
}
```

- `provider/model: number`: 해당 모델의 정확한 soft cap
- `provider/model: null`: 해당 모델은 native context window 유지
- `/context-cap`: 현재 세션에 실제 적용된 cap 확인

OpenAI Codex에서는 `/codex openai`의 native Responses compaction을 켭니다. 이 저장소의 예시는 [`examples/pi-codex-conversion.json`](examples/pi-codex-conversion.json)이며, 패키지가 지원하는 사용자 전역 경로 `~/.pi/agent/pi-codex-conversion.json`에 복사합니다. 이는 OpenAI 서버가 `remote_compaction_v2` checkpoint를 만드는 방식이며 OpenAI Codex와 명시적으로 설정한 Responses 호환 provider에만 적용됩니다. 지원하지 않거나 원격 요청이 실패하면 가능한 경우 Pi compaction으로 폴백하며, 암호화된 checkpoint를 안전하게 재사용할 수 없는 상태에서는 문맥 손상을 막기 위해 명시적으로 취소합니다. 현재 Pi와 버전 범위가 맞지 않는 [`pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)은 함께 설치하지 않습니다.

## Goal, MCP, 웹 검색과 BTW

- `/create-goal <작업>`: 검증 조건을 포함한 goal 생성
- `/goal`: 현재 goal·사용량·상태 확인
- [`.mcp.json`](.mcp.json): 프로젝트 MCP server 추가; 기본은 빈 구성이고 server는 lazy start
- `/mcp`: MCP 상태와 설정
- `web_search`, `fetch_content`: `pi-web-access`의 검색·본문 추출 도구
- `/btw <질문>`: 메인 agent가 작업 중이어도 별도 Pi sub-session에서 질문
- `/btw:model`, `/btw:thinking`: BTW 전용 모델과 reasoning 조정
- `/btw:inject`, `/btw:summarize`: 사이드 대화를 메인 문맥으로 전달

## TUI와 브라우저

`pi-zentui`는 기본 설정으로 Opencode형 editor, framed user message, Starship형 footer를 적용합니다. `/zentui`에서 각 영역을 켜거나 끄고 스타일을 바꿀 수 있으며, 사용자 설정은 `~/.pi/agent/zentui.json`에 저장됩니다.

`pi-agent-browser-native`는 `agent_browser` 도구를 추가하지만 브라우저 엔진은 포함하지 않습니다. 현재 패키지와 맞는 upstream 실행 파일을 별도로 설치하고 PATH에서 확인해야 합니다.

```sh
npm install --global --allow-scripts=agent-browser agent-browser@0.33.2
agent-browser install
agent-browser --version
npm exec --yes --package pi-agent-browser-native@0.3.0 -- pi-agent-browser-doctor
```

설치가 끝나면 에이전트가 `agent_browser`로 페이지 열기, interactive snapshot, 클릭, 입력, screenshot과 인증된 프로필 작업을 수행할 수 있습니다. `ffmpeg`는 브라우저 녹화 결과를 WebM으로 인코딩할 때만 필요합니다. 이 저장소는 확장의 선택형 Exa·Brave 검색 기능은 켜지 않으며, 기본 웹 검색에는 기존 `pi-web-access`를 사용합니다.

## 인증

OAuth 토큰과 API 키는 `~/.pi/agent/auth.json`에 저장됩니다. 이 파일은 Pi가 권한 `0600`으로 관리하며 저장소에 복사하지 않습니다.

Pi를 실행하고 다음 명령을 사용합니다.

```text
/login openai-codex
/login anthropic
/login synthetic
```

- `openai-codex`: ChatGPT Plus/Pro 계정으로 브라우저 로그인
- `anthropic`: Claude 계정 로그인을 선택해 브라우저에서 승인
- `synthetic`: Synthetic API 키 입력

셸 환경 변수를 선호하면 Synthetic은 다음 방식도 지원합니다.

```sh
export SYNTHETIC_API_KEY='...'
```

인증 값을 출력하지 않고 상태만 확인하려면 다음 명령을 사용합니다.

```sh
pi auth check --provider openai-codex --json
pi auth check --provider anthropic --json
pi --approve --list-models synthetic
```

마지막 명령은 Synthetic 인증이 준비되면 사용 가능한 모델을 표시합니다. Pi의 `auth` 하위 명령은 프로젝트 확장 공급자를 불러오지 않으므로 Synthetic 확인에는 사용하지 않습니다.

## Callstack Apex

Apex의 API base URL을 [`.pi/extensions/apex-provider.json`](.pi/extensions/apex-provider.json)에 넣습니다. URL은 모델 API 접두사까지 포함해야 합니다. 예를 들어 모델 목록이 `https://apex.example/v1/models`에 있다면 `baseUrl`은 `https://apex.example/v1`입니다. 저장소에 URL을 남기고 싶지 않으면 `CALLSTACK_APEX_BASE_URL` 환경 변수가 이 값을 덮어씁니다.

```json
{
  "baseUrl": "https://replace-with-apex-endpoint.example/v1",
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

API 키는 저장소에 넣지 않습니다. 환경 변수로 전달하거나, base URL을 설정하고 Pi를 다시 시작한 뒤 `/login callstack-apex`로 `~/.pi/agent/auth.json`에 저장합니다.

```sh
export CALLSTACK_APEX_API_KEY='...'
pi --approve --list-models callstack-apex
```

환경 변수 대신 `/login callstack-apex`로 키를 저장했다면 `/apex-refresh`를 한 번 실행합니다. 그 뒤에는 Pi를 시작할 때 모델을 자동 discovery하고 결과를 최대 4시간 재사용합니다. API의 모델 목록이 바뀌었을 때도 `/apex-refresh`로 즉시 강제 갱신할 수 있습니다.

프로젝트 확장은 `${baseUrl}/models`를 Bearer 인증으로 조회합니다. 표준 OpenAI 응답인 `{ "data": [{ "id": "..." }] }`를 비롯해 배열과 `{ "models": [...] }` 형식을 인식하고, discovery 결과를 Pi의 모델 저장소에 캐시합니다. API가 `name`, `context_window`, `max_tokens`, `input_modalities`, `reasoning` 또는 `supported_features`를 제공하면 자동 반영합니다. 빠진 값에는 `defaults`를 사용합니다.

API 메타데이터가 없거나 잘못됐으면 모델별 값을 명시할 수 있습니다. `overrides`가 discovery 값보다 우선합니다.

```json
{
  "overrides": {
    "apex-model-id": {
      "name": "Callstack Apex",
      "contextWindow": 200000,
      "maxTokens": 32768,
      "reasoning": true,
      "input": ["text", "image"]
    }
  }
}
```

기본 `api`는 일반 OpenAI Chat Completions 호환 경로를 쓰는 `openai-completions`입니다. Apex가 Responses API까지 호환한다고 확인된 경우에만 `openai-responses`로 바꿉니다. 이 변경만으로 OpenAI server-side compaction이 활성화되지는 않습니다.

## 참고 자료

- [Pi 공식 사이트](https://pi.dev/)
- [Pi 공급자와 인증](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Pi 패키지 관리](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi 사용자 정의 모델](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Pi compaction](https://pi.dev/docs/latest/compaction)
- [Synthetic Pi 확장](https://github.com/aliou/pi-synthetic)
- [Callstack Apex 소개](https://www.callstack.com/blog/introducing-apex-a-fast-specialized-model-for-react-native)
