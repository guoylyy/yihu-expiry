// npm test：没给 TEST_DATABASE_URL 就用 Docker 起一个临时 MySQL，跑完删掉。测试走真实 MySQL，SQL 问题才测得出来
//   node scripts/run-tests.mjs e2e/gates.mjs   同一个临时库跑别的脚本，库地址放在 E2E_DATABASE_URL
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import mysql from 'mysql2/promise'

const script = process.argv[2]
const files = readdirSync('test').filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`)
const runTests = (url) => spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url, NODE_ENV: 'test' }
}).status ?? 1
const runScript = (url) => spawnSync(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, E2E_DATABASE_URL: url } }).status ?? 1
const run = script ? runScript : runTests

const given = script ? process.env.E2E_DATABASE_URL : process.env.TEST_DATABASE_URL
if (given) process.exit(run(given))

const name = `expiry-test-mysql-${process.pid}`
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
docker('run', '-d', '--rm', '--name', name, '-e', 'MYSQL_ROOT_PASSWORD=test', '-e', 'MYSQL_DATABASE=expiry_test', '-p', '127.0.0.1::3306', 'mysql:8.0', '--skip-log-bin')
let status = 1
try {
  const port = docker('port', name, '3306/tcp').split(':').pop()
  const url = `mysql://root:test@127.0.0.1:${port}/expiry_test`
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    try { await (await mysql.createConnection(url)).end(); up = true } catch { await new Promise((r) => setTimeout(r, 1000)) }
  }
  if (!up) throw new Error('临时 MySQL 没起来')
  status = run(url)
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
process.exit(status)
