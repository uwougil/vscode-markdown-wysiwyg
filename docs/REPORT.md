# Markdown WYSIWYG V1 原型 — 实现与验证报告

> 项目路径：`markdown-wysiwyg-v1/`
> 目标：在本地官方 VS Code（1.131+）上，基于官方实验性 Hybrid Markdown 编辑器的核心引擎
> `@vscode/markdown-editor@0.0.2-84`，自写一个 Custom Editor 扩展，补齐 7 项功能并做正确性 + 性能验证。
> 结论：**六项功能全部落地，29/29 项测试通过，构建 + 严格类型检查 0 错误。**

---

## A. 背景与目标

VS Code 1.131 引入了实验性的「Hybrid Markdown 编辑器」（所见即所得 / WYSIWYG）。经过源码调研
（详见 `vscode-hybrid-markdown-editor-源码分析.md`），确认：

1. 该编辑器是内置扩展 `markdown-language-features` 的 Custom Editor（viewType `vscode.markdown.editor`）。
2. 核心是独立 npm 包 `@vscode/markdown-editor`，webview 胶水层为 `markdown-editor-src/editor.ts`（约 560 行）。
3. 第三方插件**没有** webview 的 CSS/JS 注入口，唯一公开挂载点是 `markdown.codeBlockEditorProviders`。

因此，本项目的策略是：**直接复用引擎 + 抄官方胶水层，自建一个 Custom Editor 扩展**，
在胶水层（而非引擎内部）叠加功能。引擎保持不变，升级引擎即可继承官方修复。

7 项目标功能：

| # | 功能 | 状态 |
|---|------|------|
| 1 | 打字机模式（Typewriter Mode） | ✅ 实现 |
| 2 | 编辑器独立缩放（Editor-independent Zoom） | ✅ 实现 |
| 3 | 增强大纲面板（Outline Panel） | ✅ 实现 |
| 4 | Typora 式连续空行（Continuous Blank Lines） | ✅ 实现 + 专项测试 |
| 5 | 图片粘贴 / 拖拽（Image Paste & Drag） | ✅ 实现 |
| 6 | 内容宽度控制（Content Width） | ✅ 实现 |
| 7 | 性能与正确性基准（Benchmark + Correctness） | ✅ 29/29 通过 |

---

## B. 技术架构

```
┌──────────────────────────── VS Code Host ────────────────────────────┐
│  src/extension.ts            注册 CustomEditorProvider + 命令         │
│  src/markdownEditorProvider.ts  host 侧 postMessage 协议 + 图片落盘   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ postMessage（edit / update / config / saveImage …）
┌───────────────────────────────▼──────────────────────────────────────┐
│  Webview（浏览器 / ESM bundle）                                       │
│  src/webview/editor.ts      胶水层：EditorModel → EditorView →        │
│                              EditorController（复用 @vscode/markdown-  │
│                              editor 引擎，不修改引擎）                │
│  src/webview/editor.css     大纲侧栏 + 布局                           │
└──────────────────────────────────────────────────────────────────────┘
```

关键依赖：`@vscode/markdown-editor@0.0.2-84`（引擎）、`@vscode/observables`（响应式）、
`katex`（行内/块级公式）、`mermaid`（图表）。构建用 esbuild：host 侧 → CJS `dist/extension.js`，
webview 侧 → ESM `dist/webview/editor.js`（含 270+ mermaid 分块）。

---

## C. 六项功能实现要点

### C1. 打字机模式（Typewriter Mode）
- 监听 `model.selection` 变化（`autorun`），读取 `view.caretRect` 与 `overlayContainer` 几何，换算光标在滚动容器中的位置。
- 仅当光标离开视口 **45%–55% 的中心带** 时才滚动，且滚动后 600ms 内尊重用户滚轮（不「抢滚动」）。
- 开关命令 `mdwysiwyg.toggleTypewriter`，默认关。

### C2. 编辑器独立缩放（Editor-independent Zoom）
- 引擎主题通过 `var(--markdown-font-size, 14px)` 读取基准字号，**所有块尺寸 em 相对**。
- 设置 `:root` 的 `--markdown-font-size` 即可整篇联动缩放（标题/列表/表格/代码块一致），
  不影响大纲侧栏，也不影响 VS Code 自身的 `window.zoomLevel`。
- 命令 `zoomIn`/`zoomOut`/`zoomReset`，范围 60–200%，步进 10%，持久化到 `workspaceState`。

### C3. 增强大纲面板（Outline Panel）
- 从 `model.document.get().blocks` 过滤 `kind === 'heading'`，用 `findNodeOffsetById` 取源码偏移。
- 特性：H1–H6 层级缩进、点击跳转（`revealRangeInCenterIfOutsideViewport`）、
  当前小节高亮（最后一个 offset ≤ 光标位置的标题）、标题筛选、折叠（`aside` + `main` 双栏布局）。

### C4. Typora 式连续空行（Continuous Blank Lines）—— 本项目核心修复
**根因**：引擎把「段末回车」建模为 *transient pending paragraph*（临时待定段落）。第一次 Enter
在段末会 arm 一个「待定段落」；第二次 Enter 时引擎提前返回（不产生新空行），只有真正输入文字才会
`materialize`。因此 `A` + Enter + Enter + `B` 永远不会得到 `A\n\n\nB`，连续空行会被「吞掉」。

**修复**（在 capture 阶段拦截，不碰引擎）：
- **Case 1**：上一个 Enter 已 arm 待定段落，再次 Enter → `cancelPendingParagraph()` +
  `applyEdit(StringEdit.replace(pending.replaceRange, '\n' * 3))`，物化真实空行。
- **Case 2**：已在空行 run 中（`blankRun ≥ 2`），继续 Enter → `StringEdit.insert` 追加一个 `\n`。
- 任何非 Enter 按键 / 鼠标点击 → 重置 `blankRun`，空行 run 结束。

**关键**：产出的就是**纯 Markdown 的 `\n`**，无 `<br>`、无私有方言，保存/重开往返保真。

### C5. 图片粘贴 / 拖拽
- 监听 `paste` / `dragover` / `drop`，识别 PNG/JPEG/WebP。
- Webview 侧 FileReader → dataURL → `postMessage('saveImage')`。
- Host 侧 `_saveImage` 解码 base64（用全局 `atob`，避免引入 `@types/node`），
  写入 `<docDir>/assets/image.png`（重名自动 `image-1.png`），返回相对路径，
  webview 在光标处插入 `![](assets/image.png)`。

### C6. 内容宽度控制（Content Width）
- 驱动引擎的 `limitedWidth` observable：`narrow=680px` / `normal=820px` / `wide=1000px` / `full=无上限`。
- 命令 `mdwysiwyg.setWidth` 弹出 QuickPick 选择。

---

## D. 正确性测试（test/run.mjs，Node 无 DOM 头less 跑真引擎）

测试框架直接 `import` 引擎在 Node 里跑，复用与 webview 完全相同的逻辑（`insertSmartEnter`、
`findNodeOffsetById`、`computeTextEdit`、空行修复步骤）。

### D1. 源码往返保真（Round-trip）—— 6/6 通过
6 份语料 `small/medium/large/math/mermaid/outline`，`sourceText.set → get` 逐字节相等。

### D2. 连续空行专项 —— 16/16 通过
| 场景 | 期望 | 结果 |
|------|------|------|
| 段末 `A` + Enter×2 + Enter×3 | `A\n\n\n` → `A\n\n\n\n` | ✅ |
| 段末带尾部换行 `A\n` + Enter | 消费 gap → `A\n\n\n` | ✅ |
| 标题 `# H` + Enter | `# H\n\n\n` | ✅ |
| 分隔线 `---` + Enter | `---\n\n\n` | ✅ |
| 段中 `AB` + Enter（非段末） | 引擎正常 split → `A\n\nB` | ✅ |
| 待定段落输入文字 `B` | materialize → `A\n\nB` | ✅ |
| 空行 run 后输入普通字符 | 正常文本，不多插换行 | ✅ |

### D3. 大纲提取 —— 2/2 通过
H1–H5 层级正确，**含前导空格缩进的标题**（`  ### C`）label 也能正确剥离（正则 `^\s*#{1,6}\s*`）。

### D4. computeTextEdit（webview↔host diff）—— 5/5 通过
insert / delete / replace / append / identical 五种场景的最小编辑区间均正确
（`hello→help` 得 `{start:3, endExclusive:5, text:'p'}`，即把 `lo` 换成 `p`）。

---

## E. 性能基准

同一套语料在 Node 下 `sourceText.set + document.get`（强制完整 parse）的耗时：

| 语料 | bytes | 行数 | blocks | 标题数 | parse 耗时 |
|------|-------|------|--------|--------|-----------|
| large   | 15,847 | 1,281 | 320   | 80     | 27.9 ms |
| math    | 18,393 | 962   | 361   | 121    | 13.2 ms |
| mermaid | 3,186  | 342   | 81    | 41     | 2.4 ms  |
| outline | 43,260 | 4,944 | 2,472 | 2,471  | 55.1 ms |
| small   | 231    | 28    | 9     | 3      | 4.4 ms  |
| medium  | 757    | 74    | 27    | 12     | 5.2 ms  |

**结论**：
- 最重负载（`outline`，2471 个标题、近 5 千行、43KB）完整解析 **约 55ms**，属亚秒级，可接受。
- 常规文档（数 KB～数十 KB）parse 均在 **2–30ms** 区间，配合引擎的增量 parse（未改动 block 复用对象身份），
  编辑时不会整篇重解析。
- 小文件（small/medium）耗时被「每次 parse 的固定 observable 事务开销（约 2–4ms）」主导，非内容本身。

---

## F. 已知限制与风险

1. **运行时验证需人工执行**：Custom Editor 需在 Extension Development Host（F5）里
   右键 `.md` →「打开方式」→「Markdown WYSIWYG V1」实测，headless 无法覆盖 DOM 交互。
2. **图片路径约定**：写入 `<docDir>/assets/`，未处理跨目录引用、删除图片时清理、图片重命名同步等。
3. **待定段落依赖引擎内部行为**：`PendingParagraph` 是非导出接口（运行时 duck-typing 访问），
   引擎升级若改动字段名需同步核对。
4. **mermaid 分块体积**：webview 产物含 270+ mermaid 分块（约数 MB），冷启动首次渲染略慢；可按需裁剪。
5. **键盘配置**：当前用 `vscodeLocalKeyboardProfile` + `vscodeHostKeyboardProfile`，与官方一致，
   但未覆盖所有平台快捷键差异。

---

## G. 结论与后续工作

### 结论
- 六项功能全部在**胶水层**落地，未改动引擎，升级引擎即可继承官方修复。
- 正确性 29/29、构建 + 类型检查 0 错误、性能亚秒级，达成 V1 原型验证目标。

### 后续建议
1. **运行时人工验收**：F5 打开 `.md`，逐项核对六项功能与空行往返。
2. **性能再验证**：在真实 DOM 中对比官方编辑器与本扩展的渲染帧率/内存。
3. **图片管理**：加「删除图片时清理 assets」「引用重命名同步」。
4. **打包发布**：补充 `README.md`、图标、`repository`/`homepage`，走 `vsce package` 打包为可安装 `.vsix`。
5. **配置面板**：把 zoom/width/typewriter/outline 集成进设置 UI（当前走命令 + `settings.json`）。
6. **空行行为的可配置化**：将「每次 Enter 空行数」与「是否启用连续空行」做成配置项。

---

*报告生成：2026-09-02。语料文件位于 `test/corpus/`（含 `generate.mjs` 生成器与 6 份 `.md` 语料）。*
