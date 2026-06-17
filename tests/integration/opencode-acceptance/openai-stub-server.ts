/**
 * In-harness OpenAI-compatible HTTP stub server for #543 smoke step 3.
 *
 * Starts a minimal HTTP server that speaks the OpenAI chat completions API
 * (POST /v1/chat/completions) and returns a canned streamed SSE completion
 * plus a token-usage payload. No external service, no Docker provisioning,
 * no network egress.
 *
 * Usage:
 *   const stub = await startOpenAIStubServer();
 *   // point OpenCode at stub.baseUrl via opencode.json provider base URL
 *   stub.stop();
 *
 * Owner boundary: this fixture is this ticket's (#543) own deliverable.
 * The ability to inject stub.baseUrl into opencode.json belongs to #478/#479.
 */

import * as http from 'http';

export interface OpenAIStubServer {
  /** e.g. "http://127.0.0.1:54321" */
  baseUrl: string;
  port: number;
  stop(): Promise<void>;
}

// Canned SSE frames for a minimal streamed chat completion with token usage.
const SSE_FRAMES = [
  // First chunk: role + first content token
  'data: {"id":"chatcmpl-stub001","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
  // Second chunk: more content
  'data: {"id":"chatcmpl-stub001","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"content":" from stub"},"finish_reason":null}]}\n\n',
  // Final chunk: finish_reason + usage (OpenAI stream_options pattern)
  'data: {"id":"chatcmpl-stub001","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
  // SSE terminator
  'data: [DONE]\n\n',
];

export function startOpenAIStubServer(): Promise<OpenAIStubServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        // Drain the request body before responding (avoids ECONNRESET on the client).
        req.resume();
        req.on('end', () => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          let frameIndex = 0;
          const writeNext = (): void => {
            if (frameIndex < SSE_FRAMES.length) {
              res.write(SSE_FRAMES[frameIndex++]);
              // Small delay between frames so the consumer sees true streaming.
              setTimeout(writeNext, 5);
            } else {
              res.end();
            }
          };
          writeNext();
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });

    server.on('error', reject);

    // Bind to 127.0.0.1 on an OS-assigned port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { address: string; port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        stop: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
