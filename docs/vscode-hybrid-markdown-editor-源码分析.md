# VS Code 1.131+ 实验性 Hybrid Markdown 编辑器源码分析

> 分析基于 microsoft/vscode main 分支（2026-09-02 快照），源码本地副本：`WorkBuddy 工作空间/vscode-src/`（sparse checkout）

## 一、它到底在哪里、是什么架构

这个"所见即所得 Markdown 编辑器"**不在 VS Code 核心里，而是内置扩展** `markdown-language-features`，以 Custom Editor（webview）形式实现：

```
extensions/markdown-language-features/
├── package.json                      # contributes.customEditors 注册两个编辑器:
│                                     #   vscode.markdown.preview.editor (Markdown Preview)
│                                     #   vscode.markdown.editor        (Markdown Editor, 新的 hybrid)
├── markdown-editor-src/              # ★ webview 前端（总共 <1000 行，非常薄）
│   ├── editor.ts            (560行)  # webview 入口，Editor 类：消息协议 + 视图创建
│   ├── syntaxHighlighter.ts (216行)  # 语法高亮（走 worker/宿主）
│   ├── linkPresentationProvider.ts (179行) # 链接富展示
│   └── markdownEditor.css   (22行)
└── src/preview/
    └── markdownEditorProvider.ts (971行) # 宿主侧：文档同步、评论、undo/redo、代码块编辑器
```

**关键点：真正的编辑引擎是独立 npm 包** `@vscode/markdown-editor@^0.0.2-84`（微软官方发布、MIT）。
editor.ts 只是"胶水层"：`EditorModel / EditorView / EditorController / CommentsModel / CommentModeController` 全部来自这个包，自带主题 CSS（`themes/vscode-default.css`）、KaTeX、Mermaid 渲染。

### 通信协议（webview ↔ 宿主，postMessage，带 messageSecret 防伪）

| webview → 宿主 | 宿主 → webview |
|---|---|
| `edit`（diff 格式的文本编辑）、`ready`、`openLink`、`addComment`/`deleteComment`、`setReadonly`、`history`(undo/redo 转发给 TextDocument)、`resolveCodeBlockEditor` | `update`（权威文本）、`comments`、`gutterMarkers`、`command`（执行编辑命令）、`codeBlockEditorProviders`、`resolvedCodeBlockEditor` |

历史（undo/redo）故意不本地记账，直接转发给底层 TextDocument 的 undo 栈；滚动/光标用 webview `getState/setState` 持久化。

## 二、为什么现在还没有第三方"优化插件"

1. **webview 是沙箱**：不像 Markdown 预览有 `markdown.previewStyles/previewScripts` 注入点，新编辑器的 webview 没有 CSS/JS 注入口，第三方扩展无法注入任何东西。
2. 唯一公开的挂载点：**`markdown.codeBlockEditorProviders`**（还有 legacy 的 `markdown.codeBlockEditors`）contribution point —— 只能针对 fenced code block 的特定语言提供 iframe 编辑器/渲染器（static HTML 或 exportApi 动态解析），不能改整体编辑体验。
3. 编辑器 `priority` 目前是 `textEditor: "option"`（不是 default），只在 Agents 窗口经 `workbench.editor.markdownDefaultEditorInAgentsWindow` 设为默认，还是实验特性，生态观望中。

## 三、三条改造路线评估

### 路线 A：正经写"优化插件"（推荐起步）⭐⭐⭐⭐
利用 `markdown.codeBlockEditorProviders`：
```jsonc
"contributes": {
  "markdown.codeBlockEditorProviders": [{
    "id": "my-runner",
    "selector": { "language": "python" },        // 或 languagePrefix
    "source": { "kind": "static", "entrypoint": "./editor.html" },  // 或 exportApi
    "contentType": "text", "initialHeight": 200
  }]
}
```
- 优点：API 正式、随官方升级自动兼容、发布到市场即可用。
- 局限：只作用于代码块级别（如做可运行的 p5.js / 乐谱 / 表格可视化编辑器）。

### 路线 B：用 `@vscode/markdown-editor` 自造编辑器（真正的"所见即所得增强"）⭐⭐⭐⭐⭐
直接 `npm install @vscode/markdown-editor`，照抄 editor.ts 写自己的 Custom Editor 扩展：
- 引擎完全公开：AST 可遍历、可加语法、可换主题 CSS、可加大纲/图片粘贴/公式工具条等。
- `editor.ts` 就是现成模板，去掉 Agents 窗口专属逻辑后核心胶水 <400 行。
- 风险：包还在 0.0.x，API 未冻结，上游更新可能 breaking；与官方编辑器并存需自己的 viewType。

### 路线 C：魔改官方源码 ⭐⭐
- 内置扩展无法被第三方扩展覆盖，只能 fork 整个 vscode 仓库改 `markdown-editor-src/` 重新构建 VS Code（开源构建流程成熟，但要维护自己的构建）。
- 更现实的 C 变体：fork 后提 PR 给 microsoft/vscode —— 但 1.132 刚加了 Markdown diff，迭代很快，PR 容易冲突。

## 四、结论

**好改。** 这个功能架构上故意做成了"薄 webview 胶水 + 公开 npm 引擎"，最快见效的路径是路线 B：装 `@vscode/markdown-editor`、以 editor.ts 为模板写一个自己的 Custom Editor 扩展，半天可以跑起来一个最小原型；想进市场生态就再叠加路线 A 的代码块 provider。真正的拦路虎只有一条：引擎 0.0.x 版本 API 未稳定，要接受跟版本的成本。
