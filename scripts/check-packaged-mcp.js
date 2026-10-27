// 打包后检查：安装包里没有 MCP 代码和它用的库，只有校验值（src/mcp-module.json）和设置窗口的页面。
// 用法：node scripts/check-packaged-mcp.js dist/win-unpacked/resources/app.asar
const asar = require('@electron/asar');

const files = asar.listPackage(process.argv[2]).map((f) => f.replace(/\\/g, '/'));
const has = (f) => files.includes(f);
const bad = files.filter((f) => /^\/src\/mcp\/(?!settings\.html$|settings\.js$|preload\.js$)[^/]+$/.test(f)
  || /^\/node_modules\/(@modelcontextprotocol|zod)(\/|$)/.test(f) || /^\/bin(\/|$)/.test(f));
const missing = ['/src/mcp-module.json', '/src/mcp-module.js', '/src/mcp/settings.html', '/src/mcp/settings.js', '/src/mcp/preload.js'].filter((f) => !has(f));
if (bad.length) console.error(`不该在安装包里：\n${bad.join('\n')}`);
if (missing.length) console.error(`安装包里缺少：\n${missing.join('\n')}`);
if (bad.length || missing.length) process.exit(1);
console.log(`通过：安装包里没有 MCP 代码和库（共 ${files.length} 个文件）`);
