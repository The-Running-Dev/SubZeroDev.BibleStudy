// The Claude executable AgentConsole runs for the connector: the real `claude`, with every tool, MCP server,
// user setting and slash command taken away (I-26). The runtime passes its own arguments; these come last.
import { spawn } from 'node:child_process';
const locked = ['--tools', '', '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands', '--permission-mode', 'default'];
const child = spawn('claude', [...process.argv.slice(2), ...locked], { stdio: 'inherit', shell: false });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', e => { console.error(String(e)); process.exit(1); });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
