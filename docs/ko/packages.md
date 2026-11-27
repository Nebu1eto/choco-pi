# 설치된 패키지

[English](../en/packages.md)

프로필은 아래의 로컬 패키지 18개를 불러옵니다. 각 패키지는 에이전트 디렉터리 `settings.json`의 `packages`에 절대 경로로 등록되어 있습니다. 열아홉 번째 패키지인 [`@choco-pi/acp`](../../packages/choco-pi-acp) 1.0.0-alpha.1은 Pi가 불러오지 않으며, 에디터와 연결되는 별도 ACP 프로세스로 실행됩니다([Zed에서 choco-pi 사용하기](zed-setup.md) 참고).

| 패키지                                                                                         |          버전 | 용도                                                      |
| ---------------------------------------------------------------------------------------------- | ------------: | --------------------------------------------------------- |
| [`@choco-pi/web-search`](../../packages/choco-pi-web-search)                                   | 1.0.0-alpha.1 | 통합 웹 검색, 라우팅, 출처 검증, 콘텐츠 추출              |
| [`@choco-pi/provider-synthetic`](../../packages/choco-pi-provider-synthetic)                   | 1.0.0-alpha.1 | Synthetic 공급자, 인증, 사용량, 검색                      |
| [`@choco-pi/provider-google-antigravity`](../../packages/choco-pi-provider-google-antigravity) | 1.0.0-alpha.1 | Google Antigravity 공급자, OAuth 로그인, 할당량, 검색     |
| [`@choco-pi/ui`](../../packages/choco-pi-ui)                                                   | 1.0.0-alpha.1 | TUI, 상태 표시줄, 환경설정, Nord 테마                     |
| [`@choco-pi/shells`](../../packages/choco-pi-shells)                                           | 1.0.0-alpha.1 | 셸을 소유한 세션별로 격리된 백그라운드 셸 프로세스        |
| [`@choco-pi/hooks`](../../packages/choco-pi-hooks)                                             | 1.0.0-alpha.1 | Claude Code 호환 생명주기 훅                              |
| [`@choco-pi/subagents`](../../packages/choco-pi-subagents)                                     | 1.0.0-alpha.1 | 서브 에이전트, workflow, 세션, fleet UI                   |
| [`@choco-pi/advisor`](../../packages/choco-pi-advisor)                                         | 1.0.0-alpha.1 | 서브 에이전트로 실행하는 읽기 전용 advisor 자문           |
| [`@choco-pi/editor-context`](../../packages/choco-pi-editor-context)                           | 1.0.0-alpha.1 | 에디터 컨텍스트 프로토콜, 저장, 주입                      |
| [`@choco-pi/goal`](../../packages/choco-pi-goal)                                               | 1.0.0-alpha.1 | Codex 방식의 지속형 goal                                  |
| [`@choco-pi/mcp`](../../packages/choco-pi-mcp)                                                 | 1.0.0-alpha.1 | 네이티브 Figma 도구(MCP 기능은 Pi에 내장)                 |
| [`@choco-pi/lsp`](../../packages/choco-pi-lsp)                                                 | 1.0.0-alpha.1 | LSP, lint, 구조 분석, 시맨틱 도구                         |
| [`@choco-pi/compaction`](../../packages/choco-pi-compaction)                                   | 1.0.0-alpha.1 | 요약하지 않고 남긴 메시지와 대조하는 로컬 compaction 요약 |
| [`@choco-pi/codex`](../../packages/choco-pi-codex)                                             | 1.0.0-alpha.1 | Codex 도구, Code Mode, Responses compaction               |
| [`@choco-pi/agents-md`](../../packages/choco-pi-agents-md)                                     | 1.0.0-alpha.1 | 하위 디렉터리의 `AGENTS.md` 지침 불러오기                 |
| [`@choco-pi/agent-browser`](../../packages/choco-pi-agent-browser)                             | 1.0.0-alpha.1 | 네이티브 브라우저 자동화 도구                             |
| [`@choco-pi/computer-use`](../../packages/choco-pi-computer-use)                               | 1.0.0-alpha.1 | macOS 데스크톱 화면 확인과 조작                           |
