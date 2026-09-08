#!/usr/bin/env node
/**
 * opencode-bridge-helper — HTTP CONNECT → 本地 SOCKS5 桥（零依赖独立进程）
 *
 * 由 Pi 扩展 opencode-bridge/index.ts 在会话启动时拉起（不是开机自启）。
 * 独立进程运行：Pi 崩溃/退出不会影响它，多个 Pi 实例（含 subagent）共用一个桥。
 *
 * 仅绑定 127.0.0.1:<PI_BRIDGE_PORT，默认 10899>（HTTP 代理），转发到
 * <PI_BRIDGE_SOCKS_HOST:PI_BRIDGE_SOCKS_PORT，默认 127.0.0.1:10808>（SOCKS5，v2rayN）。
 *
 * 协议行为：
 *  - 普通 HTTP 请求返回 405 CONNECT only；
 *  - /__bridge/shutdown（仅本地可达）返回 200 后优雅退出，用于测试/受控关闭；
 *  - CONNECT 先完成 SOCKS5 无认证握手，按域名方式（ATYP=3）发送目标 host/port，
 *    再回 200 Connection Established 并双向转发（含 CONNECT 请求头部剩余数据）；
 *  - 分片 SOCKS5 应答按缓冲累积解析，不假设单个 data 事件是完整握手包；
 *  - 客户端中途断开、上游拒绝、握手失败都返回 502/400 或安全清理，绝不向进程
 *    抛出未捕获异常；每个 socket 都有 error/close 清理，任一端关闭即销毁另一端；
 *  - 监听端口已被另一桥占用（EADDRINUSE）时记录日志并以 0 退出（多实例竞争安全）；
 *    其它 server error 以 1 退出；SIGTERM/SIGINT 优雅退出。
 *
 * 日志：写入 PI_BRIDGE_LOG（默认与 helper 同目录的 opencode-bridge.log），
 *       单行与文件大小均有上限，只记录诊断信息，不记录 payload/认证内容。
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ===== 配置 =====

const LISTEN_HOST = "127.0.0.1";

function parsePortEnv(raw, fallback) {
  if (raw === undefined || raw === "") return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return { ok: false, message: `invalid port env (need integer 1-65535): ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
}

const bridgePort = parsePortEnv(process.env.PI_BRIDGE_PORT, 10899);
const socksPort = parsePortEnv(process.env.PI_BRIDGE_SOCKS_PORT, 10808);
const SOCKS_HOST = (process.env.PI_BRIDGE_SOCKS_HOST || "127.0.0.1").trim();

function fatal(message) {
  log(`fatal: ${message}`);
  process.exit(1);
}

if (!bridgePort.ok) fatal(bridgePort.message);
if (!socksPort.ok) fatal(socksPort.message);
const LISTEN_PORT = bridgePort.value;
const SOCKS_PORT = socksPort.value;

// ===== 日志（有界 best-effort，失败不影响桥） =====

const MAX_LOG_LINE_CHARS = 2000;
const MAX_LOG_FILE_BYTES = 512 * 1024;

let LOG_FILE;
try {
  LOG_FILE = process.env.PI_BRIDGE_LOG
    ? path.resolve(process.env.PI_BRIDGE_LOG)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode-bridge.log");
} catch {
  LOG_FILE = path.join(os.tmpdir(), "opencode-bridge.log");
}

function log(message) {
  try {
    let text = String(message);
    if (text.length > MAX_LOG_LINE_CHARS) text = `${text.slice(0, MAX_LOG_LINE_CHARS)}…(truncated)`;
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_FILE_BYTES) {
        fs.truncateSync(LOG_FILE, 0);
      }
    } catch {
      /* 截断失败忽略 */
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`);
  } catch {
    /* 日志失败不影响服务 */
  }
}

// ===== 兜底：任何未捕获异常都不允许弄死桥 =====

process.on("uncaughtException", (err) => log(`uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err?.stack || err}`));

// ===== SOCKS5 握手 =====

/**
 * 建立到 targetHost:targetPort 的 SOCKS5 隧道。
 * 回调只调用一次；成功后保留 error 监听（内部 no-op），避免后续错误变成未捕获异常。
 * 握手应答按分片缓冲累积解析。
 */
function socks5Connect(targetHost, targetPort, cb) {
  let phase = 0; // 0=等待握手应答，1=等待 CONNECT 应答
  let buf = Buffer.alloc(0);
  let settled = false;
  const done = (err, socket) => {
    if (settled) return;
    settled = true;
    cb(err, socket);
  };

  let socket;
  try {
    socket = net.connect(SOCKS_PORT, SOCKS_HOST, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // SOCKS5，1 个方法：无认证
    });
  } catch (err) {
    done(err);
    return;
  }

  socket.on("data", (chunk) => {
    try {
      buf = Buffer.concat([buf, chunk]);

      if (phase === 0) {
        if (buf.length < 2) return;
        if (buf[0] === 5 && buf[1] === 0) {
          buf = Buffer.alloc(0);
          phase = 1;
          const hostBuf = Buffer.from(targetHost, "utf8");
          socket.write(
            Buffer.concat([
              Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
              hostBuf,
              Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
            ]),
          );
        } else {
          socket.destroy(new Error("SOCKS5 握手失败（代理未就绪？）"));
        }
        return;
      }

      if (buf.length < 4) return;
      const atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 3 ? buf[4] : atyp === 4 ? 16 : 0;
      if (!addrLen || buf.length < 4 + addrLen + 2) return;
      if (buf[1] === 0) {
        socket.removeAllListeners("data");
        done(null, socket);
      } else {
        socket.destroy(new Error(`SOCKS5 连接被拒绝（rep=${buf[1]}）`));
      }
    } catch (err) {
      socket.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  });

  socket.on("error", (err) => done(err));
  socket.on("close", () => {
    if (!settled) done(new Error("SOCKS5 连接在建立完成前关闭"));
  });
}

// ===== 优雅退出 =====

const trackedSockets = new Set();
let shuttingDown = false;

function track(socket) {
  trackedSockets.add(socket);
  socket.on("close", () => trackedSockets.delete(socket));
}

function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${reason}`);
  try {
    server.close();
  } catch {
    /* ignore */
  }
  for (const socket of [...trackedSockets]) {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 500).unref();
}

// ===== HTTP 代理服务 =====

const server = http.createServer((req, res) => {
  try {
    const url = req.url || "";
    if (url.startsWith("/__bridge/shutdown")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("opencode-bridge shutting down\n", () => gracefulShutdown("shutdown request"));
      return;
    }
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("CONNECT only\n");
  } catch {
    try {
      req.socket.destroy();
    } catch {
      /* ignore */
    }
  }
});

server.on("clientError", (_err, socket) => {
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
});

server.on("connect", (req, clientSocket, head) => {
  track(clientSocket);
  let upstream;
  const killBoth = () => {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    try {
      upstream?.destroy();
    } catch {
      /* ignore */
    }
  };

  // 客户端（Pi）侧的任何错误只清理自己，绝不能向上冒泡
  clientSocket.on("error", killBoth);
  clientSocket.on("close", () => {
    try {
      upstream?.destroy();
    } catch {
      /* ignore */
    }
  });

  // 目标解析：host:port；空/异常目标直接 400，不进入 SOCKS 握手
  const target = typeof req.url === "string" ? req.url : "";
  const idx = target.lastIndexOf(":");
  const host = idx > 0 ? target.slice(0, idx).replace(/^\[/, "").replace(/\]$/, "") : "";
  const port = idx > 0 ? Number.parseInt(target.slice(idx + 1), 10) : Number.NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    log(`connect: bad target ${target ? JSON.stringify(target.slice(0, 120)) : "(empty)"}`);
    try {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      try {
        clientSocket.destroy();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  try {
    socks5Connect(host, port, (err, up) => {
      if (err || !up) {
        log(`connect ${host}:${port} failed: ${err?.message ?? "unknown"}`);
        try {
          if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        } catch {
          try {
            clientSocket.destroy();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      upstream = up;
      track(up);
      up.on("error", killBoth);
      up.on("close", () => {
        try {
          clientSocket.destroy();
        } catch {
          /* ignore */
        }
      });
      try {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) up.write(head);
        clientSocket.pipe(up);
        up.pipe(clientSocket);
      } catch (err2) {
        log(`connect setup error: ${err2?.stack || err2}`);
        killBoth();
      }
    });
  } catch (err) {
    log(`connect handler error: ${err?.stack || err}`);
    killBoth();
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    log(`port ${LISTEN_PORT} already in use; another bridge is running, exiting`);
    process.exit(0);
  }
  log(`server error: ${err?.stack || err}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening http://${LISTEN_HOST}:${LISTEN_PORT} -> socks5 ${SOCKS_HOST}:${SOCKS_PORT}`);
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
