# 工程脚本

后续仅放置开发、样本生成和测试辅助脚本，不放浏览器业务逻辑。

所有需要 Node.js 的脚本均由文档指定的 Node 24 绝对路径启动，不依赖系统 PATH 中的其他 Node.js 版本。

所有 npm 操作通过绝对 Node 启动项目启动器，确保生命周期子进程也使用同一 Node 24：

```powershell
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\npm.mjs' install
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\npm.mjs' run typecheck
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\npm.mjs' run test
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\npm.mjs' run build
```

重新生成脱敏 XLSX 测试文件：

```powershell
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\generate-xlsx-fixture.mjs'
```

当前可直接执行的无依赖检查：

```powershell
& 'D:\Softwares\NodeJs\node-v24.21.0\node.exe' 'scripts\verify-skeleton.mjs'
```
