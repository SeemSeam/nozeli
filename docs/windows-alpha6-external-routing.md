# Windows alpha.6 生产外部打开队列（2026-11-09）

后续 managed 分离目录验证与当前源码包见[最新记录](windows-alpha6-managed-roots.md)；下文保留对应批次的原始结果。

当前固定基线仍为上游已合并 main `cb07c5180c85ca0e127ddc332089300498103cc5`／最终 PR27 `b72e744`，工作树 `D:\nozeli_windows\nozeli-alpha6`。本轮将已有 Windows 原生持久队列接入正式主进程和 renderer，修复 `externalFiles.shift()` 在打开前丢弃请求的问题。完整 Windows 版本与 W1–W5 资格仍未完成。

## 产品行为

账号单实例锁仍先于任何 profile 解析、配置和 Host／Agent 创建。启动 argv、第二实例转发与早期 open-file 事件在配置 profile 就绪后按序持久接收；内存接收缓冲和队列均有上限。接收失败的请求保留稳定 ID，并在主窗口明确提示尚未持久接收、退出后不能保留；格式／容量拒绝显示数量，不能冒充已接收。

主进程从可信 shell record 产生 window／WebContents／generation／boot 身份，renderer 不传 owner。领取、读取、确认均绑定原请求；窗口重载、崩溃和关闭同步撤销代次。renderer 请求切换项目和打开文档，原编辑／组合输入／恢复屏障继续生效；升级冻结或应用退出期间不准入新领取。

打开完成必须由主进程查询实际原文档面：原生窗口可见、工作面 ready、当前分区活动视图、精确项目／路径／项目原件来源与原代次均须匹配。实际文档 renderer 还须确认已成功挂载，正文／源版本／材料／保留草稿摘要与原读取一致；独立挑战不复用普通 flush 回执。目录查询实际项目 shell。`session.takeOpen` 返回 OPEN_PROTOCOL_REQUIRED，零移除。

不支持格式、正文不符、隐藏／背景视图、源文件变化、过期确认都保留 blocked 请求。冷启动不自动重放；后续 FIFO 请求须显式打开。主窗口“外部打开”提供重试、两步移除请求、重试保存结果和重试接收。移除仅影响请求。显示后的结果落盘不确定时，显式重试只确认同一终态，不再读取或渲染第二次。

绑定的 Node 文件身份不再把 inode=0 当作原对象相同；这仍不等于完成 Windows 原生 128 位 File ID／全部命名空间对抗资格。Office 脏模型会保守保留请求，本轮不冒称所有格式草稿都能完成显示确认。

## 实际验证

证据根 `D:\nozeli-test\20261109-alpha6-external-routing`；总收据 `qualification.json`。新增 13 项路由回归使用真实 Windows profile／项目／原生队列／Host，窗口记录为模拟；正式 GUI 测试单独使用真实生产主入口、原生窗口和文档 renderer。

| 项目 | 结果与范围 |
| --- | --- |
| 四宿主定向套件 | 源码 Node／Electron、独立解压 Node／Electron各 180 项：179 通过、0 失败、1 Linux 专用跳过。 |
| 源码和解压生产 GUI | 各 8 项；各两次正常退出 0；renderer errors=0。启动参数、真实第二次启动 IPC、原文档面、unsupported 保留、FIFO 冷恢复、显式移除／重试、外部冲突与未发送草稿保留、目录确认及伪造回执拒绝。实际文档和恢复 UI 截图已查看。 |
| 相邻启动 GUI | 源码 6 项通过，项目登记、文本 CAS、外部赢家、草稿冷恢复与设置。 |
| 构建 | renderer 实际重建成功；native 输入与先前实际构建二进制未变并核对，本批未重编。依赖／Pi／PPTist闭包沿用已验证字节，未宣称 clean npm ci。 |
| 语法 | 1234 个 JS 文件通过。 |
| 完整旧失败 | 本批未重跑 full unit／safety／integration。前批 unit813/8/1、safety12/25/16 与历史 integration 失败继续保留；局部通过不能抹去它们。 |

新测试覆盖 actual-display challenge、外来 owner／未知字段拒绝、正文／版本／材料不符、不可见／背景视图、明确移除、终态落盘屏障失败后的零重读重试、接收不确定与 FIFO、原代次失效和冷启动不重放、精确保留草稿、目录及读后外部源变化。唯一跳过为 Linux non-dumpable 场景，不计 Windows 通过。

CLI／CDP驱动和原生 view 内容是本轮范围，物理 Explorer、关联安装、IME、触摸、屏幕遮挡与多显示器仍未签收。共享主入口已改，Linux／macOS生产流程本轮未实测。

## 当前验证包

- 路径：`D:\nozeli-test\20261109-alpha6-external-routing\desktop-package-final-v2\Nozeli-windows-alpha6-external-routing-qualification.zip`。
- SHA256：`818e26fe939ceeb98e9eb107ce192c9dac6bdbb608683ea8357f03cee3c55283`。
- 43578 文件、1412354123 展开字节；独立中文／空格路径解压、CRC 和全部文件 SHA 复核通过。当前 src／dist／tests／tools 共 1692 文件逐摘要一致。
- 仅 System32 PATH 下解析随包 Node／Git／Pi 通过；没有使用开发机 Git／Node 代替包内运行时。
- 本地资格包含合成测试 harness，不是安装器；未安装、签名、公开发布、提交或推送。

打包暂存曾通过硬链接复用不可变依赖闭包；最终 ZIP 与解压文件独立。旧解压目录两份说明文件被写入时未先断开链接，已从未改动的原 ZIP 按原摘要恢复，旧解压全部 43543 文件复核一致。原因、恢复和原始执行脚本摘要保留；可复用打包辅助脚本已补先断链保护。这次修正没有修改产品源码或最终已验证 ZIP。

## 中间失败与保留

首轮路由组13通过／7失败／4取消：测试将 begin 返回的项目／路径也传入只允许令牌字段的 confirm；修正驱动后24/24通过。首GUI缺窗口调整测试标志；随后用普通 UTF-8 的 .xyz 假定 unsupported，但产品正确识别为文本，改成真实二进制 fixture。草稿复验还暴露测试时序：产品自动保存可能先完成，使草稿为 null；最终用真实独立外部版本冲突固定未保存草稿，未禁用产品定时器或放宽保留断言。所有原件保留。

首两个候选包在冻结之后分别补 main 退出／升级门控和 GUI fixture 修正，均被打包末尾的一致性断言拒绝，结果保留 failed。仅 `desktop-package-final-v2` 为当前一致且完成四宿主与GUI验证的包。

## 未完成与下一步

继续收敛生产安全文件／持久化／进程归属选择和 pending／tools／projection／owner 冷恢复，再推进 alpha.6 初始化／永久重置、Work-Git 接受闭环、终端／TeX／回收站及 Office 更广工作面。完整 128 位原生对象绑定、命名空间／断电、物理桌面、普通账号干净安装、升级回滚、依赖与签名发行仍待验。原 W0–W5 范围不变，生产矩阵不因这组局部结果放宽。
