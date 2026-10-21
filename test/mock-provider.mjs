// Mock provider: an OpenAI-compatible chat/completions endpoint with SSE.
//
// Used by the test suite so the whole loop (prompt -> stream -> tool call ->
// approval -> resume) runs without a network or a key. Behaviour is scripted:
//   - if the last user message starts with "TOOL " it answers with a tool call
//   - if it starts with "ECHO " it echoes the rest
//   - otherwise it replies with a deterministic line and reports usage

import http from 'node:http';

export function startMockProvider({ port = 0 } = {}) {
  const requests = [];
  let callSeq = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-a' }, { id: 'mock-b' }] }));
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, headers: req.headers });

    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    const text = String(lastUser?.content ?? '');
    // "SLOW <ms> ..." lets a test hold a turn open deterministically.
    const slow = /^SLOW (\d+)/.exec(text);
    if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
    const isToolResultTurn = (body.messages ?? []).at(-1)?.role === 'tool';

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };

    if (!isToolResultTurn && text.startsWith('ASK ')) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call-mock-ask-${++callSeq}`,
                  type: 'function',
                  function: {
                    name: 'ask_user',
                    arguments: JSON.stringify({ prompt: text.slice(4).trim(), options: ['yes', 'no'] }),
                  },
                },
              ],
            },
          },
        ],
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      send({ choices: [], usage });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (!isToolResultTurn && text.startsWith('TOOL ')) {
      const command = text.slice(5).trim();
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: `call-mock-${++callSeq}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } },
              ],
            },
          },
        ],
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      send({ choices: [], usage });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const reply = isToolResultTurn
      ? `ran it: ${text.slice(0, 200)}`
      : text.startsWith('ECHO ')
        ? text.slice(5)
        : `ack: ${text.slice(0, 120)}`;

    send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.slice(0, 20) } }] });
    send({ choices: [{ index: 0, delta: { content: reply.slice(20) } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
