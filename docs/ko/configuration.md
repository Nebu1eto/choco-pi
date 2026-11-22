# 설정과 사용자화

[English](../en/configuration.md)

이 페이지는 choco-pi를 설정하는 파일을 정리하고, 완성된 전역 `settings.json` 예시와 함께 advisor, Pi 내장 확장, MCP 서버 설정을 설명합니다. 독립 실행형 설치에서는 `~/.pi/agent` 아래의 경로가 모두 `~/.choco-pi/agent` 아래에 있습니다([자세히](installation.md#pi와의-분리)).

| 파일 또는 디렉터리                                                                                                                                | 용도                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 전역 `~/.pi/agent/settings.json`(체크아웃에는 `.pi/settings.json` 없음)                                                                           | 불러올 패키지, 테마, TUI 모드, 모델별 thinking 수준, compaction  |
| [`profile/SYSTEM.md`](../../profile/SYSTEM.md)                                                                                                    | 프로필 전체에 적용되는 에이전트 동작 규칙과 권한 규칙            |
| [`profile/model-guidance.md`](../../profile/model-guidance.md)                                                                                    | 모델 라우팅과 모델별 정책                                        |
| [`profile/writing-policy.md`](../../profile/writing-policy.md)와 [`profile/review-policy.md`](../../profile/review-policy.md)                     | 응답 문장 규칙과 리뷰 정책                                       |
| [`AGENTS.md`](../../AGENTS.md)와 [패키지 예시](../../packages/choco-pi-subagents/AGENTS.md)                                                       | 루트와 경로별 저장소 규칙                                        |
| [`profile/agents`](../../profile/agents), [`profile/skills`](../../profile/skills), [`profile/prompts`](../../profile/prompts)                    | 에이전트 역할, 작업 절차 스킬, 슬래시 명령 프롬프트              |
| [`profile/subagents.json`](../../profile/subagents.json)                                                                                          | 서브 에이전트 동시 실행 수, 중첩 깊이, fleet 화면, worktree 격리 |
| [`profile/choco-pi-codex.json`](../../profile/choco-pi-codex.json)                                                                                | Code Mode, Codex 도구, notebook, compaction 설정                 |
| [`profile/zentui.json`](../../profile/zentui.json)                                                                                                | TUI 색상, 구성 요소, 아이콘                                      |
| [`profile/models.json`](../../profile/models.json)과 [`profile/keybindings.json`](../../profile/keybindings.json)                                 | 공급자 모델 재정의와 키 바인딩                                   |
| [`apex-provider.json`](../../profile/extensions/apex-provider.json)                                                                               | Callstack Apex 공급자 탐색 기본값                                |
| [`review.json`](../../profile/extensions/review.json)                                                                                             | 로컬 리뷰 인터페이스 설정                                        |
| 전역 `~/.pi/agent/advisor.json`과 프로젝트별 재정의 파일 `.pi/advisor.json`                                                                       | advisor 사용 여부, 모델, effort, 턴당 사용 한도                  |
| [`profile/mcp.example.json`](../../profile/mcp.example.json)을 바탕으로 만든 `~/.pi/agent/mcp.json`(독립 실행형은 `~/.choco-pi/agent/mcp.json`)   | Git으로 추적하지 않는 Pi 내장 형식의 MCP 서버 설정               |
| 패키지별 [`AGENTS.md`](../../packages/choco-pi-agent-browser/AGENTS.md)와 [`VENDORED.md`](../../packages/choco-pi-agent-browser/VENDORED.md) 파일 | 패키지 정책과 업스트림 대비 변경 기록                            |

`npm run install:profile`(독립 실행형 명령은 `choco-pi self setup`)은 정책 파일, `subagents.json`, `choco-pi-codex.json`, `models.json`, `keybindings.json`, 에이전트 정의, 확장 JSON 파일 2개(`extensions/apex-provider.json`, `extensions/review.json`)를 `~/.pi/agent`에 연결합니다. `zentui.json`은 `choco-pi-ui.json`이라는 이름으로 연결됩니다. 기존 `~/.pi/agent/extensions/background-compaction.json`이 있으면 현재 구조로 옮깁니다. 이때 백엔드 스위치는 OpenAI·Anthropic compaction 모드를 기준으로 다시 계산하고, `enabled`를 비롯한 다른 키는 그대로 둡니다. 파일이 없으면 새로 만들지 않습니다.

Pi 1.0.3부터 `Home`/`End`는 편집기 커서를 옮깁니다. 대화 기록의 맨 위나 맨 아래로 가려면 `Ctrl+Home`/`Ctrl+End`를 쓰세요.

## 전역 설정 예시

`npm run install:profile`은 `~/.pi/agent/settings.json`을 다시 쓰되, 자신이 관리하지 않는 키는 그대로 둡니다. `choco-pi self setup`은 같은 설치 프로그램으로 `~/.choco-pi/agent/settings.json`을 다시 씁니다. 체크아웃에는 `.pi/settings.json`이 없으므로 프로필 정책은 이 전역 파일에서 가져옵니다. 체크아웃의 `packages` 아래를 가리키는 `packages` 항목과 `extensions`의 내장 확장 정책이 그 정책입니다.

이 파일에 번들 패키지가 하나도 없으면 설치 프로그램은 `scripts/install-profile.ts`에 정의된 프로필 기본값에서 시작합니다. 이 기본값에는 모델별 thinking 수준(`modelThinkingLevels`)이 들어 있고, Pi에 프로필을 설치할 때는 관리자가 쓰는 모델 범위(`enabledModels`)도 들어갑니다. 독립 실행형 `choco-pi self setup`은 `enabledModels` 범위를 기록하지 않습니다([이유](installation.md#첫-실행-설정)). 처음 설치할 때도 이미 설정해 둔 `enabledModels`는 유지하며, 기본 thinking 수준은 사용자 항목이 우선하도록 합칩니다. 설치 프로그램은 실행할 때마다 다음과 같이 처리합니다.

- `packages`, `skills`, `prompts`를 체크아웃 절대 경로로 기록하고, `extensions`에는 [내장 확장 정책](#내장-확장)도 넣습니다. 사용자가 추가한 항목은 choco-pi 항목 뒤에 남지만, 번들 패키지로 대체된 패키지는 제거됩니다.
- `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`, `modelThinkingLevels`는 전역 파일에 설정된 값을 그대로 둡니다. 값을 바꾸려면 전역 파일을 고치거나 `/preferences`를 쓰세요.
- 그 밖의 키는 건드리지 않습니다. 직접 쓰거나 `/preferences`로 설정하세요.

체크아웃에 `.pi/settings.json`을 추가하면 그 파일이 우선합니다. 설치 프로그램과 `/check`는 전역 파일 대신 그 파일을 읽어, 그 파일의 `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`으로 전역 값을 덮어쓰고, `modelThinkingLevels`는 전역 항목이 우선하도록 합칩니다.

완성된 전역 파일은 다음과 같습니다. `/path/to/choco-pi`는 실제 체크아웃 경로로 바꾸고, 독립 실행형 명령이라면 `~/.choco-pi/app`의 절대 경로로 바꾸세요. `defaultModel`, `modelThinkingLevels`, `enabledModels` 값은 관리자가 현재 쓰는 설정입니다. 비밀 값은 이 파일에 넣지 마세요.

```json
{
  "packages": [
    "/path/to/choco-pi/packages/choco-pi-web-search",
    "/path/to/choco-pi/packages/choco-pi-web-access",
    "/path/to/choco-pi/packages/choco-pi-provider-synthetic",
    "/path/to/choco-pi/packages/choco-pi-provider-google-antigravity",
    "/path/to/choco-pi/packages/choco-pi-ui",
    "/path/to/choco-pi/packages/choco-pi-shells",
    "/path/to/choco-pi/packages/choco-pi-hooks",
    "/path/to/choco-pi/packages/choco-pi-subagents",
    "/path/to/choco-pi/packages/choco-pi-advisor",
    "/path/to/choco-pi/packages/choco-pi-goal",
    "/path/to/choco-pi/packages/choco-pi-mcp",
    "/path/to/choco-pi/packages/choco-pi-lsp",
    "/path/to/choco-pi/packages/choco-pi-compaction",
    "/path/to/choco-pi/packages/choco-pi-codex",
    "/path/to/choco-pi/packages/choco-pi-agents-md",
    "/path/to/choco-pi/packages/choco-pi-agent-browser",
    "/path/to/choco-pi/packages/choco-pi-computer-use",
    "/path/to/choco-pi/packages/choco-pi-editor-context"
  ],
  "extensions": [
    "/path/to/choco-pi/profile/extensions",
    "-builtin:codemode",
    "-builtin:tool-search"
  ],
  "skills": ["/path/to/choco-pi/profile/skills"],
  "prompts": ["/path/to/choco-pi/profile/prompts"],

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
  "agentStyle": "balanced",
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

| 키                                                                                                                                | 설정 주체                  | 설명                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages`, `extensions`, `skills`, `prompts`                                                                                     | 설치 프로그램              | 체크아웃의 절대 경로입니다. 체크아웃을 옮기면 설치 프로그램을 다시 실행하세요.                                                                                                                                                                                                                                                                                           |
| `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`                                                     | 사용자                     | `compaction.reserveTokens`는 컨텍스트 창이 가득 차기 얼마나 전에 compaction을 시작할지 정하는 토큰 수이고(요약에는 모델의 출력 한도를 씀), `compaction.keepRecentTokens`는 요약하지 않고 남겨 둘 최근 토큰 수입니다. 컨텍스트 한도는 `/preferences`의 프리셋으로 정합니다.                                                                                               |
| `modelThinkingLevels`                                                                                                             | 사용자                     | 정확한 `provider/modelId`를 키로 씁니다. 체크아웃에 `.pi/settings.json`이 있으면, 그 파일은 사용자가 설정하지 않은 모델의 항목만 추가합니다.                                                                                                                                                                                                                             |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`                                                        | 사용자                     | 시작할 때 쓸 모델과 thinking 수준입니다. `enabledModels`는 모델을 차례로 전환할 때 고를 수 있는 대상을 제한합니다.                                                                                                                                                                                                                                                       |
| `cacheWarming`, `transport`, `httpIdleTimeoutMs`, `quietStartup`, `enableInstallTelemetry`, `markdown`, `terminal`                | 사용자                     | Pi 런타임 설정입니다. `cacheWarming`은 전역 파일에서만 읽으며, `off`, `streaming`, `idle`(기본값) 중 하나를 씁니다.                                                                                                                                                                                                                                                      |
| `agentLanguage`, `agentStyle`, `agentPersona`, `agentOnUsageLimit`, `sessionAutoName`, `sessionAutoNameModel`, `promptSuggestion` | 사용자 또는 `/preferences` | choco-pi는 이 키들을 전역 파일에서만 읽습니다. `agentStyle`에는 `balanced`(기본값), `concise`, `explanatory`, 또는 `~/.pi/agent/agent-styles/`에 둔 스타일 파일 이름을 씁니다. 기본값은 `agentPersona`가 `pessimistic`, `agentOnUsageLimit`이 `none`(`fallback`, `auto-resume`도 가능), `sessionAutoNameModel`이 `openai/gpt-6-luna`, `promptSuggestion`이 `true`입니다. |
| `hooks`                                                                                                                           | 사용자                     | Claude Code 훅 형식입니다. choco-pi-hooks는 `.claude`, `.agents` 설정 파일의 훅도 읽습니다. 자세한 내용은 이 패키지의 [README](../../packages/choco-pi-hooks/README.md)를 참고하세요.                                                                                                                                                                                    |

## advisor 설정

advisor 설정은 별도 파일인 `~/.pi/agent/advisor.json`에 둡니다. 프로젝트에 `.pi/advisor.json`이 있으면 그 파일이 키 단위로 덮어씁니다.

```json
{
  "enabled": true,
  "model": "anthropic/claude-fable-5-2",
  "effort": "low",
  "maxUses": 3
}
```

`effort`에는 `off`부터 `max`까지의 값을 쓸 수 있고, `maxUses`는 1 이상이어야 합니다. 이 파일이 없으면 advisor는 꺼져 있습니다. 기본값과 제한은 [advisor README](../../packages/choco-pi-advisor/README.md)에 있습니다.

## 내장 확장

Pi 1.5에는 `codemode`, `tool-search`, `mcp`, `llama.cpp` 확장이 내장되어 있습니다. choco-pi는 Pi 내장 MCP는 그대로 쓰지만, 자체 `exec` 코드 모드 브리지와 자체 `tool_search`를 쓰기 때문에 `"extensions": ["-builtin:codemode", "-builtin:tool-search"]`로 `codemode`와 `tool-search`를 끕니다. 프로필 설치 프로그램은 이 정책을 전역 설정에 반영하고, 그 밖의 내장 확장 제외 항목은 지웁니다.

MCP 서버는 에이전트 디렉터리의 `mcp.json`에 Pi 내장 형식으로 설정합니다. Pi에 설치한 프로필은 `~/.pi/agent/mcp.json`을, 독립 실행형 명령은 `~/.choco-pi/agent/mcp.json`을 씁니다. 지금은 쓰지 않는 `pi-mcp-adapter` 포크용으로 작성한 파일은 변환해야 합니다. 체크아웃에서는 `node scripts/translate-mcp-config.ts`를, 독립 실행형 명령에서는 `choco-pi self exec node ~/.choco-pi/app/scripts/translate-mcp-config.ts`를 실행하세요. 이 스크립트는 값을 가린 dry-run diff를 출력하며, `--apply`를 줄 때만 파일을 쓰고 시각이 붙은 백업을 남깁니다.
