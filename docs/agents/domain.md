# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`SPEC.md`** at the repo root — the authoritative technical specification for this project. Read it before any implementation work; it carries the decision record (辅助型 vs 裁决型、无弹窗定义、结算引擎算法、19 角色数据模型) that the code is meant to realise.
- **`CONTEXT.md`** at the repo root, if it exists.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── SPEC.md                  ← authoritative spec
├── CONTEXT.md               ← glossary (created lazily)
├── docs/
│   ├── adr/
│   └── agents/              ← this directory
└── *.js, *.css, *.html      ← flat, no build step
```

## Use the domain's vocabulary

This project's domain is 狼人杀 (Werewolf/Mafia) as played at Chinese tables. **Domain terms are Chinese and stay Chinese** in issue titles, log strings, UI copy, and comments — 法官, 天亮结算, 同守同救, 殉情, 自爆, 查验, 放逐, 阵营. Code identifiers stay English (`resolveDawn`, `wolfking`, `charmedBySeat`); the mapping between the two is fixed by the role table in `roles.js` and the death-reason enum in SPEC §5.2.

Do not invent synonyms for terms SPEC already fixes. Notably:

- **情侣 is a status, not a role** (SPEC §5.3) — never reintroduce it as a `roleId`.
- **死因** comes from the closed enum in SPEC §5.2, not free text.
- **弹窗** means an overlay/blocking layer (SPEC §8.1) — inline banners and full-screen route changes are not 弹窗.

If the concept you need isn't fixed by SPEC yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag SPEC and ADR conflicts

`SPEC.md` is the decision record. If your output contradicts it, surface the conflict explicitly rather than silently overriding:

> _与 SPEC §5.4 冲突（被毒的猎人默认不可开枪）—— 但值得重新讨论，因为…_

Same rule for `docs/adr/` once ADRs exist.
