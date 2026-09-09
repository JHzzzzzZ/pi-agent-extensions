# TODO

- [x] 修复 `view` 视角下，leader 派活给成员后切换视角时上方不断出现换行重影的问题。（首轮：指纹门控+按 id 选中+帧高消抖，未根除，见第二轮条）
- [x] view 顶部标题+页签堆叠依旧（第二轮：overlay 加 maxHeight 85% + margin 1 与参考对齐，viewer 打开期间暂停并隐藏下方 widget 亮块）。105 测试 + typecheck 全绿；但用户真机截图实锤依旧堆叠（53s/54s、1m26s/1m27s 标题并存），见第三轮条。
- [x] view 标题+页签堆叠第三轮（照抄 pi-subagents fleet 壳——options 一字不差 + 标题去 elapsed 静态化 + openViewer 互斥防双 overlay；elapsed 只留下方 widget，viewer 内零每秒文本）。106 测试 + typecheck 全绿；等用户真机确认。
- [ ] 支持与各个 agent 进行动态对话。（验证中：count-duet 团队 1-10 轮流计数已跑通，5 次串行派单；1-1000 逐个派单超预算待分批方案确认）
- [ ] 补齐 `view` 视角下的功能，例如停止 agent。
- [x] 根 README 为每个插件增加效果示意图
- [x] devDependencies 安全升级：@earendil-works/pi-coding-agent 等 ^0.83.0 → ^0.85.1，修复 undici/brace-expansion 高危漏洞
- [ ] 参照 pi-subagents（v0.66.0）对齐 agent-team 可靠性：async-first 统一 + run 落盘/reconcile + 预算可配可见 + doctor 自检 + model 预检。（processing：方案待审批，未动手）
- [ ] 修复每次 `/reload` 后 team 相关工具消失的问题（globalThis 双加载守卫跨 reload 常驻，entry 直接 return）。
