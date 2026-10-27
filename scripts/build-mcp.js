// 把 MCP 接口（src/mcp、bin/waswitch-mcp.js 和它们用的库）打成一个单独下载的文件。
//   node scripts/build-mcp.js          输出 dist-mcp/waswitch-mcp-<版本>.js 和 dist-mcp/mcp-module.json
//   node scripts/build-mcp.js --embed  另外把 mcp-module.json 复制到 src/，打安装包时带进去（软件靠它校验下载的文件）
// 发版时只在一台机器上打一次（release.yml 的 mcp-module），Windows 和 Mac 安装包用同一份校验值。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const outDir = path.join(root, 'dist-mcp');
const file = `waswitch-mcp-${version}.js`;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, file);
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'mcp', 'bundle.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    minify: true,
    charset: 'utf8',
    legalComments: 'eof',
    logLevel: 'warning',
  });
  const buf = fs.readFileSync(outfile);
  const info = {
    version,
    file,
    sha512: crypto.createHash('sha512').update(buf).digest('base64'),
    size: buf.length,
  };
  fs.writeFileSync(path.join(outDir, 'mcp-module.json'), `${JSON.stringify(info, null, 2)}\n`);
  if (process.argv.includes('--embed')) fs.copyFileSync(path.join(outDir, 'mcp-module.json'), path.join(root, 'src', 'mcp-module.json'));
  console.log(`${file}  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
