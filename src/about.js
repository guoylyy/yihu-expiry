// 「关于」页要显示的应用信息。平台模型名走开放接口，拿不到就写未配置，不让页面失败
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { VERSION } from './version.js'

const MODEL_CACHE_MS = 60_000
const MODEL_TIMEOUT_MS = 3000
const UNCONFIGURED = '未配置'
const KB = 1024

const read = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8').trim() } catch { return '' } }

/** 镜像构建时写入的 BUILD_TIME，本地直接跑没有这个文件 */
export const buildTime = () => read('../BUILD_TIME') || '本地运行，没有构建'

/** 平台模型列表里排第一的是默认模型（/api/open/llm/models，OpenAI 兼容格式） */
export function createModelInfo({ clientId, clientSecret, apiUrl }, { cacheMs = MODEL_CACHE_MS, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const available = !!(clientId && clientSecret && apiUrl)
  let cache = null

  async function fetchName() {
    try {
      const auth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
      const r = await fetch(`${apiUrl}/api/open/llm/models`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) return null
      const list = (await r.json())?.data
      const m = Array.isArray(list) ? list.find((x) => x?.default) ?? list[0] : null
      return m?.name || m?.id || null
    } catch {
      return null
    }
  }

  async function name() {
    if (!available) return null
    if (cache && Date.now() - cache.at < cacheMs) return cache.name
    cache = { name: await fetchName(), at: Date.now() }
    return cache.name
  }

  return { available, name }
}

async function databaseVersion(pool) {
  if (!pool) return '未连接'
  try {
    const [[row]] = await pool.query('SELECT VERSION() AS v')
    return `MySQL ${row.v}`
  } catch {
    return '未连接'
  }
}

export function formatBytes(n) {
  if (n < KB) return `${n} B`
  if (n < KB * KB) return `${(n / KB).toFixed(1)} KB`
  return `${(n / KB / KB).toFixed(1)} MB`
}

/** 附件目录的用量。目录还不存在（没传过附件）算 0，读不了不让页面失败 */
export async function usedBytes(dir) {
  try {
    const names = await readdir(dir)
    const sizes = await Promise.all(names.map((f) => stat(path.join(dir, f)).then((s) => s.size, () => 0)))
    return sizes.reduce((a, b) => a + b, 0)
  } catch {
    return 0
  }
}

export async function aboutInfo({ pool, modelInfo, hosted, dataDir, attachmentsDir }) {
  return {
    version: VERSION,
    build_time: buildTime(),
    mode: hosted ? '平台' : '本地单人',
    data_dir: path.resolve(dataDir),
    database: await databaseVersion(pool),
    model: (await modelInfo.name()) ?? UNCONFIGURED,
    node: process.version,
    attachments_dir: attachmentsDir,
    attachments_used: formatBytes(await usedBytes(attachmentsDir))
  }
}
