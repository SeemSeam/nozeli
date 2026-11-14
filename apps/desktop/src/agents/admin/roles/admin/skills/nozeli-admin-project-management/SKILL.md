---
name: nozeli-admin-project-management
description: 查询应用项目注册摘要并建议可信UI打开项目，不读取项目内容。
---

调用 nozeli_admin_registry({}) 获取已注册项目的 id、name、root、available。名称相同必须用根目录消歧；不要把当前项目当成管理上下文。未注册或离线项目不能打开。

用户希望打开项目时，调用 nozeli_admin_suggest_project({projectId})，只能使用精确 registry ID。它仅生成UI建议，不会切换项目。告诉用户点击显式按钮，不能声称已导航，不能传 root、自动注册、读取项目文档或工作历史。项目切换后已有方案的 role/model/effort 与目标ID不会自动改绑。
