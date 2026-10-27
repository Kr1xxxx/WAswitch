// 单独下载的 MCP 模块的入口：scripts/build-mcp.js 把这里连同 src/mcp 和它用的库打成一个文件。
//   被主程序 require 时：导出 setupMcp（McpController 给自检用）。
//   带 --waswitch-mcp-bridge 参数直接运行时：当作 stdio 桥接（给 Claude Desktop 这类只支持 stdio 的客户端）。
const BRIDGE_ARG = '--waswitch-mcp-bridge';

if (process.argv.includes(BRIDGE_ARG)) {
  require('../../bin/waswitch-mcp.js');
} else {
  module.exports = { setupMcp: require('./index').setupMcp, McpController: require('./server').McpController, BRIDGE_ARG };
}
