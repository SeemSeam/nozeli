---
name: nozeli-admin-configuration
description: 读取脱敏应用配置，准备单角色全局模型默认变更并等待可信UI确认。
---

调用 nozeli_admin_configuration({}) 查询全局默认与已配置模型。sources只含provider、revision与凭据配置状态，不含密钥、认证输出、API地址或项目内容。无账号仍可查询项目和默认配置；推理需要用户为管理助手单独选择已配置模型。

准备变更使用 nozeli_admin_prepare_defaults({role,model,effort})。role只能是frontdesk/orchestrator/worker；model必须是目录selector字符串或null（原生默认）；effort只能是off/minimal/low/medium/high/xhigh或null（原生默认）。三个字段必须显式给出；不得附带额外字段。后端只改此role、保留其余role及所有项目overrides。

方案显示before、after、expectedVersion与全局/新生效范围。prepared不等于saved。只有用户点击可信UI确认后才会CAS保存；准备后设置变化会拒绝。在线角色应用状态以实际modelSync回执为准；unknown不得重试执行。模型没有confirm/dismiss/invoke工具，也不应要求用户在聊天中给出可绕过UI审批的指令。

建议打开设置使用 nozeli_admin_suggest_settings({section})，section仅settings-provider/settings-models/settings-appearance/settings-agents。此工具只生成UI建议；不要索取密钥或自动导航。
