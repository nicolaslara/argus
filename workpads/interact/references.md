# interact — references

Sources for ACP, the Claude Agent SDK, remote control, and embedded-agent patterns.
Inherits research R2's references; add interact-specific ones with dates.

## Jump-into-session (X2) — verified 2026-06-05

Primary sources (official Claude Code docs, code.claude.com):
- CLI reference — `--resume`/`-r`, `-c`/`--continue`, `--fork-session`, `--session-id`,
  `--from-pr`, `--teleport`, `--ide`, `--remote-control`:
  https://code.claude.com/docs/en/cli-reference (fetched 2026-06-05).
- Manage sessions — resume semantics, transcript path, interleave caveat, branching:
  https://code.claude.com/docs/en/sessions (fetched 2026-06-05).
  Key quote: "Sessions created with `claude -p` or the Agent SDK do not appear in the
  session picker, but you can still resume one by passing its session ID to
  `claude --resume <session-id>`." Transcript path:
  `~/.claude/projects/<project>/<session-id>.jsonl`.
- Launch sessions from links — `claude-cli://open` terminal deep link (params `q`,
  `cwd`, `repo`; NO session-resume param; requires CC v2.1.91+):
  https://code.claude.com/docs/en/deep-links (fetched 2026-06-05).
- VS Code extension — `vscode://anthropic.claude-code/open?session=<id>&prompt=...`
  URI handler (RESUMES a session by ID; session must belong to the open workspace):
  https://code.claude.com/docs/en/vs-code (fetched 2026-06-05).
- Headless / Agent SDK CLI — capture `session_id` from `--output-format json`; resume
  with `--resume "$session_id"`: https://code.claude.com/docs/en/headless (2026-06-05).
- TS Agent SDK `query()` resume options (`resume`, `resumeSessionAt`, `forkSession`,
  `continue`); can resume CLI-created sessions:
  https://code.claude.com/docs/en/agent-sdk/typescript (fetched 2026-06-05).

Local ground-truth inspection (strongest evidence):
- Installed `claude` 2.1.162 (pinned ADAPTER_FORMAT verified vs 2.1.161). `claude --help`
  confirms every flag above. The PATH `claude` is a cmux wrapper that injects
  `--session-id`; stock native binary at `~/.local/bin/claude`.
- Run path → session-id mapping confirmed:
  `~/.claude/projects/<slug>/<sessionId>/workflows/wf_<id>.json` where `<sessionId>` =
  `d2cfe0e6-8f9f-4491-a5ac-b2622cf741bf` is exactly the value `--resume` expects, and a
  sibling top-level `<sessionId>.jsonl` transcript exists. argus's `RunRef.sessionId` is
  resume-ready as-is.
