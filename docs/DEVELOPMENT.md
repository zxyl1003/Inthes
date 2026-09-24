# 开发与版本管理

## 分支

`main` 保持可构建、可供用户安装的稳定状态。日常改动从 `main` 建立短期分支，通过 PR 与 CI 后合并。

正式版本使用 `vX.Y.Z` 标签和同名 GitHub Release。测试包使用 `vX.Y.Z-beta.N` 并在 GitHub 标记为 pre-release，**不更新稳定版的 `updates.json`**。发布用 XPI 以 Release 资产保存，不提交 `dist/` 到 Git。版本号遵循语义化版本：修复增 PATCH，兼容功能增 MINOR，破坏性变更增 MAJOR；0.x 阶段仍可能调整接口。

## 本地构建

需要 Node.js 24+。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

打包脚本检查 `package.json` 与 `addon/manifest.json` 版本一致，产物位于 `dist/inthes-<版本>.xpi`。GitHub CI 会在 push 和 PR 时执行类型检查、测试和构建；涉及 Zotero 窗口、账号或外部服务的改动还需要实机验证。

## 正式发布

1. 在短期分支完成代码与文档，核对 [使用指南](USER_GUIDE.md)、隐私描述、支持的 Zotero 版本和 `CHANGELOG.md`。只声明实测过的兼容范围；首次公开版本以 Zotero 10 为基线。
2. 同步更新 `package.json`、`package-lock.json` 和 `addon/manifest.json` 中的版本号。检查打包清单的永久 ID `inthes@zxyl1003.github.io` 与更新地址 `https://raw.githubusercontent.com/zxyl1003/Inthes/main/updates.json`。插件 ID 公布后不再变更，否则会被当作另一款插件安装。
3. 运行类型检查、测试、构建，并在 Zotero 实机安装 XPI，检查启动、连接、引用跳转、历史与笔记等与本版改动相关的路径。检查 XPI 和将要推送的 Git 文件，不得包含账号凭据、私人论文、聊天记录或本机缓存。
4. 合并到 `main` 后创建并推送标签 `vX.Y.Z`；在 GitHub 创建同名 Release，上传 `dist/inthes-X.Y.Z.xpi`，填写本版变更和兼容范围。Release 资产必须在公开更新清单指向它之前可下载。
5. 执行 `npm run release:manifest`。脚本读取刚构建的 XPI 并计算 SHA-256，生成根目录 `updates.json`，其中的下载链接指向上述 Release。核对链接可下载后，将 `updates.json` 单独提交并推送到 `main`。
6. 用已安装上一版的 Zotero 检查更新到新版本。首次发布至少验证 XPI 手动安装和 `updates.json`、Release 资产的公开访问；真正的自动更新可在下一次版本递增时验证。

`updates.json` 是稳定版本的更新通道；GitHub 仓库和 Release 必须保持公开。GitHub Release 提供 XPI，`raw.githubusercontent.com` 提供更新清单，无需自建服务器。不要删除或改名已发布版本的 XPI，否则旧清单与下载链接会失效。

## 提交与安全

提交说明使用简短动词，如 `feat: add library task progress`、`fix: restore citation navigation`、`docs: describe installation`。PR 应说明用户可见变化和验证结果。`.env`、Key、缓存、构建包与本机调试数据均不进入 Git；分享 JSON 导出或问题截图前，检查其中的本地路径、论文内容和账户信息。
