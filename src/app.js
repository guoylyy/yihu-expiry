// 只做接线：中间件 → 接口 → MCP → 页面。路由在 routes/，权限都在 items.js
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { VERSION } from './version.js'
import { addMonths, monthDayText, monthRange, todayIn } from './dates.js'
import { HttpError, LIST_LIMIT, createItems } from './items.js'
import { createAttachments } from './attachments.js'
import { PlatformUsersError, createPlatformUsers } from './platform-users.js'
import { createSettings } from './settings.js'
import { createModelInfo } from './about.js'
import { calendarOf, decorate, filterOf, formatAmount, hrefOf } from './present.js'
import { buildTools, mcpHandler } from './mcp.js'
import { apiRouter, attachmentRouter } from './routes/api.js'
import { importRouter } from './routes/import.js'
import { pageRouter } from './routes/pages.js'

export { formatAmount }

const here = path.dirname(fileURLToPath(import.meta.url))
const DEV_USER = { id: 1, name: '本地用户' }
const BODY_LIMIT = '256kb' // 粘贴上限 5 万字，全是四字节字符也放得下

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next)
const CSP = "default-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; object-src 'none'"

export function createApp({ ws, pool, getReady = () => !!pool, reminder = null, dataDir = process.env.EXPIRY_DATA_DIR || '/data', aiTimeoutMs, importTimeoutMs }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('views', path.join(here, 'views'))
  app.set('view engine', 'ejs')

  const items = pool ? createItems({ pool }) : null
  const settings = pool ? createSettings({ pool, items }) : null
  const files = createAttachments(dataDir)
  const credentials = { clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl }
  const users = createPlatformUsers(credentials)
  const modelInfo = createModelInfo(credentials)
  const llm = ws.clientId && ws.clientSecret ? (opts) => ws.llm(opts) : null
  // 没配平台凭证时只有本地开发能进（单一用户）；生产环境绝不能退回匿名，否则所有人共用一本账
  const devMode = !ws.enabled && process.env.NODE_ENV !== 'production'

  // 健康检查必须免登录。配了数据库但表还没建好时不算正常，平台据此自动回滚
  app.get('/health', (req, res) => {
    if (process.env.DATABASE_URL && !getReady()) return res.status(503).json({ status: 'starting', version: VERSION })
    res.json({ status: 'ok', version: VERSION })
  })

  app.use(ws.middleware({ publicPaths: ['/health', '/mcp', '/static/'] }))
  app.use(express.json({ limit: BODY_LIMIT }))
  app.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }))
  app.use((req, res, next) => { res.setHeader('Content-Security-Policy', CSP); next() })

  const userOf = (req) => req.yhUser || (devMode ? DEV_USER : null)
  const ready = () => !!items && getReady()
  const requireReady = (req, res, next) => {
    if (!ready()) return next(new HttpError(503, '数据库还没准备好，稍后再试'))
    next()
  }
  const requireUser = (req, res, next) => {
    req.me = userOf(req)
    if (!req.me) return next(new HttpError(503, '应用未接入平台，请联系管理员'))
    next()
  }

  const filterFor = async (req) => filterOf(req.query, await items.visibleCategories(userOf(req).id), todayIn().slice(0, 7))

  async function loadCalendar(me, filter, today) {
    const [from, to] = monthRange(filter.month)
    const [month, undated] = await Promise.all([
      items.list(me.id, { ...filter, window: '', from, to }, today),
      items.list(me.id, { ...filter, window: 'needs' }, today)
    ])
    return { month, undated }
  }

  /** 看板的全部数据：列表视图和日历视图共用一个局部，右侧栏不跟筛选走 */
  async function renderBoard(me, filter) {
    const today = todayIn()
    const thisMonth = today.slice(0, 7)
    const calendarOn = filter.view === 'calendar'
    const cal = calendarOn ? await loadCalendar(me, filter, today) : null
    const [railFrom, railTo] = monthRange(thisMonth)
    const [list, stats, categoryCounts, assignees, rail, categories] = await Promise.all([
      calendarOn ? [] : items.list(me.id, filter, today),
      items.stats(me.id, filter, today),
      items.categoryCounts(me.id, filter),
      items.assignees(me.id),
      items.rail(me.id, railFrom, railTo),
      items.visibleCategories(me.id)
    ])
    const rows = calendarOn ? cal.month : list
    const undated = cal?.undated ?? []
    const shown = [...rows, ...undated, ...rail.month, ...rail.recent].flatMap((t) => [t.owner_id, t.assignee_id])
    const names = await users.names([...assignees, ...shown].filter((id) => id && id !== me.id))
    const show = (t) => decorate(t, me, today, names)
    const decorated = rows.map(show)
    return {
      filter,
      stats,
      people: assignees.map((id) => ({ id, name: id === me.id ? `${me.name}（我）` : names.get(id) || `用户 ${id}` })),
      categories,
      categoryCounts,
      href: hrefOf(filter, thisMonth),
      truncated: rows.length >= LIST_LIMIT,
      limit: LIST_LIMIT,
      items: filter.day ? decorated.filter((t) => t.due_date === filter.day) : decorated,
      undated: undated.map(show),
      calendar: calendarOn ? { month: filter.month, prev: addMonths(filter.month, -1), next: addMonths(filter.month, 1), label: `${Number(filter.month.slice(0, 4))} 年 ${Number(filter.month.slice(5))} 月`, dayLabel: filter.day ? monthDayText(filter.day) : '', weeks: calendarOf(filter.month, today, decorated, filter.day) } : null,
      rail: { month: rail.month.map(show), monthTotal: rail.monthTotal, byCategory: rail.byCategory, recent: rail.recent.map(show) }
    }
  }

  const about = { pool, modelInfo, hosted: ws.enabled, dataDir, attachmentsDir: files.root }
  const guards = { requireReady, requireUser, wrap }
  app.use('/api', importRouter({ ws, items, settings, llm, aiTimeoutMs, importTimeoutMs, ...guards }))
  app.use('/api', apiRouter({ ws, items, settings, users, files, renderBoard, filterFor, ...guards }))
  app.use(attachmentRouter({ ws, items, files, ...guards }))

  if (items) {
    const tools = buildTools({ items, settings, onCreated: (user) => ws.track(user, 'item.create', { source: 'ai', via: 'ai' }) })
    app.post('/mcp', requireReady, mcpHandler({ ws, tools, devUser: devMode ? DEV_USER : null }))
  } else {
    app.post('/mcp', requireReady)
  }
  // 无状态模式不开 SSE
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: '只支持 POST' }))

  app.use(pageRouter({ ws, items, settings, users, about, reminder, ready, userOf, wrap, renderBoard, filterFor }))

  app.use((req, res) => res.status(404).json({ error: '没有这个地址' }))

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    if (err instanceof PlatformUsersError) return res.status(503).json({ error: err.message })
    if (err.type === 'entity.too.large') return res.status(400).json({ error: '内容太长了' })
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求内容不对' })
    console.error('[expiry]', req.method, req.path, err.message)
    res.status(500).json({ error: '出错了，稍后再试' })
  })

  return app
}
