# Issue tracker：本地 Markdown

本仓库的议题（issue）与规格（spec）以 markdown 文件形式存放在 `.scratch/` 下。

## 约定

- 一个特性一个目录：`.scratch/<feature-slug>/`
- 规格文件：`.scratch/<feature-slug>/spec.md`
- 实现议题每票一个文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起编号，绝不合并为单文件
- Triage 状态记录在议题文件顶部的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 评论与对话历史追加到文件底部的 `## Comments` 标题下

## 当 skill 说"发布到 issue tracker"

在 `.scratch/<feature-slug>/` 下创建新文件（目录不存在则先创建）。

## 当 skill 说"获取相关 ticket"

读取所引用路径的文件；用户通常会直接给出路径或编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个文件，每个 ticket 对应一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文含问题。`Type:` 行记录类型（research/prototype/grilling/task）；`Status:` 行记录 claimed/resolved
- **Blocking**：文件顶部 `Blocked by: NN, NN` 行；所列文件全部 resolved 即解除阻塞
- **Frontier**：扫描 `.scratch/<effort>/issues/` 中开放、无阻塞、未认领的文件，编号小者优先
- **Claim**：动手前先写入 `Status: claimed` 保存
- **Resolve**：在 `## Answer` 标题下追加答案，置 `Status: resolved`，并将上下文指针（要点 + 链接）追加到 map 的 Decisions-so-far
