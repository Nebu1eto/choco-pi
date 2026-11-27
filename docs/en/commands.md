# Common commands

[한국어](../ko/commands.md)

These are the slash commands you will use most often. Aliases are in parentheses.

| Command                                           | Purpose                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `/status`                                         | Show session, cost, model, context, MCP, and environment state        |
| `/preferences` (`/pref`)                          | Configure the agent, advisor, language, style, persona, and interface |
| `/context all`                                    | Inspect the prompt, tools, MCP, agents, files, skills, and token use  |
| `/usage` (`/quota`)                               | Show usage and reset information for supported providers              |
| `/stats`                                          | Show token usage, cost, breakdowns by feature and model, and speed    |
| `/effort [level]`, `/fast [on\|off\|status]`      | Set the reasoning effort or the session's Fast mode preference        |
| `/check`                                          | Validate the installed profile and its required resources             |
| `/task-inline <task>`                             | Implement one ordinary change directly                                |
| `/task <task>`                                    | Run independent implementation units in parallel                      |
| `/task-dynamic <task>`                            | Opt in to nested work that is decomposed as it runs                   |
| `/task-hotfix <task>`                             | Apply an urgent production fix directly                               |
| `/review [target]`                                | Have a fresh agent run an adversarial review that only reports        |
| `/review-assist [target]`                         | Review the changes of a session, branch, or pull request yourself     |
| `/diff [subcommand]`                              | Toggle or control the live diff pane beside the transcript            |
| `/review-continue`, `/verify-continue`            | Show or raise a work task's cap on review or verification rounds      |
| `/commit [guidance]`                              | Create a verified local commit without pushing                        |
| `/checkpoint`                                     | Rewind, roll back, or fork at a turn, or fork the current state       |
| `/rewind`, `/fork`                                | Only rewind, or only fork from a turn or the current state            |
| `/agents`, `/btw`                                 | Manage agents, or open a read-only side conversation                  |
| `/shells`                                         | List, read, or stop managed shells                                    |
| `/sessions`, `/session-new`                       | List project conversations, or start an independent one               |
| `/session-read`, `/session-send`, `/session-wait` | Read, steer, or wait on another conversation                          |
| `/goal [objective]`                               | Create, inspect, or manage a persistent goal                          |
| `/hooks`, `/add-dir`                              | Browse hooks, or add a working directory                              |
| `/mcp`                                            | Inspect MCP servers, sign in or out, reconnect, or change exposure    |
| `/search`                                         | Browse stored search results (configure search priority in `/pref`)   |
| `/lsp`                                            | Turn LSP use on or off, or show its state                             |
| `/codex`, `/computer-use`                         | Configure the Codex adapter, or show the computer-use configuration   |
| `/apex-refresh`                                   | Refresh the Callstack Apex models                                     |
| `/clear`, `/exit`, `/delete`                      | Start a fresh session, quit, or permanently delete this session       |
