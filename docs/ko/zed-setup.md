# Zed에서 choco-pi 사용하기

[English](../en/zed-setup.md)

이 안내서는 choco-pi를 Zed의 사용자 정의 ACP 에이전트로 설정하는 방법을 설명하며, 두 설치 방법을 모두 다룹니다. 하나는 저장소 체크아웃을 Pi에 프로필로 설치하는 방식으로, 아래에서는 레거시 설치라고 부릅니다. 이 방식은 `~/.pi`를 `pi`와 함께 씁니다. 다른 하나는 상태를 `$CHOCO_PI_HOME`(기본값 `~/.choco-pi`)에 두는 독립 실행형 `choco-pi` 설치입니다. 게시된 패키지를 설치하거나 내려받지는 않습니다. 독립 실행형 설치에서 달라지는 점은 [독립 실행형 설치](#독립-실행형-설치-choco-pi-실행기)에 모아 두었고, 나머지는 두 방식에 똑같이 적용됩니다.

## 요구 사항

- Node.js 24 LTS 이상. Bun은 지원하지 않습니다. 현재 체크아웃은 TypeScript 소스를 그대로 실행하므로 빌드 결과물이 없습니다.
- Zed. 현재 설치해 검증한 버전은 Zed 1.18.0입니다. 이 버전은 기준일 뿐 반드시 맞춰야 하는 최소 버전은 아니며, 이전 릴리스는 가능한 범위에서 지원합니다.
- 앞으로 경로를 옮기지 않을 이 저장소의 로컬 clone
- 레거시 설치: `pi`를 설치해 `PATH`에서 실행할 수 있어야 하고, 모델 공급자도 설정되어 있어야 합니다. `pi`가 다른 위치에 있으면 `PI_ACP_PI_COMMAND`에 실행 파일 경로를 지정하세요. 독립 실행형 설치는 자체적으로 고정한 Pi를 실행하므로 둘 다 필요하지 않습니다.

레거시 설치에서는 저장소 루트에서 [Pi에 프로필 설치](installation.md#pi에-프로필-설치)에 나온 대로 의존성과 choco-pi 프로필을 설치합니다.

```sh
pnpm install --frozen-lockfile
npm run install:profile
```

레거시 설치에서는 `install:profile` 단계를 꼭 실행해야 합니다. 이 단계에서 이 체크아웃의 `choco-pi-editor-context` 패키지가 Pi 전역 프로필에 추가됩니다. 건너뛰면 Task가 컨텍스트를 게시해도 이 체크아웃 밖의 Pi 세션은 그 컨텍스트를 받아 쓰지 않습니다. 설치 프로그램은 연결하거나 갱신한 경로를 모두 출력합니다. 충돌하는 프로필 파일이 있으면 내용을 검토하고, 기존 파일을 백업하고 교체하려는 경우에만 `npm run install:profile -- --backup`으로 다시 실행하세요.

독립 실행형 설치에서는 두 명령을 모두 건너뜁니다. `install.sh`와 `choco-pi self setup`이 `choco-pi-editor-context`를 포함한 프로필을 이미 `$CHOCO_PI_HOME/agent`에 설치했기 때문입니다.

## 독립 실행형 설치 (`choco-pi` 실행기)

독립 실행형 설치에서는 모든 진입점이 `choco-pi` 실행기를 거쳐 실행됩니다. 실행기는 Node가 시작되기 전에 다음 환경 변수를 설정합니다. `CHOCO_PI_STANDALONE=1`, `CHOCO_PI_HOME`, `CHOCO_PI_LAUNCHER`, `PI_CODING_AGENT_DIR=$CHOCO_PI_HOME/agent`, 그리고 실행기 경로를 담은 `PI_ACP_PI_COMMAND`입니다. 이 안내서의 Zed 명령은 `node packages/choco-pi-acp/bin/choco-pi-acp.ts ...` 대신 `choco-pi self acp ...` 형식으로 실행하세요.

```sh
choco-pi self acp zed setup --dry-run
choco-pi self acp zed setup --apply
choco-pi self acp zed doctor
choco-pi self acp zed remove --apply
```

실행기가 이 환경 변수를 설정한 상태에서 설정 명령을 실행하면, 실행기를 거쳐 실행되는 정의가 기록됩니다. 저장소에서 관리하는 같은 내용의 예시 파일은 `editors/zed/settings.standalone.example.json`과 `editors/zed/tasks.standalone.example.json`입니다. 기록되는 정의는 다음과 같습니다.

- `agent_servers.choco-pi`는 실행기의 절대 경로를 `["self", "acp"]` 인자와 함께 실행합니다. 그래서 어댑터, 어댑터가 띄우는 모든 Pi 자식 프로세스, `/changelog`, 버전 헤더, 터미널 로그인(`self acp --terminal-login`)이 모두 고정된 Pi와 `$CHOCO_PI_HOME`을 씁니다.
- 컨텍스트 Task 다섯 개는 `<launcher> self exec <node> <app>/packages/choco-pi-editor-context/src/cli.ts ...`를 실행합니다. 따라서 editor-context CLI도 세션과 같은 에이전트 디렉터리를 읽습니다.
- **Open Terminal Thread**는 `pi` 대신 실행기를 실행합니다.

독립 실행형 모드에서 어댑터는 세션 매핑을 `~/.pi/pi-acp/`가 아니라 `$CHOCO_PI_HOME/pi-acp/`에 저장하고, 프롬프트와 확장 목록은 `$CHOCO_PI_HOME/agent/`에서 읽으며, `~/.pi`는 전혀 읽지 않습니다. Pi 버전이 lockfile로 고정되어 있어 `npm i -g`로 갱신할 수 없으므로 "New version available" 알림도 띄우지 않습니다. `CHOCO_PI_STANDALONE=1`은 설정되어 있는데 `CHOCO_PI_LAUNCHER`에 절대 경로가 없으면, 설정 명령은 실행을 거부합니다. 그대로 진행하면 실행기가 설정하는 환경 밖에서 시작될 정의가 기록되기 때문입니다. 레거시 설정과 독립 실행형 설정은 둘 다 `choco-pi` 에이전트 키와 Task 레이블 여섯 개를 쓰므로, 한쪽에서 다른 쪽으로 바꾸려면 `--replace`가 필요합니다. 설정에는 실행기의 절대 경로가 기록되므로, 설치 위치를 옮겼다면 설정 명령을 다시 실행하세요.

## Zed 설정 미리 보기와 적용

변경을 적용하기 전에 Zed 설정을 백업하세요. 그런 다음 적용될 결과를 미리 정확히 확인합니다.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --dry-run
```

미리 보기는 기존 settings 파일과 Tasks 파일(주석이 들어간 JSON)을 읽어, 설정 명령이 쓸 문서 전체를 출력할 뿐 아무것도 쓰지 않습니다. 출력에 나온 Node와 체크아웃의 절대 경로를 확인하고, 미리 보기 결과가 맞을 때만 적용하세요.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --apply
```

대화형 확인 단계는 따로 없습니다. `--apply`를 넘기면 파일 쓰기를 명시적으로 승인한 것으로 봅니다. 내용이 바뀌는 기존 파일은 교체하기 전에 `.bak` 파일 하나로 복사해 두지만, 직접 만든 백업도 따로 보관하세요.

macOS에서 설정 명령이 읽고 쓰는 파일은 다음과 같습니다.

- `~/.config/zed/settings.json`
- `~/.config/zed/tasks.json`

Linux에서는 `XDG_CONFIG_HOME`이 절대 경로이면 `$XDG_CONFIG_HOME/zed/`를, 아니면 `~/.config/zed/`를 씁니다. Windows에서는 기본 경로를 찾는 기능이 구현되어 있지 않으므로 `--zed-config-dir`로 디렉터리를 직접 지정하세요.

다른 Zed 설정 디렉터리에 적용하려면 `--zed-config-dir <dir>`을 붙이세요. 상대 경로는 설정 명령을 실행한 작업 디렉터리를 기준으로 해석합니다. 명령은 해석한 설정 디렉터리와 `settings.json`, `tasks.json`의 정확한 경로를 출력합니다. dry run과 `doctor`는 디렉터리를 만들지 않고, `setup --apply`는 필요하면 디렉터리를 만듭니다. 경로가 잘못되었으면 플랫폼 기본 경로로 대신하지 않고 실패합니다.

설정 명령이 바꾸는 것은 다음 두 가지뿐입니다.

1. `settings.json`에 `agent_servers.choco-pi`를 추가합니다. 이 사용자 정의 서버는 현재 Node 실행 파일로 체크아웃의 `packages/choco-pi-acp/bin/choco-pi-acp.ts`를 실행하며, 두 경로는 모두 절대 경로로 기록됩니다. `PI_ACP_ENABLE_EMBEDDED_CONTEXT`도 `"true"`로 설정합니다.
2. `tasks.json`에 **Sync Focused Context**, **Sync Focused Context (No Selection)**, **Sync Saved File Context**, **List Live Sessions**, **Select Context Target**, **Open Terminal Thread** 정의 여섯 개를 추가합니다.

관련 없는 설정과 Task는 그대로 남습니다. 다만 `tasks.json`을 다시 쓸 때 일반 JSON으로 정규화하므로 Task 파일의 주석과 서식은 사라집니다. 내용이 다른 `choco-pi` 에이전트가 이미 있거나, 여섯 Task 레이블 가운데 하나가 다른 내용으로 정의되어 있으면 충돌로 봅니다. 이때 설정 명령은 `--replace`를 직접 붙이지 않는 한 파일을 쓰지 않습니다.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --apply --replace
```

`--replace`는 `choco-pi` 에이전트와 그 여섯 레이블에만 적용됩니다.

연동을 일회용 Zed 프로필에서 시험해 보려면 Zed의 `--user-data-dir <DIR>` 옵션을 쓰세요. 이 옵션은 그 프로필의 설정을 `<DIR>/config`에 따로 둡니다. 그 프로필로 Zed를 시작하기 전에, 설정 명령이 그 설정 디렉터리를 대상으로 하도록 지정하세요.

```sh
PROFILE_DIR="$(mktemp -d)"
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --dry-run --zed-config-dir "$PROFILE_DIR/config"
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --apply --zed-config-dir "$PROFILE_DIR/config"
open -n -a /Applications/Zed.app --args --user-data-dir "$PROFILE_DIR" <project>
```

격리된 프로필은 위 예시처럼 LaunchServices로 시작해야 합니다. macOS의 `zed` CLI 래퍼는 `--user-data-dir`을 적용하지 않습니다. `zed --user-data-dir <DIR>`은 요청을 이미 실행 중인 에디터에 넘기므로, 결국 실제 사용자 프로필을 쓰는 인스턴스가 열립니다. 기록해 둔 런타임 E2E 실행에서 이 동작을 확인했습니다. 해당 프로세스를 `lsof`로 살펴보니 `~/Library/Application Support/Zed/db/0-stable/db.sqlite`가 열려 있었고 사용자가 설치한 확장도 실행 중이었지만, 일회용 디렉터리에는 설정 명령이 쓴 `config/` 디렉터리 말고는 아무것도 없었습니다. 반면 `open -n -a` 형식은 `<DIR>/db/0-stable/db.sqlite`를 연다는 것을 확인했습니다. 전체 기록은 [런타임 E2E 기록](../zed-e2e-evidence.md)에 있습니다.

같은 격리 설정을 점검하거나 제거할 때도 디렉터리를 명시합니다.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed doctor \
  --zed-config-dir "$PROFILE_DIR/config"
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove \
  --apply --zed-config-dir "$PROFILE_DIR/config"
```

## 에이전트 시작하기

Zed를 다시 시작하거나 설정을 다시 불러온 뒤, Agent Panel을 열고 `choco-pi` 사용자 정의 에이전트를 고르세요. Zed는 다음 명령을 실행합니다.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts
```

위 예시는 상대 경로를 썼지만, 설정 명령이 만드는 설정에는 절대 경로가 들어갑니다. 어댑터는 표준 입출력으로 ACP 메시지를 주고받고, 선택한 프로젝트 디렉터리에서 `pi --mode rpc`로 Pi를 시작합니다. 공급자 인증, 명령, 도구, 확장, 저장된 세션 기록은 여전히 Pi가 관리합니다.

### 시작 정보

새 스레드를 열면 보통 Pi 버전, 컨텍스트, 스킬, 프롬프트, 확장을 알려 주는 시작 블록이 먼저 나옵니다. 터미널에서 `pi`를 실행할 때 출력되는 내용과 같습니다. Pi의 `quietStartup` 설정이 `true`나 `"header"`이면 이 블록은 나오지 않습니다. 이 설정은 Pi 에이전트 디렉터리(`~/.pi/agent`, 독립 실행형 설치에서는 `$CHOCO_PI_HOME/agent`)의 `settings.json`이나 `<project>/.pi/settings.json`에 있습니다. Pi의 기본값은 `quietStartup: false`이므로 직접 끄지 않았다면 블록이 나타납니다. 다만 독립 실행형 설치는 [첫 실행 설정](installation.md#첫-실행-설정)에서 이 값을 `"header"`로 정합니다. 블록이 숨겨져 있어도, 설치된 Pi가 최신 버전이 아니면 어댑터는 "New version available" 알림을 띄웁니다. 독립 실행형 설치에서는 이 알림이 나오지 않습니다([독립 실행형 설치](#독립-실행형-설치-choco-pi-실행기) 참고). 새 스레드에 시작 블록이 보이지 않으면 결함이라고 판단하기 전에 이 설정부터 확인하세요.

### 실행 중인 스레드

열려 있는 ACP 스레드는 각자 실행 중인 Pi 자식 프로세스를 하나씩 가집니다. 그래서 한 Zed 창에 스레드가 여러 개 있어도 각각 따로 쓸 수 있고, editor-context 동기화 대상으로도 각각 지정할 수 있습니다. 어댑터는 기본적으로 최근에 쓴 스레드 8개를 유지하고, 이 수를 넘으면 가장 오랫동안 쓰지 않은 스레드부터 닫습니다. 한도를 바꾸려면 에이전트 환경에서 `PI_ACP_MAX_LIVE_SESSIONS`를 1부터 32 사이의 정수로 설정하세요. 스레드의 Pi 자식 프로세스가 닫혀도 Pi 세션은 지워지지 않으며, 스레드를 다시 열면 Pi 세션 기록에서 복원됩니다.

ACP v1에는 Zed 스레드 창이 닫혔다고 어댑터에 알리는 기능이 없습니다. 그래서 할 일이 없는 Pi 자식 프로세스는 세션별 타이머로 정리합니다. 기본값은 10분이고 `PI_ACP_SESSION_IDLE_MS`로 바꿀 수 있으며, 값은 60,000밀리초 이상 7,200,000밀리초 이하(1분에서 120분)로 제한됩니다. 실행 중이거나 대기 중인 턴이 있으면 정리하지 않습니다. 응답을 기다리는 대화 상자가 있을 때 타이머가 만료되면, 결과를 정확히 한 번만 확정하는 일반 경로로 그 대화 상자를 취소한 뒤 종료합니다. 나중에 그 스레드에 프롬프트를 보내면 저장된 Pi 세션이 새 자식 프로세스에서 자동으로 복원됩니다. ACP 전송 연결이 끊기면 지금까지처럼 모든 자식 프로세스를 즉시 종료합니다.

### Zed 스레드 기록의 기존 Pi 세션

`session/list`는 현재 프로젝트에 기록된 메인 Pi 세션을 모두 최신순으로 돌려주며, 세션마다 Pi가 저장한 제목, 세션의 절대 작업 디렉터리, 마지막 활동 시각을 함께 알려 줍니다. 프로젝트 범위는 실제 파일 시스템 경로로 비교하므로, 심볼릭 링크로 연 worktree도 같은 프로젝트로 인식합니다(예: macOS의 `/tmp/project`와 실제 경로 `/private/tmp/project`). 서브 에이전트의 사이드체인 대화 기록은 빼고, 메인 세션을 이어 가거나 분기한 일반 세션은 포함합니다.

Zed는 외부 에이전트 스레드를 Thread History에 자동으로 추가하지 않습니다. Zed의 [External Agents 문서](https://zed.dev/docs/ai/external-agents)에 따르면 Threads Sidebar에서 Thread History를 열고 **Import Threads**를 써야 합니다. 그러면 Zed가 ACP로 에이전트에 연결해 아직 가져오지 않은 세션을 보관된 항목으로 추가하며, 항목을 열면 세션이 복원됩니다. 어댑터는 세션마다 절대 작업 디렉터리를 함께 보고하므로, Zed의 "sessions without an associated working directory" 규칙 때문에 건너뛰는 세션은 없습니다.

## Zed Task와 단축키 하나로 컨텍스트 동기화

설정 명령은 Choco Pi Task 여섯 개를 설치합니다. Task는 Zed의 Task 선택기에서 실행합니다.

- **Choco Pi: Sync Focused Context**는 현재 파일, 행과 열(1부터 세며 Zed 값을 그대로 넘김), 언어, 심벌, worktree를 게시하고, 선택한 텍스트가 있으면 그것도 함께 게시합니다. 버퍼는 저장하지 않습니다.
- **Choco Pi: Sync Focused Context (No Selection)**은 같은 경로, 커서, 언어, 심벌, worktree 메타데이터를 게시하지만, 선택한 텍스트는 읽지도 게시하지도 않습니다.
- **Choco Pi: Sync Saved File Context**는 현재 버퍼를 저장한 뒤, 커서와 선택 텍스트 없이 파일, 언어, 심벌, worktree를 게시합니다.
- **Choco Pi: List Live Sessions**는 현재 정규화된 worktree에서 실행 중인 Pi 세션을 나열하고, 바로 실행할 수 있는 대상 지정 명령을 출력합니다.
- **Choco Pi: Select Context Target**은 같은 목록을 보여 주고, 고른 명령을 Zed 터미널에서 실행하라고 안내합니다.
- **Choco Pi: Open Terminal Thread**는 터미널 UI가 필요한 작업을 위한 대안으로, worktree에서 `pi`(독립 실행형 설치에서는 `choco-pi` 실행기)를 실행합니다.

컨텍스트 동기화 Task 세 개를 쓰려면 선택기를 열기 전에 텍스트 편집기에 포커스를 두세요. Zed는 `$ZED_FILE`, `$ZED_ROW`, `$ZED_COLUMN`, `$ZED_SELECTED_TEXT` 변수를 쓸 수 없는 Task를 숨기므로, Agent Panel에서 선택기를 열면 focused-context Task가 목록에 나오지 않습니다. **Sync Focused Context**를 쓰려면 선택기를 열기 전에 텍스트를 먼저 선택해 두세요. 선택 영역이 없는 변형은 편집기 포커스만 있으면 됩니다. Zed의 `$ZED_ROW`와 `$ZED_COLUMN` 값은 1부터 시작하므로, 설치된 Task는 이 값을 그대로 editor-context의 줄과 열로 넘깁니다.

설정 명령은 키맵을 바꾸지 않습니다. focused sync를 단축키 하나로 실행하려면 `editors/zed/keymap.example.json`의 바인딩을 `~/.config/zed/keymap.json`에 합치세요.

```json
{
  "context": "Workspace && !Terminal",
  "bindings": {
    "ctrl-alt-c": ["task::Spawn", { "task_name": "Choco Pi: Sync Focused Context" }]
  }
}
```

이 동기화는 상태를 자동으로 따라가지 않고, 실행할 때마다 스냅숏을 하나 만듭니다. 포커스, 커서, 심벌, 선택 영역이 바뀌면 단축키를 다시 누르세요. 확장은 다음 에이전트 턴 직전에 가장 최근에 받아들인 스냅숏을 쓰며, 스냅숏은 30초가 지나면 만료됩니다.

## 임베디드 ACP 컨텍스트와 선택 영역 개인정보 보호

생성된 에이전트 정의에는 다음 값이 들어갑니다.

```json
"PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true"
```

이 기능은 값이 정확히 문자열 `true`일 때만 켜집니다. 켜져 있으면 첨부된 ACP resource 블록과 resource-link 블록에서 중복을 없앤 뒤, 경계를 분명히 표시한 **untrusted editor context** 섹션에 담아 Pi 프롬프트 뒤에 붙입니다. resource의 메타데이터와 텍스트는 그대로 두고, 바이너리 데이터는 빼는 대신 디코딩한 크기만 표시합니다. 임베디드 섹션 전체는 UTF-8 기준 64 KiB로 제한되며, 넘치면 잘렸다는 표시가 들어갑니다. 이 변수가 없거나 다른 값이면 어댑터는 임베디드 컨텍스트를 지원한다고 알리지 않으며, 그런데도 보내온 resource 블록은 버립니다.

focused-context Task는 선택한 텍스트를 명령 인자가 아니라 항상 `CHOCO_PI_ZED_SELECTION` 환경 변수로 넘깁니다. 16 KiB를 넘는 선택 텍스트는 거부하며, editor-context 문서 전체에도 64 KiB 제한이 있습니다.

선택 텍스트는 빼고 경로, 커서, 언어, 심벌, worktree 메타데이터만 스냅숏에 담으려면 **Choco Pi: Sync Focused Context (No Selection)**을 쓰세요. 이 Task는 `--no-selection-text`를 넘기며, 선택 영역을 Task 환경에 넣지 않습니다. 저장소에서 관리하는 같은 정의가 `editors/zed/tasks.example.json`에 있습니다.

`publish` 명령에서도 다음 두 방법 중 하나로 선택 텍스트를 직접 뺄 수 있습니다.

```sh
node packages/choco-pi-editor-context/src/cli.ts publish \
  --cwd "$PWD" --no-selection-text

CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION=1 \
  node packages/choco-pi-editor-context/src/cli.ts publish --cwd "$PWD"
```

환경 변수는 값이 정확히 `1`일 때만 적용됩니다. 선택 텍스트를 빼는 설정은 `--selection-env`나 `--selection-file`보다 우선합니다. 이때 CLI는 지정된 선택 소스를 읽지 않고, 컨텍스트 문서에서 `selection`을 뺍니다. 개인정보를 지키기 위해 일부러 이렇게 우선순위를 정했습니다. Task JSON을 고치지 않고 일반 focused-context Task에도 이 설정을 적용하려면, `CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION=1`이 설정된 환경에서 Zed를 실행하세요. 다만 실행 환경과 관계없이 동기화할 때마다 고를 수 있는 방법은 선택 영역이 없는 전용 Task입니다.

첨부된 선택 영역 resource를 포함해 명시적인 ACP resource 콘텐츠를 모두 끄려면, 에이전트 환경에서 `PI_ACP_ENABLE_EMBEDDED_CONTEXT`를 지우거나 `true`가 아닌 값으로 설정하세요.

## 컨텍스트 대상 선택하기

컨텍스트를 게시할 때는 정규화된 worktree가 같은 실행 중인 Pi 세션을 찾습니다. 일치하는 세션이 하나면 그 세션을 자동으로 고르고, 둘 이상이면 추측하지 않고 실패합니다. 세션을 잘못 고르면 파일이나 선택 영역 컨텍스트가 엉뚱한 대화로 갈 수 있기 때문입니다.

열린 스레드마다 Pi 자식 프로세스가 따로 실행되므로, 같은 worktree에서 스레드를 두 개만 열어도 일치하는 세션이 여러 개가 됩니다. 이때는 **Choco Pi: List Live Sessions**를 실행해 대상을 직접 고르세요.

정규화된 worktree를 비교할 때는 양쪽의 심볼릭 링크를 모두 따라가 해석합니다. 그래서 `/tmp/project`로 연 프로젝트는 작업 디렉터리의 실제 경로가 `/private/tmp/project`인 Pi 세션과 일치합니다. 파일 시스템에서 해석할 수 없는 worktree는 문자열로 비교하지 않고 거부합니다.

`publish`는 무엇이든 쓰기 전에, 컨텍스트를 받을 세션이 쓰는 검증 로직을 그 세션의 작업 디렉터리 기준으로 먼저 실행합니다. 그래서 세션이 거부할 컨텍스트는 이제 Task와 CLI 단계에서 실패하며, 정해진 진단 코드와 0이 아닌 종료 상태를 돌려주고 컨텍스트 파일도 쓰지 않습니다. 예전 리비전에서는 세션이 페이로드를 거부했는데도 `Editor context published.`를 출력하고 종료 코드 0을 돌려주었습니다.

**Choco Pi: List Live Sessions**를 실행한 다음, 출력된 `select` 명령 중 하나를 복사해 Zed 터미널에서 실행하세요. 체크아웃에서 실행하면 명령은 다음과 같습니다.

```sh
node packages/choco-pi-editor-context/src/cli.ts select \
  --session-id <session-id> \
  --owner-id <owner-id> \
  --cwd <absolute-worktree-path>
```

저장된 대상은 정규화된 worktree 단위로 적용되며, 게시할 때마다 다시 검증합니다. 대상을 지우려면 다음 명령을 실행합니다.

```sh
node packages/choco-pi-editor-context/src/cli.ts select \
  --clear \
  --cwd <absolute-worktree-path>
```

`publish` 명령에 `--session-id`와 `--owner-id`를 명시하면 저장된 대상보다 우선합니다. 두 식별자는 반드시 함께 지정해야 합니다.

## 로컬 프로젝트와 원격 프로젝트

로컬 Zed 프로젝트에서는 Zed가 Node, 어댑터, Pi, Task를 로컬 컴퓨터에서 실행하므로, 경로와 인증 정보도 그 컴퓨터의 것을 씁니다.

SSH로 연 원격 프로젝트에서는 UI만 로컬에 두고, 체크아웃, Task, 어댑터, Pi는 원격 호스트에서 실행하도록 설계되어 있습니다. 원격 호스트에 Node 24 이상, Pi, 저장소 의존성, choco-pi 프로필을 설치하고, 생성되는 절대 경로가 원격 호스트 기준이 되도록 설정 명령도 원격 호스트에서 실행하세요. Pi 인증 정보는 Pi를 실행하는 호스트에 있으며 Zed에서 복사해 오지 않습니다. 도구 위치 정보는 로컬 `zed` 명령이 아니라 ACP로 전달됩니다.

원격 사용 방법은 문서로 정리했지만, 쓸 수 있는 SSH 대상이 없어 처음부터 끝까지 검증하지는 못했습니다. 수동 설정으로 여기고, 선택한 텍스트를 보내기 전에 `zed doctor`, 컨텍스트 진단, 민감하지 않은 테스트 파일로 먼저 확인하세요.

## 다른 Pi ACP 항목에서 옮겨 오기

설정 명령이 관리하는 키는 `choco-pi` 하나뿐입니다. 기존 `pi`, `pi-acp`, 레지스트리 에이전트 항목은 그대로 두므로 새 항목과 나란히 보일 수 있습니다. 먼저 새 `choco-pi` 스레드가 잘 동작하는지 확인하고, 예전 항목이 더 이상 필요 없으면 직접 지우세요. `--replace`는 이름이 다른 항목을 옮기거나 지우지 않습니다.

어댑터는 대화의 기준 원본으로 계속 Pi 세션 파일을 씁니다. Zed 에이전트 정의를 지워도 Pi 세션은 삭제되지 않습니다. 체크아웃은 설정 명령이 기록한 경로에 그대로 두고, 옮겼다면 설정 명령을 다시 실행하세요.

## Zed 연동 제거하기

파일을 바꾸기 전에 제거 결과를 미리 확인하세요.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove --dry-run
```

그런 다음 명시적으로 적용합니다.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove --apply
```

제거 명령은 `agent_servers.choco-pi`와, 두 focused-context 변형을 포함한 Choco Pi Task 레이블 여섯 개만 지웁니다. 다른 에이전트, 설정, Task는 그대로 두며, 내용이 바뀌는 기존 파일은 각각 `.bak`으로 백업합니다. 직접 추가한 키맵 바인딩은 지우지 않으므로 `keymap.json`에서 해당 항목을 직접 지우세요. choco-pi 프로필, 의존성, 체크아웃, Pi 세션, 어댑터의 세션 매핑도 그대로 둡니다. Pi에 설치한 프로필을 제거하는 명령은 따로 없습니다. 독립 실행형 설치는 `choco-pi self uninstall`로 제거하며, `--purge`를 붙이지 않으면 로그인, 세션, 설정은 남겨 둡니다([업데이트와 제거](installation.md#업데이트와-제거) 참고).

## 보안과 개인정보 보호

- 파일과 선택 영역의 내용은 민감한 정보로 다루세요. 이 내용은 ACP 첨부나 Task 동기화를 명시적으로 실행했을 때만 전송됩니다. 이 연동은 선택한 텍스트를 로그에 남기지 않으며, 거부 진단에도 텍스트 대신 정해진 코드만 담습니다.
- editor-context 파일은 기본적으로 `~/.pi/agent/choco-pi/session-bridge/editor-context/`(독립 실행형 설치에서는 `$CHOCO_PI_HOME/agent/choco-pi/session-bridge/editor-context/`)에 저장됩니다. 디렉터리는 소유자만 접근할 수 있는 `0700` 권한으로, 원자적 쓰기에 쓰는 임시 파일은 `0600` 권한으로 만듭니다. 읽어 들인 파일은 검증을 통과했든 거부되었든 지웁니다. 정리 작업은 정해진 범위 안에서만 실행되며, 소유자를 확인한 만료 파일은 지우고 실행 중인 다른 소유자의 파일은 남겨 둡니다.
- 컨텍스트는 실행 중인 세션, 소유자, 세대(generation), 정규화된 worktree가 모두 일치하고 캡처가 만료되지 않았을 때만 받아들입니다. 플랫폼이 소유권 정보를 제공하면 심볼릭 링크와 다른 사용자가 소유한 컨텍스트 파일을 거부합니다.
- ACP는 전송과 표시를 위한 프로토콜일 뿐 샌드박스가 아닙니다. Pi와 Pi의 도구는 Node/Pi 프로세스의 권한으로 실행됩니다. 프로젝트 로컬 Pi 설정은 검토한 뒤에 신뢰하세요. 어댑터는 `--approve`를 붙이지 않습니다.

## 문제 해결

생성된 설정과 Task가 현재 체크아웃과 맞는지 확인하세요.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed doctor
```

`doctor`는 설정을 바꾸는 플래그는 받지 않지만, 다른 프로필을 점검할 때 쓰는 `--zed-config-dir <dir>`은 받습니다. 설정이 없거나 충돌하면 0이 아닌 값을 돌려줍니다. 특정 worktree의 절대 경로와 일치하는 실행 중인 세션을 확인하려면 다음을 실행하세요.

```sh
node packages/choco-pi-editor-context/src/cli.ts diagnose \
  --cwd <absolute-worktree-path>
```

`diagnose`는 현재 `list`와 똑같이 동작합니다. 일치하는 실행 중인 세션을 최대 20개까지 출력하고, 하나도 없으면 0이 아닌 값을 돌려줍니다. 동기화가 `LIVE_TARGET_AMBIGUOUS`를 보고하면 [컨텍스트 대상 선택하기](#컨텍스트-대상-선택하기)에서 설명한 대로 대상을 고르세요. `LIVE_TARGET_NOT_FOUND`를 보고하면 먼저 그 worktree에서 Pi 기반 choco-pi 스레드를 시작하세요. 더 이상 유효하지 않은 저장 대상은 일치하는 세션을 다시 찾기 전에 자동으로 지워집니다.

Pi가 프로젝트 로컬 설정을 신뢰할 수 없다며 거부하면, 프로젝트를 검토한 뒤 터미널에서 Pi의 일회성 신뢰 확인을 마치세요.

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts \
  --terminal-trust <absolute-project-path>
```

경로는 이미 있는 디렉터리의 절대 경로여야 합니다. 선택이 기록되면 Pi를 종료하세요. 공급자에 로그인하거나 API 키를 설정하려면 같은 진입점을 대신 `--terminal-login`과 함께 실행하세요. 어댑터가 Pi를 찾지 못하면 `@earendil-works/pi-coding-agent`를 설치하거나 `PI_ACP_PI_COMMAND`에 Pi 실행 파일 경로를 지정하세요.

독립 실행형 설치에서는 다음 명령을 실행기를 거쳐 실행해야 실행기의 상태 디렉터리를 씁니다.

- `choco-pi self acp zed doctor`
- `choco-pi self acp --terminal-trust <absolute-project-path>`
- `choco-pi self acp --terminal-login`
- `choco-pi self exec node <app>/packages/choco-pi-editor-context/src/cli.ts diagnose --cwd <absolute-worktree-path>`

여기서 `<app>`은 `$CHOCO_PI_HOME/app`이며, `self exec`에는 Node 24 이상이면 어떤 버전이든 쓸 수 있습니다.

## 관련 기록

- [호환성 기준](../zed-acp-compatibility.md): 연동의 기준으로 기록해 둔 Pi, ACP, Zed, Node.js 버전
- [명령 호환 목록](../zed-command-parity.md): 명령마다 터미널 UI 없이 Zed에서 끝까지 실행되는지 분류한 목록
- [런타임 E2E 기록](../zed-e2e-evidence.md): 실제 Zed에서 choco-pi를 실행하며 관찰한 내용
