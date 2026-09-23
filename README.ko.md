# choco-pi

[English](README.md)

choco-pi는 [Pi](https://pi.dev/) 코딩 에이전트를 위한 프로젝트 인식 프로필입니다. 운용 규칙, 구현·리뷰 작업 절차, 서브 에이전트, 코드 인텔리전스, 조사·자동화 도구, Nord 터미널 인터페이스를 제공합니다. 패키지, 스킬, 에이전트 정의는 이 체크아웃에서 불러오고, `agent-browser` CLI, MCP 서버, 검색 백엔드 같은 선택 도구는 외부에 있습니다.

OAuth 토큰, API 키, 컴퓨터별 로컬 설정은 Git 밖에 보관하세요.

## 요구 사항

- Node.js 24 이상
- pnpm `11.11.0` (다른 버전은 사용할 수 없음)
- Pi `0.87.1` (이 체크아웃이 고정한 SDK 패키지와 동일한 버전)
- Git
- 선택 사항: 브라우저 자동화를 위한 [`agent-browser`](https://github.com/vercel-labs/agent-browser). 0.34.0, 0.35.2, 0.36.0, 0.37.1, 0.38.1 버전을 검증했으며, 그 외 버전은 경고만 표시하고 실행합니다.
- 선택 사항: 데스크톱 조작(computer use)을 위한 macOS 14 이상([computer use 설정하기](#computer-use-설정하기-macos) 참고)

`pnpm --version`이 `11.11.0`을 출력하지 않으면 `npm install --global pnpm@11.11.0`으로
필요한 버전을 설치한 뒤 다시 확인하세요. vendored 패키지 설치 프로그램은 pnpm 버전이
다르면 패키지 트리를 바꾸기 전에 중단합니다.

## 처음 설치하기

저장소는 경로가 바뀌지 않는 곳에 clone하세요. 프로필 설치 프로그램은 Pi 사용자 설정에
절대 경로를 기록하므로, 나중에 체크아웃을 옮기면 새 위치에서 다시 실행해야 합니다.
먼저 [Homebrew를 사용하지 않고 Pi 설치](#homebrew를-사용하지-않고-pi-설치)를 따라
Pi를 설치한 후 프로필을 설치하세요.

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
cd choco-pi

npm install --global pnpm@11.11.0
pnpm --version

pnpm install --frozen-lockfile --ignore-scripts
npm run install:vendored
npm run install:profile
pi
```

### Homebrew를 사용하지 않고 Pi 설치

Homebrew의 `pi-coding-agent` formula는 지원 버전보다 늦게 갱신됩니다. 다음과 같이 버전별 로컬 경로에 Pi를 설치하세요.

```sh
npm install --prefix ~/.local/pi-0.87.1 --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
```

`~/.local/pi-shim/pi` 파일을 만들고 실행 권한을 부여하세요.

```sh
#!/bin/sh
PI_SKIP_VERSION_CHECK=1 exec "$HOME/.local/pi-0.87.1/node_modules/.bin/pi" "$@"
```

셸 설정에서 이 shim 경로를 `/opt/homebrew/bin`보다 앞에 두세요.

```sh
export PATH="$HOME/.local/pi-shim:$PATH"
```

Pi 0.87.1의 `cli.js` 실행기는 Node 컴파일 캐시를 활성화합니다. 원인을 알 수 없는 모듈 로드 오류를 조사할 때는 `NODE_DISABLE_COMPILE_CACHE=1`로 설정해 캐시를 끌 수 있습니다.

Pi가 열리면 `/login`을 실행하고 공급자를 선택하세요. 설치 스크립트는 인증을 수행하거나 로그인 화면을 열지 않으며, 인증 정보를 저장소에 복사하지 않습니다.

루트 설치와 vendored 패키지 6개의 설치는 모두 커밋된 lockfile을 사용합니다.
`npm run install:vendored`는 각 패키지를 독립된 workspace에 설치하고, 설치에 실패하면
해당 패키지의 이전 의존성 트리 복원을 시도합니다. 프로세스가 중단되면
`node_modules.bootstrap-lock` 점유 디렉터리와 `node_modules.bootstrap-backup*` 의존성
백업이 남을 수 있습니다. 설치 프로그램은 이 복구 가능한 상태를 자동으로 정리하지 않으며,
SIGINT 같은 중단 뒤의 롤백도 보장하지 않습니다. 다시 시도하기 전에 무작정 지우지 말고
내용을 확인해 보존하세요.

`npm run install:profile`은 기존 런타임·인증 상태와 사용자가 추가한 패키지를 보존하고,
체크아웃의 절대 경로를 기록한 다음 추적 중인 프로필 리소스를 `~/.pi/agent`에 연결합니다.
MCP 설정은 연결하지 않습니다. 대상에 관련 없는 내용이 이미 있으면 중단합니다. 충돌을
확인한 뒤 적절하다면 `npm run install:profile -- --backup`으로 기존 내용을 보존하고 교체하세요.

## 업데이트와 다시 불러오기

의존성 트리를 교체하기 전에 실행 중인 Pi 세션을 종료하세요. 저장소 변경을 pull한 뒤에는
같은 Node와 pnpm 버전을 유지한 채 frozen 루트 설치, vendored 설치, 프로필 설치를 다시
실행하세요.

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm run install:vendored
npm run install:profile
```

업데이트 후에는 Pi를 다시 시작하세요. 실행 중인 세션에서 `.pi` 아래 파일을 수정했다면
`/reload`를 실행해 확장, 스킬, 프롬프트, 테마, 연결된 프로필 파일을 다시 불러오세요.

## 인증

Pi 세션에서 인증하세요.

```text
/login openai-codex
/login anthropic
/login synthetic
```

Pi는 인증 정보를 저장소 밖에 보관합니다. 인증 정보가 담긴 파일을 Git에 복사하지 마세요.

choco-pi는 Pi에 내장된 Anthropic, OpenAI Codex 로그인 외에 Synthetic 공급자를 추가하고, [`apex-provider.json`](.pi/extensions/apex-provider.json)을 통해 Callstack Apex 모델을 찾습니다.

## computer use 설정하기 (macOS)

computer-use 도구(`observe_ui`, `act_ui` 등)는 네이티브 helper 앱인
`pi-computer-use.app`을 통해 동작합니다. helper는 접근성 트리를 읽고, 창을 캡처하고,
입력을 전달합니다. Apple silicon과 Intel용 helper 바이너리가
`.pi/packages/choco-pi-computer-use/prebuilt/macos`에 커밋되어 있으므로 설치 중에
내려받는 파일은 없습니다. macOS가 아닌 운영체제에는 helper를 설치할 수 없습니다.

### 요구 사항

- macOS 14 이상
- 처음 권한을 부여할 때 사용할 대화형 Pi 세션
- 소스에서 빌드할 때만: `xcrun swiftc`를 제공하는 Xcode 또는 Command Line Tools

### 1. helper 설치

대화형 Pi 세션이 시작될 때 `pi-computer-use.app`이 없으면 Pi가 미리 빌드된
바이너리로 설치합니다. 미리 설치하거나 다시 설치하려면 체크아웃에서 다음을 실행하세요.

```sh
node .pi/packages/choco-pi-computer-use/scripts/setup-helper.mjs
```

스크립트는 설치한 경로를 출력하며, 다음 작업을 합니다.

- `~/Applications/pi-computer-use.app`에 설치합니다. `/Applications/pi-computer-use.app`이 이미 있고 `/Applications`에 쓸 수 있으면 그 자리의 앱을 갱신합니다. 다른 위치를 쓰려면 `PI_COMPUTER_USE_HELPER_APP_PATH`를 설정하고, Pi를 실행할 때도 같은 값을 설정하세요.
- 바이너리를 번들 식별자 `com.injaneity.pi-computer-use`의 앱 번들로 감싸 코드 서명하고 LaunchServices에 등록합니다.
- 다음 순서로 처음 찾은 인증서로 서명합니다. `PI_COMPUTER_USE_CODESIGN_IDENTITY`, 키체인의 "Developer ID Application" 인증서, 스크립트가 `openssl`로 만들어 로그인 키체인에 가져오는 자체 서명 인증서 `pi-computer-use Local Signing (com.injaneity.pi-computer-use)`, 마지막으로 ad-hoc 서명입니다. ad-hoc 서명으로 갱신하면 macOS가 기존 권한을 취소할 수 있습니다. `PI_COMPUTER_USE_NO_SIGN=1`을 설정하면 서명하지 않습니다.
- 이미 최신 helper가 설치되어 있으면 바꾸지 않고 다시 등록만 합니다.

### 2. 권한 부여

helper에는 macOS 권한 두 가지가 필요합니다. 화면 기록(Screen Recording) 권한으로
에이전트가 창을 보고, 손쉬운 사용(Accessibility) 권한으로 창을 조작합니다. 둘 중
하나라도 없으면 Pi가 현재 상태와 함께 다음 메뉴를 보여 줍니다.

- **Open Accessibility Settings (missing)**
- **Open Screen Recording Settings (missing)**
- **Recheck (restarts helper)**
- **Cancel**

각 설정 화면을 열고 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용과 화면 기록에서
`pi-computer-use.app`을 켠 뒤 **Recheck**를 선택하세요. 실행 중인 프로세스가 이전
권한 상태를 기억할 수 있으므로 Pi는 helper를 다시 시작하고, 두 권한이 모두 있으면
`pi-computer-use is ready.`를 표시합니다.

권한은 터미널이 아니라 `pi-computer-use.app`에 부여하세요. helper가 설치된
`pi-computer-use.app`으로 실행되지 않았다는 경고가 나오면 권한을 주기 전에 Pi를 다시
시작하세요. 그 상태에서 준 권한은 helper를 실행한 앱에 붙습니다. print 모드처럼
대화형이 아닌 실행에서는 메뉴 대신 안내 메시지와 함께 설정이 중단되므로, 대화형
세션에서 한 번 권한을 부여하세요.

### 3. 확인

`/computer-use`를 실행하면 적용 중인 설정과 불러온 설정 파일이 표시됩니다. Pi는 세션이
시작될 때와 computer-use 도구를 호출할 때마다 권한을 다시 확인하므로, 빠진 권한이
있으면 위의 메뉴가 다시 나타납니다.

### helper 업데이트

- Pi는 앱이 없을 때만 helper를 설치하고, 이미 있는 helper는 바꾸지 않습니다. `prebuilt/macos` 아래가 바뀐 변경 사항을 pull했다면 설치 스크립트를 다시 실행하고 Pi를 다시 시작하세요.
- Pi는 helper에 연결할 때 프로토콜 버전(현재 7)을 확인합니다. 버전이 다르면 helper를 한 번 다시 실행하고, 그래도 다르면 "helper mismatch after relaunch" 오류로 중단합니다. 이때는 설치 스크립트를 다시 실행하세요.
- helper를 교체하면 앱이 다시 서명되므로 macOS가 이전 권한을 무효화할 수 있습니다. 토글이 켜져 있는데도 Pi가 권한이 없다고 하면 토글을 껐다가 다시 켜세요.
- ad-hoc 서명만 가능한 환경에서는 macOS가 권한을 초기화할 수 있어 스크립트가 설치된 helper의 교체를 거부합니다. Developer ID 인증서를 설치하거나, `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`을 설정한 뒤 권한을 다시 부여하세요.

### 소스에서 빌드

스크립트는 현재 아키텍처용 prebuilt 바이너리가 있으면 항상 그것을 사용합니다.
바이너리가 없을 때만 `PI_COMPUTER_USE_ALLOW_BUILD=1`(또는 `--allow-build`)을 설정하면
`.pi/packages/choco-pi-computer-use/native/macos`의 Swift 소스를 `xcrun swiftc`로
컴파일합니다. 이 설정이 없으면 바이너리가 없을 때 오류로 끝납니다.

### computer use 설정

설정은 `~/.pi/agent/extensions/pi-computer-use.json`, 프로젝트의
`.pi/computer-use.json`, 환경 변수 순서로 읽으며, 나중에 읽은 값이 우선합니다. 두 파일
모두 자동으로 만들어지지 않습니다. 다음 예시는 기본값입니다.

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "foreground_grant": []
}
```

| 키                 | 환경 변수                                       | 효과                                                                                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_use`      | `PI_COMPUTER_USE_BROWSER_USE`                   | 에이전트가 브라우저 창을 조작할 수 있게 합니다.                                                                                                                                                                                                                                                       |
| `managed_browser`  | `PI_COMPUTER_USE_MANAGED_BROWSER`               | 관리형 브라우저가 필요할 때 Pi가 실행할 브라우저입니다. `chrome` 또는 `helium`을 쓸 수 있습니다.                                                                                                                                                                                                      |
| `headless`         | `PI_COMPUTER_USE_HEADLESS`                      | 포인터나 키보드 이벤트 없이 손쉬운 사용 기능으로만 동작을 전달합니다.                                                                                                                                                                                                                                 |
| `cursor_overlay`   | `PI_COMPUTER_USE_CURSOR_OVERLAY`                | 에이전트가 조작하는 동안 화면에 에이전트 커서를 표시합니다.                                                                                                                                                                                                                                           |
| `foreground_grant` | `PI_COMPUTER_USE_FOREGROUND_GRANT`(쉼표로 구분) | 에이전트가 앞으로 가져오고, 창을 올리고, 키보드·마우스 이벤트를 보낼 수 있는 번들 ID 목록입니다. `"*"`도 쓸 수 있습니다. 허용되지 않은 앱에는 입력을 백그라운드로 보내며, 포커스가 필요한 동작은 포커스를 가져가지 않고 `foreground_required`로 실패합니다. 도구 호출로는 이 목록을 바꿀 수 없습니다. |

### helper 제거

1. Pi를 종료합니다. helper가 계속 실행 중이면 `pkill -f pi-computer-use.app/Contents/MacOS/bridge`로 중지합니다.
2. `~/Applications/pi-computer-use.app`(또는 `/Applications/pi-computer-use.app`)을 삭제합니다.
3. 시스템 설정의 손쉬운 사용과 화면 기록 목록에서 `pi-computer-use`를 제거합니다.
4. 필요하면 키체인 접근에서 로그인 키체인의 `pi-computer-use Local Signing` 인증서를 삭제합니다.

## 기능

### 운용 규칙과 작업 절차

- [`.pi/SYSTEM.md`](.pi/SYSTEM.md)는 범위, 권한, 증거, 완료 기준에 대한 공통 규칙을 정합니다. [`.pi/model-guidance.md`](.pi/model-guidance.md)는 모델별 지침을, [`.pi/writing-policy.md`](.pi/writing-policy.md)는 응답 문장 규칙을 더합니다.
- 루트와 경로별 `AGENTS.md` 파일은 에이전트가 하위 디렉터리에서 작업할 때 함께 불러옵니다.
- 작업 절차 스킬은 직접 구현(`task-inline`), 병렬 구현 단위(`task`), 동적 분해 작업(`task-dynamic`), 긴급 수정(`task-hotfix`), 적대적 리뷰(`review`), 환경 점검(`check`), 서명된 로컬 커밋(`commit`), 문서 작성(`effective-writing`)을 다룹니다. 구현 절차는 체크아웃 변경 lease를 잡고 인수 기준표로 검증하며, 푸시하지 않습니다.
- `/preferences`에서 응답 언어, 응답 스타일(`concise` 또는 `explanatory`), 에이전트 페르소나(`unset`, `critical`, `pessimistic`)를 설정합니다. 페르소나는 에이전트가 자신의 주장과 계획을 얼마나 엄격하게 검증할지 정합니다.

### 에이전트와 오케스트레이션

- [`.pi/agents`](.pi/agents)의 전문 역할(`advisor`, `explore`, `general`, `handoff`, `implementer`, `planner`, `reviewer`)은 백그라운드 서브 에이전트로 실행됩니다. 예약 실행, 격리된 Git worktree 실행, `workflow_run`으로 의존 관계 순서를 따르는 workflow 실행도 지원합니다. `/agents`로 관리합니다.
- fleet 패널은 실행 중인 서브 에이전트와 관리되는 백그라운드 셸을 함께 보여 줍니다. 셸은 소유자별로 격리되며 `shell_start`와 `/shells`로 관리합니다.
- `/btw`는 병렬로 진행되는 읽기 전용 곁대화를 엽니다.
- 루트 에이전트와 하위 에이전트는 `advisor` 도구로 설정된 고성능 모델에 의견을 구할 수 있습니다. advisor는 현재 세션 중 일부 발췌만 새 문맥에서 읽고 파일은 수정하지 않으며, 호출한 에이전트는 답을 받을 때까지 기다립니다. 기본값은 비활성이며, advisor 모델이 세션 모델과 같으면 호출을 건너뜁니다. `/preferences`의 Agent → Advisor Agent에서 `enabled`, `model`, `effort`, `maxUses`를 설정할 수 있습니다.

### 세션, 컨텍스트, goal

- 다른 세션에서 프로젝트 대화를 나열, 생성, 읽기, 조정, 대기할 수 있습니다(`/sessions`, `/session-new`, `/session-read`, `/session-send`, `/session-wait`).
- `/goal`은 여러 턴과 compaction에 걸쳐 지속되는 목표를 유지합니다.
- `/rewind`는 체크포인트가 있는 턴 기준으로 파일을 롤백하거나, 세션을 되감거나, 분기합니다.
- compaction 요약은 로컬에서 만들며, 요약 뒤에도 남는 최근 메시지와 대조합니다. [`context-cap.json`](.pi/extensions/context-cap.json)은 모델별 사용 가능한 컨텍스트 상한과 compaction 임계값을 정합니다.
- 새 세션에는 이름이 자동으로 붙습니다. 이름을 짓는 모델은 `sessionAutoNameModel`로 정하며 기본값은 `synthetic/hf:Qwen/Qwen3.8-27B`입니다. 끄려면 `sessionAutoName`을 `false`로 설정하세요.

### 코드 인텔리전스와 Code Mode

- choco-pi-lsp는 LSP 탐색과 진단, lint 연동, ast-grep·tree-sitter 검색과 규칙, 그리고 `symbol_search`, `module_report`, `read_symbol` 같은 시맨틱 도구를 제공합니다. 실행 중에는 `/lsp on|off|status`와 `/lens-*` 명령으로 제어합니다.
- Code Mode의 `exec` 도구는 여러 도구 호출을 한 단계로 묶는 제한된 JavaScript를 실행하며, notebook 모드는 Deno TypeScript 상태를 유지합니다. choco-pi-codex는 `apply_patch`, `exec_command` 같은 Codex 스타일 도구와 Responses compaction도 제공하며, `/codex`로 설정을 엽니다.
- 대부분의 도구는 지연 로딩되며 `tool_search`로 찾습니다. 덕분에 항상 불러오는 도구 목록이 작게 유지됩니다. Pi의 내장 `grep` 도구는 비활성화되어 있으며, 소스 탐색은 `symbol_search`, `module_report`, 필요한 심벌만 읽기, 코드 탐색, AST 검색으로 합니다.

### 조사와 연동

- 웹 조사는 대화 모델과 관계없이 지연 로딩되는 단일 `web_search` 도구를 사용합니다. 검색 인증 정보와 요금은 대화 공급자가 아니라 선택된 검색 백엔드(OpenAI, Exa, Kagi, Synthetic, Brave)에서 결정됩니다. 공급자, 라우팅, 개인정보 보호, fallback 동작은 [웹 검색 안내](docs/web-search.md)를 참고하세요.
- `fetch_content`는 페이지 내용을 추출하고, `source_check`는 인용된 구절로 주장을 검증합니다. `/search`는 저장된 검색 결과를 보여 주고, `/websearch`와 `/curator`는 검색 curator 작업 절차를 실행합니다.
- MCP 서버는 필요할 때 시작되며 OAuth(`/mcp-auth`)와 elicitation을 지원하고, `mcpScript`로 여러 호출을 묶을 수 있습니다. 네이티브 Figma 도구는 파일, 컴포넌트, 변수, 렌더링 결과를 읽습니다.
- `agent_browser`는 선택 사항인 `agent-browser` CLI로 웹 페이지를 자동화합니다.
- macOS에서는 computer-use 도구가 네이티브 helper를 통해 데스크톱 앱을 확인하고 조작합니다. helper에는 손쉬운 사용(Accessibility)과 화면 기록(Screen Recording) 권한이 필요합니다. 설치, 권한, 설정 방법은 [computer use 설정하기](#computer-use-설정하기-macos)를 참고하세요.
- Claude Code 호환 생명주기 훅은 Pi 설정에서 실행됩니다. `/hooks`로 훅을 살펴볼 수 있고, `/add-dir`는 작업 디렉터리를 추가한 뒤 `DirectoryAdded` 훅을 실행합니다.

### 모델과 사용량

- `/effort`는 추론 effort를, `/fast`는 세션의 Fast 모드 설정을 바꿉니다. 설정의 `modelThinkingLevels`는 모델별 기본 thinking 수준을 지정합니다.
- choco-pi는 `PI_CACHE_RETENTION`의 기본값을 `long`으로 설정해, 지원하는 공급자에 1시간 프롬프트 캐시 유지를 요청합니다. 명시적으로 지정한 값이 우선합니다.
- `/usage`(별칭 `/quota`)는 공급자 사용량과 초기화 시각을, `/synthetic:quotas`는 Synthetic 할당량을 보여 줍니다.

### 인터페이스

- Nord 테마의 전체 화면 TUI, 상태 표시줄, 그리고 Status·Context·Usage·Preferences 탭이 있는 `/status` 대화 상자를 제공합니다.
- Mermaid 다이어그램을 터미널에서 렌더링합니다. 응답에서 상자나 화살표 문자로 다이어그램을 그리면, 다음 요청에 Mermaid를 쓰라는 숨은 알림이 붙습니다.
- 퍼지 `@` 파일 멘션, 프롬프트 어디서나 동작하는 슬래시 명령 자동 완성, 터미널 멀티플렉서를 고려한 인라인 이미지 지원을 제공합니다.

## 주요 명령

| 명령                                              | 용도                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `/status`                                         | 세션, 비용, 모델, 컨텍스트, MCP, 환경 상태 표시             |
| `/preferences` (`/pref`)                          | 에이전트, advisor, 언어, 스타일, 페르소나, 인터페이스 설정  |
| `/context all`                                    | 프롬프트, 도구, MCP, 에이전트, 파일, 스킬, 토큰 사용량 확인 |
| `/usage` (`/quota`)                               | 지원하는 공급자의 사용량과 초기화 정보 표시                 |
| `/effort [level]`, `/fast [on\|off\|status]`      | 추론 effort 또는 세션 Fast 모드 설정                        |
| `/check`                                          | 설치된 프로필과 필수 리소스 검증                            |
| `/task-inline <task>`                             | 일반적인 변경 하나를 직접 구현                              |
| `/task <task>`                                    | 독립적인 구현 단위를 병렬 실행                              |
| `/task-dynamic <task>`                            | 동적으로 분해하는 중첩 작업을 명시적으로 활성화             |
| `/task-hotfix <task>`                             | 긴급 운영 수정을 직접 적용                                  |
| `/review [target]`                                | 세션, 브랜치, 풀 리퀘스트 변경을 직접 검토                  |
| `/review-agent [target]`                          | 새 문맥의 에이전트가 코드를 고치지 않고 적대적 리뷰만 수행  |
| `/commit [guidance]`                              | 푸시하지 않고 검증된 로컬 커밋 생성                         |
| `/rewind`                                         | 체크포인트가 있는 턴에서 롤백, 되감기, 분기                 |
| `/agents`, `/btw`                                 | 에이전트 관리 또는 읽기 전용 곁대화 열기                    |
| `/shells`                                         | 관리되는 셸 목록 보기, 출력 읽기, 중지                      |
| `/sessions`, `/session-new`                       | 프로젝트 대화 목록을 보거나 독립 대화 시작                  |
| `/session-read`, `/session-send`, `/session-wait` | 다른 대화 읽기, 조정, 대기                                  |
| `/goal [objective]`                               | 지속형 goal 생성, 확인, 관리                                |
| `/hooks`, `/add-dir`                              | 훅 살펴보기 또는 작업 디렉터리 추가                         |
| `/mcp`, `/mcp-auth`                               | MCP 서버 상태 확인 또는 서버 인증                           |
| `/search`, `/websearch`, `/curator`               | 저장된 검색 결과 보기 또는 검색 curator 실행                |
| `/lsp`                                            | LSP 사용을 켜거나 끄고 상태 표시                            |
| `/codex`, `/computer-use`                         | Codex 어댑터 설정 또는 computer-use 설정 확인               |
| `/apex-refresh`                                   | Callstack Apex 모델 목록 새로 고침                          |
| `/clear`, `/exit`, `/delete`                      | 새 세션 시작, 종료, 현재 세션 영구 삭제                     |

## 설치된 패키지

[`.pi/settings.json`](.pi/settings.json)은 다음 로컬 패키지 17개를 불러옵니다. 이와 별도로 [`choco-pi-acp`](.pi/packages/choco-pi-acp) 0.0.33 패키지는 Pi가 불러오지 않으며, 에디터와 연결하는 독립 ACP 프로세스로 실행됩니다([Zed에서 choco-pi 사용하기](#zed에서-choco-pi-사용하기) 참고).

| 패키지                                                                    |           버전 | 용도                                             |
| ------------------------------------------------------------------------- | -------------: | ------------------------------------------------ |
| [`choco-pi-web-search`](.pi/packages/choco-pi-web-search)                 |          0.1.0 | 단일 웹 검색 도구의 세션별 라우팅                |
| [`choco-pi-web-access`](.pi/packages/choco-pi-web-access)                 | 0.24.1-choco.0 | 웹 검색, 출처 검증, 콘텐츠 추출                  |
| [`choco-pi-provider-synthetic`](.pi/packages/choco-pi-provider-synthetic) |          0.1.0 | Synthetic 공급자, 인증, 사용량, 검색             |
| [`choco-pi-ui`](.pi/packages/choco-pi-ui)                                 |          0.1.0 | TUI, 상태 표시줄, 환경 설정, Nord 테마           |
| [`choco-pi-shells`](.pi/packages/choco-pi-shells)                         |          0.1.0 | 소유자별 백그라운드 셸 프로세스                  |
| [`choco-pi-hooks`](.pi/packages/choco-pi-hooks)                           |          0.1.0 | Claude Code 호환 생명주기 훅                     |
| [`choco-pi-subagents`](.pi/packages/choco-pi-subagents)                   |          0.1.0 | 서브 에이전트, 작업 절차, 세션, fleet UI         |
| [`choco-pi-advisor`](.pi/packages/choco-pi-advisor)                       |          0.1.0 | 서브 에이전트를 통한 읽기 전용 advisor 자문      |
| [`choco-pi-editor-context`](.pi/packages/choco-pi-editor-context)         |          0.1.0 | 에디터 컨텍스트 프로토콜, 저장, 주입             |
| [`choco-pi-goal`](.pi/packages/choco-pi-goal)                             |          0.1.0 | Codex 형태의 지속형 goal                         |
| [`choco-pi-mcp`](.pi/packages/choco-pi-mcp)                               |          0.1.0 | 지연 로딩 MCP 서버, Figma 도구, elicitation      |
| [`choco-pi-lsp`](.pi/packages/choco-pi-lsp)                               |          0.1.0 | LSP, lint, 구조 분석, 시맨틱 도구                |
| [`choco-pi-compaction`](.pi/packages/choco-pi-compaction)                 |          0.1.0 | 유지된 최근 메시지와 대조한 로컬 compaction 요약 |
| [`choco-pi-codex`](.pi/packages/choco-pi-codex)                           |          0.1.0 | Codex 도구, Code Mode, Responses compaction      |
| [`choco-pi-agents-md`](.pi/packages/choco-pi-agents-md)                   |          0.1.0 | 하위 `AGENTS.md` 지침 로딩                       |
| [`choco-pi-agent-browser`](.pi/packages/choco-pi-agent-browser)           |  0.5.0-choco.0 | 네이티브 브라우저 자동화 도구                    |
| [`choco-pi-computer-use`](.pi/packages/choco-pi-computer-use)             |  0.5.0-choco.0 | macOS 데스크톱 확인 및 조작                      |

## 설정과 사용자화

| 파일 또는 디렉터리                                                                                                                            | 용도                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`.pi/settings.json`](.pi/settings.json)                                                                                                      | 불러올 패키지, 테마, TUI 모드, 모델별 thinking 수준, compaction |
| [`.pi/SYSTEM.md`](.pi/SYSTEM.md)                                                                                                              | 프로필 전체에 적용되는 에이전트 동작과 권한 규칙                |
| [`.pi/model-guidance.md`](.pi/model-guidance.md)                                                                                              | 모델 라우팅과 모델별 정책                                       |
| [`.pi/writing-policy.md`](.pi/writing-policy.md)와 [`.pi/review-policy.md`](.pi/review-policy.md)                                             | 응답 문장 규칙과 리뷰 정책                                      |
| [`AGENTS.md`](AGENTS.md)와 [패키지 예시](.pi/packages/choco-pi-subagents/AGENTS.md)                                                           | 루트 및 경로별 저장소 규칙                                      |
| [`.pi/agents`](.pi/agents), [`.pi/skills`](.pi/skills), [`.pi/prompts`](.pi/prompts)                                                          | 에이전트 역할, 작업 절차 스킬, 슬래시 명령 프롬프트             |
| [`.pi/subagents.json`](.pi/subagents.json)                                                                                                    | 서브 에이전트 동시 실행 수, 깊이, fleet 화면, worktree 격리     |
| [`.pi/choco-pi-codex.json`](.pi/choco-pi-codex.json)                                                                                          | Code Mode, Codex 도구, notebook, compaction 설정                |
| [`.pi/zentui.json`](.pi/zentui.json)                                                                                                          | TUI 색상, 구성 요소, 아이콘                                     |
| [`.pi/models.json`](.pi/models.json)과 [`.pi/keybindings.json`](.pi/keybindings.json)                                                         | 공급자 모델 재정의와 키 바인딩                                  |
| [`context-cap.json`](.pi/extensions/context-cap.json)                                                                                         | 모델별 context cap과 compaction 임계값                          |
| [`apex-provider.json`](.pi/extensions/apex-provider.json)                                                                                     | Callstack Apex 공급자 탐색 기본값                               |
| [`review.json`](.pi/extensions/review.json)                                                                                                   | 로컬 리뷰 인터페이스 설정                                       |
| 전역 `~/.pi/agent/advisor.json`과 프로젝트 재정의 `.pi/advisor.json`                                                                          | advisor 활성화, 모델, effort, 턴별 사용 한도                    |
| `~/.pi/agent/mcp.json`과 그 예시인 [`.pi/mcp.example.json`](.pi/mcp.example.json)                                                             | 추적하지 않는 MCP 서버 및 OAuth 설정                            |
| 패키지별 [`AGENTS.md`](.pi/packages/choco-pi-agent-browser/AGENTS.md)와 [`VENDORED.md`](.pi/packages/choco-pi-agent-browser/VENDORED.md) 파일 | 패키지 정책과 기록된 업스트림 변경 사항                         |

`npm run install:profile`은 정책 파일, `subagents.json`, `choco-pi-codex.json`, `models.json`, `keybindings.json`, 에이전트 정의, 확장 JSON 파일 3개를 `~/.pi/agent`에 연결합니다. `zentui.json`은 `choco-pi-ui.json`이라는 이름으로 연결됩니다.

### 전역 설정 예시

`npm run install:profile`은 [`.pi/settings.json`](.pi/settings.json)을 바탕으로
`~/.pi/agent/settings.json`을 만들며, 관리하지 않는 키는 그대로 둡니다. 실행할 때마다
다음 세 가지를 합니다.

- `packages`, `extensions`, `skills`, `prompts`를 체크아웃 절대 경로로 기록합니다. 사용자가 추가한 항목은 choco-pi 항목 뒤에 유지됩니다.
- `.pi/settings.json`의 나머지 키(`theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `modelThinkingLevels`, `compaction`)를 전역 값 위에 덮어씁니다. 이 키들은 `.pi/settings.json`에서 바꾸세요. 전역 파일에서만 고친 값은 다음 설치 때 사라집니다.
- 그 밖의 키는 건드리지 않습니다. 직접 쓰거나 `/preferences`로 설정하세요.

완성된 전역 파일은 다음과 같습니다. `/path/to/choco-pi`는 실제 체크아웃 경로로
바꾸세요. `modelThinkingLevels`는 여기서 줄여 적었으며, 설치 프로그램은 전체 목록을
복사합니다. 비밀 값은 이 파일에 두지 마세요.

```json
{
  "packages": [
    "/path/to/choco-pi/.pi/packages/choco-pi-web-search",
    "/path/to/choco-pi/.pi/packages/choco-pi-web-access",
    "/path/to/choco-pi/.pi/packages/choco-pi-provider-synthetic",
    "/path/to/choco-pi/.pi/packages/choco-pi-ui",
    "/path/to/choco-pi/.pi/packages/choco-pi-shells",
    "/path/to/choco-pi/.pi/packages/choco-pi-hooks",
    "/path/to/choco-pi/.pi/packages/choco-pi-subagents",
    "/path/to/choco-pi/.pi/packages/choco-pi-advisor",
    "/path/to/choco-pi/.pi/packages/choco-pi-goal",
    "/path/to/choco-pi/.pi/packages/choco-pi-mcp",
    "/path/to/choco-pi/.pi/packages/choco-pi-lsp",
    "/path/to/choco-pi/.pi/packages/choco-pi-compaction",
    "/path/to/choco-pi/.pi/packages/choco-pi-codex",
    "/path/to/choco-pi/.pi/packages/choco-pi-agents-md",
    "/path/to/choco-pi/.pi/packages/choco-pi-agent-browser",
    "/path/to/choco-pi/.pi/packages/choco-pi-computer-use",
    "/path/to/choco-pi/.pi/packages/choco-pi-editor-context"
  ],
  "extensions": ["/path/to/choco-pi/.pi/extensions"],
  "skills": ["/path/to/choco-pi/.pi/skills"],
  "prompts": ["/path/to/choco-pi/.pi/prompts"],

  "theme": "nord-dark",
  "tuiMode": "fullscreen",
  "fullscreenExitOutput": "resume-hint",
  "fuzzyFileMentions": true,
  "modelThinkingLevels": {
    "anthropic/claude-opus-5-5": "medium",
    "anthropic/claude-sonnet-5": "xhigh",
    "openai-codex/gpt-6-sol": "medium"
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },

  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5-5",
  "defaultThinkingLevel": "low",
  "enabledModels": [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-5",
    "openai-codex/gpt-6-sol"
  ],
  "cacheWarming": "streaming",
  "transport": "auto",
  "httpIdleTimeoutMs": 300000,
  "quietStartup": true,
  "enableInstallTelemetry": false,
  "markdown": { "mermaid": "streaming" },
  "terminal": { "showTerminalProgress": true, "imageWidthCells": 60 },

  "agentLanguage": "English",
  "agentStyle": "concise",
  "agentPersona": "critical",
  "sessionAutoName": true,
  "sessionAutoNameModel": "synthetic/hf:Qwen/Qwen3.8-27B",

  "hooks": {
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "$HOME/bin/notify-done.sh", "timeout": 5 }]
      }
    ]
  }
}
```

| 키                                                                                                                 | 설정 주체                                   | 설명                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`, `extensions`, `skills`, `prompts`                                                                      | 설치 프로그램                               | 체크아웃 절대 경로입니다. 체크아웃을 옮기면 설치 프로그램을 다시 실행하세요.                                                                                                                                                        |
| `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `modelThinkingLevels`, `compaction`               | 설치 프로그램(`.pi/settings.json`에서 복사) | `compaction.reserveTokens`는 모델 응답용으로 남겨 두는 토큰 수, `compaction.keepRecentTokens`는 요약하지 않고 남기는 최근 토큰 수입니다. 모델별 컨텍스트 상한은 [`context-cap.json`](.pi/extensions/context-cap.json)에서 정합니다. |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`                                         | 사용자                                      | 시작 모델과 thinking 수준입니다. `enabledModels`는 모델 전환 대상을 제한합니다.                                                                                                                                                     |
| `cacheWarming`, `transport`, `httpIdleTimeoutMs`, `quietStartup`, `enableInstallTelemetry`, `markdown`, `terminal` | 사용자                                      | Pi 런타임 설정입니다. `cacheWarming`은 전역 파일에서만 읽으며 `off`, `streaming`(기본값), `idle` 중 하나입니다.                                                                                                                     |
| `agentLanguage`, `agentStyle`, `agentPersona`, `sessionAutoName`, `sessionAutoNameModel`                           | 사용자 또는 `/preferences`                  | choco-pi는 이 키를 전역 파일에서만 읽습니다. `agentStyle`은 `concise`, `explanatory`, 또는 `~/.pi/agent/agent-styles/`에 둔 스타일 파일 이름입니다. `agentPersona`의 기본값은 `critical`입니다.                                     |
| `hooks`                                                                                                            | 사용자                                      | Claude Code 훅 형식입니다. choco-pi-hooks는 `.claude`, `.agents` 설정 파일의 훅도 읽습니다. 자세한 내용은 [README](.pi/packages/choco-pi-hooks/README.md)를 참고하세요.                                                             |

advisor 설정은 별도 파일인 `~/.pi/agent/advisor.json`에 두며, 프로젝트의
`.pi/advisor.json`이 키 단위로 덮어씁니다.

```json
{
  "enabled": true,
  "model": "anthropic/claude-fable-5-1",
  "effort": "low",
  "maxUses": 3
}
```

`effort`에는 `off`부터 `max`까지 쓸 수 있고, `maxUses`는 1 이상이어야 합니다. 파일이
없으면 advisor는 비활성 상태입니다.

## Zed에서 choco-pi 사용하기

`.pi/packages/choco-pi-acp`는 Agent Client Protocol로 Zed와 choco-pi를 연결하고,
`.pi/packages/choco-pi-editor-context`는 Zed Task를 통해 현재 파일, 커서, 선택 영역을
대상 Pi 세션에 동기화합니다. [Zed 설정 안내](docs/zed-setup.md)부터 시작하세요.
[호환성 기준](docs/zed-acp-compatibility.md), [명령 호환 목록](docs/zed-command-parity.md),
[런타임 E2E 증거](docs/zed-e2e-evidence.md)에 검증된 내용이 기록되어 있습니다.

## 개발 검증

루트 검증 절차를 실행하세요.

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm test
```

런타임과 TUI 변경은 새 Pi 프로세스에서도 검증해야 합니다. 패키지 정책에 따라 추가 검사가 필요할 수 있습니다.

## 보안과 권한

인증 정보와 로컬 재정의 값은 Git으로 추적하면 안 됩니다. 원격 쓰기, 배포, 풀 리퀘스트, 게시 등 외부 시스템을 변경하려면 명시적인 승인이 필요합니다.

## 라이선스 상태

`choco-pi-web-search`를 제외한 모든 로컬 패키지 매니페스트에는 MIT 라이선스가 선언되어 있으며, `choco-pi-web-search`에는 라이선스 선언이 없습니다. 저장소 루트에는 라이선스 파일이 없으므로, 이 README는 저장소 전체에 라이선스를 부여하지 않습니다.

## 참고 자료

- [Pi](https://pi.dev/)
- [OpenAI Codex Code Mode](https://github.com/openai/codex/tree/main/codex-rs/code-mode)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [`agent-browser`](https://github.com/vercel-labs/agent-browser)
- [`pi-computer-use`](https://github.com/injaneity/pi-computer-use)
