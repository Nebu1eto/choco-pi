# 기능

[English](../en/features.md)

이 페이지는 choco-pi가 Pi에 더하는 기능을 영역별로 설명합니다. 주요 슬래시 명령은 [주요 명령](commands.md)에 표 하나로 정리되어 있습니다.

## 운용 규칙과 작업 절차

- [`profile/SYSTEM.md`](../../profile/SYSTEM.md)는 작업 범위, 권한, 근거, 완료 기준에 관한 공통 규칙을 정합니다. 여기에 [`profile/model-guidance.md`](../../profile/model-guidance.md)가 모델별 지침을, [`profile/writing-policy.md`](../../profile/writing-policy.md)가 응답 문장 규칙을 더합니다.
- 에이전트는 루트의 `AGENTS.md`를 불러오고, 하위 디렉터리에서 작업할 때는 그곳에서 찾은 경로별 `AGENTS.md` 파일도 함께 불러옵니다.
- 작업 절차 스킬은 직접 구현(`task-inline`), 병렬 구현 단위(`task`), 동적 분해 작업(`task-dynamic`), 긴급 수정(`task-hotfix`), 적대적 리뷰(`review`), 리뷰 주장 재현(`verify`), TLA+ 모델 검사(`formal-verify`), 환경 점검(`check`), 서명된 로컬 커밋(`commit`), 문서 작성(`effective-writing`)을 다룹니다. 구현 절차는 체크아웃을 수정하는 동안 lease를 잡아 두고, 인수 기준에 맞춰 검증하며, 푸시는 하지 않습니다. 리뷰와 근거 확인에 쓰는 스킬은 [리뷰와 검증](#리뷰와-검증)에서 설명합니다.
- `/preferences`에서 응답 언어, 응답 스타일, 에이전트 페르소나를 설정합니다. 응답 스타일은 `balanced`(기본값. 최종 답은 짧게 하고, 긴 작업 중에는 몇 문장으로 진행 상황을 알림), `concise`(모든 진행 보고를 한 줄로 줄임), `explanatory` 중에서 고릅니다. 페르소나는 `unset`, `critical`, `pessimistic`(기본값) 중 하나이며, 에이전트가 자기 주장과 계획을 얼마나 엄격하게 검증할지 정합니다.
- `/preferences` → Agent → On usage limit(`agentOnUsageLimit`)은 현재 공급자가 사용량 한도가 다 찼다고 알려 올 때 어떻게 할지 정합니다.
  - `none`(기본값): 실행을 오류 상태로 끝냅니다.
  - `fallback`: [`profile/model-fallbacks.json`](../../profile/model-fallbacks.json)에서 다른 공급자의 비슷한 등급 모델을 골라 바꾼 뒤 작업을 이어 갑니다. 같은 등급에 쓸 수 있는 후보가 없으면 최후 수단으로 `xai/grok-4.7`, `synthetic/hf:moonshotai/Kimi-K3.1-Pro`(Kimi K3보다 우선), `synthetic/hf:moonshotai/Kimi-K3` 순으로 넘어갑니다.
  - `auto-resume`: 한도가 초기화될 때까지 기다렸다가 작업을 이어 갑니다.

  서브 에이전트는 한도에 걸리면 예상 초기화 시각과 범위 안에서 쓸 수 있는 추천 모델을 부모 에이전트에 보고합니다. `auto-resume`일 때는 대기 상태로 있다가 초기화 뒤 다시 실행됩니다. `/goal`이 active나 paused 상태이면 복구는 goal 런타임이 대신 맡습니다.

## 에이전트와 오케스트레이션

- [`profile/agents`](../../profile/agents)에 정의된 전문 역할(`advisor`, `explore`, `general`, `handoff`, `implementer`, `planner`, `reviewer`, `verifier`)은 백그라운드 서브 에이전트로 실행됩니다. 예약 실행도 지원하고, 격리된 Git worktree에서 실행하거나 `workflow_run`으로 의존 관계 순서에 맞춘 workflow로 묶어 실행할 수도 있습니다. 관리는 `/agents`에서 합니다.
- `max_turns` 제한은 재개한 실행에도 적용됩니다. 토큰 예산이 정해진 에이전트는 예산이 바닥나 중단되기 전에 작업을 마무리하라는 지시를 받습니다.
- fleet 패널에는 실행 중인 서브 에이전트와 관리되는 백그라운드 셸이 함께 표시됩니다. 행을 클릭하면 화살표 키로 고른 것처럼 선택되고, 셸 행을 더블 클릭하면 그 셸의 출력이 열립니다. 서브 에이전트를 선택하면 그 대화 기록으로 포커스가 옮겨 가며, 텍스트, 도구 진행 상황, 사용자 정의 메시지가 실시간으로 표시됩니다. 여기서 thinking 표시를 바꾸면 포커스된 화면에만 적용됩니다. 셸은 셸을 시작한 세션에 속하며 `shell_start`와 `/shells`로 관리합니다. 셸을 소유한 세션이 비활성일 때 셸이 끝나면, 완료 알림은 그 세션이 다시 활성화될 때 전달됩니다.
- `/btw`는 메인 대화와 나란히 진행되는 읽기 전용 곁대화를 엽니다. 곁대화는 메인 세션과 같은 모델과 thinking 수준을 씁니다. 내부 `side-chat` 에이전트로 실행되며 이름은 `side-chat`, `side-chat-2`처럼 차례로 붙고, 다른 호출자는 이 역할을 실행할 수 없습니다.
- `advisor` 도구를 쓰면 루트 에이전트와 서브 에이전트가 미리 설정한 더 강한 모델에게 두 번째 의견을 구할 수 있습니다. 호출하면 답이 올 때까지 기다리며, advisor는 현재 세션에서 제한된 분량만 발췌해 받은 새 읽기 전용 컨텍스트에서 답합니다. 기본으로는 꺼져 있고, advisor 모델이 세션 모델과 같으면 호출을 건너뜁니다. 설정은 `/preferences`의 Agent → Advisor Agent나 [`advisor.json`](configuration.md#advisor-설정)에서 합니다.

## 리뷰와 검증

- `/review [target]`은 에이전트에게 변경을 적대적으로 리뷰하게 합니다. `review` 스킬이 리뷰 대상(기본값은 `HEAD` 대비 staged·unstaged 변경)을 바꿀 수 없는 번들로 고정한 뒤, 새로 띄운 읽기 전용 `reviewer` 하나에게 넘깁니다. [`profile/review-policy.md`](../../profile/review-policy.md)에 따라 모든 리뷰는 세 가지 관점을 다룹니다. 호출자, 테스트, 문서가 아직 기대고 있는 동작이 바뀌지 않았는지, 규약이 바뀐 곳을 호출하는 코드가 빠짐없이 확인되었는지, 그리고 앞선 점검이 놓친 것만 찾는 마지막 점검입니다. 리뷰어는 finding과 candidate를 따로 보고합니다. candidate는 위반으로 이어지는 추적 경로에 빠졌거나 가정으로 메운 고리가 있는 우려 사항입니다. 위반까지 경로를 끝까지 추적했다면 리뷰어가 아무것도 실행하지 않았더라도 finding입니다. 둘 다 에이전트나 verifier가 확인하기 전까지는 참고 의견일 뿐입니다.
- 리뷰어와 verifier는 응답 끝에 구조화된 블록(`choco-pi-review` 또는 `choco-pi-verdict`)을 붙입니다. work task로 실행하면 subagents 패키지가 이 블록을 기록하고 결과에 `Verdict record:` 줄을 덧붙입니다. 블록이 없거나 형식이 잘못된 리뷰는 기록되지 않으며, 문제없음으로 보고되는 일도 없습니다. 리뷰와 검증 라운드 수는 work task마다 상한이 있으며, `/review-continue <work_task>`와 `/verify-continue <work_task>`로 더 허용할 수 있습니다.
- 터미널에서는 파싱에 성공한 블록을 결과 카드, 완료 알림, 대화 기록 Markdown에 짧은 요약(판정, 개수, finding이나 claim마다 한 줄)으로 보여 주며, 카드를 펼치면 원본 블록을 볼 수 있습니다. 파싱에 실패한 블록은 파서가 밝힌 이유 한 줄 뒤에 원문 그대로 보여 줍니다. 바뀌는 것은 화면 표시뿐이며, 저장된 메시지, 모델이 받는 내용, 기록된 판정은 그대로입니다.
- `verifier` 역할은 `verify` 스킬에 따라, 지정된 체크아웃 스냅숏에서 리뷰어의 주장을 재현해 봅니다. scratch 공간에만 쓰고 코드는 고치지 않으며, `UNPROVEN` 결과는 있는 그대로 보고합니다. 재현하지 못했다고 해서 주장이 틀렸다는 뜻은 아닙니다. 작은 변경에는 verifier를 붙이지 않습니다.
- `formal-verify` 스킬은 에이전트가 작업하는 프로젝트에서 실행 순서와 상태에 관한 약속을 검사합니다. 실행은 정확히 한 번 끝나야 한다거나, lease가 동시에 두 번 잡혀서는 안 된다는 약속이 그 예입니다. 에이전트가 작은 TLA+ 모델을 작성해 스킬의 래퍼로 TLC 검사를 돌리고, 모델을 일부러 망가뜨렸을 때 규칙마다 실패하는 것을 보여 줍니다. 검사를 통과했다는 것은 정해진 범위 안에서 모델이 맞다는 뜻이지, 코드가 맞다는 뜻은 아닙니다. 모델이 다루는 코드가 바뀌면 drift 검사가 알려 줍니다. 모델로는 어떤 언어의 코드든 기술할 수 있지만, drift 검사가 심벌 단위로 해시하는 언어는 TypeScript와 JavaScript뿐이고 나머지는 파일 전체를 해시합니다. TLC를 쓰려면 Java 11 이상이 있어야 하고 `tlc-setup.ts`를 한 번 실행해야 합니다. 이 스크립트가 고정 버전의 `tla2tools.jar`를 `${XDG_CACHE_HOME:-~/.cache}/choco-pi/formal`에 내려받습니다. 자세한 내용은 [스킬 문서](../../profile/skills/formal-verify/SKILL.md)를 보세요. [`formal/tla/subagent-run`](../../formal/tla/subagent-run)은 이 저장소의 서브 에이전트 실행 생명주기를 모델링한 예시입니다.
- `/diff`는 대화 기록 옆에 패널을 띄워 변경된 파일과 diff를 보여 주고, 에이전트가 작업하는 동안 계속 새로 고칩니다.
  - **비교 기준.** 기본으로는 세션이 시작된 뒤의 변경을 보여 줍니다. 세션의 첫 파일 체크포인트와 현재 작업 트리를 비교하므로, 그사이 커밋한 변경도 포함됩니다. `/diff source uncommitted`는 `HEAD`와 작업 트리를, `/diff source turn [<n>]`은 특정 턴의 체크포인트와 작업 트리를 비교합니다. `/diff source branch [<base>]`는 브랜치와의 merge base부터 비교하며, 브랜치를 지정하지 않으면 원격의 기본 브랜치, 없으면 `main`, 그것도 없으면 `master`를 씁니다. 고른 비교 기준은 패널을 닫을 때까지 유지되고, `/diff source session`으로 기본값에 돌아갑니다. `/diff` 뒤에서 자동 완성을 쓰면 하위 명령 목록이 나옵니다.
  - **입력창으로 보내기.** 패널에서는 파일, hunk, 고른 줄의 참조를 입력창에 넣을 수 있습니다. `c`로 hunk마다 메모를 남겨 두었다가 `a`로 한꺼번에 질문하면, 메모가 메시지 하나로 묶여 입력창에 들어가고 패널에서는 지워집니다. 메모가 없을 때 `a`를 누르면 커서가 있는 파일, hunk, 줄의 참조가 들어갑니다. 리뷰어와 verifier가 기록한 finding을 차례로 살펴볼 수 있고, `/review` 지시문을 입력창에 넣을 수도 있습니다(`/diff review`). 어느 경우든 Enter를 누르기 전에는 아무것도 전송되지 않습니다.
  - **민감한 파일**은 이름만 보이고, 그 파일에서 `v`를 눌러야 내용이 나타납니다. 이 선택은 저장되지 않으므로 패널을 다시 열면 다시 숨겨집니다.
  - **이동.** Ctrl+Alt+P로 패널을 열고 닫고, Ctrl+Alt+F로 패널 안팎으로 포커스를 옮깁니다. 패널에서 `?`를 누르면 키 목록이 나옵니다. 패널 안에서 `j`/`k`는 파일 사이를, ↑/↓는 펼친 파일의 줄 사이를 이동합니다. Shift+↑/↓나 마우스 드래그로 여러 줄을 고르고, 클릭하면 그 줄이나 hunk에 커서가 놓이며, 파일 행을 클릭하면 그 파일이 펼쳐지거나 접힙니다.
  - **복사.** macOS에서는 Cmd+C(그 밖의 OS에서는 Ctrl+C)로 고른 줄을 코드 그대로 복사하며, 커서가 hunk 헤더에 있으면 hunk 전체를 diff 형식으로 복사합니다. Cmd+C는 터미널이 이 키를 Pi에 넘겨줄 때만 동작합니다. 패널 안과 리뷰 화면의 diff에서는 마우스로 diff 줄을 고르므로, 마우스로 선택하면 바로 복사되는 Pi 기본 기능은 동작하지 않습니다.
  - **한 턴씩 보기.** ←와 →는 한 턴의 변경만 따로 보여 줍니다. ←를 누르면 가장 최근 턴부터 한 턴씩 거슬러 올라가고, →를 누르면 다음 턴으로 가며, 가장 최근 턴에서 한 번 더 누르면 세션 전체 변경으로 돌아옵니다. 한 턴의 변경은 그 턴의 파일 체크포인트부터 다음 체크포인트까지(가장 최근 턴은 현재 작업 트리까지)입니다. 그래서 두 프롬프트 사이에 직접 고친 내용은 앞 턴에 들어가고, 파일이 하나도 바뀌지 않은 상태에서 시작한 프롬프트는 앞 턴과 함께 표시됩니다.
  - **포커스와 입력창.** 입력창의 커서가 글 끝에 있고 선택한 부분이 없으면 Shift+→로 열려 있는 패널에 포커스를 옮깁니다. 그 밖의 경우에는 Shift+→가 입력창의 선택 범위를 넓힙니다. Tab, Esc, `q`, Shift+←를 누르거나 패널 옆 또는 입력창을 클릭하면 포커스가 입력창으로 돌아오며, 입력창의 글자를 클릭하면 커서도 그 글자 위치로 옮겨집니다. 입력창에서 글자를 드래그하거나 Shift와 방향키를 누르면 그 범위가 선택됩니다. 선택한 상태에서 Backspace나 Delete를 누르면 한 번에 지워지고, 입력하거나 붙여 넣으면 선택한 부분이 바뀝니다. Ctrl+C나 Ctrl+X는 선택을 유지한 채 복사하며, 터미널이 Cmd+C를 Pi에 넘겨주면 Cmd+C도 같은 일을 합니다. 선택한 부분이 없으면 이 키들은 원래대로 동작합니다. Esc를 누르면 선택이 풀립니다.
  - **좁은 터미널과 Zed.** 패널을 쓰려면 전체 화면 TUI와 너비 65열 이상인 터미널이 필요합니다. 조건이 맞지 않으면 `/diff`는 변경 목록을 출력합니다. Zed에서는 패널 대신 크기를 제한한 네이티브 diff를 보내며, diff마다 앞에 파일 이름과 상태를 붙이고 민감한 파일은 이름만 보여 줍니다. 세션에서 바뀐 파일은 아직 없지만 작업 트리에 변경이 있으면, `/diff source uncommitted`로 그 변경을 볼 수 있다고 알려 줍니다([자세히](../zed-command-parity.md#diff-in-zed)).
- `/review-assist [target]`은 사용자가 직접 변경을 검토하는 화면이며, 모델 컨텍스트에는 아무것도 추가하지 않습니다.
  - **검토 대상.** 현재 세션이나 그중 한 턴, 브랜치 범위, 커밋하지 않은 변경, 저장된 리뷰, GitHub 풀 리퀘스트를 검토할 수 있습니다. 코멘트를 달고, 승인하거나 거절하고, 리뷰를 풀 리퀘스트에 제출할 수 있습니다. `session`은 `/diff`와 같은 파일을 세션의 첫 체크포인트부터 보여 주고, `session turn <n>`의 턴 번호는 체크포인트가 있는 턴만 1부터 셉니다.
  - **키.** 이 화면은 `/diff` 패널의 뷰를 전체 화면으로 띄운 것입니다. 두 화면에 공통된 기능은 패널과 같은 키를 씁니다. hunk 이동은 `n`/`N` 또는 `[`/`]`, 접기는 Enter나 Space이고, `g`/`G`, `r`, `f`/`F`, `v`, `?`도 같습니다. 리뷰 전용 기능에는 `j`/`k`나 ↑/↓로 움직이는 줄 커서를 씁니다. Shift+↑/↓나 마우스 드래그로 여러 줄을 고르고, 클릭으로 줄에 커서를 놓거나 파일을 펼치고 접습니다. Cmd+C(macOS가 아니면 Ctrl+C)는 고른 줄을 코드 그대로 복사하고, 접힌 hunk는 diff로 복사합니다. 나머지 키는 다음과 같습니다. `c` 코멘트 달기, `m` hunk를 검토 완료로 표시, `a` 옆 채팅 열기, `/` 바뀐 줄 검색(`>`/`<`로 다음 결과), `+`/`-` 주변 코드 더 보기·덜 보기, `|` 나란히 보기로 전환, `e`/`E` 편집기 열기, `S` 검토 마치기, `q`나 Esc 저장하고 나가기.
  - **변경 따라가기.** 변경이 작업 트리까지 이어지는 대상이라면 `r`을 누를 때와 옆 채팅의 도구 호출이 끝날 때마다 변경을 다시 읽습니다. `f`/`F`로 리뷰어가 기록한 finding을 차례로 봅니다. 검토 표시와 코멘트는 내용이 바뀌지 않은 hunk에 그대로 남고, 코멘트를 단 뒤 코드가 바뀐 코멘트는 outdated로 표시됩니다.
  - **민감한 파일**은 목록에는 나오지만 내용은 숨겨지며, 그 파일에서 `v`를 눌러야 이 화면에서만 내용이 나타납니다. `.env`, 개인 키, 경로에 `secret`이나 `credential`이 들어간 파일이 여기에 해당합니다.
  - **숨긴 파일과 옆 채팅.** 옆 채팅에는 어떤 파일이 숨겨져 있는지 알려 줍니다. 숨긴 파일에서 `v`를 누르기 전까지는, 인자가 그 파일을 가리키는 옆 채팅의 도구 호출을 모두 거부합니다. 파일 이름은 두 가지 방식으로 대조합니다.
    - 경로로 대조합니다. Pi 파일 도구가 경로를 해석하는 방식보다 넓게 해석해, 앞뒤 공백, `@`, `~`, `file://`, `..`, 끝의 슬래시, 심볼릭 링크와 하드 링크, 유니코드 정규화 형태, 파일 시스템이 대소문자를 구분하지 않을 때의 대소문자 차이까지 고려합니다.
    - 인자 텍스트 어디에서든 경로나 파일 이름을 찾습니다. POSIX 셸, fish, PowerShell, cmd 문법으로 따옴표나 이스케이프를 섞어 쓴 경우와 퍼센트 인코딩한 경우(`cat .e"n"v`, `cat o\'key.txt`, `type .e^nv`)도 찾아냅니다. 그래서 숨긴 파일과 이름이 따옴표나 이스케이프 문자만 다른 별개의 파일도 거부됩니다.

    `write`와 `edit`가 파일에 써 넣는 텍스트는 경로인지만 확인합니다.

  - **이 검사의 한계.** 이 장치는 샌드박스가 아니라 이중 방어입니다. 이름의 모든 문자가 텍스트에 그대로 또는 퍼센트 인코딩으로 나타나면 거부하지만, 문자를 코드값으로 적거나 파일 이름을 쓰지 않고 파일에 접근하는 명령은 막지 못합니다. `cat .e*`나 `cat *` 같은 glob, 중괄호 확장, 변수, `$'\x2e'` 같은 이스케이프, 재귀 검색, 환경 변수 덤프, 미리 써 둔 스크립트가 그런 예입니다. 채팅이 이미 읽은 내용도 막을 수 없습니다.
  - **메시지.** 메시지, 경고, 오류는 리뷰 화면의 메시지 줄에 표시됩니다. 오류는 Pi 알림에도 남으므로 리뷰를 닫은 뒤에도 볼 수 있습니다.
  - **신뢰할 수 없는 텍스트와 큰 변경.** 파일 이름, diff 같은 신뢰할 수 없는 텍스트는 화면에 그리기 전에 터미널 제어 시퀀스를 걸러 냅니다. 큰 변경은 한도 안에서만 읽고, 빠진 파일 수를 알려 줍니다.
  - **저장된 리뷰**는 Pi 에이전트 디렉터리의 `choco-pi/reviews`에 있습니다. 파일을 마지막으로 수정한 지 7일이 지나면, 보내지 않은 코멘트가 있어도 삭제됩니다.
  - **터미널 UI가 아닌 환경**에서는 `/review-assist`가 읽기 전용 요약을 출력합니다. Zed에서는 이 요약이 Markdown이며, 파일마다 변경 내용을 코드 블록 안의 unified diff로 보여 줍니다.

## 세션, 컨텍스트, goal

- 다른 세션에서도 프로젝트 대화의 목록을 보고, 새 대화를 만들고, 내용을 읽고, 지시를 보내고, 끝나기를 기다릴 수 있습니다(`/sessions`, `/session-new`, `/session-read`, `/session-send`, `/session-wait`).
- `/goal`은 여러 턴과 compaction을 거쳐도 유지되는 목표를 정해 둡니다.
- `/checkpoint`는 체크포인트가 있는 턴으로 세션을 되감거나, 파일을 롤백하거나, 그 턴에서 분기합니다. 현재 상태 그대로 분기할 수도 있습니다. `/rewind`는 대화를 되감기만 하고, `/fork`는 이전 턴이나 현재 상태에서 분기만 합니다.
- 컨텍스트 한도는 `/preferences`에서 프리셋 두 개로 정합니다. **Context soft cap**은 Session → Context에, **Auto-compaction point**는 Session → Compaction에 있습니다.
  - soft cap은 쓸 수 있는 컨텍스트의 상한이며 strictest 250K, strict 400K, standard 600K, permissive 800K, unlimited 중에서 고릅니다. 기본값은 permissive입니다.
  - compaction 지점은 compaction을 시작하는 위치이며 strictest 200K, strict 300K, standard 450K, permissive 600K, unlimited 중에서 고릅니다. 기본값은 standard입니다.

  각 프리셋은 모델의 네이티브 컨텍스트 창에 맞춰 조정됩니다. 상한은 네이티브 창을 넘지 않고, compaction 지점은 상한보다 `min(100K, 상한의 15%)`만큼 아래에 놓입니다. 다만 이 간격은 host reserve + 8K보다 작아지지 않습니다. 네이티브 창이 64K보다 작은 모델에는 Pi 자체 compaction 트리거가 적용됩니다. OpenAI가 모델의 네이티브 compaction 예산을 공개했다면, compaction 지점도 그 예산 안으로 제한됩니다. 설정할 수 있는 것은 이 두 프리셋뿐이며, 여유분(headroom)은 고정되어 있습니다.

- compaction 방식은 `/preferences`의 Session → Compaction에서 정합니다.
  - **OpenAI compaction**은 Codex 전송과 설정된 Responses 공급자에서 OpenAI 원격 compaction을 씁니다. 이 프로필의 [`profile/choco-pi-codex.json`](../../profile/choco-pi-codex.json)은 이 값을 server-side로 설정합니다.
  - **Anthropic compaction**의 기본값은 server-side입니다. Anthropic on-demand compaction은 `api.anthropic.com`에 OAuth로 접속했을 때, Fable 5+, Mythos 5+와 Preview, Opus 4.6+, Sonnet 4.6+, Haiku 5.5+에서만 씁니다.
  - **xAI compaction**의 기본값도 server-side이며, `api.x.ai`의 `grok-*` 모델에서 OAuth나 API 키로 xAI `/responses/compact`를 씁니다. 포그라운드 compaction에만 적용됩니다.

  server-side compaction이 실패하면 choco-pi는 로컬 요약으로 대신하며, 이 요약은 요약하지 않고 남긴 메시지와 대조해 만듭니다. 백그라운드 compaction은 기본으로 켜져 있습니다. 켜져 있으면 텍스트 레인은 항상 실행되고, 네이티브 레인(OpenAI, Anthropic)은 해당 공급자 행이 server-side로 설정되어 있을 때만 실행됩니다.

- 시작 헤더에는 choco-pi 로고, choco-pi와 Pi 버전, 단축키 안내가 나옵니다. Pi의 모델 범위와 불러온 리소스 목록은 `--verbose`로 시작할 때만 보이며, 스킬 충돌 같은 로딩 문제는 이 옵션 없이도 표시됩니다. `quietStartup: true`로 설정하면 헤더도 숨겨집니다.
- 새 세션에는 이름이 자동으로 붙습니다. 이름을 짓는 모델은 `sessionAutoNameModel`로 정하며 기본값은 `openai/gpt-6-luna`입니다. 자동 이름 짓기를 끄려면 `sessionAutoName`을 `false`로 설정하세요.
- 에이전트 턴이 끝날 때마다 choco-pi는 `openai/gpt-6-luna`(실패하면 `anthropic/claude-haiku-5-5`)로 다음 프롬프트를 예측해, 비어 있는 입력창에 흐린 글자로 보여 줍니다. Tab을 누르면 입력창에 채워지고, Enter를 누르기 전에는 전송되지 않습니다. 제안은 꼭 필요할 때만 나옵니다. 에이전트의 마지막 답이 사용자 입력을 기다릴 때만 보이고, 대기 중인 메시지, 실행 중인 서브 에이전트나 백그라운드 셸, 활성 `/goal`처럼 에이전트를 스스로 다시 움직일 요소가 있으면 나오지 않습니다. 사용자가 쓴 프롬프트에도 없고 `agentLanguage`에도 해당하지 않는 문자 체계로 쓴 제안은 버립니다. 턴마다 최근 대화 내용을 담은 작은 요청을 제안 모델에 한 번 보냅니다. 이 기능을 끄려면 `promptSuggestion`을 `false`로 설정하세요.

## 코드 인텔리전스와 Code Mode

- choco-pi-lsp는 LSP 탐색과 진단, lint 연동, ast-grep·tree-sitter 검색과 규칙, 그리고 `symbol_search`, `module_report`, `read_symbol` 같은 시맨틱 도구를 제공합니다. 실행 중에는 `/lsp on|off|status`와 `/lens-*` 명령으로 제어합니다.
- Code Mode의 `exec` 도구는 제한된 JavaScript를 실행해 여러 도구 호출을 한 단계로 묶습니다. notebook 모드에서는 Deno TypeScript 상태가 계속 유지됩니다. choco-pi-codex는 `apply_patch`, `exec_command` 같은 Codex 스타일 도구와 Responses compaction도 제공하며, 설정은 `/codex`로 엽니다.
- 대부분의 도구는 지연 로딩되어, `tool_search`로 찾았을 때만 불러옵니다. 그래서 항상 불러와 두는 도구 목록이 작게 유지됩니다. choco-pi의 `tool_search`는 choco-pi 자체 도구도 찾습니다. Code Mode에서는 불러온 도구를 바꾸지 않고, `exec` 안에서 `tools.<name>`으로 호출할 수 있는 도구를 알려 줍니다. Code Mode가 아니면 찾은 도구를 불러와 다음 호출부터 쓸 수 있게 합니다. Pi 내장 `grep` 도구는 꺼져 있으므로, 에이전트는 `symbol_search`, `module_report`, 필요한 심벌만 골라 읽기, 코드 탐색, AST 검색으로 소스를 찾습니다.

## 조사와 연동

- 웹 조사에는 대화 모델과 관계없이 지연 로딩되는 `web_search` 도구 하나를 씁니다. 검색 인증 정보와 요금은 대화 공급자가 아니라 선택한 검색 백엔드(OpenAI, Exa, Kagi, Synthetic, Brave, xAI)를 따릅니다. xAI(Grok) 백엔드는 요청이나 라우팅 설정에 `xai`가 지정되어 있고 xAI에 로그인한 상태일 때만 실행되며, 호출할 때마다 요금이 부과됩니다. 공급자, 라우팅, 개인정보 보호, fallback 동작은 [웹 검색](web-search.md)에서 설명합니다.
- `fetch_content`는 페이지 내용을 추출하고, `source_check`는 인용된 구절과 대조해 주장을 검증합니다. `/search`로 저장된 검색 결과를 살펴보고, `/websearch`와 `/curator`로 검색 curator 작업 절차를 실행합니다.
- MCP 서버 설정, 인증, 실행은 Pi 내장 MCP가 맡습니다. 에이전트는 `tool_search`로 MCP 도구를 찾아 `mcp__<server>__<tool>` 이름으로 호출하며, Code Mode에서는 `exec` 안에서 `tools.<name>`으로 호출합니다. 네이티브 Figma 도구는 이와 별개이며, Figma 파일, 컴포넌트, 변수, 렌더링 결과를 읽습니다.
- `agent_browser`는 선택 사항인 `agent-browser` CLI로 웹 페이지를 자동화합니다.
- macOS에서는 computer-use 도구가 네이티브 helper를 거쳐 데스크톱 앱을 확인하고 조작합니다. helper에는 손쉬운 사용(Accessibility)과 화면 기록(Screen Recording) 권한이 필요합니다. 설치, 권한, 설정 방법은 [computer use 설정하기](computer-use.md)를 참고하세요.
- Pi 설정에 등록한 Claude Code 호환 생명주기 훅이 실행됩니다. `/hooks`로 훅을 살펴볼 수 있고, `/add-dir`는 작업 디렉터리를 추가한 뒤 `DirectoryAdded` 훅을 실행합니다.
- Waku는 [RPC 호스트 브리지](../rpc-host-bridge.md)로 설치된 choco-pi 프로필을 식별하고, 저장된 백그라운드 작업 항목과 goal 항목을 읽습니다. `CHOCO_PI_HOST=waku`를 설정하면 RPC 모드에서 브리지 진행 상황을 스트리밍합니다. `/host-bridge`를 쓰면 모델 턴을 시작하지 않고도 스냅숏을 받거나 백그라운드 작업을 제어할 수 있습니다. 사용자 대화 상자는 Pi의 RPC UI로 전달됩니다.

## 모델과 사용량

- `/effort`는 추론 effort를, `/fast`는 세션의 Fast 모드 설정을 바꿉니다. Fast 모드를 켜면 OpenAI 모델에는 priority 서비스 티어로 요청합니다. 단, `openai`로 로그인한 경우에는 적용되지 않습니다([인증](authentication.md) 참고). `xai/grok-4.7`(api.x.ai)에서는 choco-pi가 Grok 4.7의 Fast 변형인 `grok-4.7-build-fast`로 요청하고, 그 턴의 비용을 기본 가격의 두 배로 기록합니다. 다른 Grok 모델에서는 저장된 설정이 적용되지 않으며, `/fast status`가 그 이유를 알려 줍니다. 모델별 기본 thinking 수준은 설정의 `modelThinkingLevels`로 지정합니다.
- choco-pi는 `PI_CACHE_RETENTION`의 기본값을 `long`으로 두어, 지원하는 공급자에 프롬프트 캐시를 1시간 동안 유지해 달라고 요청합니다. 값을 직접 지정하면 그 값이 우선합니다.
- `/usage`(별칭 `/quota`)는 Claude, ChatGPT, Synthetic, Grok의 사용량과 초기화 시각을, `/synthetic:quotas`는 Synthetic 할당량을 보여 줍니다. Grok은 OAuth로 로그인했으면 구독 크레딧 사용 구간을, API 키를 쓰면 상태만 담은 행을 표시합니다. 인증 정보가 없는 공급자는 목록에서 빼고, 흐린 글씨의 `Not signed in: …` 한 줄에 이름만 모아 보여 줍니다.

## 인터페이스

- Nord 테마의 전체 화면 TUI와 상태 표시줄, 그리고 Status·Context·Usage·Preferences·Statistics 탭으로 이루어진 `/status` 대화 상자가 있습니다.
- `/stats`는 Statistics 탭을 엽니다. 이 설치의 세션 로그(`<agent dir>/sessions`와 `sessionDir` 또는 `PI_CODING_AGENT_SESSION_DIR`로 지정한 세션 디렉터리)를 바탕으로 토큰 사용량과 정가 기준 사용 비용을 계산해 보여 주며, fork나 rewind로 생긴 사본은 한 번만 셉니다.
  - **기간과 범위.** 기간은 최근 24시간, 최근 3일·7일·30일, 전체 중 하나이며 `r`로 차례로 바꿉니다. 범위는 모든 프로젝트 또는 현재 프로젝트이며 `p`로 전환합니다.
  - **섹션.** 헤더 아래에서 Preferences처럼 ←/→로 다섯 섹션을 오갑니다. 섹션마다 높이는 25행이고(터미널이 낮으면 더 적음), 그보다 긴 섹션은 스크롤됩니다.
    - **Summary**: 합계와 일별 토큰 차트(최근 24시간이면 시간별)를 섹션 크기에 맞춰 보여 줍니다.
    - **By Model**과 **By Feature**: 들어가는 만큼 상위 행을 보여 줍니다. By Feature는 MCP 서버, code mode, 서브 에이전트, 내장 도구, 브라우저, 웹, compaction을 다룹니다.
    - **Context & Compaction**: 컨텍스트 크기와 함께, compaction 횟수를 방식별·트리거별, 공급자별로 보여 줍니다.
    - **Throughput**: 모델별 tok/s(생성 속도. 첫 토큰 이후의 요청 시간 대비 출력 토큰 수)와 첫 토큰까지 걸린 시간을 보여 주고, 가장 많이 쓴 모델들의 일별 tok/s 차트를 함께 그립니다.
  - **자세히 보기.** Ctrl+O를 누르면 모든 행이 펼쳐져 세부 정보와 공급자별 처리량이 나옵니다.
  - **캐시.** 로그를 훑은 결과와 그로부터 계산한 기간·범위별 값은 5분 동안 재사용합니다. Ctrl+O를 누르거나 섹션을 바꿔도 로그를 다시 읽지 않습니다.
  - **이전 세션.** 이 프로필은 응답마다 첫 토큰까지 걸린 시간을 기록합니다. 그 전에 만든 세션은 tok/s와 첫 토큰까지 걸린 시간을 모두 요청 시간과 출력량으로 추정하고, est로 표시합니다.
- Mermaid 다이어그램을 터미널에 그려 줍니다. 응답에서 상자 그리기 문자나 화살표 문자로 다이어그램을 그리면, 다음 요청에 Mermaid를 쓰라는 숨은 알림이 붙습니다.
- 퍼지 `@` 파일 멘션, 프롬프트 어디에서나 쓸 수 있는 슬래시 명령 자동 완성, 터미널 멀티플렉서 환경까지 고려한 인라인 이미지 표시를 지원합니다.
