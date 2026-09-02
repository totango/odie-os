import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const [sourceArgument, outputArgument = 'release-macos'] = process.argv.slice(2)

if (!sourceArgument) {
  throw new Error('Usage: pnpm macos:prepare-release <notarized-dmg> [output-directory]')
}
if (process.platform !== 'darwin') throw new Error('macOS release preparation must run on macOS')

const source = resolve(sourceArgument)
const outputDirectory = resolve(outputArgument)
const sourceStat = await stat(source)
if (!sourceStat.isFile()) throw new Error(`${source} is not a file`)

const tauriConfig = JSON.parse(await readFile(resolve(packageRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
const cargoToml = await readFile(resolve(packageRoot, 'src-tauri/Cargo.toml'), 'utf8')
const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1]
const version = tauriConfig.version

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('tauri.conf.json must contain a numeric three-part version')
}
if (packageJson.version !== version || cargoVersion !== version) {
  throw new Error('package.json, Cargo.toml, and tauri.conf.json versions must match')
}

await execFile('/usr/bin/xcrun', ['stapler', 'validate', source])
await execFile('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose', source])

const mountPoint = await mkdtemp(join(tmpdir(), 'odie-release-'))
try {
  await execFile('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, source])
  const appNames = (await readdir(mountPoint)).filter((name) => name.endsWith('.app'))
  if (appNames.length !== 1) throw new Error('disk image must contain exactly one application')
  const infoPlist = join(mountPoint, appNames[0], 'Contents/Info.plist')
  const [{ stdout: appVersion }, { stdout: appIdentifier }] = await Promise.all([
    execFile('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', infoPlist]),
    execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', infoPlist]),
  ])
  if (appVersion.trim() !== version) {
    throw new Error(`disk image contains version ${appVersion.trim()}, expected ${version}`)
  }
  if (appIdentifier.trim() !== tauriConfig.identifier) {
    throw new Error(`disk image contains identifier ${appIdentifier.trim()}, expected ${tauriConfig.identifier}`)
  }
} finally {
  await execFile('/usr/bin/hdiutil', ['detach', mountPoint]).catch(() => {})
  await rm(mountPoint, { recursive: true, force: true })
}

await mkdir(outputDirectory, { recursive: true })
const dmgName = 'OdieOS-latest.dmg'
const dmgPath = resolve(outputDirectory, dmgName)
if (source !== dmgPath) await copyFile(source, dmgPath)

const checksum = await new Promise((resolveChecksum, reject) => {
  const hash = createHash('sha256')
  createReadStream(dmgPath)
    .on('data', (chunk) => hash.update(chunk))
    .on('error', reject)
    .on('end', () => resolveChecksum(hash.digest('hex')))
})
const versionedDmgName = `OdieOS-${version}-${checksum}.dmg`
const versionedDmgPath = resolve(outputDirectory, versionedDmgName)
if (source !== versionedDmgPath) await copyFile(source, versionedDmgPath)
await Promise.all([
  writeFile(resolve(outputDirectory, `${dmgName}.sha256`), `${checksum}  ${dmgName}\n`),
  writeFile(resolve(outputDirectory, 'OdieOS-latest.json'), `${JSON.stringify({
    version,
    url: `/downloads/mac/${versionedDmgName}`,
    sha256: checksum,
  })}\n`),
])

console.log(`Prepared Odie OS ${version} from ${basename(source)} in ${outputDirectory}`)
