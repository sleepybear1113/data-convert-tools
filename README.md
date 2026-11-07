# Data Convert Tools

一个以 DBF 数据交换为核心的纯浏览器数据转换工具。目标是在不上传文件、不依赖后端服务的情况下，完成 DBF、SQLite、XLSX、CSV 的读取、查询、转换和导出。

> **当前状态：首版功能已完成。** 已通过 TypeScript 类型检查、23 个测试文件的 92 项单元/集成测试、4 个 Chromium 端到端测试及生产构建。DBF、CSV、XLSX、SQLite 的导入、SQL 查询和导出均已通过真实浏览器验证。本文命令均使用指定的 Node 24 绝对路径。
>
> 详细需求、已确认决策和默认业务规则见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。依赖版本矩阵和升级约束见 [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)。

## 1. 项目目标

### 1.1 核心功能

- 在浏览器中读取和写入 FoxPro/dBASE DBF 文件。
- 以用户提供的脱敏 JavaDBF 样本、VFP 格式规则和二进制测试作为内部兼容基准。
- 将 DBF、XLSX、CSV 导入浏览器内的 SQLite 工作数据库。
- 打开已有的 SQLite 数据库文件，并选择其中的表进行处理。
- 使用 SQLite SQL 进行数据查询和常用数据操作，不支持也不需要 FoxPro SQL 方言。
- SQL 编辑器支持关键词、表名和列名补全。
- 查询结果分页展示，并可导出为 DBF、SQLite、XLSX 或 CSV。
- XLSX、CSV 转 DBF/SQLite 时支持列选择、列重命名和类型推断。
- 尽可能保留 DBF 字段类型、长度、小数位、编码及来源元数据。
- 对编码、字段宽度、数值精度和不支持类型给出明确诊断，而不是静默损坏数据。

### 1.2 格式范围

| 格式 | 读取 | 写入/导出 | 说明 |
| --- | --- | --- | --- |
| DBF | 计划支持 | 计划支持 | 使用独立 TypeScript Codec；SheetJS 不负责 DBF 兼容实现 |
| SQLite `.sqlite/.db` | 计划支持 | 计划支持 | 指 SQLite 二进制数据库，不是 `.sql` 文本脚本 |
| XLSX | SheetJS | SheetJS | 固定使用 SheetJS CE 0.20.3，不引入 ExcelJS |
| CSV | Papa Parse | Papa Parse/分批导出 | 另行处理编码和列类型推断 |

### 1.3 明确边界

- 只提供 `.dbf` 时，无法恢复实际存储在 `.fpt`、`.dbt` 中的 Memo 等内容。
- 不承诺任意 FoxPro 版本、任意字段类型都能无损互转。
- SQL 查询产生的表达式、别名和计算列，在导出 DBF 时需要重新确认字段映射。
- SQLite 的索引、视图、触发器、外键等结构不能完整映射到单表 DBF。
- 第一版以内存数据库为主，浏览器刷新前需要导出需要保留的成果。
- 大文件能力取决于浏览器内存、WASM 内存和 XLSX 工作簿开销，不能仅凭使用 Web Worker 就保证处理超大文件。

## 2. 技术方案

### 2.1 运行与界面

- Vue 3
- TypeScript
- Vite
- Naive UI
- Pinia

Vue 只负责页面与交互。DBF、类型推断和格式转换等核心代码使用纯 TypeScript，不依赖 Vue 或 DOM。

### 2.2 数据处理

- SQLite：`sql.js`，运行在 Web Worker 中。
- SQL 编辑器：CodeMirror 6、`@codemirror/lang-sql`，使用 SQLite 方言和动态 Schema。
- Excel：SheetJS CE 0.20.3，统一封装在 `src/core/formats/xlsx.ts`。
- CSV：Papa Parse，统一封装在 `src/core/formats/csv.ts`。
- 编码：浏览器 `TextDecoder` 配合 `iconv-lite`，写回非 UTF-8 DBF 时按编码后的字节长度校验。
- 数值：原生 `BigInt` 与 `decimal.js`，避免所有数值都经过 JavaScript `Number`。
- DBF：基于 `ArrayBuffer`、`DataView`、`Uint8Array` 的独立读写模块。

### 2.3 数据流

```text
DBF / SQLite / XLSX / CSV
          │
          ▼
统一 TableSchema + 分批行数据 + 来源元数据
          │
          ▼
Web Worker 中的 SQLite 工作数据库
          │
          ├── SQL 查询与常用数据操作
          ├── 当前页结果展示
          ├── DBF 导出
          ├── SQLite 导出
          ├── XLSX 导出
          └── CSV 导出
```

第一版只使用一个数据处理 Worker，避免多 Worker 共享 SQLite 状态所带来的复杂度。

## 3. 目标目录结构

以下是目标结构，不要求一次创建所有文件。

```text
data-convert-tools/
├─ src/
│  ├─ main.ts
│  ├─ App.vue
│  ├─ views/
│  │  └─ WorkspaceView.vue
│  ├─ components/
│  │  ├─ FileImportPanel.vue
│  │  ├─ ColumnMappingEditor.vue
│  │  ├─ SqlEditor.vue
│  │  ├─ ResultGrid.vue
│  │  ├─ ExportDialog.vue
│  │  └─ DiagnosticList.vue
│  ├─ stores/
│  │  ├─ workspace.ts
│  │  └─ settings.ts
│  ├─ services/
│  │  ├─ workspace-api.ts
│  │  ├─ file-open.ts
│  │  └─ file-save.ts
│  ├─ workers/
│  │  ├─ data.worker.ts
│  │  ├─ worker-client.ts
│  │  └─ protocol.ts
│  ├─ core/
│  │  ├─ model/                  # 表、字段、值、元数据、诊断类型
│  │  ├─ dbf/                    # DBF Reader、Writer、编码和校验
│  │  ├─ database/               # 数据库接口、sql.js、查询和 Schema
│  │  ├─ formats/                # SheetJS、Papa Parse 适配层
│  │  ├─ conversion/             # 类型推断、列映射和目标格式校验
│  │  └─ utils/
│  └─ styles/
├─ tests/
│  ├─ unit/
│  ├─ e2e/
│  └─ fixtures/                  # 脱敏、最小化、可提交的测试样本
├─ scripts/
├─ third_party/                  # SheetJS 固定版本安装包（随仓库提交）
│  └─ sheetjs/
│     └─ xlsx-0.20.3.tgz
├─ sample-data/                  # 本地源样本，默认不提交
│  └─ dbf/                       # JavaDBF 生成的本地测试文件
├─ .npmrc                        # 项目级 npm registry
├─ package.json
├─ package-lock.json
├─ vite.config.ts
├─ tsconfig.json
├─ vitest.config.ts
├─ playwright.config.ts
└─ README.md
```

## 4. 本机环境与固定路径

本项目在 Windows PowerShell 中构建，**不修改系统或其他项目的 Node.js 环境变量**。

统一使用：

```text
Node.js 目录：D:\Softwares\NodeJs\node-v24.21.0
Node.js：     D:\Softwares\NodeJs\node-v24.21.0\node.exe
npm：         D:\Softwares\NodeJs\node-v24.21.0\npm.cmd
```

已验证版本：

```text
Node.js v24.21.0
npm     11.19.0
```

当前命令行默认 Node.js 仍为其他版本，因此不能直接依赖 `node`、`npm` 在 PATH 中的解析结果。

Java、Maven、Python 均不是本工程安装、开发、测试、构建和运行的必要条件。外部工具验收由用户另行执行，不在本工程配置相关环境。

## 5. npm 源与 SheetJS 包

### 5.1 项目级 npm 源

项目根目录的 `.npmrc` 固定使用：

```ini
registry=https://registry.npmjs.org/
```

原用户级配置中的 `https://registry.npm.taobao.org/` 已出现超时，本项目不会使用该旧地址。准备阶段曾选择 `https://registry.npmmirror.com/`，但首次安装发现其 `@playwright/test@1.65.0` 与依赖的 `playwright@1.65.0` 同步不一致，因此改用已验证可连通的 npm 官方源。官方源的 `playwright-core` 最新完整版本同样滞后于 1.65.0 元数据，所以本项目将 Playwright 固定为三者完整一致的 1.64.1。

项目级配置只影响当前工程，不需要修改其他项目使用的全局配置。

### 5.2 SheetJS

SheetJS 压缩包已移动并验证为：

```text
third_party/sheetjs/xlsx-0.20.3.tgz
```

该压缩包内容确认为：

```text
package name: xlsx
version:      0.20.3
module:       xlsx.mjs
types:        types/index.d.ts
```

`package.json` 已使用以下本地依赖路径：

```json
{
  "dependencies": {
    "xlsx": "file:third_party/sheetjs/xlsx-0.20.3.tgz"
  }
}
```

该安装包已随仓库提交（服务器克隆后 `npm ci` 即可安装，无需外部网络）。若需要升级版本，可从 SheetJS 官方 CDN 下载新版本并替换：

```text
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

SheetJS 官方 CDN 不经过 npm registry。

## 6. 安装、开发、测试与构建

> 工程配置和依赖已经安装，`node_modules/` 与 `package-lock.json` 已生成。后续开发使用下面的绝对路径命令；功能尚未完成的模块会在实现过程中逐步补齐测试。

### 6.1 打开 PowerShell 并设置当前会话变量

```powershell
Set-Location 'D:\Code\Front\data-convert-tools'

$NodeHome = 'D:\Softwares\NodeJs\node-v24.21.0'
$Node = Join-Path $NodeHome 'node.exe'

& $Node --version
& $Node 'scripts\npm.mjs' --version
```

每个新的 PowerShell 窗口都需要重新定义这些变量。它们只存在于当前会话，不修改系统 PATH。

后文所有 npm 操作都通过 `& $Node 'scripts\npm.mjs' ...` 执行。该启动器从 `process.execPath` 定位同一安装目录下的 `npm-cli.js`，并只在子进程内将 Node 24 放到 PATH 首位，避免 npm 生命周期脚本误用系统 Node 18；不会修改系统环境。

不安装依赖即可执行的骨架检查：

```powershell
& $Node 'scripts\verify-skeleton.mjs'
```

该脚本只验证纯 TypeScript 工具函数、纯模型模块、本地 SheetJS 路径和 `package.json`，不能替代依赖安装后的类型检查、Vitest 与构建。

### 6.2 安装依赖

首次安装或依赖发生变化时：

```powershell
& $Node 'scripts\npm.mjs' install
```

已经存在完整 `package-lock.json`，并且本地 SheetJS 压缩包存在时，可使用干净安装：

```powershell
& $Node 'scripts\npm.mjs' ci
```

`npm ci` 会重建 `node_modules`，日常修改依赖时使用 `npm install`，不要为了普通启动反复执行 `npm ci`。

### 6.3 启动开发环境

```powershell
& $Node 'scripts\npm.mjs' run dev -- --host 127.0.0.1
```

打开命令输出的本地 HTTP 地址。开发服务器只用于提供静态页面、JavaScript、Worker 和 WASM 文件，不接收或上传用户数据。

### 6.4 类型检查与单元测试

```powershell
& $Node 'scripts\npm.mjs' run typecheck
& $Node 'scripts\npm.mjs' run test
```

计划的单元测试范围：

- DBF 文件头、字段描述和记录读取；
- DBF 写入及 JS 读写回环；
- JavaDBF 基准样本的字段和值断言；
- 中文编码及字段字节长度；
- 日期、逻辑值、NULL、数值精度和溢出；
- CSV 引号、换行和编码；
- XLSX 工作表及单元格读取；
- 列选择、类型推断和 DBF 字段映射。

### 6.5 浏览器端到端测试

安装 Playwright Chromium 并运行端到端测试：

```powershell
& $Node 'scripts\playwright.mjs' install chromium
& $Node 'scripts\npm.mjs' run test:e2e
```

`playwright.mjs` 只给 Playwright 子进程设置项目内的 `.cache/ms-playwright` 路径，不修改系统环境。测试服务器默认使用独立的 `127.0.0.1:4174`，如端口被占用可通过 `PLAYWRIGHT_PORT` 调整。

### 6.6 生产构建

```powershell
& $Node 'scripts\npm.mjs' run typecheck
& $Node 'scripts\npm.mjs' run test
& $Node 'scripts\npm.mjs' run build
```

构建结果输出到：

```text
dist/
```

本地检查生产构建：

```powershell
& $Node 'scripts\npm.mjs' run preview -- --host 127.0.0.1
```

### 6.7 计划提供的 npm scripts

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run typecheck` | Vue/TypeScript 类型检查 |
| `npm run test` | 运行 Vitest 单元测试 |
| `npm run test:watch` | 监听并运行单元测试 |
| `npm run test:e2e` | 运行 Playwright 浏览器测试 |
| `npm run build` | 类型检查并生成 `dist/` |
| `npm run preview` | 本地预览生产构建 |

实际使用时均通过 `& $Node 'scripts\npm.mjs' run ...` 调用，而不是依赖 PATH 中的 Node/npm。

## 7. 静态部署说明

`dist/` 可以部署到任意静态 HTTP/HTTPS 服务，不需要 Node.js 后端和数据库服务。

部署要求：

- 通过 HTTP/HTTPS 访问，不以双击 `file://` 方式作为正式运行方式。
- JavaScript、Worker 和 `.wasm` 文件应保持构建后的相对路径。
- 服务器应正确使用 `application/wasm` MIME 类型提供 WASM 文件。
- 如果部署在子路径，需要在 Vite 中配置对应的 `base`。
- SheetJS、sql.js 和 WASM 资源均随工程本地分发，不依赖运行时外部 CDN。

第一版使用内存数据库时，不需要 OPFS 和额外跨域隔离配置。后续如果引入需要跨域隔离的持久化方案，再单独补充部署响应头。

## 8. 页面布局与使用流程

### 8.1 计划页面布局

```text
┌──────────────────────────────────────────────────────────┐
│ 导入文件 │ 新建工作区 │ 导出 │ 当前任务和状态             │
├──────────────┬───────────────────────────────────────────┤
│ 数据表/字段  │ SQL 编辑器                                │
│              │ 关键词、表名、列名补全                    │
│              ├───────────────────────────────────────────┤
│              │ 查询结果 / 数据预览 / 诊断信息            │
│              │ 分页、行数、耗时、导出当前结果            │
└──────────────┴───────────────────────────────────────────┘
```

列选择、字段映射和导出参数使用对话框或侧栏完成。

### 8.2 导入 DBF

1. 点击“导入文件”，选择本地 `.dbf` 文件，或拖放到导入区域。
2. 页面显示文件版本、字段、记录数和编码选项。
3. 如果中文出现乱码，手工切换 GBK/GB18030 等编码并重新预览。
4. 确认字段和记录预览后，导入 SQLite 工作数据库。
5. 左侧显示工作表名和字段，SQL 编辑器同步更新补全 Schema。

当前 `sample-data/dbf/` 中的 DBF 已脱敏，可作为工程内部兼容测试输入。长期自动测试仍会保留最小二进制夹具，避免只依赖单一文件。

### 8.3 导入 XLSX

1. 选择 `.xlsx` 文件。
2. SheetJS 读取工作簿，页面列出工作表。
3. 选择需要导入的工作表和表头行。
4. 预览数据并选择全部或部分列。
5. 使用快速抽样或全量扫描推断列类型。
6. 人工修改列名、目标类型、DBF 长度和小数位。
7. 确认警告后导入 SQLite。

如果某个工作簿包含多个需要处理的工作表，可分别导入为不同工作表。

### 8.4 导入 CSV

1. 选择 `.csv` 文件。
2. 设置或确认 UTF-8、GBK 等文件编码。
3. 确认分隔符、引号和表头。
4. 预览并修正列选择及类型推断。
5. 导入 SQLite。

CSV 中的 `00123`、混合日期、空字符串和布尔值不能只依赖解析器的自动类型转换，需要由统一推断规则处理。

### 8.5 执行 SQL

导入后，SQL 编辑器提供：

- SQLite SQL 高亮；
- 关键词补全；
- 表名补全；
- 列名补全；
- 导入或建表后的 Schema 自动刷新。

计划快捷键：

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+Space` | 主动触发补全 |
| `Ctrl+Enter` | 执行当前语句或当前选中的语句 |

典型查询：

```sql
SELECT *
FROM "导入表名"
LIMIT 100;
```

查询结果按页读取，页面只保留当前页数据。错误信息、返回行数和执行耗时显示在结果区域。

支持以查询为主，同时可由 SQLite 执行 `INSERT`、`UPDATE`、`DELETE`、`CREATE TABLE` 和事务等常用 SQL。需要长期保留的修改必须导出 SQLite 或其他文件。

### 8.6 导出

导出时首先选择数据来源：

- 当前查询结果；
- 当前数据表；
- 整个 SQLite 工作数据库，仅适用于 SQLite 文件导出。

然后选择目标格式：

| 目标格式 | 主要选项 |
| --- | --- |
| DBF | 字段名、字段类型、长度、小数位、编码、严格/兼容模式 |
| SQLite | 文件名、需要保留的工作表 |
| XLSX | Sheet 名称、导出列 |
| CSV | 编码、UTF-8 BOM、分隔符、导出列 |

DBF 严格模式遇到溢出、不可编码字符或不支持类型时停止；兼容模式只有在用户明确允许后才进行截断、改名或类型降级，并生成完整警告。

未选择任何列时不能生成有效的表格文件。如果用户不手工指定类型，则使用自动推断结果。

## 9. 典型使用路径

### DBF 查询后导出 Excel/CSV

```text
导入 DBF
  → 确认编码和预览
  → 执行 SQLite SQL
  → 分页检查结果
  → 导出当前查询结果为 XLSX/CSV
```

### XLSX/CSV 转为遗留项目可读取的 DBF

```text
导入 XLSX/CSV
  → 选择列
  → 推断并修正类型
  → 设置 DBF 字段名、长度、小数位和编码
  → 执行内部校验
  → 导出 DBF
```

### SQLite 与 DBF 互转

```text
DBF → SQLite 工作表 → SQL 处理 → SQLite 文件
SQLite 文件 → 选择表或查询 → 字段映射 → DBF
```

## 10. DBF 内部测试与外部验收边界

本工程不包含 Java 代码，也不包含外部工具验收任务。最终兼容性由用户在工程外使用其他工具自行验收，不作为安装、测试或构建的依赖。

工程内部采用：

1. **脱敏 JavaDBF 基准样本**：验证实际 VFP `0x30`、C 字段、NULL 位图、编码和头部布局。
2. **二进制边界测试**：对 `C/N/F/Y/D/L/I/T/B` 的字段描述和记录字节建立独立预期值。
3. **JS 自动测试**：覆盖 Reader、Writer、读写回环、类型映射和诊断规则。
4. **最小长期夹具**：放在 `tests/fixtures/`，避免测试只依赖 `sample-data/` 中的单个文件。

JS 自己写入、自己读取成功主要证明内部一致性，因此二进制预期值和格式规则测试同样必要。外部工具的验收结果由用户在工程外处理。

## 11. 本地文件与版本管理

`.gitignore` 默认忽略：

- `node_modules/`、`dist/`、测试报告和缓存；
- 本机环境路径说明；
- `sample-data/` 中的真实数据；
- 根目录 `.tgz`（`third_party/sheetjs/` 中 SheetJS 固定版本安装包已随仓库提交）；
- 本地导出结果和日志。

不要全局忽略所有 `.dbf`、`.xlsx`、`.sqlite` 文件，否则脱敏后的最小测试样本也无法提交。

换机后只需要恢复 Node.js 和本地测试数据，再执行 `npm ci` 或 `npm install`（SheetJS 安装包已随仓库提交，无需单独恢复）。

## 12. 首版实施结果与后续可选项

首版已经完成：

- Vite + Vue 3 + TypeScript、绝对 Node/npm 启动器和锁定依赖；
- VFP `0x30` DBF Reader/Writer、`C/N/F/Y/D/L/I/T/B`、GBK、NULL 位图、删除标志和原头部保留；
- 单 Worker、sql.js、常用 SQL、多语句、事务、结果物化和分页；
- CodeMirror SQLite 高亮、关键词/表名/列名补全；
- SheetJS/Papa Parse 导入、列映射、类型推断和高精度保护；
- DBF、SQLite、XLSX、CSV 导出、严格/兼容模式和诊断；
- 未保存提醒、任务串行化、当前查询结果复用及本地下载；
- 单元/集成测试、真实 Chromium 互转测试和生产构建。

后续根据实际需要再考虑，不属于首版阻塞项：

- OPFS/IndexedDB 自动恢复工作区；
- 更大文件的流式 CSV 与导出、进一步降低 XLSX 内存占用；
- 可验证的查询取消；
- 结果表格直接编辑；
- 更细的代码分包以消除大 chunk 提示。
