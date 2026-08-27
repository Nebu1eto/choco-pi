# choco-pi

[English](README.md)

choco-pi는 프로젝트를 인식하는 Pi 프로필로, 운용 규칙과 작업 절차, 로컬 패키지, 개발 도구를 제공합니다.

OAuth 토큰, API 키, 컴퓨터별 로컬 설정은 Git 밖에 보관하세요.

## 요구 사항

- Pi `>=0.84.2 <0.85`
- Node.js 24 이상
- Git
- 선택 사항: 브라우저 자동화를 위한 [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.34.0

## 빠른 시작

```sh
cd choco-pi
npm run install:profile
pi
```

설치 프로그램은 런타임 및 인증 상태와 사용자가 추가한 패키지를 보존하고, 체크아웃의 절대 경로를 기록한 다음 추적 중인 프로필 리소스를 `~/.pi/agent`에 연결합니다.
MCP 설정은 연결하지 않습니다. 대상 파일이 충돌하면 중단되며, `npm run install:profile -- --backup`으로 다시 실행하면 됩니다. 체크아웃은 경로가 바뀌지 않는 곳에 두세요.
체크아웃을 업데이트한 뒤에는 설치 프로그램을 다시 실행하고, `.pi` 아래 파일을 수정한 뒤에는 `/reload`를 실행하세요.

## 인증

Pi 세션에서 인증하세요.

```text
/login openai-codex
/login anthropic
/login synthetic
```

Pi는 인증 정보를 저장소 밖에 보관합니다. 인증 정보가 담긴 파일을 Git에 복사하지 마세요.

## 기능

| 영역            | 용도                                                        |
| --------------- | ----------------------------------------------------------- |
| 정책            | 공통 운용 규칙과 루트 및 경로별 `AGENTS.md` 지침            |
| 작업 절차       | 직접 구현, 병렬 구현, 동적 분해, 리뷰, 점검, 커밋 절차      |
| 에이전트        | 설정 가능한 계획, 구현, 탐색, 리뷰, 인계 역할               |
| 세션과 goal     | 독립 대화와 compaction 후에도 유지되는 지속형 goal          |
| 코드 인텔리전스 | LSP 탐색, 시맨틱 인덱싱, AST 검색, 진단, Code Mode          |
| 연동            | MCP, 웹 조사, 브라우저 자동화, macOS 조작, Claude 호환 훅   |
| 인터페이스      | Nord TUI, 컨텍스트와 사용량 화면, 환경 설정, Mermaid 렌더링 |

Pi의 내장 `grep` 도구는 비활성화되어 있습니다. 소스 탐색은 LSP와 Code Mode 절차를 따릅니다: `symbol_search`, `module_report`, 필요한 심벌만 읽기, 코드 탐색, AST 검색.

## 주요 명령

| 명령                        | 용도                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `/status`                   | 세션, 모델, 공급자, 컨텍스트, 불러온 프로필 상태 표시       |
| `/preferences`              | 에이전트 언어, 응답 스타일, 인터페이스 환경 설정            |
| `/context all`              | 프롬프트, 도구, MCP, 에이전트, 파일, 스킬, 토큰 사용량 확인 |
| `/usage`                    | 지원하는 공급자의 사용량과 초기화 정보 표시                 |
| `/check`                    | 설치된 프로필과 필수 리소스 검증                            |
| `/task-inline <task>`       | 일반적인 변경 하나를 직접 구현                              |
| `/task <task>`              | 독립적인 구현 단위를 병렬 실행                              |
| `/task-dynamic <task>`      | 동적으로 분해하는 중첩 작업을 명시적으로 활성화             |
| `/review [target]`          | 사람이 직접 검토하는 로컬 인터페이스 열기                   |
| `/review-agent [target]`    | 새로운 독립 문맥에서 수정 없는 적대적 리뷰 실행             |
| `/commit [guidance]`        | 푸시하지 않고 검증된 로컬 커밋 생성                         |
| `/sessions`, `/session-new` | 프로젝트 대화 목록을 보거나 독립 대화 시작                  |
| `/goal [objective]`         | 지속형 goal 생성, 확인, 관리                                |
| `/hooks`                    | 현재 적용되는 Claude 호환 훅 설정 확인                      |
| `/mcp`                      | MCP 설정, 인증, 서버 상태 확인                              |

## 설치된 패키지

[`.pi/settings.json`](.pi/settings.json)은 다음 로컬 패키지 13개를 불러옵니다.

| 패키지                                                                    |           버전 | 용도                                        |
| ------------------------------------------------------------------------- | -------------: | ------------------------------------------- |
| [`choco-pi-provider-synthetic`](.pi/packages/choco-pi-provider-synthetic) |          0.1.0 | Synthetic 공급자, 인증, 사용량, 검색        |
| [`choco-pi-ui`](.pi/packages/choco-pi-ui)                                 |          0.1.0 | TUI, 상태 표시줄, 환경 설정, Nord 테마      |
| [`choco-pi-shells`](.pi/packages/choco-pi-shells)                         |          0.1.0 | 소유자별 백그라운드 셸 프로세스             |
| [`choco-pi-hooks`](.pi/packages/choco-pi-hooks)                           |          0.1.0 | Claude Code 호환 생명주기 훅                |
| [`choco-pi-subagents`](.pi/packages/choco-pi-subagents)                   |          0.1.0 | 서브 에이전트, 작업 절차, 세션, fleet UI    |
| [`choco-pi-goal`](.pi/packages/choco-pi-goal)                             |          0.1.0 | Codex 형태의 지속형 goal                    |
| [`choco-pi-mcp`](.pi/packages/choco-pi-mcp)                               |          0.1.0 | 지연 로딩 MCP 서버, Figma 도구, elicitation |
| [`choco-pi-lsp`](.pi/packages/choco-pi-lsp)                               |          0.1.0 | LSP, lint, 구조 분석, 시맨틱 도구           |
| [`choco-pi-codex`](.pi/packages/choco-pi-codex)                           |          0.1.0 | Codex 도구, Code Mode, Responses compaction |
| [`choco-pi-agents-md`](.pi/packages/choco-pi-agents-md)                   |          0.1.0 | 하위 `AGENTS.md` 지침 로딩                  |
| [`choco-pi-web-access`](.pi/packages/choco-pi-web-access)                 | 0.24.1-choco.0 | 웹 검색, 출처 검증, 콘텐츠 추출             |
| [`choco-pi-agent-browser`](.pi/packages/choco-pi-agent-browser)           |  0.5.0-choco.0 | 네이티브 브라우저 자동화 도구               |
| [`choco-pi-computer-use`](.pi/packages/choco-pi-computer-use)             |  0.5.0-choco.0 | macOS 데스크톱 확인 및 조작                 |

## 설정과 사용자화

| 파일 또는 디렉터리                                                                                                                            | 용도                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`.pi/settings.json`](.pi/settings.json)                                                                                                      | 불러올 패키지, 테마, 모델 effort, compaction 설정 |
| [`.pi/SYSTEM.md`](.pi/SYSTEM.md)                                                                                                              | 프로필 전체에 적용되는 에이전트 동작과 권한 규칙  |
| [`AGENTS.md`](AGENTS.md)와 [패키지 예시](.pi/packages/choco-pi-subagents/AGENTS.md)                                                           | 루트 및 경로별 저장소 규칙                        |
| [`.pi/agents`](.pi/agents)                                                                                                                    | 에이전트 역할 정의와 기본값                       |
| [`context-cap.json`](.pi/extensions/context-cap.json)                                                                                         | 모델별 context cap과 compaction 임계값            |
| [`apex-provider.json`](.pi/extensions/apex-provider.json)                                                                                     | Callstack Apex 공급자 탐색 기본값                 |
| [`review.json`](.pi/extensions/review.json)                                                                                                   | 로컬 리뷰 인터페이스 설정                         |
| `~/.pi/agent/mcp.json`과 그 예시인 [`.pi/mcp.example.json`](.pi/mcp.example.json)                                                             | 추적하지 않는 MCP 서버 및 OAuth 설정              |
| 패키지별 [`AGENTS.md`](.pi/packages/choco-pi-agent-browser/AGENTS.md)와 [`VENDORED.md`](.pi/packages/choco-pi-agent-browser/VENDORED.md) 파일 | 패키지 정책과 기록된 업스트림 변경 사항           |

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

로컬 패키지 매니페스트에는 MIT 라이선스가 선언되어 있습니다. 저장소 루트에는 별도의 라이선스 파일이 없으므로, 이 README는 저장소 전체에 라이선스를 부여하지 않습니다.

## 참고 자료

- [Pi](https://pi.dev/)
- [OpenAI Codex Code Mode](https://github.com/openai/codex/tree/main/codex-rs/code-mode)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [`agent-browser`](https://github.com/vercel-labs/agent-browser)
- [`pi-computer-use`](https://github.com/injaneity/pi-computer-use)
