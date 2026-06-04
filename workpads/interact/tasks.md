# interact — tasks

**Objective (exploratory).** Design the interactive layer: jump into a session, and
an **embedded agent** running in the project dir to review & modify a workflow.
Evaluate ACP / remote control / the headless Claude Agent SDK against the file-first
baseline. **Gate:** a decision-ready design matrix + spike plan. Does **not** change
the proven read-only path; any write/drive capability is an explicit user opt-in.

> Exploratory; do not start a committed build here without user sign-off.

## Tasks (draft)

- [ ] **X1 — Capability matrix.** For "jump into session", "see latest output",
  "describe", "review", "modify/run a workflow": what does file-first give, and what
  genuinely requires ACP / remote control / the Agent SDK? (Builds on research R2.)
- [ ] **X2 — Jump-in.** Design how argus hands off to / observes the live session
  (open the session, surface latest output) with the least new mechanism.
- [ ] **X3 — Embedded agent.** Design an agent that runs in the target project dir
  to review and edit `.claude/workflows/*.js`, with a strict permission/opt-in model
  and the privacy stance enforced.
- [ ] **X4 — Spike.** A minimal, reversible spike proving the chosen mechanism, kept
  off the read-only path.

## knowledge
The design matrix + spike findings land in `knowledge.md`.
