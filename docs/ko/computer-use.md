# computer use 설정하기 (macOS)

[English](../en/computer-use.md)

이 페이지는 computer-use 도구에 필요한 네이티브 helper를 설치하고, macOS 권한을 주고, 설정하고, 제거하는 방법을 설명합니다.

computer-use 도구(`observe_ui`, `act_ui` 등)는 네이티브 helper 앱인 `pi-computer-use.app`을 거쳐 동작합니다. helper는 접근성 트리를 읽고, 창을 캡처하고, 입력을 전달합니다. 저장소에는 helper 바이너리가 들어 있지 않습니다. 설치 스크립트가 설치할 때마다 `packages/choco-pi-computer-use/native/macos`의 Swift 소스를 이 Mac의 아키텍처에 맞게 컴파일하며, 따로 내려받는 파일은 없습니다. macOS 외의 운영체제에는 helper를 설치할 수 없습니다.

## 요구 사항

- macOS 14 이상
- 처음 권한을 줄 때 쓸 대화형 Pi 세션
- `xcrun swiftc`를 제공하는 Xcode 또는 Command Line Tools(`xcode-select --install`)

## 1. helper 설치

대화형 Pi 세션이 시작될 때 `pi-computer-use.app`이 없으면 Pi가 helper를 빌드해 설치합니다. 수십 초 정도 걸립니다. 미리 설치하거나 다시 설치하려면 체크아웃에서 다음 명령을 실행하세요.

```sh
node packages/choco-pi-computer-use/scripts/setup-helper.ts
```

스크립트는 설치한 경로를 출력하며, 다음 작업을 합니다.

- `~/Applications/pi-computer-use.app`에 설치합니다. 단, `/Applications/pi-computer-use.app`이 이미 있고 `/Applications`에 쓸 수 있으면 그 앱을 그 자리에서 갱신합니다. 다른 위치에 설치하려면 `PI_COMPUTER_USE_HELPER_APP_PATH`를 설정하고, Pi를 실행할 때도 같은 값을 설정하세요.
- 바이너리를 번들 식별자가 `com.injaneity.pi-computer-use`인 앱 번들로 감싸고, 코드 서명한 뒤 LaunchServices에 등록합니다.
- 서명에는 다음 가운데 먼저 찾은 인증서를 씁니다.
  1. `PI_COMPUTER_USE_CODESIGN_IDENTITY`에 지정한 인증서
  2. 키체인에 있는 "Developer ID Application" 인증서
  3. 자체 서명 인증서 `pi-computer-use Local Signing (com.injaneity.pi-computer-use)`. 스크립트가 `openssl`로 만들어 로그인 키체인에 가져옵니다.
  4. ad-hoc 서명. 이 방식으로 서명해 갱신하면 macOS가 기존 권한을 취소할 수 있습니다.

  `PI_COMPUTER_USE_NO_SIGN=1`을 설정하면 서명을 건너뜁니다.

- 이미 최신 helper가 설치되어 있으면 앱은 그대로 두고 다시 등록만 합니다.

## 2. 권한 부여

helper에는 macOS 권한 두 가지가 필요합니다. 에이전트는 화면 기록(Screen Recording) 권한으로 창을 보고, 손쉬운 사용(Accessibility) 권한으로 창을 조작합니다. 둘 중 하나라도 없으면 Pi가 현재 권한 상태와 함께 다음 메뉴를 보여 줍니다.

- **Open Accessibility Settings (missing)**
- **Open Screen Recording Settings (missing)**
- **Recheck (restarts helper)**
- **Cancel**

각 설정 화면을 열어 시스템 설정 → 개인정보 보호 및 보안의 손쉬운 사용과 화면 기록 양쪽에서 `pi-computer-use.app`을 켠 다음 **Recheck**를 고르세요. 실행 중인 프로세스는 예전 권한 상태를 기억하고 있을 수 있으므로 Pi가 helper를 다시 시작하며, 두 권한이 모두 있으면 `pi-computer-use is ready.`를 표시합니다.

권한은 터미널이 아니라 `pi-computer-use.app`에 주어야 합니다. helper가 설치된 `pi-computer-use.app`으로 실행되고 있지 않다는 경고가 나오면, 권한을 주기 전에 Pi를 다시 시작하세요. 경고가 나온 상태에서 준 권한은 helper를 실행한 앱에 부여되기 때문입니다. print 모드처럼 대화형이 아닌 실행에서는 메뉴 대신 안내 메시지를 보여 주고 설정을 멈추므로, 대화형 세션에서 한 번 권한을 주세요.

## 3. 확인

`/computer-use`를 실행하면 현재 적용 중인 설정과 불러온 설정 파일을 볼 수 있습니다. Pi는 세션이 시작될 때, 그리고 computer-use 도구를 호출할 때마다 먼저 권한을 다시 확인합니다. 그래서 빠진 권한이 있으면 2단계의 메뉴가 다시 나타납니다.

## helper 업데이트

- Pi는 앱이 없을 때만 helper를 설치하며, 이미 있는 helper를 교체하지는 않습니다. `native/macos` 아래를 바꾼 변경을 pull했다면 설치 스크립트를 다시 실행하세요. 설치된 helper가 같은 소스로 빌드된 것이면 스크립트는 빌드를 건너뜁니다.
- helper 데몬은 Pi가 종료된 뒤에도 계속 실행됩니다. Pi는 데몬에 연결할 때 데몬의 프로토콜 버전(현재 7), 실행 파일 경로, 시작 시각을 설치된 앱과 비교하고, 데몬이 설치된 바이너리보다 오래되었으면 한 번 다시 실행합니다. 그래서 helper를 다시 설치하면 Pi를 재시작하지 않아도 다음 도구 호출부터 새 helper가 쓰입니다. 다시 실행한 데몬도 맞지 않으면 Pi는 원인을 담은 "helper mismatch after relaunch" 오류를 내고 멈춥니다. 이때는 설치 스크립트를 다시 실행하세요.
- helper를 교체하면 앱이 다시 서명되므로, macOS가 기존 권한을 무효로 만들 수 있습니다. 시스템 설정에서 토글이 켜져 있는데도 Pi가 권한이 없다고 하면 토글을 껐다가 다시 켜세요.
- ad-hoc 서명만 할 수 있는 환경에서는 macOS가 권한을 초기화할 수 있으므로, 스크립트가 설치된 helper를 교체하지 않습니다. Developer ID 인증서를 설치하거나, `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`을 설정한 뒤 권한을 다시 주세요.

## 소스에서 빌드

스크립트는 항상 `xcrun swiftc`로 현재 아키텍처용 helper를 컴파일합니다. 컴파일러 경고는 출력되지만 빌드를 멈추지는 않습니다. `--arch arm64`나 `--arch x64`로 크로스 컴파일할 수 있지만 검증하지 않았습니다. `--build-only --out <dir>`을 쓰면 설치나 서명 없이 `<dir>/bridge`만 만듭니다.

## computer use 설정

설정은 `~/.pi/agent/extensions/pi-computer-use.json`, 프로젝트의 `.pi/computer-use.json`, 환경 변수 순으로 읽으며, 나중에 읽은 값이 앞의 값을 덮어씁니다. 다만 `blocked_apps`와 `unblocked_apps`는 예외이며, 아래 **차단된 앱** 설명을 참고하세요. 두 파일은 직접 만들기 전에는 없습니다. 아래 예시의 값이 기본값입니다.

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "foreground_grant": [],
  "foreground_prompt": "ask",
  "restore_focus": true,
  "background_delivery": "standard",
  "blocked_apps": [],
  "unblocked_apps": []
}
```

| 키                    | 환경 변수                                       | 효과                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_use`         | `PI_COMPUTER_USE_BROWSER_USE`                   | 에이전트가 브라우저 창을 조작할 수 있게 합니다.                                                                                                                                             |
| `managed_browser`     | `PI_COMPUTER_USE_MANAGED_BROWSER`               | 관리형 브라우저가 필요할 때 Pi가 실행할 브라우저입니다. `chrome`이나 `helium`을 쓸 수 있습니다.                                                                                             |
| `headless`            | `PI_COMPUTER_USE_HEADLESS`                      | 포인터나 키보드 이벤트를 쓰지 않고 손쉬운 사용 기능으로만 동작을 전달합니다.                                                                                                                |
| `cursor_overlay`      | `PI_COMPUTER_USE_CURSOR_OVERLAY`                | 에이전트가 조작하는 동안 화면에 에이전트 커서를 표시합니다.                                                                                                                                 |
| `foreground_grant`    | `PI_COMPUTER_USE_FOREGROUND_GRANT`(쉼표로 구분) | 에이전트가 앞으로 가져오고, 창을 올리고, 키보드·마우스 이벤트를 보낼 수 있는 앱의 번들 ID 목록이며, `"*"`도 쓸 수 있습니다. 이 목록은 도구 호출로 바꿀 수 없습니다. 아래 설명을 참고하세요. |
| `foreground_prompt`   | `PI_COMPUTER_USE_FOREGROUND_PROMPT`             | 앱에 포커스가 필요한데 허용 목록에 없을 때 어떻게 할지 정합니다. `ask`(기본값), `always`, `off` 중 하나이며, 아래 설명을 참고하세요.                                                        |
| `restore_focus`       | `PI_COMPUTER_USE_RESTORE_FOCUS`                 | 허용된 포그라운드 입력이 포커스를 가져간 뒤, 그사이 사용자가 다른 앱으로 전환하지 않았다면 원래 앞에 있던 앱에 포커스를 돌려줍니다.                                                         |
| `background_delivery` | `PI_COMPUTER_USE_BACKGROUND_DELIVERY`           | `standard`(기본값)나 `extended`입니다. `extended`는 앱에 활성화되었다고 알려 더 많은 입력을 백그라운드로 전달하는 선택 기능입니다. 아래 설명을 참고하세요.                                  |
| `blocked_apps`        | `PI_COMPUTER_USE_BLOCKED_APPS`(쉼표로 구분)     | 에이전트가 살펴보거나 조작할 수 없게 추가로 막을 앱의 번들 ID 목록입니다. 모든 설정 소스의 항목이 합쳐집니다. 아래 설명을 참고하세요.                                                       |
| `unblocked_apps`      | 없음(사용자 파일에서만)                         | 기본 차단 목록에서 뺄 앱의 번들 ID 목록입니다. 프로젝트 파일과 `PI_COMPUTER_USE_UNBLOCKED_APPS`에 적은 값은 무시합니다. 아래 설명을 참고하세요.                                             |

**포그라운드 허용 목록.** 허용 목록에 없는 앱에는 입력을 백그라운드로 보냅니다. 접근성 경로가 없는 포인터 입력도 먼저 백그라운드로 시도합니다. 포커스를 가져오지 않고 앱 프로세스에 입력을 보낸 뒤, helper가 잠깐 기다리며 대상에 변화가 있는지 지켜봅니다. 대상 자체(값, 창, 대상 주변 픽셀)가 바뀌면 성공으로 봅니다. 창의 다른 곳만 바뀌었으면 효과를 확인하지 못한 것으로 보고하고, 에이전트에게 반환된 상태에서 직접 확인하라고 알립니다. 아무 변화도 없으면 `foreground_required`로 거부하고, 같은 호출 안에서는 다시 보내지 않습니다. 허용 목록에 있는 앱에는 이런 포인터 입력을 처음부터 포그라운드로 보냅니다. 포그라운드 입력은 helper가 그 앱과 창이 실제로 앞으로 나왔는지 확인한 뒤에만 보냅니다. 확인되지 않으면 아무것도 보내지 않고 그 사실을 알립니다. 마우스 버튼이나 키를 놓는 순간 그 앱이 더 이상 앞에 있지 않으면, 호출을 멈추고 입력이 다른 앱에 갔을 수 있다고 알립니다.

**포그라운드 허용 확인.** `foreground_prompt`는 앱에 포커스가 필요한데 허용 목록에 없을 때 적용됩니다. helper가 입력이 전혀 전달되지 않았음을 확인했다면, 허용한 뒤 같은 동작을 포그라운드에서 한 번 다시 시도합니다. 이미 백그라운드로 시도했는데 눈에 띄는 변화가 없었다면, 허용은 다음 호출부터 적용되고 에이전트는 다시 시도하기 전에 앱을 먼저 살펴보라는 안내를 받습니다. 값은 다음 중 하나입니다.

- `ask`(기본값): 대화형 TUI 세션에서 앱마다 세션당 한 번 묻습니다. **Allow for this session**, **Always allow**(사용자 파일의 `foreground_grant`에 번들 ID 추가), **Not now** 중에서 고르면 됩니다.
- `always`: 묻지 않고 어떤 앱이든 앞으로 가져와 입력을 보내도록 명시적으로 허용합니다. 이렇게 허용된 앱은 호스트 모드와 관계없이 세션이 끝날 때까지 허용 상태로 남습니다.
- `off`: 묻지 않으며, `foreground_grant`만 적용합니다.

**확장 백그라운드 전달.** `background_delivery`의 기본값은 `standard`이며, 위에서 설명한 대로 동작합니다. `extended`를 직접 켜면 포커스를 가져오지 않고도 훨씬 많은 입력이 동작합니다. 손쉬운 사용 동작이 없는 뷰를 클릭하거나, WebKit과 Chromium의 웹 페이지에 입력하는 경우가 여기에 해당합니다. 이런 동작마다 helper는 대상 앱에 앱이 활성화되었다고 알리고, 살펴본 창을 키 윈도로 만들고, 모든 포인터 이벤트를 그 창으로 보냅니다. 동작이 끝나면, 실패하거나 취소된 경우에도, 앱에 다시 비활성화되었다고 알립니다. 사용자가 앞에 둔 앱은 바뀌지 않습니다. 웹 버튼과 링크는 손쉬운 사용 기능으로 누르고, 웹 텍스트 필드는 손쉬운 사용 기능으로 포커스를 준 뒤 한 글자씩 키 입력을 보냅니다. 팝업 버튼과 메뉴, 보안 텍스트 필드, helper가 앱 자체의 손쉬운 사용 정보에서 알아볼 수 없는 컨트롤, 이미 앞에 있는 앱, 백그라운드에서 이미 동작하는 손쉬운 사용 동작, 허용된 포그라운드 입력에는 기존 동작을 그대로 씁니다. 다른 앱의 창이 컨트롤을 가려도 helper가 알아보는 컨트롤은 달라지지 않습니다. helper가 효과를 확인하지 못한 동작은 확인되지 않은 것으로 보고하며, 포그라운드로 다시 보내지 않습니다. 앱에 활성화되었다고 알린 뒤 동작이 도중에 끝난 경우(예: 포커스를 받지 않는 웹 텍스트 필드)도 마찬가지이며, 이때 그 호출의 나머지 동작은 보내지 않습니다.

확장 전달은 문서화되지 않은 macOS 인터페이스에 의존하며, macOS 27에서만 측정했습니다. 다른 버전이거나 이 인터페이스를 찾지 못하면 helper는 기존 방식으로 전달하고 결과에 그 사실을 적습니다. helper가 이 방식을 쓸 수 있는지는 `/computer-use`에서 확인할 수 있습니다. 다음 위험이 있습니다.

- 대상 앱은 동작마다 0.5초쯤 자기가 활성화되었다고 여깁니다. 활성화에 반응하는 앱은 패널을 열거나 스스로 앞으로 나올 수 있습니다.
- helper가 보내는 키 윈도 기록 때문에 앱은 마우스 누름을 한 번 더 받습니다.
- 동작 도중 helper가 충돌하거나 SIGKILL로 종료되면, 앱은 다음에 활성화되거나 비활성화될 때까지 자기가 활성화되었다고 여깁니다. 정상 종료(helper의 `shutdown` 명령, SIGTERM, SIGINT, SIGHUP)에서는 종료 전에 앱에 먼저 알립니다.

**다른 Space에 있는 창.** computer use는 어느 디스플레이에도 보이지 않는 Space에 있는 창도 다룰 수 있습니다. 예를 들어 전체 화면으로 작업하는 동안 다른 데스크톱에 둔 앱의 창이 여기에 해당합니다. 이때 사용자의 Space를 바꾸거나, 앞에 둔 앱을 바꾸거나, 창을 앞으로 올리지 않습니다. `find_roots`는 이런 창을 `off_space`(화면에 없음)로 표시합니다. 앱이 그 창을 한 번이라도 보여 준 적이 있으면 두 모드 모두에서 창을 살펴보고 손쉬운 사용 동작(버튼 누르기, 텍스트 필드 값 설정)을 할 수 있습니다. 앱이 보이는 Space에 한 번도 보여 준 적이 없는 창은 `needs_discovery`로 표시됩니다. `standard`에서는 이런 창을 살펴보는 요청이 `off_space_window_unresolved`로 거부됩니다. 창을 한 번 보여 주거나(그 Space로 갔다가 돌아오기) `background_delivery`를 `extended`로 바꾸세요. `extended`에서는 helper가 확장 동작과 같은 방식으로 앱에 잠시 활성화되었다고 알린 뒤 다시 비활성화되었다고 알리는 발견 활성화를 한 번 써서 창을 드러냅니다. 손쉬운 사용 동작이 없는 뷰의 클릭과 키 입력에는 다른 백그라운드 창과 마찬가지로 `extended`가 필요합니다. 이런 창에 보내는 포그라운드 입력은 창을 앞으로 가져오면 사용자의 Space가 바뀌므로 항상 `off_space_foreground`로 거부되며, 포그라운드 허용도 쓰지 않습니다. 차단된 앱은 어느 Space에 있든 차단됩니다. 숨긴 앱의 창, 최소화한 창, 전체 화면 Space의 창은 목록에 나오지 않습니다. 이 기능은 문서화되지 않은 macOS 인터페이스에 더 의존하며, macOS 27에서 테스트 앱으로만 측정했습니다. 발견 활성화 동안 앱은 최대 0.75초쯤 자기가 활성화되었다고 여기고 그에 반응할 수 있습니다. 이 인터페이스를 찾지 못하면 이런 창은 예전처럼 목록에 나오지 않습니다.

**긴 대기.** 에이전트가 `observe_ui`와 `act_ui` 사이에 오래 생각하거나 사용자가 대화 상자에 답하느라 시간이 걸려도, 창과 요소가 관찰한 상태와 같으면 그 관찰은 그대로 쓸 수 있습니다. 여러 Pi 프로세스가 helper 하나를 함께 씁니다. 30초 동안 아무 요청도 보내지 않은 Pi 프로세스는 붙잡고 있던 전경 입력 구간을 내놓으므로, 비정상 종료한 Pi가 다른 Pi를 막지 않습니다. 하지만 관찰 기록은 유지됩니다. helper는 Pi 프로세스마다 최근 관찰 8개를, 최대 64개 프로세스까지 보관하고, 그 Pi가 세션을 끝내거나 다시 시작하거나 종료하면 버립니다. 관찰이 사라졌거나 그사이 창이 바뀌었으면 `act_ui`는 아무것도 보내지 않고, 다시 시도하기 전에 호출할 `observe_ui`를 담아 `observation_refresh_required`를 돌려줍니다.

**차단된 앱.** computer use는 일부 앱을 절대 살펴보거나 조작하지 않습니다. 그래서 에이전트는 Pi의 셸 승인을 거치지 않고 Pi가 실행 중인 터미널에 입력하거나 비밀번호를 읽을 수 없습니다. 차단된 앱은 모든 도구(`observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `read_text`, `wait_for`, `act_ui`)와 손쉬운 사용 기능만 쓰는 입력을 포함한 모든 전달 경로에서, 화면을 캡처하거나 입력을 보내기 전에 거부되며, 도구는 `app_blocked`로 실패합니다. `find_roots`는 이런 앱의 창도 보여 주지만 `BLOCKED`로 표시합니다(세부 정보에는 `blocked: true`와 `block_reason`). Pi가 관리형 브라우저로 제어하는 브라우저 페이지에는 영향이 없고, 브라우저 앱 자체의 창은 다른 앱과 같은 규칙을 따릅니다. 기본으로 차단하는 앱은 다음과 같습니다.

- Pi를 실행하고 있는 앱: Pi 프로세스나 그 상위 프로세스에 해당하는 앱, 그리고 macOS가 `__CFBundleIdentifier`로 Pi에 넘겨준 번들 ID의 앱입니다. Pi는 상위 프로세스를 `ps`로 조회합니다. 조회에 실패하면 자기 프로세스와 바로 위 부모 프로세스를 차단하고, `/computer-use`에 실패 사실을 표시한 뒤, 다음 도구 호출 때 다시 조회합니다. helper도 Pi의 상위 프로세스를 직접 조회해 모두 거부하므로, Pi의 조회가 실패하는 동안에도 Pi를 실행하고 있는 앱은 차단된 상태로 남습니다. helper가 이 조회를 끝까지 마치지 못하면 요청을 거부합니다.
- 터미널: Terminal(`com.apple.Terminal`), iTerm2(`com.googlecode.iterm2`), Warp(`dev.warp.Warp-Stable`), kitty(`net.kovidgoyal.kitty`, `net.kovidgoyal.kitty-quick-access`), Ghostty(`com.mitchellh.ghostty`), Alacritty(`org.alacritty`), WezTerm(`com.github.wez.wezterm`), Hyper(`co.zeit.hyper`), Tabby(`org.tabby`).
- 비밀번호 관리자: 1Password 7(`com.agilebits.onepassword7`), 1Password 8(`com.1password.1password`), Bitwarden(`com.bitwarden.desktop`), 암호(`com.apple.Passwords`), 키체인 접근(`com.apple.keychainaccess`).
- macOS 인증 대화상자(`com.apple.SecurityAgent`)와 helper 자신(`com.injaneity.pi-computer-use`).

어느 설정 소스에서든 `blocked_apps`로 앱을 추가할 수 있으며, 이렇게 추가한 차단은 항상 적용됩니다. 기본 차단은 사용자 파일의 `unblocked_apps`로만 풀 수 있습니다. 프로젝트 파일과 환경 변수로는 어떤 앱도 차단을 풀 수 없으며, 그런 항목은 무시되고 `/computer-use`에 무시된 항목으로 표시됩니다. Pi를 실행하고 있는 앱과 helper는 차단을 풀 수 없습니다. 번들 ID는 대소문자만 무시하고 정확히 일치해야 하며, 와일드카드는 쓸 수 없습니다. 분리된 `tmux`나 `screen` 서버, 또는 SSH를 거쳐 Pi에 연결된 터미널은 Pi의 상위 프로세스가 아니므로 번들 ID로만 보호됩니다. 목록에 없는 터미널은 `blocked_apps`에 추가하세요.

파일을 고치면 다음 도구 호출부터 적용되고, 환경 변수는 Pi가 시작될 때 읽습니다. `/computer-use`는 현재 적용 중인 설정과 이 세션에서 허용한 앱을 보여 줍니다. `/computer-use grant ask|always|off`는 현재 세션의 `foreground_prompt`를 바꾸고 그 값을 사용자 파일에 저장합니다.

## helper 제거

1. Pi를 종료합니다. helper가 아직 실행 중이면 `pkill -f pi-computer-use.app/Contents/MacOS/bridge`로 멈춥니다.
2. `~/Applications/pi-computer-use.app`(또는 `/Applications/pi-computer-use.app`)을 삭제합니다.
3. 시스템 설정의 손쉬운 사용 목록과 화면 기록 목록에서 `pi-computer-use`를 제거합니다.
4. 필요하면 키체인 접근에서 로그인 키체인에 있는 `pi-computer-use Local Signing` 인증서를 삭제합니다.
