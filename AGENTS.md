# Stella

Stella 是一个万用日常型 Agent：Web 页面对话，可读写文件、运行命令协助完成各类任务。
领域术语见 `GLOSSARY.md`，架构决策见 `docs/adr/`。

## Agent skills

### Issue tracker

议题以本地 markdown 文件记录在 `.scratch/<feature-slug>/`。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五角色标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。
