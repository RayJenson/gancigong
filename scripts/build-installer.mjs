import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const NSIS_PACKAGE = 'https://registry.npmmirror.com/@nsis-u/makensis/-/makensis-3.3.0.tgz'

const root = resolve(import.meta.dirname, '..')
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(root, 'src-tauri/target')
const releaseDir = join(targetDir, 'release')
const appExe = join(releaseDir, 'gancigong.exe')

if (!existsSync(appExe)) {
  console.error(`找不到 ${appExe}\n请先执行 npx tauri build（或至少完成 release 编译）`)
  process.exit(1)
}

const nsisDir = await ensureNsis()
const scriptPath = join(root, 'scripts/nsis/installer.nsi')
ensureUtf8Bom(scriptPath)

const outDir = join(releaseDir, 'bundle', 'nsis')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `赶词工_${conf.version}_x64-setup.exe`)

execFileSync(
  join(nsisDir, 'Bin', 'makensis.exe'),
  [
    '/V2',
    `/DVERSION=${conf.version}`,
    `/DAPPEXE=${appExe}`,
    `/DRESDIR=${join(root, 'resources')}`,
    `/DICONFILE=${join(root, 'src-tauri/icons/icon.ico')}`,
    `/DOUTFILE=${outFile}`,
    scriptPath,
  ],
  { stdio: 'inherit' },
)

console.log(`\n安装包已生成：${outFile}`)

async function ensureNsis() {
  const base = join(process.env.LOCALAPPDATA || homedir(), 'gancigong-build', 'nsis')
  if (existsSync(join(base, 'Bin', 'makensis.exe'))) {
    return base
  }
  mkdirSync(base, { recursive: true })
  console.log('首次构建，从 npm 镜像获取 NSIS 3.03 ...')
  const res = await fetch(NSIS_PACKAGE)
  if (!res.ok) {
    throw new Error(`下载 NSIS 失败：HTTP ${res.status}`)
  }
  const tgz = join(base, 'nsis.tgz')
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
  // Git 自带的 GNU tar 会把 C:\ 当成远程主机名，改用系统自带的 bsdtar
  const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(bsdtar, ['-xzf', tgz, '-C', base, '--strip-components=1'], {
    stdio: 'inherit',
  })
  rmSync(tgz, { force: true })
  return base
}

// makensis 只在 UTF-8 BOM 存在时按 UTF-8 解析脚本，否则中文会乱码
function ensureUtf8Bom(file) {
  const buf = readFileSync(file)
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return
  }
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]))
}
