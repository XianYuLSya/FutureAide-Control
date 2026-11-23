import { startColdStartBridge } from '../src/claude-report-bootstrap.mjs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const port = Number(process.env.ISOLATED_BRIDGE_PORT);
if (!Number.isInteger(port) || port < 1024 || process.env.ISOLATED_ROSTER !== 'bridge-test-only') throw new Error('isolated endpoint required');
const bridge = await startColdStartBridge({load: async () => ({ reportPort: port, stateDirectory: 'isolated' }), storeFor: () => ({ identity: () => 'bridge-test-only', close() {} }), ensure: async () => { throw new Error('real backend disabled'); }, waitMs: 100, log: () => {} });
if (!bridge.ready) throw new Error('isolated service not ready');
await bridge.server.connect(new StdioServerTransport());
process.stdin.on('end', () => void bridge.close());
