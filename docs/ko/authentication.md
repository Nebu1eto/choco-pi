# 인증

[English](../en/authentication.md)

Pi 세션에서 `/login`으로 모델 공급자에 로그인합니다.

```text
/login openai
/login anthropic
/login synthetic
/login xai
```

Pi는 인증 정보를 저장소 밖에 보관합니다. 인증 정보가 담긴 파일을 Git에 복사하지 마세요.

Pi에는 Anthropic, OpenAI, xAI 로그인이 내장되어 있습니다. choco-pi는 여기에 Synthetic 공급자를 더하고, [`apex-provider.json`](../../profile/extensions/apex-provider.json) 설정에 따라 Callstack Apex 모델을 찾습니다.

`/login openai`는 Pi의 "Sign in with ChatGPT" 로그인으로, `openai` 공급자(api.openai.com)에 연결됩니다. 예전 `openai-codex` 공급자(chatgpt.com 백엔드)도 원하면 `/login openai-codex`로 로그인해 계속 쓸 수 있습니다. `openai`로 로그인하면 다음 기능이 제한됩니다.

- Fast 모드를 켜도 오류는 나지 않지만 아무 효과가 없으며, 요청에도 포함되지 않습니다.
- Daybreak은 쓸 수 없습니다.
- 서버 측 compaction은 시도하지 않고, 대신 로컬 compaction을 실행합니다.
- 네이티브 `web_run` 검색은 쓸 수 없으므로 웹 검색은 `choco-pi-web-access`를 거칩니다.
- `imagegen`과 `view_image`는 `openai` 인증 정보를 찾아 쓰지만, 둘 다 실제 서비스에서는 아직 검증하지 않았습니다.

Pi에 내장된 `xai` 공급자(Grok)는 `/login xai`로 SuperGrok 또는 X Premium 구독 계정에 로그인하거나, `XAI_API_KEY` 환경 변수에서 키를 읽습니다. Fast 모드는 api.x.ai의 `xai/grok-4.7`에만 적용됩니다.
