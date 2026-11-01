// 接口保持薄：取当前用户 → 调 items.js / settings.js。权限都在 items.js
import express from 'express'
import { HttpError } from '../items.js'
import { MAX_BYTES, contentDisposition, storedExt } from '../attachments.js'
import { parseBatch } from '../batch.js'
import { matchesKeyword } from '../platform-users.js'
import { todayIn } from '../dates.js'
import { decorate } from '../present.js'

const PICKER_LIMIT = 50

export function apiRouter({ ws, items, settings, users, files, renderBoard, filterFor, requireReady, requireUser, wrap }) {
  const r = express.Router()
  const data = [requireReady, requireUser]

  const toJson = (t, me, names) => ({ ...decorate(t, me, todayIn(), names), note: t.note })

  // 整块看板的 HTML 片段：筛选、保存后局部刷新。放在 /api 下，未登录时回 401 而不是跳转
  r.get('/board.html', ...data, wrap(async (req, res) => {
    res.render('partials/board', await renderBoard(req.me, await filterFor(req)))
  }))

  async function checkAssignee(assigneeId, me) {
    if (assigneeId === null || assigneeId === undefined || assigneeId === '' || Number(assigneeId) === me.id) return
    const found = (await users.all()).find((u) => u.id === Number(assigneeId))
    if (!found || !found.active) throw new HttpError(400, '平台上找不到这个人')
  }

  r.post('/items', ...data, wrap(async (req, res) => {
    await checkAssignee(req.body?.assignee_id, req.me)
    const item = await items.create(req.me.id, await settings.withDefaults(req.me.id, req.body || {}))
    ws.track(req.me, 'item.create', { source: 'self', category: item.category })
    const names = await users.names(item.assignee_id && item.assignee_id !== req.me.id ? [item.assignee_id] : [])
    res.status(201).json(toJson(item, req.me, names))
  }))

  r.get('/items', ...data, wrap(async (req, res) => {
    const filter = await filterFor(req)
    const today = todayIn()
    const [list, stats] = await Promise.all([items.list(req.me.id, filter, today), items.stats(req.me.id, filter, today)])
    res.json({ stats, list: list.map((t) => toJson(t, req.me)) })
  }))

  r.get('/items/:id', ...data, wrap(async (req, res) => {
    const item = await items.get(req.me.id, req.params.id)
    const names = await users.names([item.owner_id, item.assignee_id].filter((id) => id && id !== req.me.id))
    res.json(toJson(item, req.me, names))
  }))

  r.patch('/items/:id', ...data, wrap(async (req, res) => {
    // 先确认归属，别让人靠报错探测平台用户。负责人没变时不查平台，离职的人不至于让条目改不了
    const cur = await items.assertOwner(req.me.id, req.params.id)
    const next = req.body?.assignee_id
    if (next !== undefined && (next || null) !== cur.assignee_id) await checkAssignee(next, req.me)
    const item = await items.update(req.me.id, req.params.id, req.body || {})
    ws.track(req.me, 'item.update')
    const names = await users.names(item.assignee_id && item.assignee_id !== req.me.id ? [item.assignee_id] : [])
    res.json(toJson(item, req.me, names))
  }))

  r.delete('/items/:id', ...data, wrap(async (req, res) => {
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
  r.put('/items/:id/attachment', ...data, ownerOnly, // 先查归属，非创建人的请求体不读
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

  r.delete('/items/:id/attachment', ...data, wrap(async (req, res) => {
    const out = await items.setAttachment(req.me.id, req.params.id, null)
    await files.remove(out.previous)
    ws.track(req.me, 'attachment.delete')
    res.json(toJson(out.item, req.me))
  }))

  // ---------- 批量录入 ----------
  r.post('/batch/preview', ...data, wrap(async (req, res) => {
    res.json(parseBatch(req.body?.text, await settings.categories(req.me.id)))
  }))

  // 提交的是原文，服务端重新解析，不信前端传回来的预览结果
  r.post('/batch', ...data, wrap(async (req, res) => {
    const { rows, errors } = parseBatch(req.body?.text, await settings.categories(req.me.id))
    if (!rows.length) throw new HttpError(400, '没有能录入的行')
    const created = await items.createMany(req.me.id, await Promise.all(rows.map((x) => settings.withDefaults(req.me.id, x))))
    ws.track(req.me, 'item.create', { source: 'batch', count: created, failed: errors.length })
    res.status(201).json({ created, errors })
  }))

  // ---------- 设置 ----------
  r.put('/settings', ...data, wrap(async (req, res) => {
    const input = req.body || {}
    if (input.default_assignee_id) await checkAssignee(input.default_assignee_id, req.me)
    res.json(await settings.save(req.me.id, input))
  }))

  r.post('/categories', ...data, wrap(async (req, res) => {
    res.status(201).json({ categories: await settings.addCategory(req.me.id, req.body?.name) })
  }))

  r.put('/categories/order', ...data, wrap(async (req, res) => {
    res.json({ categories: await settings.orderCategories(req.me.id, req.body?.names) })
  }))

  r.patch('/categories', ...data, wrap(async (req, res) => {
    res.json({ categories: await settings.renameCategory(req.me.id, req.body?.from, req.body?.to) })
  }))

  r.delete('/categories', ...data, wrap(async (req, res) => {
    res.json(await settings.removeCategory(req.me.id, req.body?.name))
  }))

  // 只给选人用，字段收到最少，不把手机号之类带给前端。负责人可以是自己
  r.get('/users', requireUser, wrap(async (req, res) => {
    const hits = (await users.all()).filter((u) => u.active && matchesKeyword(u, req.query.q))
    res.json({ total: hits.length, list: hits.slice(0, PICKER_LIMIT).map(({ id, name, dept }) => ({ id, name, dept })) })
  }))

  return r
}

/** 附件下载不放 /api 下：新窗口打开时登录过期，走跳转重新授权，而不是给用户看一段 JSON */
export function attachmentRouter({ ws, items, files, requireReady, requireUser, wrap }) {
  const r = express.Router()
  r.get('/attachments/:id', requireReady, requireUser, wrap(async (req, res) => {
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
  return r
}
