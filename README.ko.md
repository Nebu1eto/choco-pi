<h1>
  <img src="assets/choco-pi-logo.svg" alt="choco-pi 로고" width="40" height="40" align="absmiddle" />
  choco-pi
</h1>

[English](README.md)

choco-pi는 [Pi](https://pi.dev/) 코딩 에이전트용 프로필로, 작업하는 프로젝트에 맞춰 동작합니다. 운용 규칙, 구현·리뷰 작업 절차, 서브 에이전트, 코드 인텔리전스, 조사·자동화 도구, Nord 테마의 터미널 인터페이스가 들어 있습니다. 패키지, 스킬, 에이전트 정의는 저장소 체크아웃에서 불러옵니다. `agent-browser` CLI, MCP 서버, 검색 백엔드 같은 선택 도구는 저장소에 들어 있지 않습니다.

## 주요 기능

- [운용 규칙과 작업 절차](docs/ko/features.md#운용-규칙과-작업-절차): 작업 범위, 권한, 근거에 관한 공통 규칙과 함께 구현, 리뷰, 검증, 서명된 로컬 커밋에 쓰는 스킬을 제공합니다.
- [에이전트와 오케스트레이션](docs/ko/features.md#에이전트와-오케스트레이션): 역할별 전문 서브 에이전트를 백그라운드나 격리된 Git worktree에서 실행합니다. 의존 관계에 맞춰 차례로 실행하는 workflow로 묶을 수도 있습니다.
- [리뷰와 검증](docs/ko/features.md#리뷰와-검증): `/review`는 diff를 고정한 뒤 새로 띄운 읽기 전용 리뷰어에게 검토를 맡깁니다. `/diff`와 `/review-assist`는 변경 내용을 터미널에서 보여 줍니다.
- [세션, 컨텍스트, goal](docs/ko/features.md#세션-컨텍스트-goal): 지속형 goal, 체크포인트, 컨텍스트 한도 프리셋, 서버 측 compaction과 로컬 compaction을 지원합니다.
- [코드 인텔리전스와 Code Mode](docs/ko/features.md#코드-인텔리전스와-code-mode): LSP, ast-grep, 심벌 도구가 있고, `exec` 도구는 여러 도구 호출을 한 단계로 묶어 실행합니다.
- [조사와 연동](docs/ko/features.md#조사와-연동): `web_search` 도구 하나로 여러 검색 백엔드를 쓸 수 있고, Pi 내장 MCP, 브라우저 자동화, macOS computer use도 지원합니다.
- [모델과 사용량](docs/ko/features.md#모델과-사용량): 추론 effort와 Fast 모드를 조절하고, 공급자별 사용량과 초기화 시각을 `/usage`에서 확인합니다.
- [인터페이스](docs/ko/features.md#인터페이스): Nord 테마의 전체 화면 TUI, `/status` 대화 상자, 사용량 통계, 터미널에 바로 그려지는 Mermaid 다이어그램을 제공합니다.

## 빠른 시작

choco-pi를 설치하는 방법은 두 가지입니다. 독립 실행형 `choco-pi` 명령으로 설치하면 버전이 고정된 Pi를 따로 두고 실행하며, 상태는 `~/.choco-pi`에 저장합니다. 프로필로 설치하면 직접 설치한 Pi에 얹어 쓰며, `~/.pi/agent`를 `pi`와 함께 씁니다.

독립 실행형 명령은 다음과 같이 설치합니다.

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
sh choco-pi/install.sh
choco-pi
```

`choco-pi`가 실행되면 `/login`으로 로그인하세요.

직접 설치한 Pi에 프로필로 설치하려면 먼저 [Homebrew를 사용하지 않고 Pi 설치](docs/ko/installation.md#homebrew를-사용하지-않고-pi-설치)를 보고 Pi를 설치하고, [mise](https://mise.jdx.dev/)도 설치하세요. 그다음 아래 명령을 실행합니다.

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
cd choco-pi

mise install
pnpm --version

pnpm install --frozen-lockfile
npm run install:profile
pi
```

- 설치 방법별로 필요한 플랫폼과 도구는 [요구 사항](docs/ko/installation.md#요구-사항)에 있습니다.
- 설치 프로그램 옵션, 첫 실행 설정, 런타임 선택, 업데이트와 제거는 [설치와 업데이트](docs/ko/installation.md)에서 설명합니다.
- `/login`으로 로그인할 수 있는 공급자는 [인증](docs/ko/authentication.md)에 있습니다.

## 문서

| 문서                                                     | 내용                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| [설치와 업데이트](docs/ko/installation.md)               | 요구 사항, 두 가지 설치 방법, 업데이트와 다시 불러오기                   |
| [인증](docs/ko/authentication.md)                        | `/login`으로 로그인하는 공급자와 인증 정보 관리                          |
| [computer use 설정하기 (macOS)](docs/ko/computer-use.md) | helper 설치, 권한 부여, 설정, 제거                                       |
| [기능](docs/ko/features.md)                              | 기능 영역별로 하는 일                                                    |
| [주요 명령](docs/ko/commands.md)                         | 주요 슬래시 명령과 하는 일                                               |
| [설치된 패키지](docs/ko/packages.md)                     | 번들 패키지와 패키지별 기능                                              |
| [설정과 사용자화](docs/ko/configuration.md)              | 프로필 파일, 전역 설정, advisor 설정, 내장 확장, MCP 설정                |
| [Zed에서 choco-pi 사용하기](docs/ko/zed-setup.md)        | 체크아웃이나 독립 실행형 설치에서 choco-pi를 Zed ACP 에이전트로 실행하기 |
| [웹 검색](docs/ko/web-search.md)                         | `web_search` 라우팅, 검색 백엔드, 개인정보 보호, 요금                    |
| [개발](docs/ko/development.md)                           | 고정된 툴체인과 검증 단계                                                |

RPC 호스트 브리지 규약, 검증 안내 같은 기여자용 기록은 영문으로만 작성되어 있으며, 목록은 [docs/README.md](docs/README.md)에 있습니다.

## 보안과 권한

OAuth 토큰과 API 키를 비롯한 인증 정보, 이 컴퓨터에서만 쓰는 설정, 로컬 재정의 값은 Git에 넣지 마세요. choco-pi의 운용 규칙에 따라 원격 쓰기, 배포, 풀 리퀘스트, 게시를 비롯해 이 컴퓨터 밖의 무언가를 바꾸는 작업은 모두 명시적인 승인을 받아야 합니다.

## 라이선스 상태

로컬 패키지 매니페스트는 `choco-pi-web-search`를 빼고 모두 MIT 라이선스를 선언하며, `choco-pi-web-search`에는 라이선스 선언이 없습니다. 저장소 루트에 라이선스 파일이 없으므로, 이 README가 저장소 전체에 라이선스를 부여하지는 않습니다.

## 참고 자료

- [Pi](https://pi.dev/)
- [OpenAI Codex Code Mode](https://github.com/openai/codex/tree/main/codex-rs/code-mode)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [`agent-browser`](https://github.com/vercel-labs/agent-browser)
- [`pi-computer-use`](https://github.com/injaneity/pi-computer-use)
