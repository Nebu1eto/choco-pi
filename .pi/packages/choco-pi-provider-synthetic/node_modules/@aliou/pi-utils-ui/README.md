![banner](https://assets.aliou.me/pi-extensions/banners/pi-utils-ui.png)

# @aliou/pi-utils-ui

Internal shared TUI abstractions for Pi extensions.

## Modules

- `tools`: reusable tool call/result UI components.
- `widgets`: reusable interactive panels and viewers.
- `primitives`: ANSI-safe layout and rendering helpers.

## Usage

```ts
import {
  ToolHeader,
  ToolBody,
  ToolLlmTelemetryFooter,
  ToolCallListField,
  MarkdownResponseField,
  createRenderCache,
} from "@aliou/pi-utils-ui";
```