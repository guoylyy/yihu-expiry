// 页面：列表（含日历）、导入、设置、关于、导出下载都由服务端渲染
import express from 'express'
import { basePathOf } from '../yh-one.mjs'
import { VERSION } from '../version.js'
import { todayIn, tzName } from '../dates.js'
import { ACCEPT as IMPORT_ACCEPT, FILES_MAX, PDF_PAGES, TEXT_MAX } from '../import.js'
import { ACCEPT, MAX_BYTES } from '../attachments.js'
import { EXPORT_LIMIT, NAME_MAX, NOTE_MAX, REMIND_MAX } from '../items.js'
import { CATEGORIES_MAX } from '../settings.js'
import { calendarRange, decorate } from '../present.js'
import { aboutInfo } from '../about.js'
import { downloadHeader, toCsv, toMarkdown } from '../export.js'

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const EXPORT_TYPES = { csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8' }

export function pageRouter({ ws, items, settings, users, about, reminder, ready, userOf, wrap, renderBoard, filterFor }) {
  const r = express.Router()
  const page = (req, script = null) => {
    const me = userOf(req)
    return { base: `${basePathOf(req)}/`, version: VERSION, script, me, initial: [...(me?.name ?? '')][0] ?? '我', hosted: ws.enabled }
  }

  const problemOf = (req) => {
    if (!userOf(req)) return '应用未接入平台，请联系管理员'
    return ready() ? null : '数据库还没准备好，稍后刷新'
  }

  async function personName(me, id) {
    if (!id) return ''
    if (id === me.id) return me.name
    return (await users.names([id])).get(id) || `用户 ${id}`
  }

  r.get('/', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    const shell = page(req, 'board')
    if (problem) return res.status(503).render('index', { ...shell, problem })
    ws.track(me, 'home.view')
    const cfg = await settings.get(me.id)
    res.render('index', {
      ...shell,
      problem: null,
      accept: ACCEPT,
      maxBytes: MAX_BYTES,
      limits: { name: NAME_MAX, note: NOTE_MAX, remind: REMIND_MAX, remindDefault: cfg.default_remind_days },
      defaultAssignee: { id: cfg.default_assignee_id, name: await personName(me, cfg.default_assignee_id) },
      formCategories: await settings.categories(me.id),
      ...await renderBoard(me, await filterFor(req))
    })
  }))

  r.get('/import', wrap(async (req, res) => {
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    const me = userOf(req)
    ws.track(me, 'import.view')
    const cfg = await settings.get(me.id)
    res.render('import', {
      ...page(req, 'import'),
      accept: IMPORT_ACCEPT.join(','),
      filesMax: FILES_MAX,
      pdfPages: PDF_PAGES,
      textMax: TEXT_MAX,
      categories: await settings.categories(me.id),
      remindDefault: cfg.default_remind_days,
      remindMax: REMIND_MAX,
      defaultOwner: await personName(me, cfg.default_assignee_id)
    })
  }))

  // 不放 /api 下：用普通链接下载，手机内置浏览器里 blob 下载常常不灵；登录过期时走跳转
  r.get('/export', wrap(async (req, res) => {
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    const me = userOf(req)
    const filter = req.query.scope === 'all' ? {} : await filterFor(req)
    const today = todayIn()
    const list = await items.list(me.id, { ...filter, ...calendarRange(filter) }, today, EXPORT_LIMIT)
    const names = await users.names(list.flatMap((t) => [t.assignee_id, t.owner_id]).filter((id) => id && id !== me.id))
    const rows = list.map((t) => ({ ...decorate(t, me, today, names), note: t.note }))
    const format = req.query.format === 'md' ? 'md' : 'csv'
    ws.track(me, 'item.export', { format, scope: req.query.scope === 'all' ? 'all' : 'filtered', count: rows.length })
    res.set({ 'Content-Type': EXPORT_TYPES[format], 'Content-Disposition': downloadHeader(`到期台账-${today}.${format}`), 'Cache-Control': 'private, no-store' })
    res.send(format === 'md' ? toMarkdown(rows, `到期台账 ${today}`) : toCsv(rows))
  }))

  r.get('/settings', wrap(async (req, res) => {
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    const me = userOf(req)
    const cfg = await settings.get(me.id)
    const notice = reminder ? await reminder.status(cfg) : { state: 'off', text: '提醒没有启动', detail: '应用还没接上提醒服务。', last: null }
    res.render('settings', {
      ...page(req, 'settings'),
      cfg,
      notice,
      tz: tzName(),
      hours: HOURS,
      remindMax: REMIND_MAX,
      categoriesMax: CATEGORIES_MAX,
      categories: await settings.categories(me.id),
      defaultOwner: await personName(me, cfg.default_assignee_id)
    })
  }))

  r.get('/about', wrap(async (req, res) => {
    if (!userOf(req)) return res.status(503).render('missing', { ...page(req), message: '应用未接入平台，请联系管理员' })
    res.render('about', { ...page(req), info: await aboutInfo(about) })
  }))

  // 退出：清本应用会话，再让平台也退出。本地单人模式没有平台，回首页。redirect 只给人看，跳哪里由 SDK 按前缀算，不信查询串
  r.get('/logout', (req, res) => {
    if (!ws.enabled) return res.redirect(302, `${basePathOf(req)}/`)
    ws.logout(req)
    res.redirect(302, ws.logoutUrl(req))
  })

  return r
}
