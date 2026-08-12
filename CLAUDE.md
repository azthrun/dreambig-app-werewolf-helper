# 狼人杀法官助手

线下狼人杀法官带场工具。纯静态、无框架、无构建步骤、无后端，托管于 GitHub Pages。

**`SPEC.md` 是本项目的权威规格与决策记录。动手前先读它。**

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`azthrun/dreambig-app-werewolf-helper`), accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `SPEC.md` + `CONTEXT.md` + `docs/adr/` at the repo root. Domain terms are Chinese; code identifiers are English. See `docs/agents/domain.md`.
