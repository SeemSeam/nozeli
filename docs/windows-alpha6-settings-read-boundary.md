# Windows Pi 配置实际读取版本

2026-11-12，v55 定向验证完成，固定 alpha.6＋已合并 PR27。正式基线保持 v50。本批证据写入 `D:\nozeli-test\20261112-alpha6-settings-reads`；完整 Windows 资格和原 helper/home 释放仍未完成。

## 读取与更新

SDK 的 FileSettingsStorage 原来使用 Node 路径读取、proper-lockfile 和 writeFileSync；驱动 getCurrentModelSettings 还直接重读两个 JSON。配置在 home 外时，冷树复制不能证明实际使用了哪个版本。新 settings-io 使用 SDK SettingsManager.fromStorage，不替换其解析、迁移、项目优先级、信任或字段合并规则；显式 Windows owner 在配置管理层和角色会话均注入同一 I/O 实例。

每次 SDK 回调先通过原生父目录链和文件 HANDLE 读取至多 1 MiB，拒绝 reparse、hardlink、非 NTFS、共享冲突及变化。普通项目目录只观察原 ACL，不强制改成私有；全局配置沿原私有 agentDir 打开。缺失 `.pi` 或文件产生明确缺失观察，不在读取时创建目录。给 SDK 的字符串由同一份保留字节解码；BOM、JSON 解析错误、旧字段迁移继续由 SDK 处理。

读取字节先通过私有 staging、文件 flush、create-only 发布和目录 barrier 写入 agentDir/settings-reads。记录含 stream UUID、序号、前一记录摘要、scope、绝对来源、项目/父目录/文件身份、字节长度及摘要。相同进程 flush 返回该流的 head 和读取数，并进入原 stdout；后继 owner 使用独立 stream，不能将序号重启冒充旧流续接。此记录不是自身可授权的冷数据库，独立恢复读取和原 stdout 集合校验仍须另行接入。

更新保留 SDK 在写入时重读并合并 dirty fields 的语义。实际回调结束后，原生 TxF 锁定目标并同时比较 FileID 与读取字节，再创建候选并提交；同字节复制实体和外部修改均拒绝。原文件 ACL 随 replacement 保留。缺失文件使用 create-only 发布；首次创建项目 `.pi` 保留普通继承 ACL，并完成目录 barrier。原生 replacement 新增只读 stat 以比较实际锁定目标身份，filesystem 与 process 组件同时重建。

证据发布或写入提交后 barrier/清理结果未知时，存储实例进入不可继续使用状态，SDK 不能吞掉存储错误后继续返回旧模型或重试写入。驱动直接模型查询与登录 deviceId manager 创建也走可选 host 接口；未提供接口的驱动行为保留。配置解析错误仍经 SDK drainErrors 暴露，修复后可 reload。

## 验证与后续

真实合成 Windows 测试覆盖项目优先级、BOM 与旧字段、无关设置保留、reload、缺失创建、并发赢家、同字节实体替换、坏 JSON、junction/hardlink 拒绝及发布后 barrier 失败。真实 Pi owner 覆盖启动、一次本地模型回合、外部配置更新、SDK reload、摘要链和零重放。最终精确结果见本批 development-status.json；进行中结果不能计通过。使用隔离环境与合成本地 Provider，无个人配置或付费模型请求。

本批不证明 models/auth、动态 import/node_modules、角色文件、metadata 替换或 journal 追加的完整生命周期闭包。证据记录没有独立完成 host 原生 custody、冷归档全量绑定、只读恢复验证和祖代释放后的二次冷恢复，原 helper/home 必须保留。SDK PackageManager 仍可能枚举自动发现目录，未宣称零外部枚举。跨平台共享驱动只在 Windows 执行；W0–W5 的普通账户复现、pending/default ManagedProjects、终端/TeX/回收、桌面交互、安装升级回滚和签名发行仍未完成。


最终定向验证：源码Node/Electron完整Pi各56/56、Provider各26/26；两种源码与两种包宿主各配置9、资源技能11、原生读写23、替换ACL持久化49、进程25通过。独立包各实际owner6、Worker布局2通过。包内通用Provider测试部分仍按旧仓库相对路径导入bridge/ZAI，26通过不计当前包bridge资格；原结果与局限保留，当前包bridge由runtime-root-aware的配置/资源/真实owner/Worker场景验证。运行后核对43639包文件、1793冻结输入、36项原生输入/输出；ZIP SHA256 `189565b3fcb6acd739a7aed3e9013d4762ec530531bc3f81727ca6f7fc8a554e`。这些结果只授予本批范围，不授予完整Windows或冷资源释放资格。
