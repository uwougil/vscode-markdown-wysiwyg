# 交接文档（Handover）— Markdown WYSIWYG V1

> 本文档面向**接手继续开发的工程师**，说明项目为何存在、当前状态、技术债、踩坑点、
> 以及继续开发时最需要注意的边界，确保你能**顺利理解并在此基础上继续**。
> 请先读一遍本文，再对照 [`REPORT.md`](REPORT.md)（设计与验证结论）和 `src/` 源码。

## 0. 仓库位置与环境

- **仓库（Git，含 `.git`）位于 WSL**：`/path/to/vscode-markdown-wysiwyg`
  （Windows 侧经 `\\wsl.localhost\Ubuntu\home\wugl\date\2026\9\2\markdown-wysiwyg-v1\` 访问）。
- **远程**：`origin = https://github.com/uwougil/vscode-markdown-wysiwyg`（公开仓库，主分支 `main`）。
  WSL 已配置 `credential.helper=store`（凭据文件 `~/.git-credentials`，权限 600），可直接 `git push`。
- 分支 `main`，当前提交 `9353252`（工作树干净）。`node_modules`/`dist` 被 `.gitignore` 忽略、**不在仓库内**，首次需 `npm install` + `npm run build`。
- **WSL 内 node/npm 不在默认 PATH**：用绝对路径或先 `export PATH="$HOME/.local/bin:$PATH"`（node v22.23.2 / npm 10.9.8）。
- 已在 WSL 干净 clone 上全链路验证通过：`npm install` → `node test/run.mjs` **29/29** → `npx tsc --noEmit` 0 错误 → `npm run build`。
- 开发环境注意：经外层 Git Bash 调 `wsl bash -lc` 时，`$PATH`/`$HOME` 会被外层提前展开成带空格的 Windows 路径导致语法错；宜把较长 WSL 命令写成 `.sh` 脚本再执行，别在命令行内嵌 `$` 变量。

> ⚠️ Windows 工作区原有一份 `markdown-wysiwyg-v1`（实际开发目录，含 node_modules/dist），
> 已于 2026-09-02 迁移后**删除**，一切以本 WSL 仓库为准，后续开发直接在 WSL 仓库内进行。

---

## 1. 一句话总结

这是 **VS Code 的一个自定义 Markdown 编辑器扩展原型（Custom Editor）**：不改造
`@vscode/markdown-editor` 引擎，而是在**自己的 webview 胶水层**上补齐 6 项编辑体验增强。

## 2. 为什么不用官方编辑器、而要自建一个？

官方 1.131 的实验性 WYSIWYG 编辑器存在体验缺口，且**插件无法向它注入 webview CSS/JS**
（唯一公开挂载点是 `markdown.codeBlockEditorProviders`，只影响代码块）。因此「复用引擎 + 自建
Custom Editor」是当时调研（`docs/vscode-hybrid-markdown-editor-源码分析.md`）得出的唯一可行路线。

**核心决策（请务必延续）**：所有增强都在 webview 胶水层实现，**绝不 patch 引擎**。
好处是引擎一升级即可继承官方修复。若未来发现某功能必须在引擎内改，请先回到这份决策重新评估，
而不是顺手 `sed` 进 `node_modules`。

## 3. 运行时架构速览（改哪一层心里要有数）

```
host（Node / CJS）                          webview（浏览器 / ESM）
src/extension.ts                 postMessage  src/webview/editor.ts
  ├─ 注册 CustomEditorProvider   ◄─────────►   ├─ EditorModel/EditorView/EditorController
  └─ 6 条命令                      edit           └─ 6 项功能全部叠在这里
src/markdownEditorProvider.ts      update /      (zoom/typewriter/outline/blankline/
  ├─ TextDocument 权威文本          config/         image/contentWidth)
  ├─ 图片落盘 assets/               saveImage
  └─ undo/redo 转发               ─────────►
```

消息协议无 TypeScript 类型约束（跨 realm），**类型靠两边 `switch(message.type)` 手写对齐**，
改动一端务必同步另一端。参考 `src/markdownEditorProvider.ts` 与 `src/webview/editor.ts` 的 `_handleMessage`。

## 4. 六项功能在代码里的大致位置（快速定位）

| 功能 | 主要代码位置 | 一句话原理 |
|------|--------------|-----------|
| 缩放 | `editor.ts` `_applyConfig`；`editor.css` | 设 `:root` 的 `--markdown-font-size`，引擎全部 em 相对联动 |
| 内容宽度 | `editor.ts` `limitedWidth` observable | 680/820/1000px 或 `undefined`(=full) |
| 打字机 | `editor.ts` `_scheduleTypewriterScroll/_typewriterScroll` | `view.caretRect`+`overlayContainer` 几何，45–55% 带 + 600ms 用户滚动宽限 |
| 连续空行 | `editor.ts` `_handleKeyDownCapture`（**capture 阶段**） | 见 §6，核心修复 |
| 图片 | `editor.ts` `_handlePaste/Drop/_saveImageFile` + provider `_saveImage` | dataURL→写 `<docDir>/assets/`→插 `![](assets/…)` |
| 大纲 | `editor.ts` `_buildOutlineChrome/_rebuildOutline/_renderOutline` | `model.document.blocks` 过滤 heading + `findNodeOffsetById` |

## 5. 当前验证状态（接手时的基线）

- `node test/run.mjs` → **29/29 通过**（源码往返 / 空行专项 16 项 / 大纲 / computeTextEdit / 性能表）。
- `npx tsc --noEmit` → **0 错误**（`noEmit`，仅类型检查）。
- `npm run build` → 成功（`dist/extension.js` ~10KB + `dist/webview/` ESM 多分块）。

**尚未闭环的一件事（重要）**：Custom Editor 的 **DOM 交互从未被自动化验证过**。
29 项测试全部是 **Node 无 DOM、直接驱动引擎** 的头less 测试，它们证明的是**引擎 + 修复逻辑正确**，
**不证明 webview 在真实浏览器里能跑**。接手后的第一件事应是人工 F5 验收（见 §9）。

## 6. 最重要的一处修复：连续空行（务必理解，别被它绊倒）

**引擎行为**：引擎把「段末回车」建模为 *transient pending paragraph*。第一次 Enter 在段末
`armPendingParagraph`（不写源码，只是"临时空白段落"），第二次 Enter 时引擎**提前返回**、不再产生新行；
只有真的输入文字才 `materializePendingParagraph` 写回源码。所以 `A`+Enter+Enter+`B` 永远不会得到
`A\n\n\nB`——**连续空行会被吞**。

**本项目的修复**：在 `view.element` 上挂 **capture 阶段**（`addEventListener('keydown', handler, true)`）
的 keydown 拦截，抢在引擎 handler 之前：
- Case 1：引擎已 arm 待定段落，再按 Enter → `cancelPendingParagraph()` + `StringEdit.replace` 物化 `\n\n\n`。
- Case 2：已在空行 run（`blankRun≥2`），再按 Enter → `StringEdit.insert` 追加一个 `\n`。
- 任何非 Enter / 鼠标点击 → 重置 `blankRun`。

**为什么要 capture 阶段**：capture 先于引擎 bubble handler 执行，只有这样才能 `preventDefault +
stopImmediatePropagation` 拦下 Enter，否则引擎会把事件消费掉。改这块务必保留 capture 语义。

**产物是纯 Markdown 的 `\n`**（无 `<br>`、无私有方言），所以保存/重开**往返保真**——
这正是 headless 测试能断言 `'A\n\n\n'` 精确串的原因。

**测试里学到的引擎坑**：headless 直接驱动 `EditorModel` 时，`materializePendingParagraph` 是 no-op，
必须先手动 `armPendingParagraph({...})` 它才会生效（真实编辑器里由 `EditorController` 代劳）。
`test/run.mjs` 的 `blankLines()` 已按此写法，别"修复"它。

## 7. 引擎升级 / API 边界（最容易踩的雷）

- **`PendingParagraph` 是非导出 `declare interface`**（`index.d.ts` ~2618 行），运行时靠 duck-typing
  访问 `{anchorBlock, replaceRange, separateFromPreviousBlock, atEof, text}`。升级引擎若改字段名，webview 会静默失效。
- **`observableValue.set(value, tx, change)` 是三参**（`tx` 常传 `undefined`）。
- `findNodeOffsetById` 返回的是**行首偏移，可能含至多 3 个空格的合法 Markdown 前导缩进**，
  label 提取正则用 `^\s*#{1,6}\s*`（见 `headingLabel`）。
- **每次升级 `@vscode/markdown-editor` 后都要重跑 `node test/run.mjs`**，一旦空行专项挂掉，
  优先怀疑引擎的 pending 模型变了。

## 8. 构建细节（易错点）

- esbuild 两套目标写死在 `build.mjs`：host=`platform:node,format:cjs`（`vscode` external）；
  webview=`platform:browser,format:esm`（splitting + 字体/图片 loader + `node:fs/promises` external）。
- **webview 是 ESM 产物，provider 的 HTML 里 `<script>` 必须带 `type="module"`**
  （`markdownEditorProvider.ts` 的 `_getHtml` 已加，删了会直接 import 报错）。
- `src/markdownEditorProvider.ts` 里**图片 base64 用全局 `atob` 解码**（不用 `Buffer`），
  是为避免引入 `@types/node`。若 host 侧要新增需要 Node API 的逻辑，再补 `@types/node` 并调整 tsconfig。

## 9. 接手第一步：人工验收清单（必须本机跑）

1. F5 启动 Extension Development Host。
2. 新建/打开 `.md`，右键标签 →「打开方式…」→「Markdown WYSIWYG V1」。
3. 逐项核对：打字机开关、Ctrl+=/-/0 缩放（60–200%）、大纲侧栏开关与跳转、
   **段末连按 3~4 次回车应出现连续空行**、粘贴/拖入一张 PNG、内容宽度四档切换。
4. 关键回归：制造连续空行后 **Ctrl+S 保存 → 关闭 → 重开**，确认空行仍是 `\n` 往返（不是 `<br>`）。
5. 有任何一项在真实 DOM 中表现异常，如实记录到本文件「已知问题」并修复后重跑测试。

## 10. 技术债 / 已知限制（继续开发前先看）

- **图片**：只写 `<docDir>/assets/`；未做「删引用时清理 assets」「图片重命名同步」「跨目录引用」。见 REPORT F2。
- **运行时/内存**：webview 产物含 270+ mermaid 分块（数 MB），冷启动首次渲染略慢，可按需裁剪。见 REPORT F4。
- **键盘**：固定 `vscodeLocalKeyboardProfile` + `vscodeHostKeyboardProfile`，未覆盖全部平台差异。见 REPORT F5。
- **空行语义**：目前「每次回车空行数」写死为 2，未做成可配置项。
- **README 已声明 engines `^1.131.0`**，若引擎 API 变化要同步评估最低版本。

## 11. 建议的后续路线（按优先级）

1. **§9 人工验收并闭环**（当前最高优先级，headless 无法替代）。
2. 空行行为可配置化（次数 + 开关）。
3. 图片生命周期管理（清理/重命名同步）。
4. 真实 DOM 下与官方编辑器对比渲染帧率/内存（性能再验证）。
5. 打包发布：补 icon、`vsce package` 出 `.vsix`（`repository`/`homepage` 已在 package.json 预留语义）。

## 12. 常见命令速查

```bash
npm install        # 装依赖
npm run build      # 出 dist/
npm run watch      # 热更（可选）
npx tsc --noEmit   # 类型检查，0 错误为通过
node test/run.mjs  # 29 项正确性 + 性能基准
```
