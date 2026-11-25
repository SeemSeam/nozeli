# Windows 原生显式续作防重放意图

2026-11-12，v53开发候选，固定alpha.6＋已合并PR27。正式v50基线保持；本批不是完整冷接管、资源释放或默认ManagedProjects资格。

## 修复及合同

实际核对发现 OwnerRuntime.recover 在恢复意图发布时仍直接调用 Node open/fsync，bridge 的 open 导入已在前批 journal 原生迁移时移除；Windows目录也不能通过这种只读Node目录句柄取得此前已验证的FlushFileBuffers合同。该路径在副作用前会失败。

本批把意图的探测与首次发布放进Pi平台I/O：Windows沿原private root固定父链，私有stage写入并同步、create-only发布、父目录屏障与后检查；既有意图不覆盖。发布后屏障或关闭失败返回PI_PERSISTENCE_UNCONFIRMED并保留原文件；没有成功返回不派发续作，后续观察仍被原意图栅栏阻断。namespace仍not-qualified，不外推真实断电耐久性。非Windows沿既有wx/文件和目录同步行为，实际仅Windows验证。

恢复检查复用同一已同步journal字节的严格内存SDK视图，不再flush之后SDK.open二次按路径读取或迁移。原请求/任务/用户条目/叶ID继续精确核对；旧叶、未决工具效果和既有意图都拒绝。已完成journal仅返回原结果，不再请求模型。没有为Windows另造Controller或Work状态机。

## 实际验证与限制

源码Node/Electron各3项原生意图测试与2项实际Pi续作通过：create-only竞争保留原赢家、独立进程读原栅栏、实际发布后注入目录屏障失败、reparse/根外拒绝；真实本地Provider的取消后显式续作、原回复丢失、旧叶拒绝、已完成结果核对，原输入只登记一次。仅合成项目/本地Provider，没有付费调用。扩展断言首次因故障注入器持续吞掉后续只读完成结果失败，改为仅丢第一次回复后通过，原失败保留。

完整源码回归、包摘要及独立包验证以 `D:\nozeli-test\20261112-alpha6-recovery-intent\development-status.json` 为准。恢复材料全生命周期、SDK外部配置/角色runtime依赖、helper/home处置、祖代处置后的再次冷恢复、pending显式协调/default入口和W0–W5剩余门仍未完成。

## 本批验证收尾

源码 Node/Electron 完整 Pi 各54/54；源码及独立包 Node/Electron 原生意图各3/3、实际续作各2/2；独立包 Worker 两布局各2/2通过。Pi实际重建，renderer/native未改未重编，核对36项原构建输入/输出。ZIP43633文件、冻结1734输入及包摘要通过，SHA256 `ba12c985c791644ebb0df8d23822938cb966f8b667f35a72f866b080f83f6739`。四宿主ready丢回复已完成4/4，以本批development-status.json和原始TAP/JSON为准，不提前计通过。

完整恢复材料生命周期、metadata/journal实体交接、项目配置/角色runtime依赖、独立恢复读取和原helper/home释放、祖代处置后二次cold、pending/default入口、终端/TeX/回收/物理桌面/普通账户安装更新回滚及剩余W0–W5继续未完成。v50正式基线保持，v53仅开发候选，固定alpha.6＋已合并PR27。没有安装替换、提交、推送、签名或发布。
