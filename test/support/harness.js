// 起一个完整实例：真实 MySQL + 真实 SDK + 假平台 + 临时附件目录。login(id) 走真实的 SSO 跳转
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspace } from '../../src/yh-one.mjs'
import { createApp } from '../../src/app.js'
import { createPool, ensureSchema } from '../../src/db.js'
import { createItems } from '../../src/items.js'
import { createNotifier, createReminder } from '../../src/reminder.js'
import { startFakePlatform } from './fake-platform.mjs'

export async function startHarness() {
  const pool = createPool(process.env.TEST_DATABASE_URL)
  await ensureSchema(pool)
  await pool.query('DELETE FROM expiry_item')
  const dataDir = await mkdtemp(path.join(tmpdir(), 'expiry-test-'))
  const platform = await startFakePlatform()
  const ws = new Workspace({ clientId: 'cid', clientSecret: 'secret', apiUrl: platform.url, webUrl: platform.url, appUrl: 'http://placeholder', basePath: '' })
  const reminder = createReminder({ items: createItems({ pool }), notifier: createNotifier(ws), url: 'http://app.test/' })
  const app = createApp({ ws, pool, reminder, dataDir })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  ws.appUrl = base

  async function login(userId) {
    platform.state.loginAs = userId
    const first = await fetch(`${base}/`, { redirect: 'manual' })
    const cookie = first.headers.get('set-cookie').split(';')[0]
    const auth = await fetch(first.headers.get('location'), { redirect: 'manual' })
    const back = await fetch(auth.headers.get('location'), { redirect: 'manual', headers: { cookie } })
    if (back.status !== 302) throw new Error(`登录失败 ${back.status}`)
    return client(cookie)
  }

  function client(cookie) {
    const call = async (method, path, body, extra = {}) => {
      const r = await fetch(base + path, {
        method,
        headers: { cookie, ...extra, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual'
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* HTML */ }
      return { status: r.status, json, text, headers: r.headers }
    }
    return {
      get: (p, headers) => call('GET', p, undefined, headers),
      post: (p, b = {}) => call('POST', p, b),
      patch: (p, b = {}) => call('PATCH', p, b),
      del: (p) => call('DELETE', p),
      upload: async (id, filename, buffer) => {
        const r = await fetch(`${base}/api/items/${id}/attachment`, {
          method: 'PUT',
          headers: { cookie, 'Content-Type': 'application/octet-stream', 'X-File-Name': filename === null ? '' : encodeURIComponent(filename) },
          body: buffer
        })
        return { status: r.status, json: await r.json().catch(() => null) }
      },
      download: async (id) => {
        const r = await fetch(`${base}/attachments/${id}`, { headers: { cookie }, redirect: 'manual' })
        return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }
      }
    }
  }

  const mcp = async (method, params, token) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    return { status: r.status, json: await r.json().catch(() => null) }
  }

  const close = async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    await platform.close()
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  }

  return { base, ws, pool, platform, dataDir, reminder, login, client, mcp, close }
}
