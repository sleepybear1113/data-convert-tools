# 依赖版本与兼容策略

## 当前结论

当前 Vue 可以使用并已使用最新的 `3.5.45`。安装后的依赖树没有缺失依赖或 invalid peer，Pinia、Naive UI、Vite 插件和 Vitest 均复用同一个 Vue 版本。

“Vue 使用最新稳定版”不等于“所有包都直接取 latest”。本项目按完整兼容组合固定版本，并通过 `package-lock.json` 锁定实际安装结果。

## 已验证版本矩阵

| 包 | 当前版本 | 兼容情况 |
| --- | --- | --- |
| Node.js | 24.21.0 | 满足 Vite、Vitest、Naive UI 和 Playwright 要求 |
| npm | 11.19.0 | 与 Node 24 同目录使用 |
| Vue | 3.5.45 | 当前最新稳定版，整个依赖树正确去重 |
| Pinia | 4.1.0 | 要求 Vue `^3.5.11`、TypeScript `>=5.6`，均满足；使用 `@vue/devtools-api@8.2.1` |
| Naive UI | 2.45.3 | 要求 Vue 3，内部 Vue 依赖均去重为 3.5.45 |
| Vite | 8.3.6 | 要求 Node `^20.19.0 || >=22.12.0`，Node 24 满足 |
| @vitejs/plugin-vue | 6.0.10 | 支持 Vue `^3.2.25 || ^3.6.0-rc.10`、Vite 5～8，当前匹配 |
| Vitest | 5.1.0 | 支持 Node 24，与 Vite 8.3.6 共用同一版本 |
| TypeScript | **5.9.3** | 满足 Pinia 和 vue-tsc；不能使用当前 TypeScript 7 组合 |
| vue-tsc | 3.3.14 | 与 TypeScript 5.9.3 工作正常 |
| @playwright/test | **1.64.1** | `playwright` 和 `playwright-core` 均为 1.64.1，版本链完整 |
| CodeMirror | 6.0.2 | CodeMirror 6 系列 |
| @codemirror/lang-sql | 6.10.0 | 提供 SQLite 方言及 Schema 补全 |
| sql.js | 1.15.2 | 浏览器/Node WASM 引擎，与 Vue 无耦合 |
| SheetJS `xlsx` | 0.20.3 | 使用项目本地官方 tgz（随仓库提交），不经过 npm latest |
| Papa Parse | 5.7.0 | 浏览器 CSV 解析 |
| iconv-lite | 0.7.3 | 自带类型声明；浏览器端配合最小 Buffer polyfill |
| buffer | 6.0.3 | 仅用于 iconv-lite 的浏览器 Buffer 兼容 |
| string_decoder | 1.3.0 | 仅用于 iconv-lite 的浏览器 string_decoder 兼容 |
| decimal.js | 10.6.0 | 自带类型声明 |

## 不能直接升级的项目

### TypeScript 不直接使用 7.x

初次使用 TypeScript `7.0.2` 时，`vue-tsc` 无法解析 `typescript/lib/tsc` 包导出。当前固定为 `5.9.3` 后类型检查正常工作。

升级 TypeScript 大版本前，需要同时确认：

- `vue-tsc` 的发布说明和实际入口解析；
- Volar 插件兼容；
- Vite、Vitest 和 Node 类型声明；
- 完整的 typecheck、test、build 结果。

### Playwright 固定为 1.64.1

准备阶段 registry 中曾出现 `@playwright/test@1.65.0` 和 `playwright@1.65.0`，但依赖的 `playwright-core@1.65.0` 尚未提供完整发布，导致安装失败。

当前三个包统一为 `1.64.1`。升级时必须同时确认：

```text
@playwright/test
playwright
playwright-core
```

三者版本完全一致，然后重新安装对应 Chromium 并运行端到端测试。

## 浏览器 polyfill

`iconv-lite` 依赖 Node 的 `buffer` 和 `string_decoder`。Vite 默认会将它们外部化，曾导致真实 Chromium 中 Worker 启动失败。项目在 `vite.config.ts` 中只将这两个名称精确 alias 到本地浏览器包，没有引入完整 Node polyfill 插件。生产构建和真实 GBK 导入均已验证。

## 类型声明版本说明

- `@types/sql.js@1.4.11` 的类型声明可能落后于 `sql.js@1.15.2` 的新 API；基础数据库 API 可用。若确实缺少新声明，优先使用局部模块增强，不因类型问题随意降级运行时。
- `@types/papaparse@5.5.2` 与 `papaparse@5.7.0` 的基本 API 兼容，新增 API 使用前检查声明。
- 不安装 `@types/iconv-lite` 或 `@types/decimal.js`，当前运行时包已自带声明。

## Node 绝对路径启动器

仅执行绝对路径的 `npm.cmd` 仍可能让 npm 生命周期脚本从系统 PATH 找到 Node 18。项目使用：

```powershell
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\npm.mjs' run typecheck
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\npm.mjs' run test
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\npm.mjs' run build
```

`npm.mjs` 通过 `process.execPath` 定位同目录的 `npm-cli.js`，并只给子进程补充 Node 24 的 PATH 优先级，不修改系统或其他项目环境。

## 升级流程

1. 不批量执行 `npm update` 或把所有依赖改成 `latest`。
2. 每次只升级一组相关依赖并记录原因。
3. 使用绝对 Node 启动器执行安装。
4. 检查 `npm ls`、peer dependency 和 lockfile。
5. 依次运行 typecheck、unit tests、build、Playwright。
6. Playwright 升级后重新安装匹配 Chromium；SheetJS 升级则从官方 CDN 获取新的固定版本包。
