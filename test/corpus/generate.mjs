// Generates the synthetic benchmark corpora (large / math-heavy / mermaid-heavy /
// outline-heavy). Run directly to write them to disk, or import `buildCorpora()`
// from the test harness for in-memory use.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildLarge() {
	const sections = [];
	for (let s = 1; s <= 80; s++) {
		sections.push(`## 章节 ${s}`);
		sections.push('');
		for (let p = 1; p <= 4; p++) {
			sections.push(`这是第 ${s} 章的第 ${p} 段正文，用于压测解析器的吞吐与内存表现。`);
		}
		sections.push('');
		sections.push('- 要点一');
		sections.push('- 要点二');
		sections.push('');
		sections.push('```text');
		sections.push(`line ${s * 3 - 2}`);
		sections.push(`line ${s * 3 - 1}`);
		sections.push(`line ${s * 3}`);
		sections.push('```');
		sections.push('');
	}
	return sections.join('\n') + '\n';
}

function buildMath() {
	const parts = ['# 数学重载文档\n'];
	for (let i = 1; i <= 120; i++) {
		parts.push(`## 公式组 ${i}`);
		parts.push('');
		parts.push(`行内：$a_i^2 + b_i^2 = c_i^2$ 与 $\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$。`);
		parts.push('');
		parts.push('$$');
		parts.push(`f_i(x) = \\int_{0}^{x} e^{-t^2} dt + \\sum_{k=1}^{${i}} \\frac{1}{k^2}`);
		parts.push('$$');
		parts.push('');
	}
	return parts.join('\n');
}

function buildMermaid() {
	const parts = ['# Mermaid 重载文档\n'];
	const diagrams = [
		['flowchart', 'graph TD\n    A-->B\n    B-->C\n    C-->D'],
		['sequence', 'sequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hi'],
		['class', 'classDiagram\n    Animal <|-- Dog\n    Animal <|-- Cat'],
		['state', 'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Run\n    Run --> [*]'],
	];
	for (let i = 1; i <= 40; i++) {
		const [lang, body] = diagrams[(i - 1) % diagrams.length];
		parts.push(`## 图 ${i}`);
		parts.push('');
		parts.push('```mermaid');
		parts.push(body);
		parts.push('```');
		parts.push('');
	}
	return parts.join('\n');
}

function buildOutline() {
	const parts = ['# 大纲重载文档\n'];
	let n = 0;
	for (let h1 = 1; h1 <= 10; h1++) {
		parts.push(`# 一级 ${h1}`);
		parts.push('');
		n++;
		for (let h2 = 1; h2 <= 6; h2++) {
			parts.push(`## 二级 ${h1}.${h2}`);
			parts.push('');
			n++;
			for (let h3 = 1; h3 <= 4; h3++) {
				parts.push(`### 三级 ${h1}.${h2}.${h3}`);
				parts.push('');
				n++;
				for (let h4 = 1; h4 <= 3; h4++) {
					parts.push(`#### 四级 ${h1}.${h2}.${h3}.${h4}`);
					parts.push('');
					n++;
					parts.push(`##### 五级 ${h1}.${h2}.${h3}.${h4}`);
					parts.push('');
					n++;
					parts.push(`###### 六级 ${h1}.${h2}.${h3}.${h4}`);
					parts.push('');
					n++;
				}
			}
		}
	}
	return parts.join('\n') + `\n<!-- ${n} headings -->\n`;
}

export function buildCorpora() {
	return {
		large: buildLarge(),
		math: buildMath(),
		mermaid: buildMermaid(),
		outline: buildOutline(),
	};
}

// CLI: write the generated corpora to disk.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	for (const [name, content] of Object.entries(buildCorpora())) {
		const p = path.join(__dirname, `${name}.md`);
		writeFileSync(p, content);
		console.log(`wrote ${name}.md  ${content.length} bytes / ${content.split('\n').length} lines`);
	}
}
