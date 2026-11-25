# Windows alpha.6 归档结果核对

本批继续固定 alpha.6＋已合并 PR27，未整合 beta.1/main。

新增 `reconcileWindowsManagedColdArchive` 只读核对入口。它接收注册项目和原归档 operation UUID，重新打开受保护的 `ui.sqlite`，读取原始 intent/ready operation receipt，核对完整归档记录、检查点、退休历史、数据库和实例目录身份，再通过 Windows 私有目录句柄校验归档根目录和 `manifest.json`。它不会提交第二次归档、接管宿主、释放 helper/home 或重放业务输入。

只存在 intent 或提交回执缺失时，结果为 `unknown`；ready 记录、回执、归档目录、manifest、历史或数据库身份有任何不一致时，结果为 `MANAGED_COLD_ARCHIVE_UNVERIFIED`，继续保留原实体。ready 归档只有在所有原提交和文件身份都核对通过后才返回 `ready-verified`，且仍保留 `originalHelpersRequired`、`ownerReleaseQualified:false` 和 `recoveryClosureQualified:false`。

存储 worker 新增只读 `compareAndPutReceipt`，用于按原始 compare-and-put 指纹读取结果，禁止借核对接口再次写入。 `ProjectStorage.localDirectory` 增加 `create:false` 选项，避免冷核对因目录缺失而创建新的实例目录。

本批已完成 Node 语法、模块导入和 `git diff --check`。原有 56 项存储回归中 48 项通过、8 项失败；用 v50 独立包在相同环境实际运行得到同样的 8 个失败名称，两份 TAP 均保留。本批新增真实 Windows SQLite 测试已通过：原始 CAS 先执行一次，关闭数据库再重开，核对接口能读取原回执；改变比较集合、目标内容、预期 revision 均拒绝，账本不变。

检查中修正了数据库 record/boundedRecord 返回对象键顺序不同导致的错误拒绝；核对使用结构化相等，原始摘要计算方式保持不变。文件核对后再次检查两次原提交指纹，随后复核归档行和记录。

测试证据在 `C:\nozeli-test\20261111-alpha6-archive-reconciliation`。`receipt-source-node.tap` 是新增回执测试通过证据。随后扩大到完整 native database 组时，新增测试先通过，其余运行因 `Fatal process out of memory: Zone` / exit 2147483651 中断；保留 `native-database-source-node.tap`，不记为整组通过。前一轮归档场景既有 Worker input-preparation 失败的根因尚未确认；另一个场景已确证 Node 原生 OOM，两者不混为同一根因。

旧候选包 staging 与各自保留的 ZIP 逐文件核对后，仅移除字节相同的临时副本。当前 C 盘已恢复数 GB，历史有效/候选 ZIP 和独立解压目录保持。原始清理脚本一次因内存不足中止，后续改用有界读取并在每次删除前写逐文件记录；中止日志保留。

完整冷归档核对尚未通过，现有 v50 ZIP 未修改，机器可用虚拟内存仍不足以运行完整 Controller/Pi 场景。等待释放内存后，需要先运行真实源码归档回归，再实际构建 renderer、打包和独立解压复验；未改动的 native/Pi 输入与 v50 构建摘要核对，不把旧二进制当本轮重建。v51 仍是开发状态，正式资格保持 v50。

## 本轮实际验证补充

渲染层已实际构建成功。新增回执测试及完整原生 SQLite 组，在源码 Node、源码 Electron、独立包内 Node 和包内 Electron 各通过 14/14，共 56 次测试执行。早期 OOM 和 8 项共享存储旧失败保留，不计为本轮通过项。

开发候选 ZIP 已生成并独立解压，CRC、43,631 文件和 1,716 冻结源码/渲染/测试/工具文件验证通过；运行后的逐文件与 ZIP 摘要复核通过。两个 native 组件的 36 项源码/二进制输入与 v50 实编记录一致，本轮未重编；Pi 同样未改未重编。候选不包含完整冷归档核对通过声明，正式通过基线保持 v50。

候选路径：`C:\nozeli-test\20261111-alpha6-archive-reconciliation\desktop-package-candidate\Nozeli-windows-alpha6-archive-reconciliation-candidate.zip`。

SHA256：`7bb892a3456b3b26eaf8b7f27172367bcc5e3dfced7fa7b8eb9108406f10bad0`。

完整 Controller/Pi 归档场景仍待释放更多系统提交内存后继续；该场景没有被上述 SQLite 回归替代。后续还需 helper/home 处置、已归档祖代的后继冷恢复、pending 协调、默认 ManagedProjects、W3/W4/W5 剩余门。
