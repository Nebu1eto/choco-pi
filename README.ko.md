# choco-pi

[English](README.md)

choco-pi는 [Pi](https://pi.dev/) 코딩 에이전트를 위한 프로젝트 인식 프로필입니다. 운용 규칙, 구현·리뷰 작업 절차, 서브 에이전트, 코드 인텔리전스, 조사·자동화 도구, Nord 터미널 인터페이스를 제공합니다. 패키지, 스킬, 에이전트 정의는 이 체크아웃에서 불러오고, `agent-browser` CLI, MCP 서버, 검색 백엔드 같은 선택 도구는 외부에 있습니다.

OAuth 토큰, API 키, 컴퓨터별 로컬 설정은 Git 밖에 보관하세요.

## 요구 사항

- Node.js 24 이상
- pnpm `11.11.0` (다른 버전은 사용할 수 없음)
- Pi `1.5.2` 이상의 `1.5.x` (`>=1.5.2 <1.6.0`, 이 체크아웃의 SDK 범위 `~1.5.2`와 동일)
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

pnpm install --frozen-lockfile
npm run install:profile
pi
```

체크아웃에는 `.pi/settings.json`이 없습니다. 설치 프로그램은 프로필 정책을
`~/.pi/agent/settings.json`에서 읽습니다. 새 컴퓨터처럼 이 파일이 없거나 번들
패키지가 하나도 없으면 설치 프로그램이 번들 패키지 목록과 내장 확장 정책을 직접
기록합니다. 나머지 키가 필요하면 그다음에 [전역 설정 예시](#전역-설정-예시)를
참고해 추가하세요.

### Homebrew를 사용하지 않고 Pi 설치

Homebrew의 `pi-coding-agent` formula는 고정된 릴리스보다 늦게 갱신되므로 choco-pi는 Homebrew 설치를 지원하지 않습니다. 공식 설치 프로그램으로 Pi를 설치하세요.

```sh
curl -fsSL https://pi.dev/install.sh | sh
```

설치 프로그램은 관리형 실행기 `~/.pi/agent/bin/pi`를 만들고 `~/.local/bin/pi`에서 이 실행기로 링크합니다. 셸 설정에서 `~/.local/bin`을 `/opt/homebrew/bin`보다 앞에 둔 다음 버전을 확인하세요.

```sh
export PATH="$HOME/.local/bin:$PATH"
pi --version
```

이 명령은 `1.5.2` 이상의 `1.5.x` 릴리스를 출력해야 합니다. 이후의 1.5 패치 릴리스는 체크아웃을 바꾸지 않아도 허용됩니다. 설치 프로그램은 Pi의 최신 릴리스를 설치하므로, `1.6.0`처럼 범위를 벗어난 버전이 출력되면 이 체크아웃의 범위를 검토해 그 버전으로 옮길 때까지 `/check`가 실패하고 프로필 설치 프로그램은 해당 실행기를 기록하지 않습니다.

Pi 1.5의 `cli.js` 실행기는 Node 컴파일 캐시를 활성화합니다. 원인을 알 수 없는 모듈 로드 오류를 조사할 때는 `NODE_DISABLE_COMPILE_CACHE=1`로 설정해 캐시를 끌 수 있습니다.

Pi가 열리면 `/login`을 실행하고 공급자를 선택하세요. 설치 스크립트는 인증을 수행하거나 로그인 화면을 열지 않으며, 인증 정보를 저장소에 복사하지 않습니다.

루트 설치와 vendored 패키지 7개의 설치는 모두 커밋된 lockfile을 사용합니다.
루트 `postinstall` 스크립트가 `npm run install:vendored`를 실행하며, 이 명령은 각 패키지를
독립된 workspace에 설치하고, 설치에 실패하면 해당 패키지의 이전 의존성 트리 복원을
시도합니다. vendored 설치가 실패하면 루트 설치도 실패하며, 루트 설치를 다시 실행하면
재시도합니다. 프로세스가 중단되면
`node_modules.bootstrap-lock` 점유 디렉터리와 `node_modules.bootstrap-backup*` 의존성
백업이 남을 수 있습니다. 설치 프로그램은 이 복구 가능한 상태를 자동으로 정리하지 않으며,
SIGINT 같은 중단 뒤의 롤백도 보장하지 않습니다. 다시 시도하기 전에 무작정 지우지 말고
내용을 확인해 보존하세요.

vendored 트리를 복구하려면 `npm run install:vendored`를 직접 실행하세요. 루트 설치가
`Already up to date`를 출력하면 vendored `node_modules`가 없거나 손상되었더라도
`postinstall`이 실행되지 않으며, `--ignore-scripts`(또는 npmrc의 `ignore-scripts=true`)를
사용하면 `postinstall`을 아예 건너뜁니다.

`npm run install:profile`은 기존 런타임·인증 상태와 사용자가 추가한 패키지를 보존하고,
체크아웃의 절대 경로를 기록한 다음 추적 중인 프로필 리소스를 `~/.pi/agent`에 연결합니다.
MCP 설정은 연결하지 않습니다. 대상에 관련 없는 내용이 이미 있으면 중단합니다. 충돌을
확인한 뒤 적절하다면 `npm run install:profile -- --backup`으로 기존 내용을 보존하고 교체하세요.

## 업데이트와 다시 불러오기

의존성 트리를 교체하기 전에 실행 중인 Pi 세션을 종료하세요. 변경이 없는 경우를 제외한
모든 루트 설치는 `pnpm add`와 `pnpm remove`를 포함해 `postinstall`로 vendored 트리
7개를 모두 교체합니다. 저장소 변경을 pull한 뒤에는 같은 Node와 pnpm 버전을 유지한 채
vendored 패키지까지 복원하는 frozen 루트 설치와 프로필 설치를 다시 실행하세요.

```sh
pnpm install --frozen-lockfile
npm run install:profile
```

업데이트 후에는 Pi를 다시 시작하세요. 실행 중인 세션에서 `.pi` 아래 파일을 수정했다면
`/reload`를 실행해 확장, 스킬, 프롬프트, 테마, 연결된 프로필 파일을 다시 불러오세요.

### 내장 확장

Pi 1.5에는 `codemode`, `tool-search`, `mcp`, `llama.cpp` 확장이 내장되어 있습니다. choco-pi는 Pi에 내장된 도구 검색과 MCP를 그대로 쓰고, 자체 `exec` 코드 모드 브리지를 유지하기 위해 `"extensions": ["-builtin:codemode"]`로 `codemode`만 비활성화합니다. 프로필 설치 프로그램은 이 정책을 전역 설정에 반영하고 그 밖의 내장 확장 비활성화 항목은 제거합니다.

MCP 서버는 Pi의 `~/.pi/agent/mcp.json` 형식으로 설정합니다. 폐기된 `pi-mcp-adapter` 포크용으로 작성한 파일은 `node scripts/translate-mcp-config.ts`로 변환하세요. 이 스크립트는 값을 가린 dry-run diff를 출력하며, `--apply`를 줄 때만 시각이 붙은 백업을 남기고 파일을 씁니다.

## 인증

Pi 세션에서 인증하세요.

```text
/login openai
/login anthropic
/login synthetic
/login xai
```

Pi는 인증 정보를 저장소 밖에 보관합니다. 인증 정보가 담긴 파일을 Git에 복사하지 마세요.

`/login openai`는 Pi의 "Sign in with ChatGPT"이며 `openai` 공급자(api.openai.com)를 사용합니다. 기존 `openai-codex` 공급자(chatgpt.com 백엔드)는 선택형 레거시로 남아 있으며 `/login openai-codex`로 로그인합니다. `openai` 로그인에서는 Fast 모드가 수락되지만 적용되지 않고 전송되지도 않으며, Daybreak은 사용할 수 없고, 서버 측 압축은 시도하지 않고(로컬 압축 실행), 네이티브 `web_run` 검색도 쓸 수 없습니다(웹 검색은 `choco-pi-web-access`를 거칩니다). `imagegen`과 `view_image`는 `openai` 인증 정보를 찾지만 실제 환경에서는 검증되지 않았습니다. Pi에 내장된 `xai` 공급자(Grok)는 `/login xai`(SuperGrok 또는 X Premium)로 로그인하거나 `XAI_API_KEY`를 읽으며, Fast 모드는 api.x.ai의 `xai/grok-4.7`에만 적용됩니다. choco-pi는 Pi에 내장된 Anthropic, OpenAI, xAI 로그인 외에 Synthetic 공급자를 추가하고, [`apex-provider.json`](.pi/extensions/apex-provider.json)을 통해 Callstack Apex 모델을 찾습니다.

## computer use 설정하기 (macOS)

computer-use 도구(`observe_ui`, `act_ui` 등)는 네이티브 helper 앱인
`pi-computer-use.app`을 통해 동작합니다. helper는 접근성 트리를 읽고, 창을 캡처하고,
입력을 전달합니다. helper 바이너리는 커밋되어 있지 않습니다. 설치 스크립트가 설치할
때마다 `.pi/packages/choco-pi-computer-use/native/macos`의 Swift 소스를 현재 Mac의
아키텍처용으로 컴파일하며, 내려받는 파일은 없습니다. macOS가 아닌 운영체제에는
helper를 설치할 수 없습니다.

### 요구 사항

- macOS 14 이상
- 처음 권한을 부여할 때 사용할 대화형 Pi 세션
- `xcrun swiftc`를 제공하는 Xcode 또는 Command Line Tools(`xcode-select --install`)

### 1. helper 설치

대화형 Pi 세션이 시작될 때 `pi-computer-use.app`이 없으면 Pi가 helper를 빌드해
설치하며, 수십 초가 걸립니다. 미리 설치하거나 다시 설치하려면 체크아웃에서 다음을 실행하세요.

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

- Pi는 앱이 없을 때만 helper를 설치하고, 이미 있는 helper는 바꾸지 않습니다. `native/macos` 아래가 바뀐 변경 사항을 pull했다면 설치 스크립트를 다시 실행하세요. 설치된 helper가 같은 소스로 빌드되었다면 스크립트는 빌드를 건너뜁니다.
- helper 데몬은 Pi가 종료된 뒤에도 계속 실행됩니다. Pi는 연결할 때 데몬의 프로토콜 버전(현재 7), 실행 파일 경로, 시작 시각을 설치된 앱과 비교하고, 설치된 바이너리보다 오래된 데몬은 한 번 다시 실행합니다. 따라서 helper를 다시 설치하면 Pi를 다시 시작하지 않아도 다음 도구 호출부터 새 helper가 쓰입니다. 다시 실행한 데몬도 맞지 않으면 원인을 담은 "helper mismatch after relaunch" 오류로 중단되므로 설치 스크립트를 다시 실행하세요.
- helper를 교체하면 앱이 다시 서명되므로 macOS가 이전 권한을 무효화할 수 있습니다. 토글이 켜져 있는데도 Pi가 권한이 없다고 하면 토글을 껐다가 다시 켜세요.
- ad-hoc 서명만 가능한 환경에서는 macOS가 권한을 초기화할 수 있어 스크립트가 설치된 helper의 교체를 거부합니다. Developer ID 인증서를 설치하거나, `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`을 설정한 뒤 권한을 다시 부여하세요.

### 소스에서 빌드

스크립트는 항상 `xcrun swiftc`로 현재 아키텍처용 helper를 컴파일합니다. 컴파일러
경고는 출력되지만 빌드를 멈추지 않습니다. `--arch arm64` 또는 `--arch x64`로
크로스 컴파일할 수 있지만 검증되지 않았습니다. `--build-only --out <dir>`은 설치나
서명 없이 `<dir>/bridge`만 만듭니다.

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
  "foreground_grant": [],
  "foreground_prompt": "ask",
  "restore_focus": true
}
```

| 키                  | 환경 변수                                       | 효과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_use`       | `PI_COMPUTER_USE_BROWSER_USE`                   | 에이전트가 브라우저 창을 조작할 수 있게 합니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `managed_browser`   | `PI_COMPUTER_USE_MANAGED_BROWSER`               | 관리형 브라우저가 필요할 때 Pi가 실행할 브라우저입니다. `chrome` 또는 `helium`을 쓸 수 있습니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `headless`          | `PI_COMPUTER_USE_HEADLESS`                      | 포인터나 키보드 이벤트 없이 손쉬운 사용 기능으로만 동작을 전달합니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cursor_overlay`    | `PI_COMPUTER_USE_CURSOR_OVERLAY`                | 에이전트가 조작하는 동안 화면에 에이전트 커서를 표시합니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `foreground_grant`  | `PI_COMPUTER_USE_FOREGROUND_GRANT`(쉼표로 구분) | 에이전트가 앞으로 가져오고, 창을 올리고, 키보드·마우스 이벤트를 보낼 수 있는 번들 ID 목록입니다. `"*"`도 쓸 수 있습니다. 허용되지 않은 앱에는 입력을 백그라운드로 보냅니다. 접근성 경로가 없는 포인터 입력은 먼저 백그라운드로 시도합니다. 포커스를 가져가지 않고 앱 프로세스에 직접 보낸 뒤, helper가 짧은 안정화 시간 동안 앱과 창의 픽셀 변화를 지켜봅니다. 눈에 띄는 변화가 없으면 `foreground_required`로 거부하고 같은 호출 안에서는 다시 보내지 않습니다. 허용된 앱에는 이런 포인터 입력을 바로 포그라운드로 보냅니다. 도구 호출로는 이 목록을 바꿀 수 없습니다.                                                                                                                                                     |
| `foreground_prompt` | `PI_COMPUTER_USE_FOREGROUND_PROMPT`             | 앱에 포커스가 필요한데 허용 목록에 없을 때의 동작입니다. helper가 아무것도 전달되지 않았음을 확인한 경우, 허용하면 같은 동작을 포그라운드에서 한 번 다시 시도합니다. 이미 백그라운드로 시도했지만 눈에 띄는 변화가 없었다면 허용은 다음 호출부터 적용되며, 에이전트는 다시 시도하기 전에 앱을 관찰하라는 안내를 받습니다. `ask`(기본값): 대화형 TUI 세션에서 앱마다 세션당 한 번 **Allow for this session**, **Always allow**(사용자 파일의 `foreground_grant`에 번들 ID 추가), **Not now** 중에서 묻습니다. `always`: 묻지 않고 어떤 앱이든 앞으로 가져와 입력을 보낼 수 있게 하는 명시적 opt-in이며, 그렇게 쓴 앱은 모든 호스트 모드에서 세션이 끝날 때까지 허용됩니다. `off`: 묻지 않고 `foreground_grant`만 적용합니다. |
| `restore_focus`     | `PI_COMPUTER_USE_RESTORE_FOCUS`                 | 허용된 포그라운드 입력이 포커스를 가져간 뒤, 사용자가 그 사이에 다른 앱으로 전환하지 않았다면 원래 앞에 있던 앱에 포커스를 돌려줍니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

파일을 수정하면 다음 도구 호출부터 적용되고, 환경 변수는 Pi가 시작될 때 읽습니다. `/computer-use`는 적용 중인 설정과 이 세션의 허용 내역을 보여 줍니다. `/computer-use grant ask|always|off`는 현재 세션의 `foreground_prompt`를 바꾸고 사용자 파일에 저장합니다.

### helper 제거

1. Pi를 종료합니다. helper가 계속 실행 중이면 `pkill -f pi-computer-use.app/Contents/MacOS/bridge`로 중지합니다.
2. `~/Applications/pi-computer-use.app`(또는 `/Applications/pi-computer-use.app`)을 삭제합니다.
3. 시스템 설정의 손쉬운 사용과 화면 기록 목록에서 `pi-computer-use`를 제거합니다.
4. 필요하면 키체인 접근에서 로그인 키체인의 `pi-computer-use Local Signing` 인증서를 삭제합니다.

## 기능

### 운용 규칙과 작업 절차

- [`.pi/SYSTEM.md`](.pi/SYSTEM.md)는 범위, 권한, 증거, 완료 기준에 대한 공통 규칙을 정합니다. [`.pi/model-guidance.md`](.pi/model-guidance.md)는 모델별 지침을, [`.pi/writing-policy.md`](.pi/writing-policy.md)는 응답 문장 규칙을 더합니다.
- 루트와 경로별 `AGENTS.md` 파일은 에이전트가 하위 디렉터리에서 작업할 때 함께 불러옵니다.
- 작업 절차 스킬은 직접 구현(`task-inline`), 병렬 구현 단위(`task`), 동적 분해 작업(`task-dynamic`), 긴급 수정(`task-hotfix`), 적대적 리뷰(`review`), 리뷰 주장 재현(`verify`), TLA+ 모델 검사(`formal-verify`), 환경 점검(`check`), 서명된 로컬 커밋(`commit`), 문서 작성(`effective-writing`)을 다룹니다. 구현 절차는 체크아웃 변경 lease를 잡고 인수 기준으로 검증하며, 푸시하지 않습니다. 리뷰와 증거 관련 스킬은 [리뷰와 검증](#리뷰와-검증)에서 설명합니다.
- `/preferences`에서 응답 언어, 응답 스타일(`concise` 또는 `explanatory`), 에이전트 페르소나(`unset`, `critical`, 기본값인 `pessimistic`)를 설정합니다. 페르소나는 에이전트가 자신의 주장과 계획을 얼마나 엄격하게 검증할지 정합니다.
- `/preferences` → Agent → On usage limit(`agentOnUsageLimit`)은 현재 provider가 사용량 한도를 보고했을 때의 동작을 정합니다. `none`(기본값)은 오류로 종료된 상태를 그대로 둡니다. `fallback`은 [`.pi/model-fallbacks.json`](.pi/model-fallbacks.json)의 같은 등급 다른 provider 모델로 전환하거나, 열린 등급 후보가 없으면 최후 수단인 `xai/grok-4.7`, 그다음 `synthetic/hf:moonshotai/Kimi-K3.1-Pro`(Kimi K3보다 우선), 마지막으로 `synthetic/hf:moonshotai/Kimi-K3`로 전환한 뒤 작업을 이어갑니다. `auto-resume`은 한도가 초기화될 때까지 기다린 뒤 이어갑니다. 하위 에이전트는 한도에 걸리면 초기화 예정 시각과 범위 안의 추천 모델을 부모 에이전트에 보고하며, `auto-resume`일 때만 대기했다가 초기화 후 자동으로 재개됩니다. `/goal`이 active 또는 paused 상태이면 복구 주도권은 goal 런타임이 가집니다.

### 에이전트와 오케스트레이션

- [`.pi/agents`](.pi/agents)의 전문 역할(`advisor`, `explore`, `general`, `handoff`, `implementer`, `planner`, `reviewer`, `verifier`)은 백그라운드 서브 에이전트로 실행됩니다. 예약 실행, 격리된 Git worktree 실행, `workflow_run`으로 의존 관계 순서를 따르는 workflow 실행도 지원합니다. `/agents`로 관리합니다.
- `max_turns` 제한은 재개한 실행에도 적용되며, 토큰 예산이 있는 에이전트는 예산에 걸려 중단되기 전에 마무리하라는 지시를 받습니다.
- fleet 패널은 실행 중인 서브 에이전트와 관리되는 백그라운드 셸을 함께 보여 줍니다. 행을 클릭하면 화살표 키와 같이 그 행이 선택되고, 더블 클릭하면 셸의 출력이 열립니다. 서브 에이전트를 선택하면 그 대화 기록에 포커스가 가며, 텍스트, 도구 진행 상황, 사용자 정의 메시지가 실시간으로 표시됩니다. 이 화면에서 thinking 표시를 전환해도 포커스된 화면에만 적용됩니다. 셸은 소유자별로 격리되며 `shell_start`와 `/shells`로 관리합니다. 소유 세션이 비활성일 때 끝난 셸의 완료 알림은 그 세션이 다시 활성화되면 전달됩니다.
- `/btw`는 병렬로 진행되는 읽기 전용 곁대화를 엽니다.
- 루트 에이전트와 하위 에이전트는 응답을 기다리는 `advisor` 도구로, 설정된 고성능 모델에게서 새 읽기 전용 문맥의 두 번째 의견을 받습니다. 이 문맥에는 현재 세션의 제한된 발췌만 들어갑니다. 기본값은 비활성이며, advisor 모델이 세션 모델과 같으면 호출을 건너뜁니다. `/preferences`의 Agent → Advisor Agent나 [`advisor.json`](#advisor-설정)에서 설정하세요.

### 리뷰와 검증

- `/review [target]`은 에이전트가 직접 수행하는 적대적 리뷰입니다. `review` 스킬이 대상(기본값은 `HEAD` 대비 staged·unstaged 변경)을 변경할 수 없는 번들로 고정해 새 읽기 전용 `reviewer` 하나에게 넘깁니다. [`.pi/review-policy.md`](.pi/review-policy.md)에 따라 모든 리뷰는 세 관점을 다룹니다. 호출자·테스트·문서가 여전히 기대는 동작이 바뀌거나 사라졌는지, 바뀐 계약의 모든 호출자, 그리고 앞선 검토가 놓친 것만 찾는 마지막 점검입니다. 리뷰어는 finding과 별도로 candidate를 보고합니다. candidate는 위반에 이르는 추적 경로 중 한 고리가 빠졌거나 가정에 기댄 우려입니다. 위반까지 경로를 빠짐없이 추적했다면 아무것도 실행하지 않았어도 finding입니다. 둘 다 에이전트나 verifier가 확인하기 전까지는 참고 의견입니다.
- 리뷰어와 verifier는 응답 끝에 구조화된 블록(`choco-pi-review` 또는 `choco-pi-verdict`)을 붙입니다. work task로 실행된 경우 subagents 패키지가 이 블록을 기록하고 결과에 `Verdict record:` 줄을 덧붙입니다. 블록이 없거나 잘못된 리뷰는 기록되지 않은 것으로 보며, 깨끗하다고 보고하지 않습니다. 리뷰와 검증 라운드는 work task마다 상한이 있습니다. `/review-continue <work_task>`와 `/verify-continue <work_task>`로 라운드를 더 허용합니다.
- 터미널에서는 파싱되는 블록을 결과 카드, 완료 알림, 대화 기록의 Markdown에 짧은 요약(판정, 개수, finding이나 claim마다 한 줄)으로 보여 줍니다. 원본 블록은 카드를 펼치면 보입니다. 파싱되지 않는 블록은 파서가 밝힌 이유 한 줄 뒤에 그대로 보여 줍니다. 바뀌는 것은 표시뿐이며, 저장된 메시지, 모델이 받는 내용, 기록된 판정은 그대로입니다.
- `verifier` 역할은 `verify` 스킬을 따라, 정확히 지정된 체크아웃 스냅숏에서 리뷰어의 주장을 재현해 봅니다. scratch에만 기록하고 코드를 고치지 않으며, `UNPROVEN`을 있는 그대로 보고합니다. 재현에 실패했다고 해서 주장이 반박된 것은 아닙니다. 작은 작업에는 verifier를 쓰지 않습니다.
- `formal-verify` 스킬은 에이전트가 작업하는 프로젝트에서 순서와 상태에 관한 약속을 검사합니다. 실행이 정확히 한 번 끝나야 한다거나, lease가 동시에 두 번 잡혀서는 안 된다는 약속이 그 예입니다. 에이전트가 작은 TLA+ 모델을 쓰고, 스킬의 래퍼를 거쳐 TLC로 검사하며, 의도적인 mutation을 넣어 규칙마다 실패할 수 있음을 보입니다. 통과는 정해진 범위 안의 모델에 대한 것이지 코드에 대한 것이 아닙니다. drift 검사는 모델이 다루는 코드가 바뀌었는지 알려 줍니다. 모델은 어떤 언어의 코드든 다룰 수 있지만, drift 검사가 심벌 단위로 해시하는 언어는 TypeScript와 JavaScript뿐이고 그 밖의 파일은 파일 전체를 해시합니다. TLC를 쓰려면 Java 11 이상과 `tlc-setup.ts` 1회 실행이 필요합니다. 이 스크립트는 고정 버전 `tla2tools.jar`를 `${XDG_CACHE_HOME:-~/.cache}/choco-pi/formal`에 내려받습니다. 자세한 내용은 [스킬 문서](.pi/skills/formal-verify/SKILL.md)를 보세요. [`formal/tla/subagent-run`](formal/tla/subagent-run)은 이 저장소의 서브 에이전트 실행 생명주기를 모델링한 예시입니다.
- `/diff`는 대화 기록 옆에 패널을 붙여 변경된 파일과 diff를 보여 주고, 에이전트가 작업하는 동안 내용을 새로 고칩니다. 기본으로는 세션이 시작된 뒤의 변경, 즉 세션의 첫 파일 체크포인트와 작업 트리의 비교를 보여 주며, 그사이 커밋된 변경도 포함합니다. `/diff source uncommitted`는 `HEAD`와 작업 트리를 비교하고, `/diff source turn [<n>]`은 작업 트리를 특정 턴의 체크포인트와 비교하며, `/diff source branch [<base>]`는 브랜치(기본값은 원격의 기본 브랜치, 없으면 `main`, 그다음 `master`)와의 merge base부터 비교합니다. 고른 소스는 패널을 닫을 때까지 유지되고, `/diff source session`으로 기본값에 돌아갑니다. 패널에서는 파일, hunk, 또는 고른 줄의 참조를 입력창에 넣고, `c`로 hunk에 메모를 남겼다가 `a`로 한꺼번에 묻고(메모가 한 메시지로 입력창에 들어가고 패널에서는 지워지며, 메모가 없으면 `a`는 커서가 있는 파일, hunk, 줄의 참조를 넣습니다), 리뷰어와 verifier가 기록한 finding을 차례로 살펴보고, `/review` 지시문을 입력창에 넣을 수 있습니다(`/diff review`). Enter를 누르기 전에는 아무것도 전송되지 않습니다. 민감한 파일은 이름만 보이고, 그 파일에서 `v`를 누르기 전까지 내용은 숨겨집니다. 이 선택은 저장되지 않으며 패널을 다시 열면 다시 숨겨집니다. Ctrl+Alt+P로 패널을 열고 닫고, Ctrl+Alt+F로 패널 안팎으로 포커스를 옮기며, 패널에서 `?`를 누르면 키 목록이 나옵니다. 패널 안에서 `j`/`k`는 파일 사이를, ↑/↓는 펼친 파일의 줄 사이를 움직입니다. Shift+↑/↓나 마우스 드래그로 여러 줄을 고르고, 클릭으로 줄이나 hunk에 커서를 놓으며, 파일 행을 클릭하면 그 파일을 펼치거나 접습니다. macOS에서는 Cmd+C(그 밖에서는 Ctrl+C)가 고른 줄을 코드 그대로 복사하고, 커서가 hunk 헤더에 있으면 hunk 전체를 diff로 복사합니다. Cmd+C는 터미널이 그 키를 Pi에 넘겨줄 때만 동작합니다. 패널 안과 리뷰 화면의 diff에서는 마우스가 diff 줄을 고르는 데 쓰이므로, Pi의 마우스 선택 자동 복사는 동작하지 않습니다. ←와 →는 한 턴의 변경만 보여 줍니다. ←는 가장 최근 턴부터 이전 턴으로, →는 다음 턴으로 가고, 가장 최근 턴 다음에는 세션 전체 변경으로 돌아옵니다. 한 턴의 변경은 그 턴의 파일 체크포인트부터 다음 체크포인트까지(가장 최근 턴은 작업 트리까지)이므로, 두 프롬프트 사이에 직접 고친 내용은 앞 턴에 포함되고, 파일이 바뀌지 않은 상태에서 시작한 프롬프트는 앞 턴과 함께 표시됩니다. Shift+→는 입력창에서 열려 있는 패널로 포커스를 옮기고, Tab, Esc, `q`, Shift+←, 또는 패널 옆이나 입력창을 클릭하면 입력창으로 돌아갑니다. 입력창의 글자를 클릭하면 커서도 그 자리로 옮겨집니다. 입력창의 글자를 드래그하면 그 부분이 선택되며, Backspace나 Delete로 한 번에 지우고, 입력하거나 붙여 넣으면 선택한 부분이 바뀌고, Esc로 선택을 풉니다. `/diff ` 뒤의 자동 완성은 하위 명령을 보여 줍니다. 패널을 쓰려면 전체 화면 TUI와 폭 65열 이상의 터미널이 필요하며, 조건이 맞지 않으면 `/diff`가 변경 목록을 출력합니다. Zed에서는 대신 크기가 제한된 네이티브 diff를 보내며, 각 diff 앞에 파일 이름과 상태를 붙이고, 민감한 파일은 이름만 보여 줍니다. 세션에서는 아직 바뀐 파일이 없지만 작업 트리에는 변경이 있으면 `/diff source uncommitted`로 그 변경을 볼 수 있다고 알려 줍니다([자세히](docs/zed-command-parity.md#diff-in-zed)).
- `/review-assist [target]`은 사용자가 직접 변경을 검토하는 화면이며, 모델 컨텍스트에는 아무것도 추가하지 않습니다. 대상은 현재 세션이나 그 세션의 턴 하나, 브랜치 범위, 커밋하지 않은 변경, 저장된 리뷰, GitHub 풀 리퀘스트입니다. 코멘트를 달고, 승인하거나 거절하고, 리뷰를 풀 리퀘스트에 제출할 수 있습니다. 이 화면은 `/diff` 패널의 뷰를 전체 화면으로 띄운 것이며, 두 명령이 함께 하는 일에는 패널의 키를 씁니다(hunk 이동은 `n`/`N` 또는 `[`/`]`, 접기는 Enter나 Space, `g`/`G`, `r`, `f`/`F`, `v`, `?`). 리뷰에만 있는 일에는 `j`/`k`나 ↑/↓로 움직이는 줄 커서를 씁니다. Shift+↑/↓나 마우스 드래그로 여러 줄을 고르고, 클릭으로 줄에 커서를 놓거나 파일을 펼치고 접으며, Cmd+C(macOS 밖에서는 Ctrl+C)로 고른 줄을 코드 그대로(접힌 hunk는 diff로) 복사하고, `c`로 코멘트를 달고, `m`으로 hunk를 검토 완료로 표시하고, `a`로 옆 채팅을 열고, `/`로 바뀐 줄을 검색하고(`>`/`<`로 다음 결과), `+`/`-`로 주변 맥락을 늘리거나 줄이고, `|`로 나란히 보기로 바꾸고, `e`/`E`로 편집기를 열고, `S`로 마치고, `q`나 Esc로 저장하고 나갑니다. `session`은 `/diff`와 같은 파일을 세션의 첫 체크포인트부터 보여 주고, `session turn <n>`은 체크포인트가 있는 턴을 1부터 셉니다. 변경이 작업 트리에서 끝나는 대상이면 `r`로, 그리고 옆 채팅의 도구 호출이 끝날 때마다 변경을 다시 읽으며, `f`/`F`로 리뷰어가 기록한 finding을 차례로 봅니다. 검토 표시와 코멘트는 내용이 바뀌지 않은 hunk에 그대로 남습니다. `.env`, 개인 키, 경로에 `secret`이나 `credential`이 들어간 파일 같은 민감한 파일은 내용을 숨긴 채 보여 주며, 그 파일에서 `v`를 눌러야 이 화면에서만 내용이 나타납니다. 옆 채팅에는 어떤 파일이 숨겨져 있는지 알려 주며, 그 파일에서 `v`를 누르기 전까지는 인자가 그 파일을 가리키는 도구 호출을 모두 거부합니다. 경로로서 가리키는 경우는 Pi 파일 도구가 경로를 해석하는 방식보다 넓게 판단하며(앞뒤 공백, `@`, `~`, `file://`, `..`, 끝의 슬래시, 심볼릭 링크와 하드 링크, 유니코드 정규화 형태, 파일 시스템이 대소문자를 구분하지 않으면 대소문자 차이까지), 인자 텍스트 어디에든 그 경로나 파일 이름이 들어 있으면 POSIX 셸, fish, PowerShell, cmd에서 따옴표나 이스케이프로 쓴 경우와 퍼센트 인코딩한 경우(`cat .e"n"v`, `cat o\'key.txt`, `type .e^nv`)도 거부하므로, 숨긴 파일과 이름이 따옴표나 이스케이프 문자만 다른 다른 파일도 거부됩니다. `write`와 `edit`가 파일에 써 넣는 텍스트는 경로로만 확인합니다. 이는 샌드박스가 아니라 이중 방어입니다. 이름의 모든 문자가 텍스트에 그대로 또는 퍼센트 인코딩으로 나타나면 거부하지만, 문자를 코드로 적거나 파일 이름을 쓰지 않고 파일에 닿는 명령(`cat .e*`나 `cat *` 같은 glob, 중괄호 확장, 변수, `$'\x2e'` 같은 이스케이프, 재귀 검색, 환경 변수 덤프, 미리 써 둔 스크립트)은 막지 못하며, 채팅이 이미 읽은 내용도 막지 못합니다. 메시지, 경고, 오류는 리뷰 화면의 메시지 줄에 표시되며, 오류는 리뷰를 닫은 뒤에도 읽을 수 있도록 Pi 알림에도 남습니다. 파일 이름, diff 같은 신뢰할 수 없는 텍스트는 화면에 그리기 전에 터미널 제어 시퀀스를 걸러 내고, 큰 변경은 한도 안에서 읽되 빠진 파일 수를 알려 주며, 그 뒤로 코드가 바뀐 코멘트는 outdated로 표시합니다. 저장된 리뷰는 Pi 에이전트 디렉터리의 `choco-pi/reviews`에 있으며, 파일을 마지막으로 수정한 지 7일이 지나면 보내지 않은 코멘트가 있더라도 삭제됩니다. 터미널 UI가 아닌 환경에서는 읽기 전용 요약을 출력하며, Zed에서는 이 요약이 Markdown이고 파일마다 변경을 코드 블록 안의 unified diff로 보여 줍니다.

### 세션, 컨텍스트, goal

- 다른 세션에서 프로젝트 대화를 나열, 생성, 읽기, 조정, 대기할 수 있습니다(`/sessions`, `/session-new`, `/session-read`, `/session-send`, `/session-wait`).
- `/goal`은 여러 턴과 compaction에 걸쳐 지속되는 목표를 유지합니다.
- `/checkpoint`는 체크포인트가 있는 턴 기준으로 세션을 되감거나, 파일을 롤백하거나, 분기하고, 현재 상태 그대로 분기할 수도 있습니다. `/rewind`는 대화 되감기만, `/fork`는 이전 턴이나 현재 상태에서 분기만 합니다.
- 컨텍스트 한도는 `/preferences`에서 프리셋으로 고릅니다. soft cap은 Session → Context에, compaction 지점은 Session → Compaction에 있습니다. **Context soft cap**은 사용 가능한 컨텍스트 상한으로 strictest 250K, strict 400K, standard 600K, permissive 800K, unlimited 중 하나이고, **Auto-compaction point**는 compaction이 시작되는 지점으로 strictest 200K, strict 300K, standard 450K, permissive 600K, unlimited 중 하나입니다. soft cap 기본값은 unlimited, compaction 지점 기본값은 standard입니다. 각 프리셋은 모델의 네이티브 창에 맞춰 조정됩니다. 상한은 네이티브 창을 넘지 않고, compaction 지점은 상한보다 `min(100K, 상한의 15%)`(최소 host reserve + 8K)만큼 아래에 머뭅니다. 네이티브 창이 64K 미만인 모델은 Pi 자체 트리거에 맡기며, OpenAI 네이티브 compaction 예산이 게시되어 있으면 compaction 지점도 그 안으로 제한됩니다. 설정은 이 두 프리셋뿐이며 headroom은 고정값입니다.
- compaction 방식은 `/preferences`의 Session → Compaction에서 정합니다. **OpenAI compaction**은 Codex 전송과 설정된 Responses 공급자에서 OpenAI 원격 compaction을 쓰며, 이 프로필의 [`.pi/choco-pi-codex.json`](.pi/choco-pi-codex.json)은 server-side로 설정합니다. **Anthropic compaction**은 기본값이 server-side이며, `api.anthropic.com`에 OAuth로 접속한 Fable 5+, Mythos 5+와 Preview, Opus 4.6+, Sonnet 4.6+, Haiku 5.5+에서만 Anthropic on-demand compaction을 씁니다. **xAI compaction**은 기본값이 server-side이며, `api.x.ai`의 `grok-*` 모델에서 OAuth나 API 키로 xAI `/responses/compact`를 씁니다. 포그라운드 compaction에만 적용됩니다. 어떤 실패든 최근 메시지와 대조하는 choco-pi 로컬 요약으로 대체됩니다. 백그라운드 compaction은 기본적으로 켜져 있고, 켜져 있으면 텍스트 레인은 항상 돌며 각 네이티브 레인(OpenAI, Anthropic)은 해당 공급자 행이 server-side일 때만 돕니다.
- 새 세션에는 이름이 자동으로 붙습니다. 이름을 짓는 모델은 `sessionAutoNameModel`로 정하며 기본값은 `openai/gpt-6-luna`입니다. 끄려면 `sessionAutoName`을 `false`로 설정하세요.
- 에이전트 턴이 끝날 때마다 `openai/gpt-6-luna`(실패 시 `anthropic/claude-haiku-5-5`)로 다음 프롬프트를 예측해 빈 입력창에 흐린 글자로 보여 줍니다. Tab을 누르면 채워지며, Enter를 누르기 전에는 전송되지 않습니다. 제안은 보수적으로 나옵니다. 에이전트의 마지막 답이 사용자 입력을 필요로 할 때만 보이고, 대기 중인 메시지·실행 중인 서브에이전트나 백그라운드 셸·활성 `/goal`이 에이전트를 스스로 다시 움직일 때는 나오지 않습니다. 사용자의 프롬프트와 `agentLanguage` 어디에도 쓰이지 않은 문자 체계로 된 제안은 버립니다. 턴마다 최근 대화 내용을 담은 작은 요청이 제안 모델로 한 번 나갑니다. 끄려면 `promptSuggestion`을 `false`로 설정하세요.

### 코드 인텔리전스와 Code Mode

- choco-pi-lsp는 LSP 탐색과 진단, lint 연동, ast-grep·tree-sitter 검색과 규칙, 그리고 `symbol_search`, `module_report`, `read_symbol` 같은 시맨틱 도구를 제공합니다. 실행 중에는 `/lsp on|off|status`와 `/lens-*` 명령으로 제어합니다.
- Code Mode의 `exec` 도구는 여러 도구 호출을 한 단계로 묶는 제한된 JavaScript를 실행하며, notebook 모드는 Deno TypeScript 상태를 유지합니다. choco-pi-codex는 `apply_patch`, `exec_command` 같은 Codex 스타일 도구와 Responses compaction도 제공하며, `/codex`로 설정을 엽니다.
- 대부분의 도구는 지연 로딩되며 `tool_search`로 찾습니다. 덕분에 항상 불러오는 도구 목록이 작게 유지됩니다. Pi의 내장 `grep` 도구는 비활성화되어 있으며, 소스 탐색은 `symbol_search`, `module_report`, 필요한 심벌만 읽기, 코드 탐색, AST 검색으로 합니다.

### 조사와 연동

- 웹 조사는 대화 모델과 관계없이 지연 로딩되는 단일 `web_search` 도구를 사용합니다. 검색 인증 정보와 요금은 대화 공급자가 아니라 선택된 검색 백엔드(OpenAI, Exa, Kagi, Synthetic, Brave, xAI)에서 결정됩니다. xAI(Grok) 백엔드는 요청이나 라우팅 설정이 `xai`를 지정할 때, 그리고 xAI에 로그인되어 있을 때만 실행되며 호출마다 요금이 부과됩니다. 공급자, 라우팅, 개인정보 보호, fallback 동작은 [웹 검색 안내](docs/web-search.md)를 참고하세요.
- `fetch_content`는 페이지 내용을 추출하고, `source_check`는 인용된 구절로 주장을 검증합니다. `/search`는 저장된 검색 결과를 보여 주고, `/websearch`와 `/curator`는 검색 curator 작업 절차를 실행합니다.
- 서버 설정, 인증, 실행은 Pi에 내장된 MCP가 맡습니다. 에이전트는 `tool_search`로 MCP 도구를 찾아 `mcp__<server>__<tool>` 이름으로 호출합니다. 네이티브 Figma 도구는 별개이며 파일, 컴포넌트, 변수, 렌더링 결과를 읽습니다.
- `agent_browser`는 선택 사항인 `agent-browser` CLI로 웹 페이지를 자동화합니다.
- macOS에서는 computer-use 도구가 네이티브 helper를 통해 데스크톱 앱을 확인하고 조작합니다. helper에는 손쉬운 사용(Accessibility)과 화면 기록(Screen Recording) 권한이 필요합니다. 설치, 권한, 설정 방법은 [computer use 설정하기](#computer-use-설정하기-macos)를 참고하세요.
- Claude Code 호환 생명주기 훅은 Pi 설정에서 실행됩니다. `/hooks`로 훅을 살펴볼 수 있고, `/add-dir`는 작업 디렉터리를 추가한 뒤 `DirectoryAdded` 훅을 실행합니다.

### 모델과 사용량

- `/effort`는 추론 effort를, `/fast`는 세션의 Fast 모드 설정을 바꿉니다. OpenAI 모델에서는 priority 서비스 티어로 보내고, `xai/grok-4.7`(api.x.ai)에서는 Grok 4.7 Fast 변형인 `grok-4.7-build-fast`로 보내며 해당 턴 비용을 기본 가격의 두 배로 기록합니다. 다른 Grok 모델에서는 저장된 설정이 비활성으로 남고 `/fast status`가 이유를 알려 줍니다. 설정의 `modelThinkingLevels`는 모델별 기본 thinking 수준을 지정합니다.
- choco-pi는 `PI_CACHE_RETENTION`의 기본값을 `long`으로 설정해, 지원하는 공급자에 1시간 프롬프트 캐시 유지를 요청합니다. 명시적으로 지정한 값이 우선합니다.
- `/usage`(별칭 `/quota`)는 Claude, ChatGPT, Synthetic, Grok의 사용량과 초기화 시각을, `/synthetic:quotas`는 Synthetic 할당량을 보여 줍니다. Grok은 OAuth 로그인이면 구독 크레딧 창을, API 키면 상태만 담은 행을 보여 줍니다. 인증 정보가 없는 공급자는 생략하고 흐린 `Not signed in: …` 한 줄에 나열합니다.

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
| `/review [target]`                                | 새 문맥의 에이전트가 코드를 고치지 않고 적대적 리뷰만 수행  |
| `/review-assist [target]`                         | 세션, 브랜치, 풀 리퀘스트 변경을 직접 검토                  |
| `/diff [subcommand]`                              | 대화 기록 옆 실시간 diff 패널을 열고 닫거나 제어            |
| `/review-continue`, `/verify-continue`            | work task의 리뷰·검증 라운드 상한 확인 또는 추가 허용       |
| `/commit [guidance]`                              | 푸시하지 않고 검증된 로컬 커밋 생성                         |
| `/checkpoint`                                     | 턴에서 되감기, 롤백, 분기 또는 현재 상태 분기               |
| `/rewind`, `/fork`                                | 턴으로 되감기만, 또는 턴이나 현재 상태에서 분기만           |
| `/agents`, `/btw`                                 | 에이전트 관리 또는 읽기 전용 곁대화 열기                    |
| `/shells`                                         | 관리되는 셸 목록 보기, 출력 읽기, 중지                      |
| `/sessions`, `/session-new`                       | 프로젝트 대화 목록을 보거나 독립 대화 시작                  |
| `/session-read`, `/session-send`, `/session-wait` | 다른 대화 읽기, 조정, 대기                                  |
| `/goal [objective]`                               | 지속형 goal 생성, 확인, 관리                                |
| `/hooks`, `/add-dir`                              | 훅 살펴보기 또는 작업 디렉터리 추가                         |
| `/mcp`                                            | MCP 서버 확인, 로그인·로그아웃, 재연결, 노출 방식 변경      |
| `/search`, `/websearch`, `/curator`               | 저장된 검색 결과 보기 또는 검색 curator 실행                |
| `/lsp`                                            | LSP 사용을 켜거나 끄고 상태 표시                            |
| `/codex`, `/computer-use`                         | Codex 어댑터 설정 또는 computer-use 설정 확인               |
| `/apex-refresh`                                   | Callstack Apex 모델 목록 새로 고침                          |
| `/clear`, `/exit`, `/delete`                      | 새 세션 시작, 종료, 현재 세션 영구 삭제                     |

## 설치된 패키지

프로필은 다음 로컬 패키지 17개를 불러오며, 이 목록은 `~/.pi/agent/settings.json`의 `packages`에 절대 경로로 들어 있습니다. 이와 별도로 [`choco-pi-acp`](.pi/packages/choco-pi-acp) 0.0.33 패키지는 Pi가 불러오지 않으며, 에디터와 연결하는 독립 ACP 프로세스로 실행됩니다([Zed에서 choco-pi 사용하기](#zed에서-choco-pi-사용하기) 참고).

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
| [`choco-pi-mcp`](.pi/packages/choco-pi-mcp)                               |          0.1.0 | 네이티브 Figma 도구(MCP 자체는 Pi 내장)          |
| [`choco-pi-lsp`](.pi/packages/choco-pi-lsp)                               |          0.1.0 | LSP, lint, 구조 분석, 시맨틱 도구                |
| [`choco-pi-compaction`](.pi/packages/choco-pi-compaction)                 |          0.1.0 | 유지된 최근 메시지와 대조한 로컬 compaction 요약 |
| [`choco-pi-codex`](.pi/packages/choco-pi-codex)                           |          0.1.0 | Codex 도구, Code Mode, Responses compaction      |
| [`choco-pi-agents-md`](.pi/packages/choco-pi-agents-md)                   |          0.1.0 | 하위 `AGENTS.md` 지침 로딩                       |
| [`choco-pi-agent-browser`](.pi/packages/choco-pi-agent-browser)           |  0.5.0-choco.0 | 네이티브 브라우저 자동화 도구                    |
| [`choco-pi-computer-use`](.pi/packages/choco-pi-computer-use)             |  0.5.0-choco.0 | macOS 데스크톱 확인 및 조작                      |

## 설정과 사용자화

| 파일 또는 디렉터리                                                                                                                            | 용도                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 전역 `~/.pi/agent/settings.json`(체크아웃에는 `.pi/settings.json` 없음)                                                                       | 불러올 패키지, 테마, TUI 모드, 모델별 thinking 수준, compaction |
| [`.pi/SYSTEM.md`](.pi/SYSTEM.md)                                                                                                              | 프로필 전체에 적용되는 에이전트 동작과 권한 규칙                |
| [`.pi/model-guidance.md`](.pi/model-guidance.md)                                                                                              | 모델 라우팅과 모델별 정책                                       |
| [`.pi/writing-policy.md`](.pi/writing-policy.md)와 [`.pi/review-policy.md`](.pi/review-policy.md)                                             | 응답 문장 규칙과 리뷰 정책                                      |
| [`AGENTS.md`](AGENTS.md)와 [패키지 예시](.pi/packages/choco-pi-subagents/AGENTS.md)                                                           | 루트 및 경로별 저장소 규칙                                      |
| [`.pi/agents`](.pi/agents), [`.pi/skills`](.pi/skills), [`.pi/prompts`](.pi/prompts)                                                          | 에이전트 역할, 작업 절차 스킬, 슬래시 명령 프롬프트             |
| [`.pi/subagents.json`](.pi/subagents.json)                                                                                                    | 서브 에이전트 동시 실행 수, 깊이, fleet 화면, worktree 격리     |
| [`.pi/choco-pi-codex.json`](.pi/choco-pi-codex.json)                                                                                          | Code Mode, Codex 도구, notebook, compaction 설정                |
| [`.pi/zentui.json`](.pi/zentui.json)                                                                                                          | TUI 색상, 구성 요소, 아이콘                                     |
| [`.pi/models.json`](.pi/models.json)과 [`.pi/keybindings.json`](.pi/keybindings.json)                                                         | 공급자 모델 재정의와 키 바인딩                                  |
| [`apex-provider.json`](.pi/extensions/apex-provider.json)                                                                                     | Callstack Apex 공급자 탐색 기본값                               |
| [`review.json`](.pi/extensions/review.json)                                                                                                   | 로컬 리뷰 인터페이스 설정                                       |
| 전역 `~/.pi/agent/advisor.json`과 프로젝트 재정의 `.pi/advisor.json`                                                                          | advisor 활성화, 모델, effort, 턴별 사용 한도                    |
| `~/.pi/agent/mcp.json`과 그 예시인 [`.pi/mcp.example.json`](.pi/mcp.example.json)                                                             | 추적하지 않는 Pi 내장 형식의 MCP 서버 설정                      |
| 패키지별 [`AGENTS.md`](.pi/packages/choco-pi-agent-browser/AGENTS.md)와 [`VENDORED.md`](.pi/packages/choco-pi-agent-browser/VENDORED.md) 파일 | 패키지 정책과 기록된 업스트림 변경 사항                         |

Pi 1.0.3부터 `Home`/`End`는 편집기 커서를 이동합니다. 대화 기록의 맨 위/아래로 이동하려면 `Ctrl+Home`/`Ctrl+End`를 사용하세요.

`npm run install:profile`은 정책 파일, `subagents.json`, `choco-pi-codex.json`, `models.json`, `keybindings.json`, 에이전트 정의, 확장 JSON 파일 3개를 `~/.pi/agent`에 연결합니다. `zentui.json`은 `choco-pi-ui.json`이라는 이름으로 연결됩니다.
기존 `~/.pi/agent/extensions/background-compaction.json`도 현재 구조로 이전합니다. 백엔드 스위치는 OpenAI·Anthropic 압축 모드에서 다시 계산하고, `enabled`와 다른 키는 유지하며, 파일이 없으면 만들지 않습니다.

### 전역 설정 예시

`npm run install:profile`은 `~/.pi/agent/settings.json`을 다시 쓰며, 관리하지 않는
키는 그대로 둡니다. 체크아웃에는 `.pi/settings.json`이 없으므로 프로필 정책은 이
전역 파일 자체에서 가져옵니다. 체크아웃의 `.pi/packages` 아래를 가리키는
`packages` 항목과 `extensions`의 내장 확장 정책이 그 정책입니다. 실행할 때마다
다음과 같이 처리합니다. 번들 패키지가 하나도 없으면 `scripts/install-profile.ts`의
프로필 기본값에서 시작합니다. 이 기본값에는 관리자의 모델 범위(`enabledModels`)와
모델별 thinking 수준(`modelThinkingLevels`)이 들어 있습니다. 이런 첫 설치는 이미
설정한 `enabledModels`를 유지하고, thinking 수준은 사용자 값이 우선하도록 합칩니다.

- `packages`, `skills`, `prompts`를 체크아웃 절대 경로로 기록하고, `extensions`에는 [내장 확장 정책](#내장-확장)도 넣습니다. 사용자가 추가한 항목은 choco-pi 항목 뒤에 유지되며, 번들 패키지가 대체하는 패키지는 제거됩니다.
- `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`, `modelThinkingLevels`는 전역 파일에 설정된 값을 그대로 둡니다. 전역 파일에서 바꾸거나 `/preferences`를 쓰세요.
- 그 밖의 키는 건드리지 않습니다. 직접 쓰거나 `/preferences`로 설정하세요.

체크아웃에 `.pi/settings.json`을 추가하면 그 파일이 우선합니다. 설치 프로그램과
`/check`는 그 파일을 읽고, 그 파일의 `theme`, `tuiMode`, `fullscreenExitOutput`,
`fuzzyFileMentions`, `compaction`을 전역 값 위에 덮어쓰며, `modelThinkingLevels`는
전역 값이 우선하도록 합칩니다.

완성된 전역 파일은 다음과 같습니다. `/path/to/choco-pi`는 실제 체크아웃 경로로
바꾸세요. `defaultModel`, `modelThinkingLevels`, `enabledModels` 값은 관리자의 현재
설정입니다. 비밀 값은 이 파일에 두지 마세요.

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
  "extensions": ["/path/to/choco-pi/.pi/extensions", "-builtin:codemode"],
  "skills": ["/path/to/choco-pi/.pi/skills"],
  "prompts": ["/path/to/choco-pi/.pi/prompts"],

  "theme": "nord-dark",
  "tuiMode": "fullscreen",
  "fullscreenExitOutput": "resume-hint",
  "fuzzyFileMentions": true,
  "modelThinkingLevels": {
    "anthropic/claude-fable-5": "high",
    "anthropic/claude-opus-5": "medium",
    "anthropic/claude-opus-4-6": "high",
    "anthropic/claude-sonnet-5": "xhigh",
    "openai/gpt-6-astra": "low",
    "openai-codex/gpt-6-astra": "low",
    "openai/gpt-5.6-sol": "low",
    "openai-codex/gpt-5.6-sol": "low",
    "openai/gpt-daybreak-blue-latest": "high",
    "openai/gpt-5.6-terra": "high",
    "openai-codex/gpt-5.6-terra": "high",
    "openai/gpt-5.6-luna": "xhigh",
    "openai-codex/gpt-5.6-luna": "xhigh",
    "synthetic/hf:moonshotai/Kimi-K3": "high",
    "anthropic/claude-fable-5-1": "low",
    "anthropic/claude-opus-5-5": "medium",
    "anthropic/claude-sonnet-5-5": "medium",
    "anthropic/claude-haiku-5-5": "medium",
    "openai/gpt-6-sol": "low",
    "openai-codex/gpt-6-sol": "low",
    "openai/gpt-6.1-sol": "low",
    "openai-codex/gpt-6.1-sol": "low",
    "openai/gpt-6.1-terra": "high",
    "openai-codex/gpt-6.1-terra": "high",
    "openai/gpt-6-luna": "high",
    "openai-codex/gpt-6-luna": "high",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash": "low",
    "synthetic/hf:zai-org/GLM-5.3": "high",
    "synthetic/hf:zai-org/GLM-5.3-Flash": "high",
    "anthropic/claude-mythos-5-1": "low",
    "anthropic/claude-fable-5-2": "high",
    "anthropic/claude-mythos-5-2": "high",
    "synthetic/hf:moonshotai/Kimi-K3.1-Pro": "high",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017": "high"
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
    "anthropic/claude-mythos-5-2",
    "anthropic/claude-fable-5-2",
    "anthropic/claude-mythos-5-1",
    "anthropic/claude-fable-5-1",
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-5-5",
    "openai-codex/gpt-6-astra",
    "openai-codex/gpt-6.1-sol",
    "openai-codex/gpt-6.1-terra",
    "openai-codex/gpt-6-sol",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-6-luna",
    "synthetic/hf:moonshotai/Kimi-K3.1-Pro",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "synthetic/hf:zai-org/GLM-5.3",
    "synthetic/hf:zai-org/GLM-5.3-Flash",
    "xai/grok-4.6",
    "xai/grok-4.7"
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
  "agentPersona": "pessimistic",
  "agentOnUsageLimit": "none",
  "sessionAutoName": true,
  "sessionAutoNameModel": "openai/gpt-6-luna",

  "hooks": {
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "$HOME/bin/notify-done.sh", "timeout": 5 }]
      }
    ]
  }
}
```

| 키                                                                                                                                | 설정 주체                  | 설명                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`, `extensions`, `skills`, `prompts`                                                                                     | 설치 프로그램              | 체크아웃 절대 경로입니다. 체크아웃을 옮기면 설치 프로그램을 다시 실행하세요.                                                                                                                                                                                                                                                                                                |
| `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`                                                     | 사용자                     | `compaction.reserveTokens`는 컨텍스트 창보다 얼마나 앞에서 압축을 시작할지 정하는 토큰 수(요약은 모델의 출력 한도 사용), `compaction.keepRecentTokens`는 요약하지 않고 남기는 최근 토큰 수입니다. 컨텍스트 한도는 `/preferences` 프리셋으로 정합니다.                                                                                                                       |
| `modelThinkingLevels`                                                                                                             | 사용자                     | 정확한 `provider/modelId`를 키로 씁니다. 체크아웃에 `.pi/settings.json`이 있으면 사용자가 설정하지 않은 모델의 값만 추가합니다.                                                                                                                                                                                                                                             |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`                                                        | 사용자                     | 시작 모델과 thinking 수준입니다. `enabledModels`는 모델 전환 대상을 제한합니다.                                                                                                                                                                                                                                                                                             |
| `cacheWarming`, `transport`, `httpIdleTimeoutMs`, `quietStartup`, `enableInstallTelemetry`, `markdown`, `terminal`                | 사용자                     | Pi 런타임 설정입니다. `cacheWarming`은 전역 파일에서만 읽으며 `off`, `streaming`, `idle`(기본값) 중 하나입니다.                                                                                                                                                                                                                                                             |
| `agentLanguage`, `agentStyle`, `agentPersona`, `agentOnUsageLimit`, `sessionAutoName`, `sessionAutoNameModel`, `promptSuggestion` | 사용자 또는 `/preferences` | choco-pi는 이 키를 전역 파일에서만 읽습니다. `agentStyle`은 `concise`, `explanatory`, 또는 `~/.pi/agent/agent-styles/`에 둔 스타일 파일 이름입니다. `agentPersona`의 기본값은 `pessimistic`, `agentOnUsageLimit`의 기본값은 `none`(`fallback`, `auto-resume` 선택 가능), `sessionAutoNameModel`의 기본값은 `openai/gpt-6-luna`, `promptSuggestion`의 기본값은 `true`입니다. |
| `hooks`                                                                                                                           | 사용자                     | Claude Code 훅 형식입니다. choco-pi-hooks는 `.claude`, `.agents` 설정 파일의 훅도 읽습니다. 자세한 내용은 [README](.pi/packages/choco-pi-hooks/README.md)를 참고하세요.                                                                                                                                                                                                     |

### advisor 설정

advisor 설정은 별도 파일인 `~/.pi/agent/advisor.json`에 두며, 프로젝트의
`.pi/advisor.json`이 키 단위로 덮어씁니다.

```json
{
  "enabled": true,
  "model": "anthropic/claude-fable-5-2",
  "effort": "low",
  "maxUses": 3
}
```

`effort`에는 `off`부터 `max`까지 쓸 수 있고, `maxUses`는 1 이상이어야 합니다. 파일이
없으면 advisor는 비활성 상태입니다. 기본값과 제한은
[advisor README](.pi/packages/choco-pi-advisor/README.md)를 참고하세요.

## Zed에서 choco-pi 사용하기

`.pi/packages/choco-pi-acp`는 Agent Client Protocol로 Zed와 choco-pi를 연결하고,
`.pi/packages/choco-pi-editor-context`는 Zed Task를 통해 현재 파일, 커서, 선택 영역을
대상 Pi 세션에 동기화합니다. [Zed 설정 안내](docs/zed-setup.md)부터 시작하세요.
[호환성 기준](docs/zed-acp-compatibility.md), [명령 호환 목록](docs/zed-command-parity.md),
[런타임 E2E 증거](docs/zed-e2e-evidence.md)에 검증된 내용이 기록되어 있습니다.

## 개발 검증

루트 검증 절차를 실행하세요. 에이전트의 도구 호출을 포함해 Pi가 시작한 셸에서는 `pnpm test` 전에 Pi가 내보내는 세션 변수를 해제해야 합니다. 그러지 않으면 서브 에이전트 scratch 디렉터리 테스트가 실패합니다.

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
env -u PI_ROOT_SESSION_ID -u PI_SCRATCH_DIR -u PI_SESSION_ID -u PI_CODING_AGENT -u PI_MANAGED_INSTALL_ROOT pnpm test
```

`pnpm test`는 Java와 TLC를 띄우는 `tests/formal/`의 formal 검증 테스트를 실행하지 않습니다. `pnpm test --formal`이 이 테스트를 함께 실행하며, `formal/`, `formal-verify` 스킬, 또는 그 테스트를 고칠 때만 필요합니다.

런타임과 TUI 변경은 새 Pi 프로세스에서도 검증해야 합니다. [검증 안내](docs/verification-map.md)에 영역별로 실행할 검사, 인증 정보 없이 테스트용 Pi를 실행하는 방법, ACP real-Pi 테스트, formal 모델·drift 검사를 정리해 두었습니다. 패키지 정책에 따라 추가 검사가 필요할 수 있습니다.

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
