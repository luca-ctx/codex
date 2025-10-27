import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.FIGMA_PERSONAL_ACCESS_TOKEN;
if (!token) throw new Error('missing token');

const client = new Client({ name: 'figma-api-cli-test', version: '0.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('https://mcp.figma.com/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
await client.connect(transport);
const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));
await client.close();
