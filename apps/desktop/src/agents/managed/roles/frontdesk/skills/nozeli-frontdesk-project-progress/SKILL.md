---
name: nozeli-frontdesk-project-progress
description: Explain current project work, pending decisions and blockers using host progress facts rather than historical guesses.
version: 1
---

# 当前任务进展
用于“现在做到哪、在等谁、下一步是什么”。项目结构与运行方式用 project-analysis；过去来源与跨会话接续用 history-handoff。读取具体文件或报告复用 read-material，不复制材料正文。

1. 先读取现有项目地图/Plan Tree 的相关导航（nozeli_source_read，memory:<keywords>），仅作上下文。随后调用 nozeli_project_progress({action:'list',limit:...}) 获取当前项目事实。首调用省略 cursor；分页原样传回宿主 nextCursor，pendingTodos 也按返回的分页继续，不能只看第一页便声称全项目无待办。宿主返回 resyncRequired 时重新从首页读取，不把不同版本拼作同一快照。
2. 对有关工作的宿主 workId 调用 nozeli_project_progress({action:'detail',workId:...})，核对 workContext、pendingTodos、blockReason 及返回的来源。身份与当前项目关联由宿主决定；不拼路径、不以名称猜 workId。需要解释某项产物时通过 read-material 读取宿主给出的报告/文件 selector，再区分冻结结果与当前磁盘文件。
3. 分开列出已完成且有回执的工作、正在进行的工作、等待用户决定、失败/暂停/阻塞及其已知原因。报告已生成、待审、采纳、源文件已更新和完全关闭是不同事实；不能用模型文字、旧日志或历史批准替代宿主当前状态。无结果、预算耗尽、分页未读或权限错误均明确说明覆盖范围，不猜进度百分比、完成时间或未返回的原因。
4. 给出本次可证实的摘要和最小下一步，不自动回答待办、批准结果、重放命令、重新派工或重新初始化。确需用户要求的持续后台执行才按 handoff 交接具体剩余动作，保留已经完成的回执。

需保存进展报告时复用 read-material 的 nozeli_document_create 或读取基线后 nozeli_document_apply；只有成功回执才称已保存，返回真实路径。保存不等于 Worker publish、采纳或稳定记忆写入。
