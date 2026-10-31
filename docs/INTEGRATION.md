# 墨净 · 集成开发说明

版本：`v1.0.0`  
适用：把小说清洗能力集成到另一个 Node / Electron / 桌面 / Web 软件中。

---

## 0. 工程地址

本地工程：

```text
<你的工作区>\novel-clean
```

本机当前路径见交付回复。

GitHub：

```text
https://github.com/chongrui20130326-web/novel-clean
```

Release：

```text
https://github.com/chongrui20130326-web/novel-clean/releases/tag/v1.0.0
```

源码包（不含 `.data/` 本地数据）：

```text
https://github.com/chongrui20130326-web/novel-clean/releases/download/v1.0.0/novel-clean-v1.0.0.zip
```

License：MIT。

---

## 1. 架构

```text
原始字节
  │
  ├─ 编码检测（BOM / UTF-8 / UTF-16 / GB18030 / Big5）
  ├─ 换行归一
  ├─ 不可见字符扫描
  ├─ 章节 / 段落 / 空行解析
  │
  ├─ 规则扫描
  │    ├─ 截断候选
  │    ├─ 章节连续性/格式
  │    ├─ 广告/网址/联系方式候选
  │    ├─ 空行
  │    └─ 缩进
  │
  ├─ 本地模型路由（只判断语义疑点）
  │    ├─ 换行是否同一句
  │    └─ 整段是否广告/作者留言
  │
  └─ 确定性渲染
       ├─ 原文 / 清洗后 blocks
       ├─ issues
       ├─ summary
       ├─ target UTF-8
       ├─ snapshot
       └─ report
```

核心原则：

1. **规则负责机械可验证的动作**：编码、缩进、空行、章节号、不可见字符、逐字校验。
2. **模型只做语义判断**：是否合并、是否删除；不自由改写正文。
3. **所有结构动作由宿主软件执行**，模型输出只作为建议。
4. **缺失章节只报告，不生成**。
5. **删除必须有硬证据**，短叙事默认保留。

---

## 2. 三种集成方式

### 方式 A：直接 import 引擎（推荐，宿主是 Node）

适合 Electron、Node CLI、已有 Node 后端。

```js
import { runClean, rerender } from './novel-clean/core/pipeline.mjs';
import { OllamaClient } from './novel-clean/core/ai.mjs';
import { serializeSnapshot, reviveSnapshot } from './novel-clean/core/snapshot.mjs';

const result = await runClean({
  buffer: Buffer.from(text, 'utf8'),
  name: '小说.txt',
  options: {
    ai: true,
    bookName: '书名',
    model: 'qwen3.5:9b-uncensored',
    maxTruncation: 24,
    maxIrrelevant: 20,
  },
  aiClient: new OllamaClient({
    baseUrl: 'http://127.0.0.1:8090',
    model: 'qwen3.5:9b-uncensored',
    timeoutMs: 900000,
  }),
  onProgress: (p) => console.log(p.percent, p.label, p.detail),
});

await fs.promises.writeFile('target.utf8.txt', result.text, 'utf8');
```

只跑规则：

```js
const result = await runClean({
  buffer,
  name: '小说.txt',
  options: { ai: false, bookName: '书名' },
});
```

### 方式 B：HTTP sidecar（推荐，宿主不是 Node）

启动：

```bash
node server.mjs
```

调用：

```text
POST http://127.0.0.1:4180/api/analyze?ai=1&bookName=书名
Content-Type: application/octet-stream
X-File-Name: 小说.txt

<原始字节>
```

然后轮询 `/api/jobs/:id`，完成后读取 `/blocks`、`/issues`、`/export`。

### 方式 C：嵌入现有 HMI

```html
<iframe
  src="http://127.0.0.1:4180/?embed=1&v=integration1"
  style="width:100%;height:100%;border:0"
></iframe>
```

`?embed=1` 只改变布局，不改变 API。

---

## 3. 引擎 API

### 3.1 `runClean(input)`

`core/pipeline.mjs`

| 字段 | 类型 | 说明 |
|---|---|---|
| `buffer` | Buffer/Uint8Array | 原始字节，必须 |
| `name` | string | 文件名，用于书名回退和报告 |
| `options.ai` | boolean | 是否运行模型复核 |
| `options.model` | string | 模型 ID |
| `options.bookName` | string | 书名；为空回退 `name` 去扩展名 |
| `options.maxTruncation` | number | 截断复核上限，默认 24 |
| `options.maxIrrelevant` | number | 无关内容复核上限，默认 20 |
| `aiClient` | object/null | 见 3.4 |
| `onProgress` | function | 进度回调 |

返回：

```js
{
  summary,   // 统计、七项检查、章节、AI
  issues,    // 全量问题
  blocks,    // HMI 对比块
  text,      // 最终 UTF-8 文本
  doc,       // 解析后的文档
  state,     // 渲染状态
  ai,        // AI 统计
  snapshot,  // 重新渲染所需快照
  options,
}
```

### 3.2 `rerender(snapshot, disabled)`

`core/pipeline.mjs`

```js
const output = rerender(snapshot, ['M0001', 'D0003']);
```

返回：

```js
{ summary, issues, blocks, text }
```

`disabled` 是 issue id 数组。它只重跑渲染，不重新调用模型。

### 3.3 snapshot 持久化

**不要直接 JSON.stringify(snapshot)**。内部包含 `Map`/`Set`，直接序列化会变成 `{}`。

错误做法：

```js
JSON.stringify(result.snapshot); // 会丢 deletions / marksByLine / inlineMatches
```

正确做法：

```js
import { serializeSnapshot, reviveSnapshot } from './core/snapshot.mjs';

const saved = serializeSnapshot(result.snapshot);
fs.writeFileSync('state.json', JSON.stringify(saved));

const snapshot = reviveSnapshot(JSON.parse(fs.readFileSync('state.json', 'utf8')));
const output = rerender(snapshot, ['M0001']);
```

工程里的 `state.json` 就是这种格式。

### 3.4 自定义 AI 客户端

`aiClient` 需要提供：

```js
{
  model: string,
  stats: object,
  health(): Promise<{ ok, model, models, found, running, error }>,
  reviewTruncations(candidates, options): Promise<{ selected, decisions, skipped }>,
  reviewIrrelevant(candidates, options): Promise<{ selected, decisions, skipped }>,
}
```

`decisions` 是 `Map<issueId, decision>`：

截断：

```js
{
  merge: boolean,
  merged: string,
  mergedSource: 'ai' | 'fallback' | 'missing' | 'error',
  confidence: number,
  reason: string,
  layer: 'ai' | 'rule',
}
```

无关内容：

```js
{
  remove: boolean,
  kind: 'ad' | 'author_note' | 'url' | 'contact' | 'noise' | 'story' | 'other',
  confidence: number,
  reason: string,
  layer: 'ai' | 'rule',
}
```

如果自定义客户端返回的合并文本和原文去空白后不一致，引擎会退回确定性拼接。

### 3.5 其他核心模块

| 文件 | 主要导出 | 用途 |
|---|---|---|
| `core/encoding.mjs` | `decodeNovel`, `normalizeNewlines` | 编码检测、换行归一 |
| `core/invisible.mjs` | `scanInvisible` | 不可见字符扫描/清理 |
| `core/parse.mjs` | `parseDocument`, `detectChapter`, `formatChapterTitle` | 章节/段落解析与标题格式 |
| `core/detect.mjs` | 截断、章节、广告、空行、缩进规则 | 规则候选 |
| `core/render.mjs` | `renderDocument`, `exportFileName` | 最终文本、对比块 |
| `core/report.mjs` | `buildReport` | 可追溯 JSON 报告 |
| `core/snapshot.mjs` | `serializeSnapshot`, `reviveSnapshot` | snapshot 持久化 |
| `core/pipeline.mjs` | `runClean`, `rerender` | 完整流水线 |

---

## 4. 本地模型路由

### 4.1 地址

```text
http://127.0.0.1:8090/v1
```

OpenAI 兼容：

```text
POST /v1/chat/completions
GET  /v1/models
GET  /health
GET  /admin/default-model
```

### 4.2 动态模型

模型列表**不要写死**。当前本机路由可能返回 16 个模型，取决于 `J:\本地模型服务器\config.json` 和已安装后端。

常见模型：

```text
qwen3.5:0.8b
qwen3.5:2b
qwen3.5:4b
qwen3.5:9b-uncensored
strata-q2
strata-q3
strata-q4
```

也可能出现 llamacpp / 27B / 128K 等模型。宿主界面应调用 `/v1/models` 渲染下拉框。

### 4.3 推荐请求参数

```json
{
  "model": "qwen3.5:9b-uncensored",
  "messages": [
    { "role": "system", "content": "只输出 JSON。" },
    { "role": "user", "content": "..." }
  ],
  "stream": false,
  "temperature": 0,
  "top_p": 0.9,
  "max_tokens": 640,
  "reasoning_effort": "none",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "novel_clean_decision",
      "schema": { "type": "object" }
    }
  }
}
```

关键点：

- `reasoning_effort: "none"`：避免思考 token 挤占 JSON 输出。
- `response_format`：优先结构化输出；后端不支持时降级为 `json_object`，再降级为纯提示词。
- 超时：首次加载 Strata 可能很久，建议客户端 15 分钟。
- 认证：本机网关无 key；如需 key，`Authorization: Bearer <key>`。

### 4.4 Node 客户端

```js
import { OllamaClient } from './core/ai.mjs';

const client = new OllamaClient({
  baseUrl: process.env.MODEL_GATEWAY_BASE || 'http://127.0.0.1:8090',
  model: 'qwen3.5:9b-uncensored',
  timeoutMs: 900000,
  apiKey: process.env.MODEL_GATEWAY_API_KEY || 'local',
});

const health = await client.health();
```

类名 `OllamaClient` 是历史兼容名，实际请求已经走 OpenAI 兼容的路由，不再直连 Ollama。

---

## 5. HTTP API

启动：

```bash
PORT=4180 node server.mjs
```

默认：

```text
http://127.0.0.1:4180
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health?force=1` | 服务、路由、模型列表 |
| GET | `/api/sample?format=utf8\|gbk` | 示例稿 |
| POST | `/api/analyze` | 原始字节 / JSON / `?path=` |
| GET | `/api/jobs/:id` | 状态、summary、disabled |
| GET | `/api/jobs/:id/blocks` | 对比块，`limit=all` 全量 |
| GET | `/api/jobs/:id/issues` | issue 列表 |
| POST | `/api/jobs/:id/render` | `{disabled:[...]}` |
| GET | `/api/jobs/:id/export` | 下载 UTF-8 |
| GET | `/api/jobs/:id/report` | 下载 report.json |
| POST | `/api/jobs/:id/save?dir=` | 正文 + 报告写目录 |
| POST | `/api/jobs/:id/project?dir=` | 导出完整工程 |
| POST | `/api/projects/open?path=` | 重新加载工程 |

### 5.1 分析

原始字节：

```text
POST /api/analyze?ai=1&bookName=书名&model=qwen3.5:9b-uncensored
Content-Type: application/octet-stream
X-File-Name: 小说.txt
```

JSON：

```json
{ "text": "第一章 ...", "name": "小说.txt" }
```

本机路径：

```text
POST /api/analyze?ai=1&bookName=书名&path=C%3A%5Cpath%5C%E5%B0%8F%E8%AF%B4.txt
```

响应：

```json
{ "jobId": "a1b2c3d4e5f6", "status": "queued", "queuePosition": 0 }
```

### 5.2 进度

```text
GET /api/jobs/:id
```

`progress`：

```json
{
  "percent": 47,
  "stage": "ai",
  "label": "模型复核无关内容",
  "detail": "0/2 · strata-q4",
  "ai": {
    "done": 1,
    "total": 3,
    "tokensPerSecond": 5.2,
    "completionTokens": 10,
    "durationMs": 2861,
    "speedSource": "backend"
  },
  "elapsedMs": 21300
}
```

### 5.3 blocks

```text
GET /api/jobs/:id/blocks?filter=all&offset=0&limit=all
```

`filter`：

```text
all | chapter | truncation | irrelevant | blank | indent | encoding | invisible
```

`limit=all` 返回全量，不依赖分页。

### 5.4 render

```text
POST /api/jobs/:id/render
Content-Type: application/json

{ "disabled": ["M0001", "D0003"] }
```

### 5.5 工程

```text
POST /api/jobs/:id/project?dir=D%3A%5C%E5%AF%BC%E5%87%BA
```

会创建：

```text
<书名>-工程/
├── source.txt
├── target.utf8.txt
├── project.json
├── report.json
├── state.json
└── README.md
```

重新加载：

```text
POST /api/projects/open?path=D%3A%5C%E5%AF%BC%E5%87%BA%5C%E4%B9%A6%E5%90%8D-%E5%B7%A5%E7%A8%8B
```

响应中的 `jobId` 可以直接用于 `/api/jobs/:id`。

---

## 6. 数据契约

### 6.1 `summary`

```json
{
  "name": "小说.txt",
  "bookName": "书名",
  "title": "书名",
  "createdAt": "2026-10-31T02:00:00.000Z",
  "durationMs": 61737,
  "input": {
    "bytes": 2308,
    "encoding": "utf8",
    "encodingLabel": "UTF-8",
    "bom": false,
    "confidence": 1,
    "newline": "lf",
    "chars": 579,
    "paragraphs": 24,
    "chapters": 3,
    "lines": 28,
    "bookName": "书名"
  },
  "output": {
    "encoding": "UTF-8",
    "bom": false,
    "bytes": 1572,
    "chars": 496,
    "paragraphs": 21,
    "chapters": 3,
    "deletedBlocks": 5,
    "mergedSentences": 2,
    "blankRemoved": 29
  },
  "stats": {},
  "checks": [],
  "chapter": {
    "continuity": 50,
    "found": 3,
    "expected": 4,
    "gaps": [{ "from": 2, "to": 4, "missing": [3] }],
    "formatCount": 3,
    "items": []
  },
  "ai": {},
  "issuesTotal": 63
}
```

### 6.2 `checks[]`

```json
{
  "type": "truncation",
  "index": 1,
  "label": "语句截断",
  "engine": "规则",
  "found": 3,
  "reviewed": 3,
  "status": "fixed",
  "detail": "3 处候选 · AI 复核 3 · 确认 2"
}
```

`status`：`ok` / `warn` / `fixed` / `review`。

### 6.3 `issues[]`

```json
{
  "id": "M0001",
  "type": "truncation",
  "layer": "ai",
  "severity": "fix",
  "fixable": true,
  "toggle": true,
  "accepted": true,
  "applied": true,
  "title": "合并被换行拆开的句子",
  "detail": "L7-L8",
  "blockIds": ["B0007", "B0008"],
  "lineNo": 7,
  "before": "她看见柜台上放着一封没有署名的信，\n信封的边缘已经发黄。",
  "after": "她看见柜台上放着一封没有署名的信，信封的边缘已经发黄。"
}
```

### 6.4 `blocks[]`

章节：

```json
{
  "id": "B0001",
  "kind": "chapter",
  "chapterIndex": 1,
  "chapterNumber": 1,
  "chapterUnit": "章",
  "chapterTitle": "雨夜",
  "lineNo": 1,
  "original": "第一章 雨夜",
  "cleaned": "《书名》（第1章）雨夜",
  "coreOriginal": "第一章 雨夜",
  "coreCleaned": "《书名》（第1章）雨夜",
  "indentBefore": 0,
  "indentAfter": 0,
  "changed": true,
  "deleted": false,
  "merged": false,
  "parts": [],
  "issueIds": [],
  "issueTypes": []
}
```

段落：

```json
{
  "id": "group-B0007",
  "kind": "paragraph",
  "chapterIndex": 1,
  "chapterTitle": "雨夜",
  "lineNo": 7,
  "original": "她看见...\n信封...",
  "cleaned": "     她看见... 信封...",
  "coreOriginal": "她看见...\n信封...",
  "coreCleaned": "她看见... 信封...",
  "indentBefore": 0,
  "indentAfter": 5,
  "changed": true,
  "deleted": false,
  "merged": true,
  "parts": [
    { "lineNo": 7, "original": "她看见...", "clean": "她看见...", "indent": 0 },
    { "lineNo": 8, "original": "信封...", "clean": "信封...", "indent": 0 }
  ],
  "issueIds": ["M0001"],
  "issueTypes": ["truncation"]
}
```

### 6.5 `project.json`

`novel-clean/project@1`

```json
{
  "schema": "novel-clean/project@1",
  "createdAt": "2026-10-31T02:00:00.000Z",
  "app": { "name": "墨净", "version": "1.0.0" },
  "book": { "title": "书名", "bookName": "书名", "sourceFile": "小说.txt" },
  "source": { "file": "source.txt", "bytes": 2308, "sha256": "...", "encoding": "utf8" },
  "target": { "file": "target.utf8.txt", "bytes": 1572, "sha256": "..." },
  "files": {
    "source": "source.txt",
    "target": "target.utf8.txt",
    "report": "report.json",
    "state": "state.json",
    "index": "project.json",
    "readme": "README.md"
  },
  "options": {},
  "disabled": [],
  "summary": {},
  "chapter": {},
  "checks": []
}
```

### 6.6 `state.json`

`novel-clean/state@1`

```json
{
  "schema": "novel-clean/state@1",
  "savedAt": "...",
  "job": { "id": "...", "name": "小说.txt", "title": "书名" },
  "options": {},
  "disabled": ["M0001"],
  "snapshot": {}
}
```

`snapshot` 必须是 `serializeSnapshot` 生成的格式，不是裸 `JSON.stringify(result.snapshot)`。

### 6.7 `report.json`

`novel-clean/report@1`

主要字段：

```json
{
  "schema": "novel-clean/report@1",
  "generatedAt": "...",
  "app": { "name": "墨净", "version": "1.0.0" },
  "job": { "id": "...", "sourceFile": "小说.txt", "bookName": "书名" },
  "source": { "bytes": 2308, "sha256": "...", "encoding": "utf8" },
  "result": { "chars": 496, "issueCounts": { "total": 63, "byType": {}, "bySeverity": {} } },
  "checks": [],
  "chapters": {},
  "issues": [],
  "disabled": [],
  "files": {
    "text": { "path": "...", "name": "target.utf8.txt", "bytes": 1572, "sha256": "..." },
    "report": { "path": "...", "name": "report.json" }
  },
  "options": {}
}
```

---

## 7. 二次处理

推荐把 `.report.json` 当机读索引：

- `checks`：七项检查状态
- `chapters.gaps`：缺失章节
- `issues`：全量 issue，含 `blockIds` 和 `blockIds` 对应行号
- `disabled`：用户关闭的 issue id
- `source.sha256` / `files.text.sha256`：源/结果完整性
- `options.model` / `options.bookName`：复现参数

批量处理流程：

```text
1. 每个文件 POST /api/analyze
2. 轮询完成
3. POST /project?dir=...
4. 读取 project.json + report.json
5. 用 report.disabled 做二次渲染或人工复核
```

---

## 8. UI 集成

最小 iframe：

```html
<iframe
  src="http://127.0.0.1:4180/?embed=1&v=integration1"
  style="width:100%;height:100%;border:0"
></iframe>
```

恢复指定任务：

```text
http://127.0.0.1:4180/?embed=1&job=<jobId>
```

说明：

- 页面没有构建步骤，纯静态 HTML/CSS/JS。
- 侧栏导出走本地服务写目录，不依赖浏览器下载。
- 当前没有 `postMessage` 协议；宿主与 HMI 之间建议用 HTTP API 交互，不要依赖 DOM 跨域。
- 如果宿主是 Electron，建议把 `novel-clean` 作为子目录，通过本地端口/iframe 加载。

---

## 9. 扩展点

### 新增规则检查

1. `core/detect.mjs` 增加候选扫描。
2. `core/pipeline.mjs` 将候选转成 issue。
3. `core/render.mjs` 应用修复或保留。
4. `tools/test.mjs` 增加回归。

### 新增章节格式

`core/parse.mjs`：

- `detectChapter()` 负责识别
- `formatChapterTitle()` 负责输出
- 不要在模型提示词里做章节号枚举

### 新增模型后端

实现 `aiClient` 接口，或把后端接到 OpenAI 兼容路由。  
不要在 `pipeline.mjs` 里写具体模型名。

### 新增导出格式

`core/render.mjs` 负责文本；`server.mjs` 负责文件路径、工程索引、报告。  
如果是宿主自己的导出，建议复用 `runClean` 的 `text` 与 `report`。

---

## 10. 测试与 CI

```bash
npm test
npm run test:http
```

当前：

```text
14 tests passed
```

GitHub Actions：`.github/workflows/tests.yml`，Windows + Node 24。

测试覆盖：

- UTF-8 BOM / GBK / UTF-16 / CRLF
- 章节标题统一、`第一章，`、`(12)`、`二十二章`
- 不可见字符
- 截断合并 / 撤销 / 恢复
- 幂等
- 规则模式降级
- 导出 UTF-8 无 BOM
- 工程导出 / 重新加载 / 报告

---

## 11. 配置与部署

环境变量：

```text
PORT=4180
HOST=127.0.0.1
MODEL_GATEWAY_BASE=http://127.0.0.1:8090
MODEL_GATEWAY_MODEL=qwen3.5:9b-uncensored
MODEL_GATEWAY_API_KEY=local
MODEL_ROUTER_ROOT=J:\本地模型服务器
```

依赖：

- Node.js >= 22
- 零 npm 运行时依赖
- 本地模型路由（Ollama / Strata / llama.cpp 由路由管理）

服务脚本：

```text
service/install-autostart.ps1
service/watchdog.ps1
service/watchdog.vbs
```

注意：`service` 使用 Windows PowerShell / WScript；Linux/macOS 宿主请用 systemd、launchd 或自己的进程管理器替代。

---

## 12. 安全与隐私

- 服务默认只监听 `127.0.0.1`。
- `/api/analyze?path=`、`/api/projects/open?path=`、`/save`、`/project` 都能读写本机路径；**不要把这些接口暴露到公网**。
- `.data/jobs` 保存源文件、snapshot 和正文，属于用户数据；发布/备份时排除。
- `.gitignore` 已排除 `.data/`、`dist/`、日志。
- 模型请求只发往本机路由；如果路由被改成远程地址，由部署方自行承担隐私风险。
- 工程里的 `state.json` 可以恢复逐条开关，不要手改。

---

## 13. 已知限制

- 缺失章节只报告，不自动生成。
- 章节重号不自动重排。
- 默认 32 MB 输入上限。
- 5 个半角空格是硬规则，修改见 `core/render.mjs` / `core/detect.mjs`。
- 全量 blocks 渲染在几万段时会变慢。
- 模型判断有概率性，删除仍受硬证据安全阀限制。
- `state.json` 的 snapshot 包含 Map/Set 的序列化格式，必须使用 `snapshot.mjs`。

---

## 14. 文件地图

```text
novel-clean/
├── server.mjs                 HTTP / 队列 / 工程 / 导出
├── core/
│   ├── encoding.mjs
│   ├── invisible.mjs
│   ├── parse.mjs
│   ├── detect.mjs
│   ├── ai.mjs                 本地路由客户端、JSON schema
│   ├── render.mjs
│   ├── pipeline.mjs
│   ├── report.mjs
│   └── snapshot.mjs
├── ui/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── service/
│   ├── watchdog.ps1
│   ├── watchdog.vbs
│   └── install-autostart.ps1
├── samples/
├── screenshots/
├── tools/
│   ├── test.mjs
│   └── test-http.mjs
├── docs/
│   └── INTEGRATION.md
├── start.cmd
└── package.json
```

---

## 15. 集成检查清单

- [ ] Node.js >= 22
- [ ] 复制/克隆 `novel-clean`
- [ ] 启动本地模型路由 `http://127.0.0.1:8090/v1`
- [ ] 确认 `/v1/models` 返回模型
- [ ] 启动 `node server.mjs` 或 import `runClean`
- [ ] 用示例稿跑通 `npm test` / `npm run test:http`
- [ ] 确定宿主使用「引擎 API」还是「HTTP sidecar」
- [ ] 保存 `text` 时使用 UTF-8 无 BOM
- [ ] 持久化 snapshot 时使用 `serializeSnapshot`
- [ ] 导出工程时保留 `source.*` / `state.json`
- [ ] 生产环境不要暴露 `/api/analyze?path=` 与 `/save`
- [ ] 遵守 MIT License
