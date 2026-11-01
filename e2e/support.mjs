// e2e 公用：数据库、应用进程、尺寸审计
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

export const SIZES = [['375', 375, 667], ['768', 768, 1024], ['1440', 1440, 900]]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 用 npm test 同一个临时库：node scripts/run-tests.mjs e2e/gates.mjs 会起库并把地址放进 E2E_DATABASE_URL。这里清空重来 */
export async function startDatabase() {
  const url = process.env.E2E_DATABASE_URL
  if (!url) throw new Error('没有 E2E_DATABASE_URL，用 npm run e2e 跑')
  const conn = await mysql.createConnection(url)
  for (const t of ['expiry_item', 'expiry_setting']) await conn.query(`DROP TABLE IF EXISTS ${t}`)
  await conn.end()
  return url
}

export async function startApp({ port, env }) {
  const proc = spawn(process.execPath, ['src/server.js'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'staging', PORT: String(port), ...env } })
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null)
    if (r?.ok) break
    await sleep(200)
  }
  return proc
}

/** 在页面里跑：当前最上层可见范围内，小于 44×44 的可点元素 */
export const SMALL_TARGETS = () => {
  const out = []
  const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  for (const el of document.querySelectorAll('a, button, input:not(.file-input), textarea, select, summary, [role="button"], label:has(input)')) {
    if (!isVisible(el)) continue
    const dialogs = [...document.querySelectorAll('dialog[open]')]
    if (dialogs.length && !dialogs[dialogs.length - 1].contains(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 44 || r.height < 44) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? `.${String(el.className).replace(/\s+/g, '.')}` : ''} ${Math.round(r.width)}×${Math.round(r.height)} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 16)}`)
  }
  return out
}
