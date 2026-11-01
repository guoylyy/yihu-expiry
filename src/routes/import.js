// 导入接口：识别只出预览、不落库；人逐条确认后 /import/commit 才入库。一个文件一个请求，单个失败不影响其他
import path from 'node:path'
import express from 'express'
import { FILE_MAX, FILES_MAX, ImportError, TEXT_MAX, kindOf, readUpload } from '../import.js'
import { EXTRACT_MAX, extractItems } from '../extract.js'
import { FILE_NAME_MAX, HttpError } from '../items.js'
import { todayIn, tzName } from '../dates.js'

export const COMMIT_MAX = EXTRACT_MAX * FILES_MAX

const clip = (s, max) => [...s].slice(0, max).join('')
const tidy = (s) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const baseName = (name) => clip(path.basename(String(name ?? '').replace(/\\/g, '/')).trim(), FILE_NAME_MAX)

export function importRouter({ ws, items, settings, llm, aiTimeoutMs, importTimeoutMs, requireReady, requireUser, wrap }) {
  const r = express.Router()
  const data = [requireReady, requireUser]
  const inFlight = new Map() // 用户 id → 正在处理的文件数

  /** 页面是一个个传的，这里是兜底：绕过页面并发猛传时不让一个人占满解析线程 */
  function limitPerUser(req, res, next) {
    const n = inFlight.get(req.me.id) ?? 0
    if (n >= FILES_MAX) return next(new HttpError(429, `同时最多 ${FILES_MAX} 个文件`))
    inFlight.set(req.me.id, n + 1)
    res.once('close', () => {
      const left = inFlight.get(req.me.id) - 1
      if (left) inFlight.set(req.me.id, left)
      else inFlight.delete(req.me.id)
    })
    next()
  }

  const rawBody = express.raw({ type: () => true, limit: FILE_MAX })
  function readBody(req, res, next) {
    rawBody(req, res, (e) => next(e?.type === 'entity.too.large' ? new HttpError(413, '单个文件不能超过 10MB') : e))
  }

  async function preview(me, source, notices, fileName) {
    let text = tidy(source)
    if ([...text].length > TEXT_MAX) {
      text = clip(text, TEXT_MAX)
      notices.push(`内容太长，只看了前 ${TEXT_MAX / 10000} 万字`)
    }
    const [cfg, categories] = await Promise.all([settings.get(me.id), settings.categories(me.id)])
    const out = await extractItems(text, { llm, today: todayIn(), tz: tzName(), categories, remindDays: cfg.default_remind_days, timeoutMs: aiTimeoutMs })
    return { ok: out.ok, reason: out.reason ?? null, message: out.message ?? '', notices: [...notices, ...out.notices], file_name: fileName, categories, items: out.items }
  }

  r.post('/import/text', ...data, limitPerUser, wrap(async (req, res) => {
    const text = req.body?.text
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, '先粘贴合同或证照信息')
    const out = await preview(req.me, text, [], null)
    ws.track(req.me, 'expiry.import', { source: 'paste', ok: out.ok, reason: out.reason, count: out.items.length, chars: text.length })
    res.json(out)
  }))

  r.post('/import/file', ...data, limitPerUser, readBody, wrap(async (req, res) => {
    const name = baseName(req.query.name)
    if (!name) throw new HttpError(400, '缺少文件名')
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '请求内容不对')
    try {
      const { text, notices } = await readUpload(name, req.body, { timeoutMs: importTimeoutMs })
      const out = await preview(req.me, text, [...notices], name)
      ws.track(req.me, 'expiry.import', { source: kindOf(name), ok: out.ok, reason: out.reason, count: out.items.length, chars: text.length })
      res.json(out)
    } catch (e) {
      if (!(e instanceof ImportError)) throw e
      ws.track(req.me, 'expiry.import', { source: kindOf(name), ok: false, reason: e.code })
      res.status(422).json({ error: e.message, code: e.code })
    }
  }))

  /**
   * 确认入库。页面只发勾选的行，selected: false 的这里再挡一次。预览结果在页面上人改过，所以逐条重新校验，不信前端。
   * owner 只存文字：模型和文件里的人名不授权，能看到条目的只有创建人和设置里选的默认负责人
   */
  r.post('/import/commit', ...data, wrap(async (req, res) => {
    const rows = req.body?.items
    if (!Array.isArray(rows)) throw new HttpError(400, '请求内容不对')
    const chosen = rows.filter((x) => x && typeof x === 'object' && x.selected !== false)
    if (!chosen.length) throw new HttpError(400, '先勾选要导入的条目')
    if (chosen.length > COMMIT_MAX) throw new HttpError(400, `一次最多导入 ${COMMIT_MAX} 条`)
    const inputs = await Promise.all(chosen.map((x) => settings.withDefaults(req.me.id, {
      name: x.name,
      category: x.category,
      due_date: x.expire_at,
      remind_days: x.remind_days,
      amount: x.amount,
      note: x.note,
      owner_name: x.owner,
      file_name: x.file_name ? baseName(x.file_name) : null
    })))
    const created = await items.createImported(req.me.id, inputs).catch((e) => {
      if (e.index === undefined) throw e
      // 第几条是按提交的算的，页面据此标红那一行
      res.status(e.status).json({ error: e.message, index: e.index })
      return null
    })
    if (created === null) return
    ws.track(req.me, 'item.create', { source: 'import', count: created, needsDate: inputs.filter((x) => !x.due_date).length })
    res.status(201).json({ created })
  }))

  return r
}
