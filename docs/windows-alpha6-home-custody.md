# Windows alpha.6 原 owner home 目录身份保管

承接 v49 冷证据归档，固定 alpha.6＋已合并 PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`。本批补齐原 owner home 目录身份的 native custody；完整恢复材料、资源释放和 W0–W5 整体验收继续保留为未完成。

启动服务初始化时保留原 home 的受限目录链，在 owner 首次 resume 前将同一目录实体、完整父链及私有 ACL 的原始 HANDLE 复制给 helper。新增 ownerHome 原生角色；Manifest 只允许一个该角色，并要求完整原 host/source 角色同时存在。HANDLE 数值不进入 JavaScript 或持久化记录。原生 ABI 版本 4，supervisor 协议版本 10，旧 helper 不兼容时明确拒绝。

helper 的原始 custody 摘要包含 home File ID、属性和 ACL；每次请求检查这些原实体。endpoint/snapshot 返回原生计算的 home File ID，重连时与实际 helper 回应核对。cold journal 检查和归档分别比较原 helper 的目录身份与通过 native 路径链重新打开的 home。目录身份保持不冻结可变日志内容，也不证明全部恢复材料的全生命周期完整性；归档继续核对文件、输入输出、业务及本机账本，原 helper 和 home 保留。

实际回归增加：原 pin 关闭后 home rename 被 helper 拒绝，日志仍可写；伪造/关闭原生目录能力被拒绝；伪造 endpoint home File ID 被实际 helper 揭穿。真实 Controller/Pi 宿主退出后，对各原 home 实际尝试 rename，并验证归档副本目录身份来自原 helper，随后进行真实 Controller 接管与常驻进程启动。独立解压包必须重复验证。

本批证据根 `C:\nozeli-test\20261110-alpha6-home-custody`。最终通过声明以 qualification/package/integrity 收据为准。早期集成错误及旧协议故障注入用例的失败保留；不回退原生二进制。

## 最终实际验证

| 实际运行 | 通过数 |
| --- | --- |
| archive-all-node-qualified | 8 |
| archive-selected-electron-qualified | 3 |
| archive-all-extracted-node-qualified | 8 |
| archive-selected-extracted-electron-qualified | 3 |
| process-node-qualified | 110 |
| process-electron-qualified | 110 |
| process-extracted-node-qualified | 110 |
| process-extracted-electron-qualified | 110 |
| cold-node-qualified | 21 |
| cold-electron-qualified | 21 |
| cold-extracted-node-qualified | 21 |
| cold-extracted-electron-qualified | 21 |
| recovery-node-qualified | 43 |
| recovery-electron-qualified | 43 |
| recovery-extracted-node-qualified | 43 |
| recovery-extracted-electron-qualified | 43 |
| journal-node-qualified | 63 |
| journal-extracted-node-isolated-serial | 63 |
| repeat-normal-node-qualified | 1 |
| repeat-normal-extracted-node-isolated | 1 |
| gui-source-qualified | 6 |
| gui-extracted-qualified | 6 |

独立解压journal原并发运行normal/forced两项启动观察超时已保留；最终包及deadline不变，其他作业结束后以文件并发1隔离重跑63项通过。仅确认隔离资格，尚未证实或修复并发原因。另两个精确失败fixture helper由原生close确认退出，未终止进程。

846次测试执行及12项GUI检查，JS1255文件；两个native组件及renderer实编，Pi未改未重编。ZIP `C:\nozeli-test\20261110-alpha6-home-custody\desktop-package-verified\Nozeli-windows-alpha6-home-custody-qualification.zip`；SHA256 `69b6621075424650e3c282b21d81a0069e08b3ba520ac974870712685621c4d2`；43629文件、1413003509展开字节、1714冻结文件。运行后完整性、原仓库311文件和helper残留0通过。

Extracted journal63 qualified only in a fresh isolated run with file concurrency one and unchanged test deadlines/package. The original concurrent run failed two startup observations and remains preserved; no concurrent pass or cause is claimed. Extracted two-death normal ran separately after isolation. Final native source and independent extraction each Node/Electron process110/cold21/recovery43; source/extracted Node journal63 and two-death normal1; Node source/extracted all eight archive modes and Electron source/extracted three key archive modes; GUI six each. The owner home test repeats sixteen actual rejected connections and checks Windows process HANDLE count. Earlier pre-cleanup positive matrices and failures are retained but not counted. Full two-death fault matrix, ordinary Worker and other old suite evidence retained separately; not rerun or counted here.

独立包实测后仅从工作树 README 移除末尾多余空行，保留已验收 ZIP，完整性收据验证这处文档差异。

早期接口误读、旧协议故障注入和真实重复拒绝HANDLE泄漏失败已保留。初次未完成ZIP原字节按分片保存，重建摘要通过；已知句柄缺陷候选以v49有效包＋差异/完整manifest/ZIP metadata保留。四个精确早期失败fixture helper由其原生close确认空Job、完整输出及退出，未终止进程。历史全量/shared失败未解决；本批未重新查询上游，main增量未整合。
