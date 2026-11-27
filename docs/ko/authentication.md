# 인증

[English](../en/authentication.md)

Pi 세션에서 `/login`으로 모델 공급자에 로그인합니다.

```text
/login openai
/login anthropic
/login synthetic
/login xai
/login google
```

Pi는 인증 정보를 저장소 밖에 보관합니다. 인증 정보가 담긴 파일을 Git에 복사하지 마세요.

Pi에는 Anthropic, OpenAI, xAI 로그인이 내장되어 있습니다. choco-pi는 여기에 Synthetic 공급자와 [Google Antigravity](#google-antigravity) 공급자를 더하고, [`apex-provider.json`](../../profile/extensions/apex-provider.json) 설정에 따라 Callstack Apex 모델을 찾습니다.

`/login openai`는 Pi의 "Sign in with ChatGPT" 로그인으로, `openai` 공급자(api.openai.com)에 연결됩니다. 예전 `openai-codex` 공급자(chatgpt.com 백엔드)도 원하면 `/login openai-codex`로 로그인해 계속 쓸 수 있습니다. `openai`로 로그인하면 다음 기능이 제한됩니다.

- Fast 모드를 켜도 오류는 나지 않지만 아무 효과가 없으며, 요청에도 포함되지 않습니다.
- Daybreak은 쓸 수 없습니다.
- 서버 측 compaction은 시도하지 않고, 대신 로컬 compaction을 실행합니다.
- 네이티브 `web_run` 검색은 쓸 수 없으므로 웹 검색은 `choco-pi-web-search`를 거칩니다.
- `imagegen`과 `view_image`는 `openai` 인증 정보를 찾아 쓰지만, 둘 다 실제 서비스에서는 아직 검증하지 않았습니다.

Pi에 내장된 `xai` 공급자(Grok)는 `/login xai`로 SuperGrok 또는 X Premium 구독 계정에 로그인하거나, `XAI_API_KEY` 환경 변수에서 키를 읽습니다. Fast 모드는 api.x.ai의 `xai/grok-4.7`에만 적용됩니다.

## Google Antigravity

[`@choco-pi/provider-google-antigravity`](../../packages/choco-pi-provider-google-antigravity)의 `google` 공급자는 일반 소비자용 Google AI 구독으로 Cloud Code Assist를 거쳐 Google Antigravity 모델(Gemini, Claude, GPT-OSS)을 제공합니다. 다음 명령을 실행한 뒤 **Google Antigravity**를 고르면 로그인됩니다.

```text
/login google
```

**Pi에 내장된 `google` 공급자를 대체합니다.** 이 패키지가 로드되어 있으면 `google/<모델>`은 Google Antigravity 모델을 가리키고, Pi에 내장된 Gemini API 키용 `google` 공급자와 그 모델은 사라집니다. `GEMINI_API_KEY`는 쓰지 않습니다. `/login google`에 Google Antigravity와 함께 Pi의 API 키 방식이 보일 수 있지만, 이 공급자는 Google Antigravity OAuth 로그인만 받습니다. 저장된 API 키나, 저장된 인증 정보가 없을 때의 `GEMINI_API_KEY`로는 요청이 네트워크 요청 없이 곧바로 인증 오류로 실패하며, 오류는 키를 보여 주지 않고 `/login google`을 안내합니다. `/usage`, Google 검색, 백그라운드 토큰 계산도 이런 키를 로그인하지 않은 상태로 봅니다. 저장된 Google Antigravity 로그인은 항상 `GEMINI_API_KEY`보다 우선합니다. Gemini API 키를 쓰려면 `packages`에서 이 패키지를 빼고 다시 시작하세요.

새로 설치하면 이 패키지가 기본으로 로드됩니다. 다시 설치하는 명령(`pnpm install:profile`, `choco-pi self setup`, `choco-pi self update`)은 기존 설치에도 이 패키지를 추가하고 그 경로를 `added package:`로 출력합니다. 이후 choco-pi를 다시 시작하세요. 이전 설치에서 이미 제공된 번들 패키지를 `settings.json`의 `packages`에서 지웠다면 그 패키지는 계속 빠진 상태로 유지되므로, Pi 기본 공급자를 계속 쓰려면 이 패키지도 같은 방법으로 지우세요.

**약관과 계정 위험.** Google의 Antigravity 약관은 소비자 OAuth 접근으로 서드파티 클라이언트를 쓰는 것을 제한하며, 실제로 이런 방식으로 쓰인 계정이 정지된 사례가 있습니다. choco-pi는 서드파티 클라이언트이고, 요청은 공식 agy CLI로 식별됩니다. Google Antigravity 로그인은 로그인 안내 위에 이 경고를 보여 주며, agy처럼 아무것도 묻지 않습니다. 로그인하면 이 위험을 받아들인 것으로 봅니다. 계정에 대한 이 위험을 받아들일 때만 이 공급자를 쓰세요.

저장소에는 OAuth 클라이언트 ID나 시크릿이 들어 있지 않습니다. 로그인은 다음 중 먼저 설정된 곳에서 값을 가져옵니다.

1. `CHOCO_PI_ANTIGRAVITY_CLIENT_ID`와 `CHOCO_PI_ANTIGRAVITY_CLIENT_SECRET` 환경 변수
2. `<에이전트 디렉터리>/google-antigravity.json`의 `client_id`와 `client_secret`. 같은 파일에 `project_id`(직접 쓰는 Cloud 프로젝트)와 `agy_path`도 지정할 수 있습니다.
3. 둘 다 없을 때: 설치된 agy 바이너리의 로컬 검사(`CHOCO_PI_ANTIGRAVITY_AGY_PATH`, `agy_path`, `PATH`의 `agy` 순). agy처럼 아무것도 묻지 않고 agy의 소비자용 클라이언트를 스스로 고릅니다.

브라우저 단계는 공식 agy CLI의 로그인과 같은 방식입니다. choco-pi가 Google 로그인 페이지를 열고, 접근을 허용하면 Google이 브라우저를 `https://antigravity.google/oauth-callback`으로 보내며, 그 페이지에 인증 코드가 표시됩니다. 이 코드를 복사해 choco-pi의 입력란에 붙여 넣으세요(그 페이지의 전체 주소를 붙여 넣어도 됩니다). 이 컴퓨터에서 대기하는 서버는 없으며, 코드는 기록하거나 화면에 다시 보여 주지 않습니다. 로그인이 요청하는 범위(scope)는 `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`, `aicode`(모두 `https://www.googleapis.com/auth/` 아래)와 `openid`입니다. 로그인 후 choco-pi는 계정 이메일을 읽어 `/usage` 같은 계정별 데이터가 같은 계정에 계속 묶이도록 합니다. 이메일은 인증 정보에만 저장되고 해시한 형태로만 쓰입니다. 인증 정보는 Pi 인증 저장소에만 저장되며, 환경 변수나 설정 파일의 시크릿은 그곳에 복사하지 않습니다. Cloud Code Assist 프로젝트는 Google이 정해 주며, 받지 못하면 프로젝트를 지어내지 않고 메시지와 함께 로그인이 실패합니다.

`google`에 Google Antigravity로 로그인하면 다음과 같이 동작합니다.

- `/usage`에 Google 행이 나타납니다. 요금제 이름, Google이 알려 줄 때는 AI 크레딧 잔액, 그리고 모델 그룹마다 주간 창과 5시간 창(예: "Gemini Models weekly", "Claude and GPT models 5h")이 사용 비율, 초기화 시각과 함께 표시됩니다. Google은 두 소비자용 Ultra 요금제를 모두 "Google AI Ultra"라고 부르므로, 행에는 tier ID로 구분한 크기가 붙습니다: "Google AI Ultra (5x)" 또는 "Google AI Ultra (20x)". 할당량 요약이 없는 요금제는 상태 한 줄만 보여 줍니다. 이 로그인이 없으면, Gemini API 키만 설정된 경우를 포함해, Google은 "Not signed in"에 나열됩니다.
- 할당량을 다 쓰면 턴이 사용량 한도로 멈춥니다. 이 공급자의 사용량 데이터를 다시 읽어 확인하지 않으므로, 한도는 실패한 모델에만 적용되고 Google이 알려 준 초기화 시각까지(알려 주지 않았다면 30분) 유지되며, 자동 재개는 꺼집니다. `/model`로 전환하세요.
- 웹 검색에서 `google` 계열을 쓸 수 있습니다. 검색할 때마다 구독 할당량을 쓰므로 자동 라우팅은 이 계열을 고르지 않으며, 명시적으로 지정할 때만 실행됩니다. [Google 검색(Antigravity)](web-search.md#google-검색-antigravity) 참고.
- 백그라운드 compaction은 토큰 추정치를 그대로 씁니다. choco-pi를 시작하기 전에 `CHOCO_PI_ANTIGRAVITY_COUNT_TOKENS=1`을 설정하면 요약 프롬프트를 Cloud Code Assist `countTokens`로 셉니다. 세션은 compaction이 시작될 때 이 값을 읽으므로, 나중에 바꾸면 새 세션에만 적용됩니다.

아직 지원하지 않는 기능: 이미지 생성, Antigravity를 통한 URL 읽기, 여러 계정 동시 로그인, 엔터프라이즈(Workspace) 라우팅, 할당량 소진 후 AI 크레딧 사용 전환, 모델 대체 표에서 이 공급자 항목, 상태 표시줄의 할당량 표시.
