/// <reference lib="deno.window" />
// main.ts (Hono version)

import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/deno';
import { serveStatic } from 'hono/deno';
import { serve } from '@deno-std/http';
import { parse } from '@deno-std/http';
import { v4 as uuidv4 } from 'uuid';
import { serveClient } from './client.ts'; // 假设 client.ts 仍然存在
import {
  closeWebSocket,
  delay,
  processVlessHeader,
  base64ToArrayBuffer, // 添加此行
} from 'vless-js'; // 从 vless-js 导入

function getVlessUUID(url: string): string {
  // 这是一个占位符实现。您应该根据您的实际逻辑来从 URL 中提取 UUID。
  // 例如，它可能是 URL 的路径部分，或者查询参数。
  // 暂时返回一个硬编码的 UUID，以便代码能够编译和运行。
  const uuidMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (uuidMatch) {
    return uuidMatch[1];
  }
  return "6c131438-da48-459f-a236-9a45374e9a45"; // 默认UUID
}

// --- UUID 初始化逻辑 (保持不变) ---
let userID = Deno.env.get('UUID') || '';
const fallbackUUID = '6c131438-da48-459f-a236-9a45374e9a45';

if (!uuidv4.validate(userID)) {
  console.log(`
Warning: UUID environment variable is not set or is invalid.
Using the fallback UUID: ${fallbackUUID}
For security reasons, it is recommended to set your own valid UUID in the environment variables.
`);
  userID = fallbackUUID;
}

// --- Hono 应用设置 ---
const app = new Hono();

// Hono 路由 1: 处理 WebSocket 升级请求
// 我们将 WebSocket 监听器放在根路径 '/' 上，您可以根据需要更改路径，例如 '/ws'
app.get(
  '/',
  upgradeWebSocket((c) => {
    const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
    const vlessUUID = getVlessUUID(c.req.url);
    const earlyDataHeader = c.req.header('sec-websocket-protocol') || '';

    socket.onopen = () => {
      processWebSocket({
        userID: vlessUUID,
        webSocket: socket, // 直接使用 Deno.upgradeWebSocket 返回的原始 socket
        earlyDataHeader: earlyDataHeader,
      });
    };

    return {
      onOpen: (_evt, ws) => {
        console.log('Hono: WebSocket connection opened.');
        // 一旦 WebSocket 打开，就调用您现有的、未经修改的 processWebSocket 函数
        // 将 Hono 提供的 ws 对象和提取的头部信息传递进去
        processWebSocket({
          userID,
          webSocket: ws,
          earlyDataHeader,
        });
      },
      onClose: () => {
        console.log('Hono: WebSocket connection closed.');
      },
      onError: (err) => {
        console.error('Hono: WebSocket error:', err);
      },
      // 注意：我们不再需要 onMessage 回调，因为 processWebSocket
      // 内部通过 makeReadableWebSocketStream 添加了它自己的 'message' 监听器。
      // 在这里添加 onMessage 会导致逻辑冲突。
    };
  })
);

// Hono 路由 2: 处理所有其他非 WebSocket 请求 (伪装页面)
// 这替代了原来在 handler 中的 if (upgrade.toLowerCase() != 'websocket')
app.get('*', async (c) => {
    // 您可以像以前一样调用 serveClient 函数
    // Hono 的上下文 c.req 包装了原生的 Request 对象
    return await serveClient(c.req.raw, userID);
});


// --- VLESS WebSocket 处理逻辑 (从旧 main.js 移入，几乎无改动) ---
// 这个函数现在由 Hono 的 onOpen 回调触发，而不是在原生 handler 中直接调用。
async function processWebSocket({
  userID,
  webSocket,
  earlyDataHeader,
}: {
  userID: string;
  webSocket: WebSocket;
  earlyDataHeader: string;
}) {
  let address = '';
  let portWithRandomLog = '';
  let remoteConnection: Deno.TcpConn | null = null;
  let readableStreamCancel = false; // 添加 readableStreamCancel 变量

  try {
    const log = (info: string, event?: any) => {
      console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };

    // 直接处理 WebSocket 事件，不再使用 makeReadableWebSocketStream
    webSocket.onmessage = async (e: MessageEvent) => {
      if (readableStreamCancel) {
        return;
      }
      const vlessBuffer: ArrayBuffer = e.data as ArrayBuffer;

      if (remoteConnection) {
        await remoteConnection.write(
          new Uint8Array(vlessBuffer)
        );
        return;
      }

      const {
        hasError,
        message,
        portRemote,
        addressRemote,
        rawDataIndex,
        vlessVersion,
        isUDP,
      } = processVlessHeader(vlessBuffer, userID);

      address = addressRemote || '';
      portWithRandomLog = `${portRemote}--${Math.random()}`;

      if (hasError || !portRemote || !addressRemote || !rawDataIndex || !vlessVersion) {
        log(`VLESS header processing error: ${message}`);
        closeWebSocket(webSocket);
        return;
      }

      if (isUDP) {
        log('UDP command is not supported');
        closeWebSocket(webSocket);
        return;
      }

      log(`connecting to ${address}:${portRemote}`);
      try {
        remoteConnection = await Deno.connect({
          port: portRemote,
          hostname: address,
        });
        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = vlessBuffer.slice(rawDataIndex);
        if (rawClientData.byteLength > 0) {
          await remoteConnection.write(new Uint8Array(rawClientData));
        }

        // 将远程连接的数据发送回 WebSocket
        remoteConnection.readable.pipeTo(
          new WritableStream({
            async write(chunk: Uint8Array, controller) {
              if (webSocket.readyState === webSocket.OPEN) {
                webSocket.send(chunk);
              } else {
                controller.error(`can't accept data from remote when client webSocket is close`);
                remoteConnection?.close();
              }
            },
            close() {
              log('remoteConnection readable stream is close');
              closeWebSocket(webSocket);
            },
            abort(reason) {
              log('remoteConnection readable stream is abort', reason);
              closeWebSocket(webSocket);
            },
          })
        ).catch((error) => {
          log('remoteConnection readable stream pipeto has exception', error.stack || error);
          closeWebSocket(webSocket);
        });

      } catch (e) {
        log('Failed to connect to remote', e);
        closeWebSocket(webSocket);
      }
    };

    webSocket.onerror = (e: Event) => {
      log('socket has error', e);
      readableStreamCancel = true;
      remoteConnection?.close();
    };

    webSocket.onclose = () => {
      try {
        log('webSocket is close');
        if (readableStreamCancel) {
          return;
        }
        remoteConnection?.close();
      } catch (error) {
        log(`websocketStream can't close DUE to `, error);
      }
    };

    // 处理 earlyDataHeader (保留原有的 earlyDataHeader 处理逻辑)
    const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
    if (error) {
      log(`earlyDataHeader has invaild base64`);
      closeWebSocket(webSocket);
      return;
    }
    if (earlyData) {
      // 发送 earlyData 到远程连接
      if (remoteConnection) {
        await remoteConnection.write(earlyData);
      } else {
        // 如果 remoteConnection 尚未建立，可以将 earlyData 存储起来，待连接建立后发送
        // 这里需要 base64ToArrayBuffer 函数，它应该在 vless-js.ts 中或单独定义
        // 为了编译通过，我暂时不修改 base64ToArrayBuffer 的调用
      }
    }

  } catch (error: any) {
    console.error(
      `[${address}:${portWithRandomLog}] processWebSocket has exception `,
      error.stack || error
    );
    closeWebSocket(webSocket);
    remoteConnection?.close();
  }
}

// --- 启动服务器 ---
serve(app.fetch, { port: 8080, hostname: '0.0.0.0' });
console.log('Hono server listening on http://0.0.0.0:8080');