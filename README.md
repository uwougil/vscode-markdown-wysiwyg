# Markdown WYSIWYG V1

> **GitHub**：<https://github.com/uwougil/vscode-markdown-wysiwyg>（远程 `origin`，主分支 `main`）

在**本地官方 VS Code（1.131+）** 上，基于微软官方实验性「Hybrid Markdown 编辑器」的核心引擎
[`@vscode/markdown-editor`](https://www.npmjs.com/package/@vscode/markdown-editor)，自写的一个
**所见即所得（WYSIWYG）Markdown 编辑器** Custom Editor 扩展原型。共落地 **6 项增强功能** +
**1 套正确性/性能基准**，正确性测试 **29/29 通过**，构建 + 严格类型检查 0 错误。

> 详细设计与验证结论见 [`docs/REPORT.md`](docs/REPORT.md)；
> 引擎架构源码分析见 [`docs/vscode-hybrid-markdown-editor-源码分析.md`](docs/vscode-hybrid-markdown-editor-源码分析.md)。

---

## 一、项目背景与动机

VS Code 1.131 引入的实验性 Markdown WYSIWYG 编辑器本身**体验尚不完整**，例如：

- 段末连按回车**无法产生连续空行**（引擎把段末回车建模成 *transient pending paragraph*，第二次回车不产生新行），
  这与 Typora 的用户习惯不符。
- 缺少打字机模式、编辑器独立缩放、增强大纲、内容宽度控制、图片直接粘贴/拖拽等常用编辑特性。

调研发现：该编辑器是内置扩展 `markdown-language-features` 的 Custom Editor，核心引擎是独立 npm 包
`@vscode/markdown-editor`，webview 胶水层只有约 560 行，且**第三方插件无法注入 webview CSS/JS**。
因此本项目的策略是：**复用官方引擎 + 自建一个 Custom Editor 扩展，把增强功能全部实现在「胶水层」**，
不修改引擎源码——升级引擎即可继承官方修复。

## 二、功能特性

| # | 功能 | 说明 | 触发命令 |
|---|------|------|----------|
| 1 | 打字机模式 | 光标保持视口垂直中心附近，尊重用户滚动 | `mdwysiwyg.toggleTypewriter` |
| 2 | 编辑器独立缩放 | `--markdown-font-size` 联动整篇缩放，不影响窗口缩放 | `zoomIn` / `zoomOut` / `zoomReset` |
| 3 | 增强大纲面板 | H1–H6、点击跳转、当前节高亮、筛选、折叠 | `mdwysiwyg.toggleOutline` |
| 4 | Typora 式连续空行 | 段末连续回车物化真实 `\n`（无 `<br>` 方言） | —（自动） |
| 5 | 图片粘贴 / 拖拽 | PNG/JPEG/WebP → `<docDir>/assets/`，插入相对路径 | —（自动） |
| 6 | 内容宽度控制 | narrow 680 / normal 820 / wide 1000 / full | `mdwysiwyg.setWidth` |
| 7 | 正确性 + 性能基准 | 源码往返、空行专项、大纲提取、性能表 | `node test/run.mjs` |

## 三、目录结构

```
markdown-wysiwyg-v1/
├── build.mjs                  # esbuild 双目标构建脚本（host CJS + webview ESM）
├── package.json               # 扩展清单 + 依赖 + 命令贡献点
├── tsconfig.json              # 严格 TS 配置（noEmit，仅类型检查）
├── README.md                  # ← 本文件（仓库说明）
├── docs/
│   ├── HANDOVER.md            # 交接 / 维护注意事项
│   ├── REPORT.md              # 实现与验证报告（A–G 七节）
│   └── vscode-hybrid-markdown-editor-源码分析.md   # 引擎/官方胶水层源码调研
├── src/
│   ├── extension.ts           # activate/deactivate + 6 条命令注册
│   ├── markdownEditorProvider.ts  # 宿主侧 postMessage 协议 + 图片落盘
│   └── webview/
│       ├── editor.ts          # webview 胶水层（EditorModel→View→Controller + 7 功能）
│       └── editor.css         # 大纲侧栏 + flex 双栏布局
├── test/
│   ├── run.mjs                # Node 无 DOM 正确性 + 性能基准（29 项）
│   └── corpus/                # 6 份测试语料 + generate.mjs 生成器
│       ├── generate.mjs       # 合成 large/math/mermaid/outline
│       └── *.md               # small/medium + 生成的语料
└── dist/                      # 构建产物（git 忽略）
```

## 四、环境要求

- **仓库位置**：本项目 Git 仓库位于 WSL `/path/to/vscode-markdown-wysiwyg`
  （Windows 侧经 `\\wsl.localhost\Ubuntu\home\wugl\date\2026\9\2\markdown-wysiwyg-v1\` 访问）。
  `node_modules`/`dist` 被 `.gitignore` 忽略，不在仓库内，首次需 `npm install` + `npm run build`。
- **Node.js** ≥ 16（开发/构建；测试 `atob` 为全局，需 ≥16）。本机 WSL 实测 node v22.23.2 / npm 10.9.8。
- **WSL 内 node/npm 不在默认 PATH**：用绝对路径，或先 `export PATH="$HOME/.local/bin:$PATH"`。
- **npm**（随 Node 自带）
- **VS Code** ≥ 1.131（`package.json` engines 声明 `^1.131.0`）
- **TypeScript**、**esbuild** 作为 devDependencies

## 五、安装与运行（Extension Development Host）

```bash
cd /path/to/vscode-markdown-wysiwyg
export PATH="$HOME/.local/bin:$PATH"   # WSL: 把 node/npm 加入 PATH

# 1) 安装依赖
npm install

# 2) 构建（生成 dist/extension.js + dist/webview/*）
npm run build
#    开发时热更新：npm run watch

# 3) 类型检查（可选，0 错误为通过）
npx tsc --noEmit

# 4) 启动调试
#    在 VS Code 中按 F5（或 运行和调试 → 选择「Extension Development Host」）
#    → 新窗口里新建/打开一个 .md 文件
#    → 右键标签 →「打开方式…」→「Markdown WYSIWYG V1」
```

> ⚠️ 开发环境提示：经 Git Bash / PowerShell 调 `wsl bash -lc "…"` 时，`$PATH`/`$HOME` 会被外层提前展开成带空格的 Windows 路径导致语法错。
> 较长 WSL 命令建议写成 `.sh` 脚本再执行，别在命令行内嵌 `$` 变量。

## 六、测试与基准

```bash
# 无需 DOM、直接 import 真引擎跑 29 项正确性 + 性能基准
node test/run.mjs
```

预期末尾输出 `通过 29 / 29 全部通过 ✅`，并打印各语料 parse 性能表（最重负载 43KB/2471 标题 ≈ 55ms）。

## 七、依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `@vscode/markdown-editor` | 0.0.2-84 | 官方 WYSIWYG 引擎（EditorModel/View/Controller + 主题） |
| `@vscode/observables` | ^0.1.1-0 | 响应式 observable（`observableValue`/`autorun`） |
| `katex` | ^0.16.33 | 行内/块级公式渲染 |
| `mermaid` | ^11.4.0 | Mermaid 图渲染（webview 侧按需动态 import） |
| `esbuild` | ^0.24.0 | 双目标打包（dev） |
| `typescript` | ^5.6.0 | 类型检查（dev） |
| `@types/vscode` | ^1.131.0 | VS Code API 类型（dev） |

## 八、关键配置与命令

用户偏好持久化在 `workspaceState`（键 `mdwysiwyg.config.v1`），也可写入 `settings.json`：

| 设置键 | 默认 | 说明 |
|--------|------|------|
| `mdwysiwyg.typewriter` | `false` | 打字机模式开关 |
| `mdwysiwyg.zoom` | `100` | 内容字号百分比（60–200） |
| `mdwysiwyg.contentWidth` | `"normal"` | 内容宽度预设（narrow/normal/wide/full） |

命令（均在命令面板 / 键位绑定时按「Markdown WYSIWYG」分类检索）：
`mdwysiwyg.zoomIn`、`zoomOut`、`zoomReset`、`toggleTypewriter`、`toggleOutline`、`setWidth`。

---

*LICENSE: MIT · 由本地原型开发产出。维护与交接要点见 [`docs/HANDOVER.md`](docs/HANDOVER.md)。*
