# Windows alpha.6 本地整合记录（2026-11-09）

后续生产功能与当前包已更新，见[Windows 外部启动持久队列](windows-alpha6-external-routing.md)。下文保留本次上游整合批次的原结果。

当前已进一步整合到上游已合并 PR27 的 main `cb07c5180c85ca0e127ddc332089300498103cc5`（最终 PR HEAD `b72e744`）。本批 15 文件增量、Windows 检查点隔离 Git 长路径补修、新 ZIP 与源码／解压四宿主／实际 GUI 结果见 [最终合并版记录](windows-alpha6-pr27-merged.md)。下文 `5fbc482`、Draft 状态、旧 ZIP 和旧统计为首批历史，不是当前 HEAD；完整 Windows 产品资格仍未通过。

## 首批 alpha.6 整合历史

当前成果是可审查的本地 Windows x64 整合工作区与独立验证 ZIP；**不是 Windows 正式发行资格通过**。原 Windows 工作树的 311 个修改／新增文件均与迁移前 SHA-256 一致。

## 上游与工作区

- 官方 `v0.1.0-alpha.6`：`9a2466a847267620747b79f9c1b97fbac8f00280`。
- 最新功能 [PR #27](https://github.com/SeemSeam/nozeli/pull/27)：`feat(macos): native arm64 desktop support on alpha.6`，固定 HEAD `5fbc482d48238e9fced31f9aeb66e197090168ae`，其父为官方 alpha.6。抓取时为 open/Draft，尚未远程合并。Mac 通过项属于上游报告，不是本 Windows 主机证据。
- 工作区 `D:\nozeli_windows\nozeli-alpha6`，本地分支 `platform/windows-alpha6-pr27`；本轮代码保持未提交状态，无 push、远程 PR merge、发布或日常安装替换。原工作树 `D:\nozeli_windows\nozeli` 保留。
- 311 个 Windows 文件初分为 270 个无重叠、14 个自动合并、27 个需人工处理；最终无冲突标记。上游相对 alpha.5 实际 Git diff 为 419 文件，不采用 API 截断的 300 文件列表作为完整范围。

## 合并结果

保留 alpha.6 的 Result Memory、角色原生技能目录、项目语义初始化、永久重置与任务工作区，以及 PR27 的 Darwin 文件／持久化／进程边界、原生视图及平台 chain 合同。Windows 继续注入原生文件 HANDLE、私有目录、数据库、CAS、宿主／Pi 进程归属和恢复效果，不复制共享状态机。

Git 采用上游两遍有界字节流捕获，并在两遍都注入 Windows HANDLE 边界；保留对象摘要交叉校验。项目重新登记和重试使用原 I/O 边界；保留新 retired/foreign-owner 防误隔离逻辑。供给接口保留 Windows 显式 provisioning 和 Darwin 的 destination 抽象。共享同步继续通过平台持久化屏障。

Node 打包支持 schema2 多平台锁，加入已核对的 Windows x64 官方 ZIP，并保留 Linux/Darwin 提取。运行时收据仍为 schema1，必须核对宿主、架构、ZIP 布局和 SHA-256；不存在对应 entry 时拒绝。实际打包使用该入口，无旧二进制回退。

Windows 项目语义整理尚无完整 chain 支持：状态明确显示 unsupported，自动／显式 retry 在配置、连接 Controller、派发任务或调用模型前拒绝。永久重置在读取删除范围前拒绝。3 个新本机边界回归同时核对项目身份、源文件与草稿保留；未把拒绝测试写成初始化／删除成功。

## 本轮真实验证

证据根 `D:\nozeli-test\20261109-alpha6-integration`；总收据 `qualification.json`。

| 项目 | 结果与边界 |
| --- | --- |
| 构建 | Windows 文件组件和进程组件实际重建退出 0；28 个原生输入、4 个生成二进制记录摘要。Pi、PPTist、renderer 实际构建退出 0。依赖图仅版本元数据变化，独立复制现有相同锁定依赖；不宣称干净 npm ci。 |
| 全源语法 | 初检 1228 个 JS 文件通过；最终变更文件复检 271 个；冻结 src/dist/tests 1657 文件。 |
| 单元套件 | 813 通过 / 8 失败 / 1 跳过（822 项）；剩余 8 项停在 PERSISTENCE_UNSUPPORTED，保留原断言。 |
| 集成套件 | 766 通过 / 1111 失败 / 58 跳过（1935 项）；独立实际运行，未因默认套件的 unit 失败而跳过。 |
| focused-node | 163 通过 / 0 失败 / 1 跳过（164 项） |
| focused-electron | 163 通过 / 0 失败 / 1 跳过（164 项） |
| focused-extracted-node | 163 通过 / 0 失败 / 1 跳过（164 项） |
| focused-extracted-electron | 163 通过 / 0 失败 / 1 跳过（164 项） |
| 原生 Pi／Controller／Worker | 67 通过 / 1 失败 / 0 跳过（68 项）；实际原生 Workspace.open／公开 Controller 与 Worker 流程通过，1 失败为手工 new Workspace 未选择原生 I/O 的旧 fixture；不放宽生产持久化。 |
| alpha.6 新消费者批次 | 131 通过 / 50 失败 / 6 跳过（187 项）；包含未支持平台的 chain、初始化、永久重置、持久化和 Windows fixture 限制，未删除失败。 |
| 创建收据丢回复修正 | 2 通过 / 0 失败 / 0 跳过（2 项）；真实 Windows 文件与 CAS，保留完整终态收据、已创建文件和 committed/unknown 返回，不用旧 revision 覆盖原终态。 |
| 源码／最终解压包 GUI | 各 6 项通过；真实可见 Electron、真实 IPC、项目登记／文本 CAS／外部并发赢家／完整冷重开；renderer 错误均 0，正常退出。不代表物理 IME、Explorer 或多屏通过。 |
| 广泛 Windows 批次 | 1200 秒到限，记录 timeout；没有完整套件统计，不能声明全过。 |
| 平台探针 | 实际退出 1，managedExecution.ready=false，生产能力矩阵未改绿。 |

四组组合回归的唯一跳过项为 Linux 专用 non-dumpable 进程归属场景，不计作 Windows 通过。此前运行时资产测试中的文件符号链接权限跳过属于另一个测试组。可见 Electron 检查包含真实窗口与 IPC 保存／冲突／冷恢复，不外推为所有文档编辑表面均已完成交互验收。

集成批次按 07:23 UTC 启动时加载的清单运行，期间合并验证继续收尾；后来加入的 3 个 Windows alpha.6 边界测试已由最终冻结源码／解压包四宿主组合单独覆盖。1935 项统计不代表对最终每个文件进行了一次共同冻结的全量执行，亦不构成全套通过证据。

集成失败的观测入口代码（非独立根因数量）：'PERSISTENCE_UNSUPPORTED': 697、'PROCESS_OWNERSHIP_UNSUPPORTED': 118、'ERR_ASSERTION': 75、'EBUSY': 40、'WIN32_IO_ERROR': 34、'DEMO_TEMPLATE_INVALID': 27、'PROJECT_ROOT_OVERLAP': 26、'EPERM': 22。完整失败名、原始 TAP、命令和退出码保存在证据目录。

修正了原生技能测试的 Windows 路径分隔符假设，以及终端 fake 的新 baseline 调用合同。两份 Archify 许可证被 Git autocrlf 改字节；核对 HEAD 原始 blob 与既有摘要后恢复原字节，并设置该固定 vendor 目录 `-text`，没有修改摘要清单迁就错误字节。

## 验证包

- `D:\nozeli-test\20261109-alpha6-integration\desktop-package-final\Nozeli-windows-alpha6-qualification.zip`，SHA-256 `44a0b6ea4e7d9b337371b01dc7aad716aa02d8580a3c218444d4aa66cf364d6f`。
- 43543 个文件；ZIP CRC 与全部解压文件摘要通过；当前 src/dist/tests、原生生成物及其输入、Pi manifest 闭包逐项一致。
- 实际解压目录包含中文和空格；系统 PATH 只保留 Windows System32 时，Node/Git/Pi 均解析到包内。解压包 Node 与 Electron Node 模式执行同一组合回归；实际解压 GUI 冷恢复通过。
- 首个 `desktop-package` 在测试 fixture 更新后被一致性检查拒绝；失败包、manifest 和日志保留。最终 `desktop-package-final` 先核对所有已构建闭包原字节，使用最终 src/dist/tests 重新生成独立 ZIP、重新解压并再次验证。
- 这是包含合成测试 harness 的本地验证包，不是安装器；未签名、未发布、未安装进日常目录。

## W0–W5 仍需推进

| 门 | 本轮状态 | 剩余工作 |
| --- | --- | --- |
| W0 | 本机源码／原生构建可追溯 | 干净普通账号依赖安装和完整可重现环境资格 |
| W1 | 显式原生组件通过部分回归；产品门 unsupported | 生产 safe-file/persistence 选择、剩余调用点与全部故障／恢复资格 |
| W2 | 显式 Pi／Controller／Worker 流程已测；产品门 unsupported | 生产归属和完整冷恢复、未决结果落账与实际回收资格 |
| W3 | unsupported | 权限／提权／隔离原生实现及验收 |
| W4 | 实际桌面保存／冲突／冷恢复部分通过；全门 unsupported | 新语义初始化与永久重置、回收站／终端／TeX等未资格化消费点、物理 IME／Explorer／多屏 |
| W5 | 本地验证 ZIP 通过；全门 unsupported | 安装器、干净机器、升级／回滚／签名／发行资格 |

外部启动恢复队列组件已随 Windows 改动迁入，但 main 仍使用内存 externalFiles／takeOpen；组件测试通过不等于主界面外部启动已具备持久恢复。下一阶段应优先收敛生产文件／持久化和进程归属调用点，再打通 alpha.6 新功能，随后完成安装／升级资格。

## 保留的 alpha.5 基线

`D:\nozeli-test\20261109-alpha5-open-queue` 的默认套件已结束：unit 665 通过／0 失败／1 跳过；integration 681 通过／1009 失败／50 跳过。其队列原生测试、helper 三宿主、源码／解压 GUI 和 ZIP 摘要属于 alpha.5，不能算入本轮 alpha.6 通过证据。
