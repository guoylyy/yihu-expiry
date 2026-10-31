// 路由保持薄：取当前用户 → 调 items.js。权限都在 items.js
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { basePathOf } from './yh-one.mjs'
import { VERSION } from './version.js'
import { daysLeft, daysText, tierOf, todayIn, tzName } from './dates.js'
import { CATEGORIES, HttpError, LIST_LIMIT, NAME_MAX, NOTE_MAX, REMIND_DEFAULT, REMIND_MAX, WINDOWS, createItems } from './items.js'
import { ACCEPT, MAX_BYTES, contentDisposition, createAttachments, storedExt } from './attachments.js'
import { parseBatch } from './batch.js'
import { PlatformUsersError, createPlatformUsers, matchesKeyword } from './platform-users.js'
import { buildTools, mcpHandler } from './mcp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PICKER_LIMIT = 50
const DEV_USER = { id: 1, name: '本地用户' }

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next)
const CSP = "default-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; object-src 'none'"

/** 查询串里的筛选条件，不认识的值当没传 */
const filterOf = (q) => {
  const who = String(q.who ?? '')
  return {
    category: CATEGORIES.includes(q.cat) ? q.cat : '',
    who: who === 'none' || /^[1-9]\d{0,9}$/.test(who) ? who : '',
    window: WINDOWS.includes(q.w) ? q.w : ''
  }
}

const hrefOf = (filter) => (patch) => {
  const next = { cat: filter.category, who: filter.who, w: filter.window, ...patch }
  const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString()
  return qs ? `?${qs}` : './'
}

/** 12345.60 → 12,345.60。金额是字符串，不转浮点 */
export const formatAmount = (v) => {
  if (v === null || v === undefined) return ''
  const [int, dec] = String(v).split('.')
  return `¥${int.replace(/\B(?=(\d{3})+$)/g, ',')}${dec && Number(dec) ? `.${dec}` : ''}`
}

export function createApp({ ws, pool, getReady = () => !!pool, reminder = null, dataDir = process.env.EXPIRY_DATA_DIR || '/data' }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('views', path.join(here, 'views'))
  app.set('view engine', 'ejs')

  const items = pool ? createItems({ pool }) : null
  const files = createAttachments(dataDir)
  const users = createPlatformUsers({ clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl })
  // 没配平台凭证时只有本地开发能进（单一用户）；生产环境绝不能退回匿名，否则所有人共用一本账
  const devMode = !ws.enabled && process.env.NODE_ENV !== 'production'

  // 健康检查必须免登录。配了数据库但表还没建好时不算正常，平台据此自动回滚
  app.get('/health', (req, res) => {
    if (process.env.DATABASE_URL && !getReady()) return res.status(503).json({ status: 'starting', version: VERSION })
    res.json({ status: 'ok', version: VERSION })
  })

  app.use(ws.middleware({ publicPaths: ['/health', '/mcp', '/static/'] }))
  app.use(express.json({ limit: '256kb' }))
  app.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }))
  app.use((req, res, next) => { res.setHeader('Content-Security-Policy', CSP); next() })

  const userOf = (req) => req.yhUser || (devMode ? DEV_USER : null)
  const requireReady = (req, res, next) => {
    if (!items || !getReady()) return next(new HttpError(503, '数据库还没准备好，稍后再试'))
    next()
  }
  const requireUser = (req, res, next) => {
    req.me = userOf(req)
    if (!req.me) return next(new HttpError(503, '应用未接入平台，请联系管理员'))
    next()
  }

  const decorate = (t, me, today, names = new Map()) => {
    const days = daysLeft(t.due_date, today)
    const mine = t.owner_id === me.id
    const nameOf = (id) => (id === me.id ? me.name : names.get(id) || `用户 ${id}`)
    return {
      id: t.id,
      name: t.name,
      category: t.category,
      due_date: t.due_date,
      days,
      days_text: daysText(days),
      tier: tierOf(days),
      remind_days: t.remind_days,
      amount: t.amount,
      amount_text: formatAmount(t.amount),
      mine,
      assignee_id: t.assignee_id,
      assignee: t.assignee_id ? nameOf(t.assignee_id) : '',
      from: mine ? '' : nameOf(t.owner_id),
      attachment: t.attachment_file ? { name: t.attachment_name, size: t.attachment_size, url: `attachments/${t.id}` } : null
    }
  }

  const toJson = (t, me, names) => ({ ...decorate(t, me, todayIn(), names), note: t.note })

  async function renderBoard(me, filter) {
    const today = todayIn()
    const [list, stats, assignees] = await Promise.all([items.list(me.id, filter, today), items.stats(me.id, filter, today), items.assignees(me.id)])
    const ids = [...assignees, ...list.map((t) => t.owner_id)].filter((id) => id !== me.id)
    const names = await users.names(ids)
    const people = assignees.map((id) => ({ id, name: id === me.id ? `${me.name}（我）` : names.get(id) || `用户 ${id}` }))
    return {
      filter,
      stats,
      people,
      categories: CATEGORIES,
      href: hrefOf(filter),
      truncated: list.length >= LIST_LIMIT,
      limit: LIST_LIMIT,
      items: list.map((t) => decorate(t, me, today, names))
    }
  }

  // 整块看板的 HTML 片段：筛选、保存后局部刷新。放在 /api 下，未登录时回 401 而不是跳转
  app.get('/api/board.html', requireReady, requireUser, wrap(async (req, res) => {
    res.render('partials/board', await renderBoard(req.me, filterOf(req.query)))
  }))

  async function checkAssignee(assigneeId, me) {
    if (assigneeId === null || assigneeId === undefined || assigneeId === '' || Number(assigneeId) === me.id) return
    const found = (await users.all()).find((u) => u.id === Number(assigneeId))
    if (!found || !found.active) throw new HttpError(400, '平台上找不到这个人')
  }

  app.post('/api/items', requireReady, requireUser, wrap(async (req, res) => {
    await checkAssignee(req.body?.assignee_id, req.me)
    const item = await items.create(req.me.id, req.body || {})
    ws.track(req.me, 'item.create', { source: 'self', category: item.category })
    res.status(201).json(toJson(item, req.me))
  }))

  app.get('/api/items', requireReady, requireUser, wrap(async (req, res) => {
    const filter = filterOf(req.query)
    const today = todayIn()
    const [list, stats] = await Promise.all([items.list(req.me.id, filter, today), items.stats(req.me.id, filter, today)])
    res.json({ stats, list: list.map((t) => toJson(t, req.me)) })
  }))

  app.get('/api/items/:id', requireReady, requireUser, wrap(async (req, res) => {
    const item = await items.get(req.me.id, req.params.id)
    const names = await users.names([item.owner_id, item.assignee_id].filter((id) => id && id !== req.me.id))
    res.json(toJson(item, req.me, names))
  }))

  app.patch('/api/items/:id', requireReady, requireUser, wrap(async (req, res) => {
    // 先确认归属，别让人靠报错探测平台用户。负责人没变时不查平台，离职的人不至于让条目改不了
    const cur = await items.assertOwner(req.me.id, req.params.id)
    const next = req.body?.assignee_id
    if (next !== undefined && (next || null) !== cur.assignee_id) await checkAssignee(next, req.me)
    const item = await items.update(req.me.id, req.params.id, req.body || {})
    ws.track(req.me, 'item.update')
    const names = await users.names(item.assignee_id && item.assignee_id !== req.me.id ? [item.assignee_id] : [])
    res.json(toJson(item, req.me, names))
  }))

  app.delete('/api/items/:id', requireReady, requireUser, wrap(async (req, res) => {
    const item = await items.remove(req.me.id, req.params.id)
    await files.remove(item.attachment_file)
    ws.track(req.me, 'item.delete')
    res.status(204).end()
  }))

  // ---------- 附件 ----------
  const readFile = express.raw({ type: () => true, limit: MAX_BYTES })
  const readUpload = (req, res, next) => readFile(req, res, (e) => next(e?.type === 'entity.too.large' ? new HttpError(413, '附件不能超过 10MB') : e))

  // 请求体就是文件本身，文件名放请求头：比 multipart 少一个依赖，手机上 fetch(file) 一样好用
  const ownerOnly = (req, res, next) => items.assertOwner(req.me.id, req.params.id).then(() => next(), next)
  app.put('/api/items/:id/attachment', requireReady, requireUser, ownerOnly, // 先查归属，非创建人的请求体不读
    readUpload,
    wrap(async (req, res) => {
      let filename
      try {
        filename = decodeURIComponent(String(req.headers['x-file-name'] ?? ''))
      } catch {
        throw new HttpError(400, '文件名不合法')
      }
      const meta = await files.save(req.params.id, filename, req.body)
      let out
      try {
        out = await items.setAttachment(req.me.id, req.params.id, meta)
      } catch (e) {
        await files.remove(meta.file)
        throw e
      }
      if (out.previous !== meta.file) await files.remove(out.previous)
      ws.track(req.me, 'attachment.upload', { size: meta.size, mime: meta.mime })
      res.json(toJson(out.item, req.me))
    }))

  app.delete('/api/items/:id/attachment', requireReady, requireUser, wrap(async (req, res) => {
    const out = await items.setAttachment(req.me.id, req.params.id, null)
    await files.remove(out.previous)
    ws.track(req.me, 'attachment.delete')
    res.json(toJson(out.item, req.me))
  }))

  // 不放 /api 下：新窗口打开时登录过期，走跳转重新授权，而不是给用户看一段 JSON
  app.get('/attachments/:id', requireReady, requireUser, wrap(async (req, res) => {
    const item = await items.forDownload(req.me.id, req.params.id)
    const ext = storedExt(item.attachment_file)
    // 页面的 CSP 带 object-src 'none'，会挡住浏览器内置的 PDF 预览。这里只会回白名单类型 + nosniff
    res.removeHeader('Content-Security-Policy')
    await new Promise((resolve, reject) => {
      res.sendFile(item.attachment_file, {
        root: files.root,
        cacheControl: false,
        headers: {
          'Content-Type': item.attachment_mime,
          'Content-Disposition': contentDisposition(item.attachment_name, ext),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store'
        }
      }, (e) => {
        if (!e) return resolve()
        if (res.headersSent) return resolve() // 客户端中途断开
        reject(e.status === 404 || e.code === 'ENOENT' ? new HttpError(404, '附件文件找不到了，请重新上传') : e)
      })
    })
    ws.track(req.me, 'attachment.download')
  }))

  // ---------- 批量录入 ----------
  app.post('/api/batch/preview', requireReady, requireUser, wrap(async (req, res) => {
    res.json(parseBatch(req.body?.text))
  }))

  // 提交的是原文，服务端重新解析，不信前端传回来的预览结果
  app.post('/api/batch', requireReady, requireUser, wrap(async (req, res) => {
    const { rows, errors } = parseBatch(req.body?.text)
    if (!rows.length) throw new HttpError(400, '没有能录入的行')
    const created = await items.createMany(req.me.id, rows)
    ws.track(req.me, 'item.create', { source: 'batch', count: created, failed: errors.length })
    res.status(201).json({ created, errors })
  }))

  // 只给选人用，字段收到最少，不把手机号之类带给前端。负责人可以是自己
  app.get('/api/users', requireUser, wrap(async (req, res) => {
    const hits = (await users.all()).filter((u) => u.active && matchesKeyword(u, req.query.q))
    res.json({ total: hits.length, list: hits.slice(0, PICKER_LIMIT).map(({ id, name, dept }) => ({ id, name, dept })) })
  }))

  if (items) {
    const tools = buildTools({ items, onCreated: (user) => ws.track(user, 'item.create', { source: 'ai', via: 'ai' }) })
    app.post('/mcp', requireReady, mcpHandler({ ws, tools, devUser: devMode ? DEV_USER : null }))
  } else {
    app.post('/mcp', requireReady)
  }
  // 无状态模式不开 SSE
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: '只支持 POST' }))

  const pageOf = (req) => ({ base: `${basePathOf(req)}/`, version: VERSION })

  app.get('/settings', requireUser, wrap(async (req, res) => {
    const notice = reminder ? await reminder.status() : { state: 'off', text: '未配置，不会主动提醒', detail: '数据库还没接上。', last: null }
    res.render('settings', { ...pageOf(req), notice, tz: tzName() })
  }))

  app.get('/', wrap(async (req, res) => {
    const me = userOf(req)
    const page = { ...pageOf(req), limits: { name: NAME_MAX, note: NOTE_MAX, remind: REMIND_MAX, remindDefault: REMIND_DEFAULT }, categories: CATEGORIES, accept: ACCEPT, maxBytes: MAX_BYTES }
    if (!me || !items || !getReady()) {
      return res.status(503).render('index', { ...page, me: null, problem: !me ? '应用未接入平台，请联系管理员' : '数据库还没准备好，稍后刷新' })
    }
    ws.track(me, 'home.view')
    res.render('index', { ...page, me, problem: null, ...await renderBoard(me, filterOf(req.query)) })
  }))

  app.use((req, res) => res.status(404).json({ error: '没有这个地址' }))

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    if (err instanceof PlatformUsersError) return res.status(503).json({ error: err.message })
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: '请求内容不对' })
    console.error('[expiry]', req.method, req.path, err.message)
    res.status(500).json({ error: '出错了，稍后再试' })
  })

  return app
}
