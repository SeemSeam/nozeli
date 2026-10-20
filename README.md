# Nozeli 0.1alpha

独立的论文阅读、批注、编辑与AI协作桌面应用。此仓库是新的产品源码基线，不含旧Git历史、开发协作运行态、原型工程、个人数据或历史测试产物。

## 平台与前提

当前构建和实际验收仅Linux x64/Wayland。Windows/macOS尚未提供已验证的构建产物。普通用户使用生成的便携包无需Node/npm、系统OMP或Git；开发者构建建议Node.js **22.22.2+**、npm、Git、Bun **1.3.14**、原生编译工具与网络。Electron图形依赖需由系统提供。

基础阅读编辑可离线使用。AI需自行配置账号与模型；Linux受管执行需可用bubblewrap及内核namespace支持。TeX编译、TexLab、SyncTeX和JS/TS语言服务的系统Node属于可选能力。不会附带账号、密钥或OAuth数据。

## 从源码生成便携包

在干净工作区执行：

```sh
cd apps/desktop
npm ci
npm run build:pptist
npm run build:omp
cd ../..
node apps/desktop/tools/package-portable.mjs /absolute/new/release-output
```

上游输入固定commit和哈希；OMP准备目录位于被忽略的`.build/`，PPTist使用独占临时构建目录并在结束后清理。首次需要网络下载依赖与上游源码；构建失败不使用旧产品二进制作为回退。生成物包含Linux x64便携归档、当前源码归档、中文使用说明、SHA-256校验和。解压后运行`AppRun`或`nozeli`；不以root运行、不绕过sandbox。

## 开发与验证

```sh
cd apps/desktop
npm start
npm run test:host
npm run test:renderer
npm run test:electron
```

永久回归脚本与合成样本保留，测试运行数据不提交。真实模型验收脚本需要显式选择和独立账号配置，不属于普通测试，不自动发起付费请求。

## 数据与版本

应用配置/会话默认在`~/.Nozeli`，项目批注在项目自身`.nozeli`；均不属于源码。Release归档、node_modules、构建输出与原生OMP二进制不进入Git。后续开发以本目录为准，不依赖旧Nozeli开发仓库或CCB。

## 许可边界

各组件许可和来源见`apps/desktop/SOURCES.md`及vendor/runtime/assets内的许可证。尚未为Nozeli整体声明新的开源许可。此仓库用于私有源码管理；Git原生发行完整对应源码、Office AGPL义务和传递依赖分发审计尚未完成，不把本地构建成功等同于已具备对外二进制发行条件。
