# 개발

[English](../en/development.md)

이 페이지는 이 저장소가 고정한 툴체인과, 변경을 믿고 받아들이기 전에 실행할 검사를 설명합니다.

## 개발 환경

저장소 루트의 `mise.toml`은 이 체크아웃을 개발하고 테스트할 때 쓰는 도구 버전을 고정합니다. Node.js는 최신 릴리스인 `26.13.1`, pnpm은 `package.json`의 `packageManager`에 적힌 `12.21.0`입니다. 독립 실행형 설치 프로그램은 여전히 Node.js 24 이상을 받아들이고, Node.js가 없으면 `24.22.3`을 내려받습니다. 따라서 코드는 Node.js 24에서도 계속 동작해야 합니다. `mise.lock`에는 arm64·x64 macOS와 Linux용 각 도구의 다운로드 URL과 체크섬이 기록되어 있습니다.

1. [mise](https://mise.jdx.dev/getting-started.html)를 설치하고 셸에서 활성화(`mise activate`)하세요. 그러면 체크아웃 안에서 `node`와 `pnpm`을 실행할 때 고정된 버전이 쓰입니다.
2. 체크아웃에서 `mise install`을 실행하세요. `mise.toml`에는 도구 버전만 들어 있으므로, paranoid 모드를 켜지 않았다면 `mise trust` 없이도 불러옵니다.
3. `pnpm install --frozen-lockfile`로 의존성을 설치하세요.

```sh
mise install
node --version   # v26.13.1
pnpm --version   # 12.21.0
pnpm install --frozen-lockfile
```

mise를 활성화하지 않은 셸에서는 `mise exec -- pnpm test`처럼 명령마다 앞에 `mise exec --`를 붙이세요.

mise를 쓰지 않는다면 Node.js 24 이상을 설치하고 `npm install --global pnpm@12.21.0`을 실행하세요. npm이 사용 중인 플랫폼에 맞는 pnpm 네이티브 바이너리를 설치합니다. 설치한 뒤 `pnpm --version`이 `12.21.0`을 출력하는지 확인하세요.

예전에 고정했던 pnpm `11.11.0`이 `PATH`에 있어도 됩니다. 이 체크아웃 안에서는 그 pnpm이 `packageManager`를 읽어 pnpm `12.21.0`을 자체 저장소에 설치하고, 모든 명령을 그 버전으로 실행합니다. 그래서 `pnpm --version`은 이 체크아웃에서는 `12.21.0`을, 다른 곳에서는 `11.11.0`을 출력합니다. 다만 이렇게 버전이 바뀔 때 `pnpm-lock.yaml` 맨 앞의 pnpm 자체 잠금에 `@pnpm/exe` 항목이 추가됩니다. `tests/workspace-policy.test.ts`가 이 항목을 거부하므로 커밋하기 전에 되돌리세요. `PATH`에 있는 다른 pnpm 버전은 테스트하지 않았습니다. 체크아웃 안에서 `pnpm --version`이 `12.21.0`이 아닌 값을 출력하면 mise나 앞에서 설명한 npm 명령을 쓰세요.

## 개발 검증

이 체크아웃에서 Pi를 시작해도 체크아웃의 프로필은 불러오지 않습니다. 확장, 스킬, 프롬프트가 `.pi/`에서 `profile/`로 옮겨졌기 때문에 Pi가 이곳에서 프로젝트 리소스를 찾지 못합니다. 대신 에이전트 디렉터리를 거쳐 불러와야 합니다. `npm run install:profile`로 `~/.pi/agent`(또는 `--agent-dir <dir>`로 지정한 디렉터리)에 설치하거나, 체크아웃에 들어 있는 실행기를 별도 홈과 함께 쓰세요.

```sh
export CHOCO_PI_HOME="$HOME/.choco-pi-dev"
bin/choco-pi self setup
bin/choco-pi
```

`CHOCO_PI_HOME`을 설정하지 않으면 체크아웃에서 시작한 실행기도 독립 실행형 설치의 홈인 `~/.choco-pi`를 씁니다.

아래 루트 검증 단계를 실행하세요. 에이전트의 도구 호출을 비롯해 Pi가 시작한 셸에서는, `pnpm test` 전에 Pi가 내보내는 세션 환경 변수를 해제해야 합니다. 해제하지 않으면 서브 에이전트 scratch 디렉터리 테스트가 실패합니다.

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
env -u PI_ROOT_SESSION_ID -u PI_SCRATCH_DIR -u PI_SESSION_ID -u PI_CODING_AGENT -u PI_MANAGED_INSTALL_ROOT pnpm test
```

`pnpm typecheck`는 루트와 `tsconfig.json`이 있는 각 패키지를 검사하고, `pnpm test`는 `tests/`와 모든 `packages/*/tests/`를 실행합니다.

`pnpm test`는 Java와 TLC를 띄우는 `tests/formal/`의 formal 검증 테스트는 실행하지 않습니다. 이 테스트까지 실행하려면 `pnpm test --formal`을 쓰세요. `formal/`, `formal-verify` 스킬, 또는 이 테스트 자체를 고쳤을 때만 필요합니다.

런타임이나 TUI를 바꿨다면 새 Pi 프로세스에서도 확인해야 합니다. [검증 안내](../verification-map.md)에 영역별로 실행할 검사, 인증 정보 없이 테스트용 Pi를 띄우는 방법, ACP real-Pi 테스트, formal 모델 검사와 drift 검사가 정리되어 있습니다. 패키지에 따라서는 자체 정책이 검사를 더 요구할 수도 있습니다.
