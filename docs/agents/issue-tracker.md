# 议题跟踪：本地 Markdown

本项目的议题和规格说明以 Markdown 文件形式存放在 `.scratch/` 中。

## 约定

- 每个功能使用一个目录：`.scratch/<feature-slug>/`
- 规格说明文件为 `.scratch/<feature-slug>/spec.md`
- 实现议题按每个工单一个文件存放：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，禁止合并为单一工单文件
- 每个议题文件顶部附近使用 `Status:` 行记录 triage 状态，具体角色字符串见 `triage-labels.md`
- 评论和对话历史追加在文件末尾的 `## Comments` 标题下

## 技能要求“发布到议题跟踪器”时

在 `.scratch/<feature-slug>/` 下创建新文件；如果目录不存在则一并创建。

## 技能要求“获取相关工单”时

读取引用路径对应的文件。用户通常会直接提供路径或议题编号。

## Wayfinder 导航约定

Wayfinder 使用一个“地图”文件和每个工单对应的子文件：

- 地图：`.scratch/<effort>/map.md`，正文包含 Notes、Decisions-so-far、Fog
- 子工单：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号；使用 `Type:` 行记录工单类型（`research`、`prototype`、`grilling`、`task`），使用 `Status:` 行记录 `claimed` 或 `resolved`
- 阻塞关系：在文件顶部附近使用 `Blocked by: NN, NN` 行；列出的文件全部为 `resolved` 后，该工单才解除阻塞
- 前沿工单：扫描 `issues/`，按编号优先选择已开放、未阻塞且未认领的工单
- 认领：设置 `Status: claimed` 并保存后再开始工作
- 解决：在 `## Answer` 标题下追加答案，将状态设置为 `Status: resolved`，然后把摘要和链接追加到地图的 Decisions-so-far

## 文件路径说明

当技能要求发布或读取议题时，均使用上述 `.scratch/` 路径约定。
