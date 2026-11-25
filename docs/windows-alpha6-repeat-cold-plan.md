# Windows 第二轮冷接管实施门

本计划已在v48完成限定的两次真实宿主退出/第三Controller启动及8模式Node、3模式Electron验收，详见[实际记录](windows-alpha6-repeat-cold.md)。原方案中更广的resident业务turn、warm退休历史及无helper历史尚未完成。下面保留v47实施门原文作为历史，不代表这些项目均已通过。

当前v47只验证一次原inspection向下一host移交，并由共享Controller启动两个新resident。再次退出时，当前owner集合同时包含新代prepared resident和旧代retired Worker；现有inspection会明确拒绝。以下是下一批实施方案，尚无第二轮通过证据。

1. **先建立真实两次退出fixture。** 外层测试进程启动合成旧host，令其完成文档apply／publication后停在未回复屏障并强杀；独立adopter进程自行打开原inspection、消费同进程opaque token、Controller.open/start并向外层报告新代精确绑定。外层再终止adopter，第三进程打开第二轮inspection。禁止把opaque token序列化传给别的进程，禁止以内存替身或伪造hostExited代替第二次真实退出。
2. **区分当前launch-set与历史carryover。** 当前generation的每个原生追加launch必须与当前owner精确一一对应；旧retired行只能由完整create-only generation history及其原生custody证明。校验lease／launch／owner／instance／revision／history操作回执，不简单过滤retired行。删除历史、同值revision赢家、漏启动行、同launch跨代重复或替代helper均拒绝。
3. **保留跨代原实体来源。** 新helper持有原受限anchor及完整source bundle；旧generation资源尚未合格释放时，仍保留并核验其精确helper／Job／stdio和source证据。数据库历史只能关联已核验事实，不能单独变成进程退出、业务效果或资源释放证明。任何代次丢失原实体、超过有界历史或连接预算，在副作用前unsupported／UNKNOWN。
4. **扩展journal与业务核对的原inspection内部绑定。** 为每个generation只读解析精确原host/owner快照，避免拿当前owner覆盖原journal绑定；旧Worker已interrupted／review保持，新resident的未完成请求分别核对。原工具回复未决继续未决，不因为下一host启动或记录退休而确认旧turn。
5. **第二次退休与移交继续使用全集合CAS。** 比较当前host/owner、完整历史、checkpoint、工具／业务相关本机集合及pending页；只追加新generation历史并按精确修订更新当前记录。提交前赢家不写，提交后变化或丢回复UNKNOWN，原pin不释放、同token不重试。新host最终postcheck后才移交原pin所有权。
6. **独立验收后再接资源释放与默认入口。** Node／Electron源码及独立解压至少覆盖正常第二轮、旧retired carryover、当前未完成intent、历史删除／同值修订、竞争只一赢家、提交后pending变化和丢回复；验证草稿、review、候选、请求数及零旧输入重放。owner私有home归档／释放仍需独立原生退出和业务处置资格，不能复用cold记录退休冒充warm最终退出证明。

通过上述门后才评估默认ManagedProjects和派工前路径资格。W3 OS隔离、初始化／重置、终端／TeX／回收站与完整W5安装发行另有未完成门；本计划不提前改变能力矩阵。
