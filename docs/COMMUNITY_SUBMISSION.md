# Inthes 社区介绍稿

正式发布时，将下方版本号和图片占位替换为已发布的内容。社区目录目前收录 GitHub 仓库与 Release 信息；先发布 XPI，再提交目录 PR。

## 中文介绍

**Inthes — 文献与灵感之间**

Inthes 是 Zotero 10 的论文阅读侧栏。它把单篇与多篇 PDF 问答、分类级文献库分析、原文引用、任务进度和 Zotero 笔记放在一个工作区。引用可预览原文并跳回 PDF 页码；文献库最多选择 200 篇，按问题选择相关文献或并发逐篇核查，显示每篇处理状态与失败原因。默认使用 Zotero 本地文字提取，也可以选择 MinerU 增强解析表格、公式与图片。

支持 ChatGPT、Antigravity 账户，以及多家模型 API。支持的连接可联网检索论文、通过 DOI／arXiv 信息核验后导入指定 Zotero 分类并检查重复。历史会话可归档、保存为 Zotero 笔记，或导出 Markdown、JSON、PDF、Word。Inthes 不提供模型服务或代付额度；文献内容只会按用户所选功能发往所选模型服务或 MinerU。

- 源码与文档：https://github.com/zxyl1003/Inthes
- 安装包：https://github.com/zxyl1003/Inthes/releases
- 兼容范围：Zotero 10（以 Release 标注的实测版本为准）
- 许可证：CC BY-NC 4.0

> 配图待补：侧栏总览、点击引用后的原文预览、文献库进度三图。社区发帖时再插入实际图片 URL，不要附带私人文献或账户信息。

## English introduction

**Inthes — Where papers meet ideas.**

Inthes is a Zotero 10 sidebar for reading research papers with traceable source citations. It supports Q&A over up to five selected papers, collection-wide questions and per-paper analysis over a selected scope of up to 200 items. Citation markers preview source passages and open the corresponding PDF page. The library view reports parsing and analysis progress for each paper, including failures and resumable work.

It uses Zotero's local text extraction by default and offers optional MinerU parsing for tables, formulas, and figures. Supported model connections can search for papers online, verify bibliographic records through DOI or arXiv, and import them into an existing Zotero collection with duplicate checks. Conversations can be archived, saved as Zotero notes, or exported to Markdown, JSON, PDF, or Word. Users provide their own model access and, when enabled, MinerU token.

Source and documentation: https://github.com/zxyl1003/Inthes

Downloads: https://github.com/zxyl1003/Inthes/releases

License: CC BY-NC 4.0

> Screenshots to add: Zotero sidebar overview, source citation preview, and collection-analysis progress, all using non-private sample papers.

## 社区插件目录 PR

在 [`syt2/zotero-addons-scraper`](https://github.com/syt2/zotero-addons-scraper) 中新增文件 `addons/zxyl1003@Inthes`，内容可写为：

```json
{"tags":["ai","reader"]}
```

仓库 README 限制最多两个标签。提交 PR 时附上公开 GitHub Release 与 XPI 下载链接，说明支持的 Zotero 版本。不要向已停止接收新插件的旧目录提交。
