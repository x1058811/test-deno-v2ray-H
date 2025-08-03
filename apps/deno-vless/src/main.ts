// main.ts (Hono version)

import { Hono } from 'https://deno.land/x/hono@v4.2.1/mod.ts';
import { serve } from 'https://deno.land/std@0.170.0/http/server.ts';
import { upgradeWebSocket } from 'https://deno.land/x/hono@v4.2.1/adapter/deno/ssg.ts';
import * as uuid from 'https://jspm.dev/uuid';
import { serveClient } from './client.ts'; // 假设 client.ts 仍然存在
import {
  closeWebSocket,
  delay,
  makeReadableWebSocketStream,
  processVlessHeader,
} from 'vless-js'; // 从 vless-js.js 导入

// --- UUID 初始化逻辑 (保持不变) ---
let userID = Deno.env.get('UUID') || '';
const fallbackUUID = '6c131438-da48-459f-a236-9a45374e9a45';

if (!uuid.validate(userID)) {
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
    // 关键点: 从 Hono 的请求上下文 c 中获取头部信息
    // 这完美地替代了原生 req.headers.get()
    const earlyDataHeader = c.req.header('sec-websocket-protocol') || '';

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

  try {
    const log = (info: string, event?: any) => {
      console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };
    const readableWebSocketStream = makeReadableWebSocketStream(
      webSocket,
      earlyDataHeader,
      log
    );
    let vlessResponseHeader: Uint8Array | null = null;
    
    // 使用 Promise 来等待 remoteConnection 被建立
    // 这是为了确保在 remote -> ws 的管道建立之前，ws -> remote 管道已经解析了头部并成功连接。
    // 这个逻辑与您原始代码中的 remoteConnectionReadyResolve 是一样的。
    const remoteConnectionReadyPromise = new Promise<Deno.TcpConn>((resolve) => {
        // ws --> remote
        readableWebSocketStream
          .pipeTo(
            new WritableStream({
              async write(chunk, _controller) {
                const vlessBuffer = chunk;
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
                  vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
                  const rawClientData = vlessBuffer.slice(rawDataIndex);
                  if (rawClientData.byteLength > 0) {
                     await remoteConnection.write(new Uint8Array(rawClientData));
                  }
                  resolve(remoteConnection); // 连接成功，解决 Promise
                } catch (e) {
                   log('Failed to connect to remote', e);
                   closeWebSocket(webSocket);
                }
              },
              close() {
                log('readableWebSocketStream is close');
                remoteConnection?.close();
              },
              abort(reason) {
                log('readableWebSocketStream is abort', reason);
                remoteConnection?.close();
              },
            })
          )
          .catch((error) => {
            log('readableWebSocketStream pipeto has exception', error.stack || error);
            closeWebSocket(webSocket);
            remoteConnection?.close();
          });
    });

    // 等待 ws -> remote 管道成功建立TCP连接
    await remoteConnectionReadyPromise;
    if (!remoteConnection) {
        log("Failed to establish remote connection. Aborting.");
        return;
    }

    let remoteChunkCount = 0;
    
    // remote --> ws
    await remoteConnection.readable.pipeTo(
      new WritableStream({
        start() {
          if (webSocket.readyState === webSocket.OPEN) {
            webSocket.send(vlessResponseHeader!);
          }
        },
        async write(chunk: Uint8Array, controller) {
            if (webSocket.readyState !== webSocket.OPEN) {
              controller.error(
                `can't accept data from remote when client webSocket is close`
              );
              remoteConnection?.close();
              return;
            }
            // 您的反压/节流逻辑 (保持不变)
            remoteChunkCount++;
            const send2WebSocket = () => webSocket.send(chunk);
            
            if (remoteChunkCount < 20) {
                send2WebSocket();
            } else if (remoteChunkCount < 120) {
                await delay(10);
                send2WebSocket();
            } else if (remoteChunkCount < 500) {
                await delay(20);
                send2WebSocket();
            } else {
                await delay(50);
                send2WebSocket();
            }
        },
        close() {
          log('remoteConnection.readable is close');
          closeWebSocket(webSocket);
        },
        abort(reason) {
          log('remoteConnection.readable abort', reason);
          closeWebSocket(webSocket);
        },
      })
    );
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