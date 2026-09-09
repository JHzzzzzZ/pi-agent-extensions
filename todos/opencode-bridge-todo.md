# TODO
- [ ] 根 README 效果示意图：效果在网络链路上（代理转发），无可见 UI，暂搁置（如需可补 /opencode-bridge 状态输出示意）
- [ ] 端口自定义待支持：目前桥监听端口靠 `PI_BRIDGE_PORT` 环境变量，希望支持不依赖环境变量的自定义方式（如 /opencode-bridge-sync 交互式询问端口并持久化，或扩展自身配置文件），修改后 httpProxy 写入值与探测端口需联动
- [x] devDependencies 安全升级：@earendil-works/pi-coding-agent 等 ^0.83.0 → ^0.85.1，修复 undici/brace-expansion 高危漏洞
