# Inthes

**Where papers meet ideas.**

Inthes 是 Zotero 侧栏中的论文阅读与文献库分析助手。你可以围绕正在阅读的论文提问，也可以选择一个文献分类，比较多篇研究、追踪证据，并将结果整理为 Zotero 笔记。

## 功能

- **阅读论文**：对当前文献或最多 5 篇选中文献提问、总结和比较。回答中的原文引用可预览，并可跳转到 PDF 对应页。
- **分析文献库**：选择分类或子分类，在最多 200 篇文献中问答、逐篇分析和综合比较。文献与进度视图展示每篇的处理状态，任务可以暂停和继续。
- **阅读复杂内容**：使用 Zotero 的本地文本，或按需启用 MinerU，以阅读论文中的表格、公式和图片。
- **检索并导入论文**：使用具备联网能力的连接查找文献，并将核验后的条目导入指定 Zotero 分类；导入时检查重复条目。
- **整理研究记录**：保存单轮问答或完整会话为 Zotero 笔记，管理和归档历史会话，导出 Markdown、JSON、PDF 或 Word 文档。笔记支持回答中的图片、表格和公式。
- **选择模型服务**：连接 ChatGPT、Antigravity 账户，或使用 DeepSeek、OpenRouter、OpenAI、Anthropic、Gemini、Qwen、Kimi、GLM、MiniMax 等 API。

## 安装

1. 从 [GitHub Releases](https://github.com/zxyl1003/Inthes/releases) 下载最新的 `inthes-<版本>.xpi`。
2. 在 Zotero 10 中打开「工具 → 插件」，从文件安装 XPI。
3. 打开 Inthes 侧栏，在「连接与偏好」中添加模型连接。
4. 选中论文或打开 PDF，即可在「阅读」页提问；需要分析一个分类时，切换到「文献库」页。

详细操作见[使用指南](docs/USER_GUIDE.md)，各连接的设置见[模型连接](docs/CONNECTIONS.md)。

## 来源与数据

Inthes 在回答中标出使用的文献来源。点击本地引用可回到 Zotero 中的 PDF；联网来源以网页链接呈现。研究结论仍应结合原文核对。

对话、设置与解析缓存保存在本机。使用模型时，提问和相关文献内容会发送给你选择的模型服务；启用 MinerU 时，待解析的 PDF 会发送给 MinerU。模型与解析服务的费用由相应服务商收取。

## 文档与项目

- [使用指南](docs/USER_GUIDE.md)
- [模型连接](docs/CONNECTIONS.md)
- [开发与发布](docs/DEVELOPMENT.md)
- [更新记录](CHANGELOG.md)
- [反馈问题](https://github.com/zxyl1003/Inthes/issues)

本项目采用 [CC BY-NC 4.0 许可证](LICENSE)。
