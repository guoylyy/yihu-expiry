// 到期台账：入口只做接线，先监听再连库，/health 才能如实反映启动状态
import { Workspace } from './yh-one.mjs'
import { createApp } from './app.js'
import { dropRoot } from './attachments.js'
import { createPool, ensureSchema } from './db.js'
import { createItems } from './items.js'
import { createNotifier, createReminder } from './reminder.js'
import { VERSION } from './version.js'

const RETRY_MS = 3000

const dataDir = process.env.EXPIRY_DATA_DIR || '/data'
try {
  if (dropRoot(dataDir)) console.log('[expiry] 已接管附件目录，降权到 node')
} catch (e) {
  // 绝不带着 root 继续跑
  console.error(`[expiry] 接管附件目录失败：${e.message}`)
  process.exit(1)
}

const ws = new Workspace()
const url = process.env.DATABASE_URL
const pool = url ? createPool(url) : null
let ready = false

const reminder = pool ? createReminder({ items: createItems({ pool }), notifier: createNotifier(ws), url: ws.appUrl ? `${ws.appUrl}/` : '' }) : null
const app = createApp({ ws, pool, getReady: () => ready, reminder, dataDir, aiTimeoutMs: Number(process.env.EXPIRY_AI_TIMEOUT_MS) || undefined })

async function prepare() {
  try {
    await ensureSchema(pool)
    ready = true
    console.log('[expiry] 数据库已就绪')
    reminder.start()
  } catch (e) {
    console.error(`[expiry] 连不上数据库，${RETRY_MS / 1000} 秒后重试：${e.message}`)
    setTimeout(prepare, RETRY_MS)
  }
}

const port = Number(process.env.PORT) || 3000
app.listen(port, () => {
  console.log(`[expiry] v${VERSION} listening on :${port}`)
  if (pool) prepare()
  else console.warn('[expiry] 没有 DATABASE_URL，只提供 /health')
})
