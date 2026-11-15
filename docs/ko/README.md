# choco-pi 문서

[English](../en/README.md)

choco-pi를 설치하고, 설정하고, 사용하는 방법을 안내합니다. 전체 소개는 [프로젝트 README](../../README.ko.md)에서 볼 수 있습니다.

## 안내서

- [설치와 업데이트](installation.md): 요구 사항, 두 가지 설치 방법, 업데이트와 다시 불러오기
- [인증](authentication.md): `/login`으로 로그인하는 공급자와 인증 정보 관리
- [computer use 설정하기 (macOS)](computer-use.md): helper 설치, 권한 부여, 설정, 제거
- [기능](features.md): 기능 영역별로 하는 일
- [주요 명령](commands.md): 주요 슬래시 명령과 하는 일
- [설치된 패키지](packages.md): 번들 패키지와 패키지별 기능
- [설정과 사용자화](configuration.md): 프로필 파일, 전역 설정, advisor 설정, 내장 확장, MCP 설정
- [Zed에서 choco-pi 사용하기](zed-setup.md): 체크아웃이나 독립 실행형 설치에서 choco-pi를 Zed ACP 에이전트로 실행하기
- [웹 검색](web-search.md): `web_search` 라우팅, 검색 백엔드, 개인정보 보호, 요금
- [개발](development.md): 고정된 툴체인과 검증 단계

## 프로젝트 기록 (영문)

기여자를 위한 다음 기록은 `docs/`에 있으며, 한국어판은 없습니다.

- [RPC 호스트 브리지](../rpc-host-bridge.md): Waku가 설치된 프로필을 식별하고 백그라운드 작업 항목과 goal 항목을 읽을 때 쓰는 규약
- [검증 안내](../verification-map.md): 변경 사항을 믿고 받아들이기 전에 choco-pi 영역별로 실행할 검사
- [모델 지침 변경 기록](../model-guidance-history.md): 지금까지 모델 지침을 고칠 때 참고한 출처와 내린 결정(기록용이며 라우팅에는 쓰지 않음)
- [Zed ACP 호환성 기준](../zed-acp-compatibility.md): Zed 연동의 기준으로 기록해 둔 구성 요소 버전
- [Zed 명령 호환 목록](../zed-command-parity.md): 명령마다 터미널 UI 없이 Zed에서 끝까지 실행되는지 분류한 목록
- [Zed 런타임 E2E 기록](../zed-e2e-evidence.md): 실제 Zed에서 choco-pi를 실행하며 시도마다 관찰한 내용
- [computer use E2E 검증](../computer-use-e2e.md): computer use를 격리된 환경에서 처음부터 끝까지 검증하는 하네스와 실행 방법
- [사용량 한도 대응 계획](../on-usage-limit-plan.md): `agentOnUsageLimit` 환경설정의 설계안
- [Pi 내장 기능 전환 계획](../pi-builtin-migration-plan.md): 도구 검색과 MCP를 Pi 내장 기능으로 옮기기 위한 조사와 계획
