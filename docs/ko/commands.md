# 주요 명령

[English](../en/commands.md)

자주 쓰는 슬래시 명령입니다. 괄호 안은 별칭입니다.

| 명령                                              | 용도                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `/status`                                         | 세션, 비용, 모델, 컨텍스트, MCP, 환경 상태 표시                          |
| `/preferences` (`/pref`)                          | 에이전트, advisor, 언어, 스타일, 페르소나, 인터페이스 설정               |
| `/context all`                                    | 프롬프트, 도구, MCP, 에이전트, 파일, 스킬, 토큰 사용량 확인              |
| `/usage` (`/quota`)                               | 지원하는 공급자의 사용량과 초기화 정보 표시                              |
| `/stats`                                          | 토큰 사용량, 비용, 기능별·모델별 분석, 속도 표시                         |
| `/effort [level]`, `/fast [on\|off\|status]`      | 추론 effort나 세션의 Fast 모드 설정 변경                                 |
| `/check`                                          | 설치된 프로필과 필수 리소스 점검                                         |
| `/task-inline <task>`                             | 일반적인 변경 하나를 직접 구현                                           |
| `/task <task>`                                    | 서로 독립된 구현 단위를 병렬로 실행                                      |
| `/task-dynamic <task>`                            | 작업을 동적으로 나누어 중첩 실행하도록 명시적으로 지정                   |
| `/task-hotfix <task>`                             | 운영 환경 긴급 수정을 직접 적용                                          |
| `/review [target]`                                | 새 컨텍스트의 에이전트가 코드를 고치지 않고 보고만 하는 적대적 리뷰 실행 |
| `/review-assist [target]`                         | 세션, 브랜치, 풀 리퀘스트의 변경을 직접 검토                             |
| `/diff [subcommand]`                              | 대화 기록 옆의 실시간 diff 패널 열기, 닫기, 조작                         |
| `/review-continue`, `/verify-continue`            | work task의 리뷰·검증 라운드 상한 확인 또는 상향                         |
| `/commit [guidance]`                              | 검증을 거친 로컬 커밋 생성(푸시하지 않음)                                |
| `/checkpoint`                                     | 특정 턴으로 되감기, 롤백, 분기, 또는 현재 상태에서 분기                  |
| `/rewind`, `/fork`                                | 되감기만 하거나, 특정 턴 또는 현재 상태에서 분기만 함                    |
| `/agents`, `/btw`                                 | 에이전트 관리 또는 읽기 전용 곁대화 열기                                 |
| `/shells`                                         | 관리되는 셸의 목록 보기, 출력 읽기, 중지                                 |
| `/sessions`, `/session-new`                       | 프로젝트 대화 목록 보기 또는 독립된 새 대화 시작                         |
| `/session-read`, `/session-send`, `/session-wait` | 다른 대화의 내용 읽기, 지시 보내기, 완료 대기                            |
| `/goal [objective]`                               | 지속형 goal 생성, 확인, 관리                                             |
| `/hooks`, `/add-dir`                              | 훅 살펴보기 또는 작업 디렉터리 추가                                      |
| `/mcp`                                            | MCP 서버 확인, 로그인·로그아웃, 재연결, 노출 방식 변경                   |
| `/search`, `/websearch`, `/curator`               | 저장된 검색 결과 보기 또는 검색 curator 실행                             |
| `/lsp`                                            | LSP 사용 켜기·끄기 또는 상태 표시                                        |
| `/codex`, `/computer-use`                         | Codex 어댑터 설정 또는 computer-use 설정 확인                            |
| `/apex-refresh`                                   | Callstack Apex 모델 목록 새로 고침                                       |
| `/clear`, `/exit`, `/delete`                      | 새 세션 시작, 종료, 현재 세션 영구 삭제                                  |
