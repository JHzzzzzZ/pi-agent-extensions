/**
 * opencode-bridge-helper 真实子进程集成测试：node:test + 手写 fake SOCKS5 server，无外部网络。
 * 覆盖 CONNECT 握手/转发、405、上游拒绝 502、客户端中途断开后存活（ECONNRESET 回归）、
 * 端口冲突退出 0、分片握手、坏目标 400、日志落盘、受控退出。
 * 运行:cd opencode-bridge && npm test
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HELPER_PATH = path.join(import.meta.dirname, "opencode-bridge-helper.mjs");
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-bridge-test-"));
const tmpDirs: string[] = [TMP_ROOT];

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 文件锁等清理失败可忽略 */
    }
  }
});

// ===== 工具 =====

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

function connectSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function probePort(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const socket = await connectSocket(port);
    socket.destroy();
    return true;
  } catch {
    if (timeoutMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return probePort(port, timeoutMs - 100);
    }
    return false;
  }
}

function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  return probePort(port, timeoutMs).then((ok) => {
    if (!ok) throw new Error(`port ${port} not listening within timeout`);
  });
}

/** 读到包含 needle 为止（含 needle 之后可能已有的额外数据一并通过 buffer 暴露）。 */
function waitForIncludes(buffer: { text: string }, needle: string, socket: net.Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; got: ${JSON.stringify(buffer.text.slice(0, 200))}`));
    }, timeoutMs);
    const onData = () => {
      if (buffer.text.includes(needle)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
    };
    socket.on("data", onData);
    onData();
  });
}

// ===== fake SOCKS5 上游 =====

interface FakeSocksOptions {
  /** 收到 CONNECT 请求后回复拒绝（rep=1） */
  reject?: boolean;
  /** 把 method-selection 应答 [5,0] 拆成两个分片发送（间隔 30ms） */
  splitHandshake?: boolean;
}

interface SocksConnection {
  greeting: number[];
  host: string;
  port: number;
  relayed: string;
}

function startFakeSocks5(options: FakeSocksOptions = {}): Promise<{ port: number; connections: SocksConnection[]; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const connections: SocksConnection[] = [];
    const server = net.createServer((socket) => {
      const conn: SocksConnection = { greeting: [], host: "", port: 0, relayed: "" };
      connections.push(conn);
      let phase: "greeting" | "connect" | "relay" = "greeting";
      let buf = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        if (phase === "greeting" && buf.length >= 2) {
          const greetingLen = 2 + buf[1]; // VER + NMETHODS + methods
          if (buf.length < greetingLen) return;
          conn.greeting = [...buf.subarray(0, greetingLen)];
          buf = buf.subarray(greetingLen);
          phase = "connect";
          if (options.splitHandshake) {
            socket.write(Buffer.from([0x05]));
            setTimeout(() => socket.write(Buffer.from([0x00])), 30);
          } else {
            socket.write(Buffer.from([0x05, 0x00]));
          }
        }

        if (phase === "connect" && buf.length >= 5) {
          const atyp = buf[3];
          const addrLen = atyp === 1 ? 4 : atyp === 3 ? buf[4] : atyp === 4 ? 16 : 0;
          if (!addrLen) return;
          const needed = 4 + (atyp === 3 ? 1 : 0) + addrLen + 2;
          if (buf.length < needed) return;
          const hostOffset = 4 + (atyp === 3 ? 1 : 0);
          conn.host = buf.subarray(hostOffset, hostOffset + addrLen).toString("utf8");
          conn.port = buf.readUInt16BE(needed - 2);
          buf = buf.subarray(needed);
          phase = "relay";
          if (options.reject) {
            socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          } else {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0x01, 0xbb]));
          }
        }

        if (phase === "relay" && buf.length > 0) {
          conn.relayed += buf.toString("utf8");
          socket.write(buf); // echo
          buf = Buffer.alloc(0);
        }
      });

      socket.on("error", () => {
        /* fake 上游的错误不外抛 */
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        connections,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on("error", reject);
  });
}

// ===== helper 进程 =====

interface HelperHandle {
  child: ChildProcess;
  port: number;
  logFile: string;
  stopped: boolean;
  stop(): Promise<void>;
}

async function startHelper(socksPort: number): Promise<HelperHandle> {
  const port = await getFreePort();
  const logFile = path.join(TMP_ROOT, `bridge-${port}.log`);
  const child = spawn(process.execPath, [HELPER_PATH], {
    env: {
      ...process.env,
      PI_BRIDGE_PORT: String(port),
      PI_BRIDGE_SOCKS_PORT: String(socksPort),
      PI_BRIDGE_SOCKS_HOST: "127.0.0.1",
      PI_BRIDGE_LOG: logFile,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  await waitForPort(port);
  const handle: HelperHandle = {
    child,
    port,
    logFile,
    stopped: false,
    stop: async (): Promise<void> => {
      if (handle.stopped) return;
      handle.stopped = true;
      try {
        await shutdownRequest(port);
      } catch {
        /* 桥可能已退出 */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  return handle;
}

function shutdownRequest(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/__bridge/shutdown", timeout: 1500 }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("timeout", () => {
      req.destroy(new Error("shutdown request timeout"));
    });
    req.on("error", reject);
  });
}

// ===== 测试 =====

test("helper: CONNECT → fake SOCKS5 域名握手 + 200 + 双向转发", { timeout: 20000 }, async () => {
  const socks = await startFakeSocks5();
  const helper = await startHelper(socks.port);
  try {
    const client = await connectSocket(helper.port);
    const response = { text: "" };
    client.on("data", (chunk) => {
      response.text += chunk.toString("utf8");
    });
    client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
    await waitForIncludes(response, "200 Connection Established", client);
    client.write("ping-1");
    await waitForIncludes(response, "ping-1", client);
    client.destroy();

    assert.equal(socks.connections.length, 1);
    const conn = socks.connections[0];
    assert.deepEqual(conn.greeting, [0x05, 0x01, 0x00]); // SOCKS5 无认证
    assert.equal(conn.host, "example.com"); // 域名方式（ATYP=3）
    assert.equal(conn.port, 443);
    assert.match(response.text, /ping-1/);
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: 普通 HTTP 请求返回 405 CONNECT only", { timeout: 20000 }, async () => {
  const socks = await startFakeSocks5();
  const helper = await startHelper(socks.port);
  try {
    const client = await connectSocket(helper.port);
    const response = { text: "" };
    client.on("data", (chunk) => {
      response.text += chunk.toString("utf8");
    });
    client.write("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
    await waitForIncludes(response, "405", client);
    await waitForIncludes(response, "CONNECT only", client);
    client.destroy();
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: 上游 SOCKS5 拒绝 CONNECT 时返回 502", { timeout: 20000 }, async () => {
  const socks = await startFakeSocks5({ reject: true });
  const helper = await startHelper(socks.port);
  try {
    const client = await connectSocket(helper.port);
    const response = { text: "" };
    client.on("data", (chunk) => {
      response.text += chunk.toString("utf8");
    });
    client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
    await waitForIncludes(response, "502", client);
    client.destroy();
    assert.match(response.text, /Bad Gateway/);
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: 客户端中途断开（ECONNRESET 回归）后桥仍存活并能服务下一次 CONNECT", { timeout: 25000 }, async () => {
  const socks = await startFakeSocks5();
  const helper = await startHelper(socks.port);
  try {
    // 第一条 CONNECT 正常建立
    const first = await connectSocket(helper.port);
    const firstResponse = { text: "" };
    first.on("data", (chunk) => {
      firstResponse.text += chunk.toString("utf8");
    });
    first.write("CONNECT a.example.com:443 HTTP/1.1\r\n\r\n");
    await waitForIncludes(firstResponse, "200 Connection Established", first);
    first.write("payload-before-reset");
    await waitForIncludes(firstResponse, "payload-before-reset", first);
    first.destroy(); // 客户端中途突然断开

    // 给 helper 处理 close/error 的时间，然后确认进程还活着
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(helper.child.exitCode, null, "helper 不应因客户端 reset 而退出");
    assert.ok(await probePort(helper.port, 0), "helper 端口应仍可连接");

    // 随后还能服务下一次 CONNECT
    const second = await connectSocket(helper.port);
    const secondResponse = { text: "" };
    second.on("data", (chunk) => {
      secondResponse.text += chunk.toString("utf8");
    });
    second.write("CONNECT b.example.com:8443 HTTP/1.1\r\n\r\n");
    await waitForIncludes(secondResponse, "200 Connection Established", second);
    second.write("after-reset");
    await waitForIncludes(secondResponse, "after-reset", second);
    second.destroy();

    assert.equal(socks.connections.length, 2);
    assert.equal(socks.connections[1]?.host, "b.example.com");
    assert.equal(socks.connections[1]?.port, 8443);
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: CONNECT 头部剩余数据（head）先转发给上游", { timeout: 20000 }, async () => {
  const socks = await startFakeSocks5();
  const helper = await startHelper(socks.port);
  try {
    const client = await connectSocket(helper.port);
    const response = { text: "" };
    client.on("data", (chunk) => {
      response.text += chunk.toString("utf8");
    });
    // 单个 chunk 内同时携带请求头结束符与 head payload
    client.write("CONNECT head.example.com:443 HTTP/1.1\r\n\r\nTLS-CLIENT-HELLO");
    await waitForIncludes(response, "200 Connection Established", client);
    // fake 上游会把收到的首个 payload 原样回显，等到回显再断言/断开（避免与网络 RTT 竞争）
    await waitForIncludes(response, "TLS-CLIENT-HELLO", client);
    client.destroy();

    assert.equal(socks.connections[0]?.host, "head.example.com");
    assert.match(socks.connections[0]?.relayed ?? "", /^TLS-CLIENT-HELLO/);
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: 分片 SOCKS5 握手应答仍能完成 CONNECT", { timeout: 20000 }, async () => {
  const socks = await startFakeSocks5({ splitHandshake: true });
  const helper = await startHelper(socks.port);
  try {
    const client = await connectSocket(helper.port);
    const response = { text: "" };
    client.on("data", (chunk) => {
      response.text += chunk.toString("utf8");
    });
    client.write("CONNECT split.example.com:443 HTTP/1.1\r\n\r\n");
    await waitForIncludes(response, "200 Connection Established", client);
    client.write("fragmented");
    await waitForIncludes(response, "fragmented", client);
    client.destroy();

    assert.equal(socks.connections[0]?.host, "split.example.com");
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: 空/异常目标返回 400 且不进入 SOCKS 握手", { timeout: 20000 }, async () => {
  const socks = await startFakeSocks5();
  const helper = await startHelper(socks.port);
  try {
    const client = await connectSocket(helper.port);
    const response = { text: "" };
    client.on("data", (chunk) => {
      response.text += chunk.toString("utf8");
    });
    client.write("CONNECT / HTTP/1.1\r\n\r\n");
    await waitForIncludes(response, "400", client);
    client.destroy();
    assert.equal(socks.connections.length, 0);
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: 端口被另一桥占用时以 0 退出（多实例竞争安全）", { timeout: 25000 }, async () => {
  const socks = await startFakeSocks5();
  const first = await startHelper(socks.port);
  try {
    const second = spawn(process.execPath, [HELPER_PATH], {
      env: {
        ...process.env,
        PI_BRIDGE_PORT: String(first.port),
        PI_BRIDGE_SOCKS_PORT: String(socks.port),
        PI_BRIDGE_LOG: path.join(TMP_ROOT, `bridge-second-${first.port}.log`),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      second.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, "第二个 helper 应识别端口占用并以 0 退出");
    assert.equal(first.child.exitCode, null, "第一个 helper 应继续运行");
  } finally {
    await socks.close();
    await first.stop();
  }
});

test("helper: /__bridge/shutdown 返回 200 后进程以 0 退出", { timeout: 25000 }, async () => {
  const socks = await startFakeSocks5();
  const helper = await startHelper(socks.port);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 8000);
      helper.child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      shutdownRequest(helper.port).catch(reject);
    });
    assert.equal(exitCode, 0);
    helper.stopped = true; // stop() 中跳过重复关闭
  } finally {
    await socks.close();
    await helper.stop();
  }
});

test("helper: 诊断信息写入 PI_BRIDGE_LOG 指定文件", { timeout: 25000 }, async () => {
  const socks = await startFakeSocks5({ reject: true }); // 拒绝 CONNECT 以触发 failed 日志
  const helper = await startHelper(socks.port);
  try {
    const client = await connectSocket(helper.port);
    const response = { text: "" };
    client.on("data", (chunk) => {
      response.text += chunk.toString("utf8");
    });
    client.write("CONNECT logcheck.example.com:443 HTTP/1.1\r\n\r\n");
    await waitForIncludes(response, "502", client);
    client.destroy();
    assert.equal(socks.connections.length, 1);
  } finally {
    await socks.close();
    await helper.stop();
  }
  const log = fs.readFileSync(helper.logFile, "utf8");
  assert.match(log, /listening http:\/\/127\.0\.0\.1/);
  assert.match(log, /socks5 127\.0\.0\.1:\d+/);
  assert.match(log, /connect logcheck\.example\.com:443 failed/);
});
