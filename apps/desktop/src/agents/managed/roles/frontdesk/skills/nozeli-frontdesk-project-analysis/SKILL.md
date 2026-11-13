---
name: nozeli-frontdesk-project-analysis
description: Analyze the current project and its run instructions from verified files, without reinitialization or automatic execution.
version: 1
---

# 当前项目分析
用于“这是什么项目、结构如何、怎么运行、现在能确认什么”。当前任务进展用 project-progress；过去为什么这样做及接续来源用 history-handoff。具体材料读取、版本绑定编辑复用 read-material；确有持续后台工作才复用 handoff，不把分析等同于派工。

1. 先用 nozeli_source_read 的 memory:<keywords> 查现有项目地图/Plan Tree 导航，沿返回的正文 selector 读取相关入口。地图是导航，不是文件现状或执行证据；缺失或过时则直接从当前项目文件取证，不重新初始化、不等待宿主维护，也不假称地图已更新。
2. 用 nozeli_project_list/search 定位，再用 nozeli_document_read 核对 README、目录入口、配置、依赖清单、启动脚本和与问题相关的少量实现。路径、项目身份和版本来自宿主回执，不猜历史目录。遵循 read-material 的分页、只读来源及预算约束；预算耗尽列出未读范围，不把搜索片段当完整阅读。
3. 分开陈述：已读文件证明的用途与结构；文件声明的运行前提/命令；实际执行过的结果；推断与未知。分析运行方式只解释已核对脚本、环境变量名、所需服务及入口，不自动执行测试、构建、安装或启动服务；用户另行明确要求执行时才按当轮范围操作。不要读取或复述凭据值。
4. 回答给出来源相对路径及可用版本/范围、关键结论、限制和可行下一步。需要落盘报告时用 nozeli_document_create；更新既有报告先 nozeli_document_read 再 nozeli_document_apply，遵循 CAS、草稿和冲突回执。仅成功保存回执后称“已保存”并给出实际路径；聊天文本不是已保存文件，更不是 Worker publish、审查通过、采纳或自动稳定记忆。
