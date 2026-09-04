# Zed ACP compatibility baseline

| Component                              | Baseline                                               | Evidence or constraint                               |
| -------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Pi CLI                                 | `0.84.4`                                               | Live upstream ACP smoke baseline                     |
| Repository `@earendil-works/pi-*` pins | `0.84.4`                                               | Root dependency pins                                 |
| `@agentclientprotocol/sdk`             | `0.26.0`                                               | Package-local installed version                      |
| ACP `protocolVersion`                  | `1`                                                    | Observed initialize exchange                         |
| Zed                                    | `1.18.0` stable                                        | Installed editor baseline (auto-updated from 1.17.2) |
| Node.js                                | `>=24`; repository currently runs `26`                 | Supported source-execution floor and current runtime |
| Upstream `pi-acp`                      | `0.0.33` at `d1cffc047ab37a096ee70ca39cfc1de463db8d12` | Vendored Git snapshot                                |

## End-to-end evidence

This table is the package-level baseline only. Runtime evidence for the
complete choco-pi and Zed integration, gathered by driving real Zed 1.18.0
against a fresh Pi process, is recorded in
[zed-e2e-evidence.md](./zed-e2e-evidence.md). Setup instructions are in
[zed-setup.md](./zed-setup.md).
