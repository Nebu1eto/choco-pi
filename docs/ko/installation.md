# 설치와 업데이트

[English](../en/installation.md)

이 페이지는 choco-pi에 필요한 것과 두 가지 설치 방법, 그리고 업데이트하고 다시 불러오고 제거하는 방법을 설명합니다.

## 요구 사항

- Git
- 선택 사항: 브라우저 자동화에 쓰는 [`agent-browser`](https://github.com/vercel-labs/agent-browser). 0.34.0, 0.35.2, 0.36.0, 0.37.1, 0.38.1 버전을 검증했으며, 다른 버전에서는 경고를 표시한 뒤 그대로 실행합니다.
- 선택 사항: computer use(데스크톱 조작)에 필요한 macOS 14 이상([computer use 설정하기](computer-use.md) 참고)

[설치 방법](#설치)에 따라 추가로 필요한 것이 다릅니다.

- **독립 실행형 `choco-pi` 명령**: arm64나 x64 macOS, 또는 x64나 arm64의 glibc 기반 Linux가 필요하고, `tar`, `curl`이나 `wget`, SHA-256 도구(`shasum`, `sha256sum`, `openssl` 중 하나)가 있어야 합니다. Node.js 24 이상과 pnpm `12.21.0`이 `PATH`에 있으면 그대로 쓰고, 없으면 설치 프로그램이 고정된 버전을 내려받습니다. Windows와 Alpine 같은 musl 기반 Linux는 지원하지 않습니다. Windows에서는 glibc 배포판을 설치한 WSL2를 쓰세요.
- **Pi에 프로필 설치**: Node.js 24 이상, pnpm `12.21.0`(다른 버전은 쓸 수 없음), `1.6.0` 이상의 Pi `1.6.x`(`>=1.6.0 <1.7.0`)가 필요합니다. 이 범위는 이 체크아웃의 SDK 범위 `~1.6.0`와 같습니다. 고정된 Node.js와 pnpm을 mise로 설치하는 방법과 mise 없이 설치하는 방법은 [개발 환경](development.md#개발-환경)에 있습니다.

## 설치

choco-pi는 두 가지 방법으로 설치할 수 있습니다. 어느 쪽이든 같은 프로필을 불러오며, 프로필을 실행하는 Pi와 상태를 저장하는 위치만 다릅니다. 한 컴퓨터에 둘 다 설치해도 됩니다.

|                    | 독립 실행형 `choco-pi` 명령             | Pi에 프로필 설치                |
| ------------------ | --------------------------------------- | ------------------------------- |
| 명령               | `choco-pi`                              | `pi`                            |
| Pi                 | 이 저장소의 lockfile이 고정한 버전      | 직접 설치한 `pi`                |
| 코드               | `~/.choco-pi/app`에 따로 clone한 저장소 | 직접 clone한 체크아웃           |
| 로그인, 세션, 설정 | `~/.choco-pi/agent` (`pi`와 분리)       | `~/.pi/agent` (`pi`와 공유)     |
| 업데이트           | `choco-pi self update`                  | pull한 뒤 설치 단계를 다시 실행 |

### 독립 실행형 `choco-pi` 명령 설치

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
sh choco-pi/install.sh
choco-pi
```

설치 프로그램은 저장소를 `~/.choco-pi/app`에 따로 clone합니다. 그래서 처음 clone한 저장소는 스크립트를 실행하는 데만 쓰입니다. 설치 프로그램이 하는 일은 다음과 같습니다.

- `PATH`에 Node.js 24 이상이 있으면 그것을 씁니다. 없으면 고정된 Node.js를 `~/.choco-pi/runtime/node`에 내려받고, 압축을 풀기 전에 SHA-256을 `scripts/standalone/runtime-pins.txt`의 값과 대조합니다.
- `PATH`의 pnpm은 버전이 정확히 `12.21.0`일 때만 씁니다. 그렇지 않으면 arm64나 x64의 macOS 또는 glibc Linux에서 `@pnpm/exe.<platform>`의 pnpm 네이티브 바이너리를 내려받아 고정된 무결성 값과 대조한 뒤 `~/.choco-pi/runtime/pnpm/pnpm`으로 저장합니다. 이 pnpm은 Node.js를 거치지 않고 실행됩니다. 그 밖의 플랫폼에서는 먼저 pnpm `12.21.0`을 `PATH`에 두세요.
- pnpm 데이터는 모두 `~/.choco-pi/runtime` 아래의 `pnpm-store`, `pnpm-cache`, `pnpm-state`, `pnpm-home`에 둡니다. pnpm에 `PNPM_HOME`을 지정하므로 `~/Library/pnpm`이나 XDG 디렉터리에는 아무것도 쓰지 않습니다.
- lockfile에 따라 프로덕션 의존성을 설치하고, 프로필을 `~/.choco-pi/agent`에 설치한 뒤, 만든 항목을 `~/.choco-pi/install.json`에 기록합니다.
- `~/.local/bin/choco-pi`가 실행기를 가리키도록 링크를 만듭니다. 이 디렉터리가 `PATH`에 없으면 셸 설정에 추가할 `export PATH=...` 줄을 출력합니다.

설치 프로그램은 `sudo`나 전역 npm 설치를 쓰지 않습니다. Git이 없으면 사용 중인 시스템에 맞는 Git 설치 방법을 출력하고 멈춥니다. 여러 번 실행해도 결과는 같습니다(idempotent).

| 옵션                  | 기본값                                                         | 효과                                                 |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `--home DIR`          | `$CHOCO_PI_HOME`, 없으면 `~/.choco-pi`                         | 설치 홈(`CHOCO_PI_HOME`)                             |
| `--bin-dir DIR`       | `~/.local/bin`                                                 | `choco-pi` 링크를 둘 디렉터리                        |
| `--source URL\|PATH`  | 기록된 소스, 없으면 `https://github.com/Nebu1eto/choco-pi.git` | clone할 저장소(로컬 경로도 가능)                     |
| `--ref REF`           | 기록된 ref, 없으면 기본 브랜치                                 | 설치할 브랜치나 태그                                 |
| `--rev COMMIT`        | REF의 최신 커밋                                                | REF에서 정확히 이 커밋을 설치(`self update`가 사용)  |
| `--runtime node\|bun` | `node` 또는 이전 설치에서 기록한 런타임                        | Pi를 실행할 런타임([런타임 선택](#런타임-선택) 참고) |

`sh install.sh --help`를 실행하면 미러 변수 `CHOCO_PI_NODE_MIRROR`, `CHOCO_PI_NPM_REGISTRY`, `CHOCO_PI_BUN_MIRROR`도 볼 수 있습니다. 미러에서 내려받은 파일도 고정값과 대조합니다.

실행기는 자기 위치로 설치 홈을 찾으므로 `CHOCO_PI_HOME`을 따로 설정하지 않아도 됩니다. 설정하면 그 값이 우선합니다. `choco-pi`가 실행되면 `/login`으로 로그인하세요. 독립 실행형 명령은 `pi`의 로그인 정보를 쓰지 않습니다.

#### 첫 실행 설정

`install.sh`가 실행하는 첫 `choco-pi self setup`은 `profile/standalone/settings.seed.json`에 있는 다음 설정을 `~/.choco-pi/agent/settings.json`에 추가합니다.

| 키                       | 넣는 값                            | Pi 기본값                     |
| ------------------------ | ---------------------------------- | ----------------------------- |
| `theme`                  | `nord-dark` (`choco-pi-ui` 제공)   | 터미널에 따라 dark 또는 light |
| `fullscreenExitOutput`   | `resume-hint`                      | `transcript`                  |
| `fuzzyFileMentions`      | `true`                             | `false`                       |
| `cacheWarming`           | `streaming`                        | `idle`                        |
| `quietStartup`           | `"header"`                         | `false`                       |
| `enableInstallTelemetry` | `false`                            | `true`                        |
| `terminal`               | `{ "showTerminalProgress": true }` | `false`                       |

각 키는 한 번만 추가됩니다. 파일에 그 키가 없고, 이전 설정 단계가 아직 처리하지 않은 키일 때만 넣습니다. 이전 단계에서 처리한 키는 그때 실제로 넣지 않았더라도 다시 넣지 않습니다. `self setup`과 `self update`는 사용자가 정한 값을 덮어쓰지 않고, 사용자가 지운 키를 다시 넣지도 않습니다. 시드가 새 버전으로 바뀌면 그 버전에서 새로 생긴 키만 추가합니다. 설정 과정이 어느 시드 버전과 어떤 키까지 처리했는지는 `~/.choco-pi/agent/choco-pi/settings-seed.json`에 기록됩니다. 값을 바꾸려면 `settings.json`을 직접 고치거나 `/preferences`나 Pi의 `/settings`를 쓰세요.

직접 요청하지 않는 한 설정 과정은 `pi`나 `~/.pi`에서 아무것도 가져오지 않습니다([선택: `pi` 환경설정을 한 번 가져오기](#선택-pi-환경설정을-한-번-가져오기) 참고). 공급자에 따라 달라지는 값과 개인적인 값은 비워 둡니다. `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `agentLanguage`, `sessionAutoNameModel`, `hooks`가 여기에 해당합니다. 특히 독립 실행형 설정은 `enabledModels` 범위를 기록하지 않습니다. 아직 로그인하지 않은 공급자의 모델이 범위에 들어 있으면 Pi가 시작할 때마다 경고하기 때문입니다. 범위가 필요하면 `/login` 후 `/scoped-models`로 정하세요. 첫 설정은 마지막에 다음 순서를 안내합니다. `choco-pi` 실행, `/login`으로 로그인(인증 정보는 `~/.choco-pi/agent/auth.json`에만 저장), `/preferences` 열기.

#### 선택: `pi` 환경설정을 한 번 가져오기

```sh
choco-pi self setup --import-pi-settings [--from FILE] [--force]
```

독립 실행형 명령 가운데 `~/.pi`를 읽는 것은 이 명령 하나뿐이며, 사용자가 직접 실행할 때만 읽습니다. 읽는 파일도 `$HOME/.pi/agent/settings.json`(또는 `FILE`) 하나뿐입니다. 복사 대상은 Pi 1.6.0나 choco-pi가 읽는 환경설정 키(`theme`, `defaultModel`, `modelThinkingLevels`, `agentLanguage`, `agentStyle` 등)이며, 값마다 그 키를 읽는 코드가 받아들이는 값인지 확인한 뒤 복사합니다. 경로, 명령, 식별자, 신뢰 결정, 인증 정보(`packages`, `extensions`, `skills`, `prompts`, `hooks`, `deviceId`, 변경 기록 표시, `defaultProjectTrust`, `httpProxy` 등)는 복사하지 않습니다. `auth.json`, `sessions/`, `trust.json`, `mcp.json`, `models.json`을 비롯한 `~/.pi`의 다른 파일은 열지도 않습니다.

choco-pi에서 정한 값이 항상 우선합니다. 키는 `~/.choco-pi/agent/settings.json`에 없거나 아직 첫 실행 시드 값 그대로일 때만 복사하고, `modelThinkingLevels`는 프로필 기본값인 항목만 바꿉니다. 실행하면 복사한 키, 건너뛴 키, 그대로 둔 키의 이름을 출력하고(값은 출력하지 않음), 실행 내역을 `~/.choco-pi/agent/choco-pi/settings-import.json`에 기록합니다. 두 번째 실행은 `--force` 없이는 거부합니다. `--force`를 주더라도 이전 가져오기에서 설정한 키와 사용자가 바꾼 키는 그대로 둡니다.

#### 업데이트와 제거

```sh
choco-pi self update
choco-pi self uninstall
```

`self update`는 기록된 브랜치나 태그(`--ref REF`를 주면 그 ref)를 fetch하고, 새 리비전을 체크아웃한 뒤 그 리비전에 들어 있는 `install.sh`를 실행합니다. Node.js, pnpm, 의존성을 새 리비전의 코드가 직접 설치하므로, 툴체인이나 핀 형식이 바뀐 리비전으로도 업데이트할 수 있습니다. 업데이트를 거부하는 경우는 세 가지입니다. app 체크아웃에 로컬 변경이 있을 때, 기록된 ref에서 fast-forward로 이동할 수 없을 때, 그리고 새 리비전에 설치를 넘기는 이 방식이 도입되기 전의 리비전일 때입니다. 새 리비전의 설치가 실패하면 이전 리비전을 다시 체크아웃하고 그 리비전의 `install.sh`로 다시 설치합니다. 업데이트하기 전에 실행 중인 세션을 종료하세요.

이미 설치된 상태에서 `install.sh`를 다시 실행해도 같은 단계를 거칩니다. 먼저 체크아웃을 옮긴 뒤 그 리비전의 코드를 실행하며, `--source`나 `--ref`를 생략하면 기록된 값을 그대로 씁니다. 각 `self` 명령의 옵션은 명령 뒤에 `--help`를 붙여 확인할 수 있습니다.

`self uninstall`은 `install.json`에 기록된 항목, 즉 `choco-pi` 링크(아직 이 실행기를 가리킬 때만), `app/`, `runtime/`, `install.json`을 제거합니다. `agent/`(로그인, 세션, 설정)와 `lsp/`는 남기며, `choco-pi self uninstall --purge`를 쓰면 이 둘도 제거합니다. `~/.pi`는 건드리지 않습니다.

| 명령                                       | 용도                                                          |
| ------------------------------------------ | ------------------------------------------------------------- |
| `choco-pi self setup`                      | 프로필을 `~/.choco-pi/agent`에 다시 설치(idempotent)          |
| `choco-pi self setup --import-pi-settings` | `~/.pi/agent/settings.json`의 환경설정을 한 번 가져오기(선택) |
| `choco-pi self runtime [node\|bun]`        | Pi를 실행할 런타임 확인 또는 변경                             |
| `choco-pi self env`                        | 실행기가 설정하는 환경 변수 출력                              |
| `choco-pi self exec <cmd> [args...]`       | 그 환경 변수를 적용해 명령 실행                               |
| `choco-pi self acp [args...]`              | 에디터용 ACP 어댑터 실행([Zed](zed-setup.md))                 |
| `choco-pi self help`                       | `self` 명령 목록 출력                                         |

실행기는 처음 두 인자가 `self`와 표에 있는 동사일 때만 명령을 직접 처리합니다. 그 밖의 인자는 `choco-pi --version`, `choco-pi --mode rpc`처럼 Pi에 그대로 전달됩니다.

#### 런타임 선택

Pi는 기본적으로 Node.js에서 실행되며, Bun은 직접 선택해야 쓸 수 있습니다.

```sh
choco-pi self runtime bun
choco-pi self runtime node
choco-pi self runtime
```

`self runtime bun`은 `PATH`에 고정된 최소 버전 이상의 `bun`이 있으면 그것을 쓰고, 없으면 고정된 Bun을 `~/.choco-pi/runtime/bun`에 내려받아 SHA-256을 확인합니다. 선택한 런타임은 Pi가 그 런타임에서 실제로 시작된 뒤에야 `install.json`에 기록됩니다. `sh install.sh --runtime bun`은 설치할 때 같은 일을 합니다. `self runtime node`는 Node.js로 되돌리고, 인자 없이 `self runtime`을 실행하면 현재 런타임과 그 선택이 어디에서 왔는지 보여 줍니다. `CHOCO_PI_RUNTIME=node`나 `CHOCO_PI_RUNTIME=bun`을 지정하면 그 실행에서만 선택을 덮어씁니다. Bun을 선택했는데 Bun을 찾을 수 없으면 실행기는 Node.js로 대신 실행하지 않고, 안내를 출력한 뒤 멈춥니다.

Bun을 써도 Node.js는 여전히 필요합니다. 설치 프로그램, `self acp`를 비롯한 모든 `self` 명령, Node.js가 필요한 자식 프로세스는 Node.js에서 실행되기 때문입니다. Bun은 `--no-env-file`과 `--no-install` 옵션으로 Pi를 시작하므로, 프로젝트의 `.env`, `bunfig.toml` preload, Bun 자동 설치가 Pi에 영향을 주지 않습니다.

#### `pi`와의 분리

독립 실행형 명령은 로그인 정보(`auth.json`), 세션, 설정, 신뢰 결정, MCP 설정, 캐시를 `~/.choco-pi` 아래에 따로 두며, `~/.pi`에는 아무것도 쓰지 않습니다. `~/.pi`를 읽는 것은 선택 명령인 `self setup --import-pi-settings`를 실행할 때뿐이고, 이때도 `~/.pi/agent/settings.json`만 읽습니다. choco-pi 문서에서 `~/.pi/agent` 아래 경로가 나오면, 독립 실행형 명령에서는 `~/.choco-pi/agent`(`$CHOCO_PI_HOME/agent`) 아래의 같은 경로로 바꿔 읽으세요.

다음 항목은 의도적으로 공유합니다.

- `.pi/settings.json`, `.pi/mcp.json` 같은 프로젝트의 `.pi/` 디렉터리는 프로젝트 설정이므로 `choco-pi`도 `pi`와 똑같이 읽습니다. 홈 디렉터리에서 Pi를 시작하면 Pi는 `~/.pi`를 그 프로젝트의 설정 디렉터리로 취급합니다. 이것은 Pi 본래의 동작이며, Pi의 프로젝트 신뢰 확인을 거칩니다.
- 여러 에이전트가 함께 쓰는 위치: `~/.claude/settings.json`과 `~/.agents/settings.json`의 훅, `~/.agents/skills`의 스킬
- choco-pi는 Pi를 고치지 않고 그대로 실행하므로, 도움말과 터미널 제목에는 여전히 `pi`(π)가 표시됩니다.

Rex 터미널에서는 다음과 같이 동작합니다.

- Node.js에서는 Rex가 `choco-pi` 창을 `pi` 창과 똑같이 표시합니다. 실행기 프로세스가 Pi를 실행하는 Node.js로 바뀌므로, Rex에는 같은 foreground 프로세스, 제목(`π - …`), 프로그램 상태(`app: pi`)가 보입니다.
- Bun에서는 제목과 프로그램 상태는 같지만, foreground 프로세스는 Pi의 `cli.js`를 실행하는 `bun`입니다.
- Rex의 SessionStart 컨텍스트는 `~/.claude/settings.json`에 등록된 Rex 훅을 거쳐 choco-pi에 전달됩니다. `~/.pi/agent/settings.json`에만 등록된 Rex 훅은 독립 실행형 세션에 전달되지 않습니다.
- `~/.agents/skills`의 `rex` 스킬은 `pi`와 함께 씁니다.

### Pi에 프로필 설치

저장소는 앞으로 옮기지 않을 경로에 clone하세요. 프로필 설치 프로그램이 Pi 사용자 설정에 절대 경로를 기록하므로, 나중에 체크아웃을 옮기면 새 위치에서 설치 프로그램을 다시 실행해야 합니다. 먼저 [Homebrew를 사용하지 않고 Pi 설치](#homebrew를-사용하지-않고-pi-설치)를 보고 Pi를 설치한 다음 프로필을 설치하세요.

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
cd choco-pi

mise install
pnpm --version

pnpm install --frozen-lockfile
npm run install:profile
pi
```

`mise install`로 `mise.toml`에 고정된 Node.js와 pnpm을 설치하고 나면, `pnpm --version`은 `12.21.0`을 출력해야 합니다. mise 없이 준비하려면 [개발 환경](development.md#개발-환경)을 참고하세요.

체크아웃에는 `.pi/settings.json`이 들어 있지 않으며, 설치 프로그램은 프로필 정책을 `~/.pi/agent/settings.json`에서 읽습니다. 새 컴퓨터처럼 이 파일이 없거나 번들 패키지가 하나도 등록되어 있지 않으면, 설치 프로그램이 번들 패키지 목록과 내장 확장 정책을 직접 기록합니다. 다른 키가 필요하면 설치한 뒤 [전역 설정 예시](configuration.md#전역-설정-예시)를 참고해 추가하세요.

#### Homebrew를 사용하지 않고 Pi 설치

Homebrew의 `pi-coding-agent` formula는 고정된 릴리스보다 늦게 갱신되므로, choco-pi는 Homebrew로 설치한 Pi를 지원하지 않습니다. 공식 설치 프로그램으로 Pi를 설치하세요.

```sh
curl -fsSL https://pi.dev/install.sh | sh
```

설치 프로그램은 관리형 실행기 `~/.pi/agent/bin/pi`를 만들고, `~/.local/bin/pi`가 이 실행기를 가리키도록 링크합니다. 셸 설정에서 `~/.local/bin`을 `/opt/homebrew/bin`보다 앞에 둔 다음 버전을 확인하세요.

```sh
export PATH="$HOME/.local/bin:$PATH"
pi --version
```

출력은 `1.6.0` 이상의 `1.6.x` 릴리스여야 합니다. 이후에 나오는 1.6 패치 릴리스는 체크아웃을 고치지 않아도 그대로 쓸 수 있습니다. 다만 공식 설치 프로그램은 항상 Pi의 최신 릴리스를 설치하므로 `1.7.0`처럼 범위를 벗어난 버전이 설치될 수 있습니다. 이 경우 이 체크아웃의 지원 범위를 검토해 그 버전까지 넓히기 전에는 `/check`가 실패하고, 프로필 설치 프로그램도 그 실행기를 기록하지 않습니다.

Pi의 `cli.js` 실행기는 Node 컴파일 캐시를 켭니다. 원인을 알 수 없는 모듈 로드 오류를 조사할 때는 `NODE_DISABLE_COMPILE_CACHE=1`을 설정해 캐시를 끌 수 있습니다.

Pi가 실행되면 `/login`을 실행하고 공급자를 고르세요. 설치 스크립트는 인증을 진행하거나 로그인 화면을 열지 않으며, 인증 정보를 저장소에 복사하지도 않습니다.

저장소 전체가 하나의 pnpm workspace입니다. `pnpm install --frozen-lockfile`은 루트에 하나뿐인 `pnpm-lock.yaml`로 루트와 `packages/` 아래 패키지 18개를 모두 설치합니다. `pnpm-workspace.yaml`의 `allowBuilds`가 빌드 스크립트가 있는 의존성을 모두 `false`로 지정하므로, 의존성의 빌드 스크립트는 실행되지 않습니다.

프로필이 `.pi/`에서 `profile/`과 `packages/`로 옮겨지기 전에 설치한 체크아웃도 그 자리에서 업그레이드할 수 있습니다. pull한 뒤 `pnpm install --frozen-lockfile`과 `npm run install:profile`을 다시 실행하세요. 프로필 설치 프로그램은 설정에 남아 있는 이 체크아웃의 예전 경로를 순서를 유지한 채 새 경로로 바꾸고, 사용자가 추가한 항목은 그대로 두며, 프로필 파일을 다시 연결합니다. 직접 교체한 프로필 파일이 있다면 여전히 `--backup`이 필요합니다. Git은 `.pi/` 아래에 무시되던 예전 `node_modules` 디렉터리를 지우지 않으므로, 새 설치가 제대로 동작하면 직접 지우세요.

`npm run install:profile`은 기존 런타임·인증 상태와 사용자가 추가한 패키지를 보존하고, 체크아웃의 절대 경로를 기록한 뒤, Git이 추적하는 프로필 리소스를 `~/.pi/agent`(또는 `PI_CODING_AGENT_DIR`이나 `--agent-dir`로 지정한 디렉터리)에 연결합니다. MCP 설정은 연결하지 않습니다. 대상 위치에 관련 없는 내용이 이미 있으면 설치를 중단합니다. 충돌 내용을 확인하고, 기존 내용을 보존한 채 교체해도 된다면 `npm run install:profile -- --backup`을 실행하세요.

설치에 성공하면 그 에이전트 디렉터리에 `choco-pi/profile.json`을 원자적으로 기록합니다. 이 파일에는 체크아웃 경로, Git 리비전(알 수 없으면 null), 확인한 Pi 버전, 실행기 경로, 호스트 브리지 스키마가 담깁니다. 실행기 경로는 `--pi-launcher <path>`를 먼저 쓰고, 없으면 `CHOCO_PI_LAUNCHER`, 그것도 없으면 `PATH`에서 버전이 `>=1.6.0 <1.7.0`으로 확인되는 첫 번째 `pi`를 씁니다. 하나도 찾지 못하면 null을 기록하고 경고를 출력합니다. Waku 같은 외부 호스트는 이 마커 파일로 프로필을 식별하며, `harness_check`는 마커 파일이 없거나, 체크아웃이 맞지 않거나, 실행기가 호환되지 않으면 경고합니다.

## 업데이트와 다시 불러오기

의존성 트리를 교체하기 전에 실행 중인 Pi 세션을 종료하세요. 독립 실행형 명령은 `choco-pi self update`로 업데이트합니다([업데이트와 제거](#업데이트와-제거) 참고). Pi에 설치한 프로필은 저장소 변경을 pull한 뒤, Node.js와 pnpm 버전은 그대로 둔 채 frozen 설치와 프로필 설치를 다시 실행합니다.

```sh
pnpm install --frozen-lockfile
npm run install:profile
```

업데이트가 끝나면 Pi를 다시 시작하세요. 실행 중인 세션에서 `profile/`이나 `packages/` 아래 파일을 고쳤다면 `/reload`로 확장, 스킬, 프롬프트, 테마, 연결된 프로필 파일을 다시 불러오세요.
