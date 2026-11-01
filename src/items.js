// 条目的全部读写。权限只在这一层：每条 SQL 都带当前用户 id，路由和 MCP 没有绕过它的路
//   看得到：自己创建的、负责人是自己的。其余一律 404（不告诉对方这个 id 存在）
//   创建人：能改、能删、能换附件
//   负责人：只读，能下载附件，改别的 403
import { addDays, parseDate, parseDueWord } from './dates.js'

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export const CATEGORIES = ['食品经营许可', '营业执照', '租赁合同', '保险', '资质证书', '保修', '其他']
export const DEFAULT_CATEGORY = '其他'
export const CATEGORY_MAX = 8
export const NAME_MAX = 200
export const NOTE_MAX = 5000
export const OWNER_MAX = 50
export const FILE_NAME_MAX = 255
export const REMIND_DEFAULT = 30
export const REMIND_MAX = 3650
export const WINDOWS = ['expired', 'today', '7', '30', 'needs']
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/
const ID_RE = /^[1-9]\d{0,18}$/
export const LIST_LIMIT = 500
export const EXPORT_LIMIT = 10000
const RAIL_ITEMS = 5

const COLUMNS = `id, owner_id, assignee_id, owner_name, name, category, due_date, needs_date, remind_days, amount, note,
  attachment_name, attachment_file, attachment_mime, attachment_size,
  last_notified_at, last_notified_tier, source, file_name, created_at, updated_at`
const MINE = '(owner_id = ? OR assignee_id = ?)'

const blank = (v) => v === null || v === undefined || v === ''
const clip = (s, max) => [...s].slice(0, max).join('')

export const parseName = (v) => {
  const name = String(v ?? '').trim()
  if (!name) throw new HttpError(400, '名称不能为空')
  if ([...name].length > NAME_MAX) throw new HttpError(400, `名称不能超过 ${NAME_MAX} 字`)
  return name
}
const parseNote = (v) => {
  const note = String(v ?? '').trim()
  if ([...note].length > NOTE_MAX) throw new HttpError(400, `备注不能超过 ${NOTE_MAX} 字`)
  return note || null
}
const parseDue = (v) => {
  const due = parseDate(v)
  if (!due) throw new HttpError(400, v ? '到期日格式不对' : '到期日不能为空')
  return due
}
const parseCategory = (v, allowed) => {
  if (blank(v)) return DEFAULT_CATEGORY
  if (!allowed.includes(v)) throw new HttpError(400, `类别只能是 ${allowed.join(' / ')}`)
  return v
}
const parseRemind = (v) => {
  if (blank(v)) return REMIND_DEFAULT
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > REMIND_MAX) throw new HttpError(400, `提前提醒天数要是 0 到 ${REMIND_MAX} 的整数`)
  return n
}
// 金额全程是字符串，不经过浮点数
const parseAmount = (v) => {
  if (blank(v)) return null
  const s = String(v).replace(/[,，\s]/g, '')
  if (!AMOUNT_RE.test(s)) throw new HttpError(400, '金额要是数字，最多两位小数')
  return s
}
const parseUserId = (v) => {
  if (blank(v)) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '负责人不对')
  return n
}
const parseItemId = (v) => {
  if (!ID_RE.test(String(v))) throw new HttpError(404, '条目不存在')
  return String(v)
}
const parseOwnerName = (v) => {
  const s = String(v ?? '').trim()
  if ([...s].length > OWNER_MAX) throw new HttpError(400, `负责人不能超过 ${OWNER_MAX} 字`)
  return s || null
}

/** allowNoDate：只有导入和本来就缺日期的条目能不填到期日，普通新建必须填 */
function normalize(input, { allowed, allowNoDate = false }) {
  const noDate = allowNoDate && blank(input.due_date)
  const assignee_id = parseUserId(input.assignee_id)
  return {
    name: parseName(input.name),
    category: parseCategory(input.category, allowed),
    due_date: noDate ? null : parseDue(input.due_date),
    needs_date: noDate ? 1 : 0,
    remind_days: parseRemind(input.remind_days),
    amount: parseAmount(input.amount),
    note: parseNote(input.note),
    assignee_id,
    owner_name: assignee_id ? null : parseOwnerName(input.owner_name), // 选了平台上的人，文字负责人就作废
    file_name: blank(input.file_name) ? null : clip(String(input.file_name), FILE_NAME_MAX)
  }
}

/** 筛选条件拼成 WHERE。条件只从固定写法里选，值全走占位符 */
function scope(userId, { category, who, from, to }) {
  const sql = [MINE]
  const args = [userId, userId]
  if (category) { sql.push('category = ?'); args.push(category) }
  if (who === 'none') sql.push('assignee_id IS NULL AND owner_name IS NULL')
  else if (who) { sql.push('assignee_id = ?'); args.push(who) }
  if (from && to) { sql.push('due_date BETWEEN ? AND ?'); args.push(from, to) }
  return { sql, args }
}

function windowClause(window, today) {
  if (window === 'expired') return { sql: 'due_date < ?', args: [today] }
  if (window === 'today') return { sql: 'due_date = ?', args: [today] }
  if (window === 'needs') return { sql: 'due_date IS NULL', args: [] }
  if (window === '7' || window === '30') return { sql: 'due_date BETWEEN ? AND ?', args: [today, addDays(today, Number(window))] }
  return null
}

export function createItems({ pool }) {
  async function tx(fn) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    } finally {
      conn.release()
    }
  }

  async function lockOwned(conn, userId, id) {
    const [rows] = await conn.execute(`SELECT ${COLUMNS} FROM expiry_item WHERE id = ? AND ${MINE} FOR UPDATE`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '条目不存在')
    if (rows[0].owner_id !== userId) throw new HttpError(403, '只有创建人能修改')
    return rows[0]
  }

  /** 按剩余天数升序：缺日期的最先（NULL 排最前），然后是到期日最早的（过期最久的） */
  async function list(userId, filter, today, limit = LIST_LIMIT) {
    const { sql, args } = scope(userId, filter)
    const w = windowClause(filter.window, today)
    if (w) { sql.push(w.sql); args.push(...w.args) }
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM expiry_item WHERE ${sql.join(' AND ')} ORDER BY due_date, id LIMIT ?`, [...args, limit])
    return rows
  }

  /** 统计不受时间窗口影响，点了「已过期」其余的数也不变。「30 天内」包含「7 天内」，都含今天 */
  async function stats(userId, filter, today) {
    const { sql, args } = scope(userId, filter)
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(due_date < ?), 0) AS expired, COALESCE(SUM(due_date = ?), 0) AS today,
         COALESCE(SUM(due_date BETWEEN ? AND ?), 0) AS in7, COALESCE(SUM(due_date BETWEEN ? AND ?), 0) AS in30,
         COALESCE(SUM(due_date IS NULL), 0) AS needs
       FROM expiry_item WHERE ${sql.join(' AND ')}`,
      [today, today, today, addDays(today, 7), today, addDays(today, 30), ...args]
    )
    return { total: Number(row.total), expired: Number(row.expired), today: Number(row.today), in7: Number(row.in7), in30: Number(row.in30), needs: Number(row.needs) }
  }

  /** 分类下拉里的计数：跟着负责人走，不受当前分类和时间窗口影响，和统计一个口径 */
  async function categoryCounts(userId, filter) {
    const { sql, args } = scope(userId, { ...filter, category: '' })
    const [rows] = await pool.query(`SELECT category, COUNT(*) AS n FROM expiry_item WHERE ${sql.join(' AND ')} GROUP BY category`, args)
    return new Map(rows.map((r) => [r.category, Number(r.n)]))
  }

  /** 筛选下拉里的负责人：只列我看得到的条目上出现过的人 */
  async function assignees(userId) {
    const [rows] = await pool.execute(`SELECT DISTINCT assignee_id FROM expiry_item WHERE ${MINE} AND assignee_id IS NOT NULL`, [userId, userId])
    return rows.map((r) => r.assignee_id)
  }

  /** 右侧栏：本月到期、分类分布、最近新增 */
  async function rail(userId, from, to) {
    const [[month], [byCategory], [recent]] = await Promise.all([
      pool.query(`SELECT ${COLUMNS} FROM expiry_item WHERE ${MINE} AND due_date BETWEEN ? AND ? ORDER BY due_date, id LIMIT ?`, [userId, userId, from, to, RAIL_ITEMS]),
      pool.query(`SELECT category, COUNT(*) AS n FROM expiry_item WHERE ${MINE} GROUP BY category ORDER BY n DESC, category`, [userId, userId]),
      pool.query(`SELECT ${COLUMNS} FROM expiry_item WHERE ${MINE} ORDER BY id DESC LIMIT ?`, [userId, userId, RAIL_ITEMS])
    ])
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM expiry_item WHERE ${MINE} AND due_date BETWEEN ? AND ?`, [userId, userId, from, to])
    return { month, monthTotal: Number(n), byCategory: byCategory.map((r) => ({ name: r.category, count: Number(r.n) })), recent }
  }

  /** 这个人能选的分类：设置里维护的，加上老条目还在用、已不在清单里的（v0.1 的合同、证照等），后者不能丢 */
  async function categoriesOf(userId, conn = pool) {
    const [[cfg]] = await conn.execute('SELECT categories FROM expiry_setting WHERE user_id = ?', [userId])
    const [rows] = await conn.execute('SELECT DISTINCT category FROM expiry_item WHERE owner_id = ?', [userId])
    return [...new Set([...(cfg?.categories ?? CATEGORIES), ...rows.map((r) => r.category)])]
  }

  /** 筛选用：再加上别人指派给我的条目的分类 */
  async function visibleCategories(userId) {
    const [own, [rows]] = await Promise.all([categoriesOf(userId), pool.execute('SELECT DISTINCT category FROM expiry_item WHERE assignee_id = ?', [userId])])
    return [...new Set([...own, ...rows.map((r) => r.category)])]
  }

  async function get(userId, rawId) {
    const id = parseItemId(rawId)
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM expiry_item WHERE id = ? AND ${MINE}`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '条目不存在')
    return rows[0]
  }

  /** 下载附件的归属校验：不存在和无权限都回 403，不能靠状态码探测 id */
  async function forDownload(userId, rawId) {
    if (!ID_RE.test(String(rawId))) throw new HttpError(403, '没有权限下载这个附件')
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM expiry_item WHERE id = ? AND ${MINE}`, [rawId, userId, userId])
    if (!rows.length) throw new HttpError(403, '没有权限下载这个附件')
    if (!rows[0].attachment_file) throw new HttpError(404, '这个条目没有附件')
    return rows[0]
  }

  const insert = async (conn, userId, v, source) => {
    const [r] = await conn.execute(
      `INSERT INTO expiry_item (owner_id, assignee_id, owner_name, name, category, due_date, needs_date, remind_days, amount, note, source, file_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, v.assignee_id, v.owner_name, v.name, v.category, v.due_date, v.needs_date, v.remind_days, v.amount, v.note, source, v.file_name]
    )
    return r.insertId
  }

  async function create(userId, input, { source = 'self' } = {}) {
    const v = normalize(input, { allowed: await categoriesOf(userId) })
    const id = await insert(pool, userId, v, source)
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM expiry_item WHERE id = ?`, [id])
    return rows[0]
  }

  /** 批量录入：一个事务，要么这批都进，要么都不进（坏行在解析时就已挑出去了） */
  async function createMany(userId, rows) {
    const allowed = await categoriesOf(userId)
    const values = rows.map((r) => normalize(r, { allowed }))
    return tx(async (conn) => {
      for (const v of values) await insert(conn, userId, v, 'batch')
      return values.length
    })
  }

  /** 导入：也是一个事务。可以缺到期日。服务端逐条重新校验，哪条不对报第几条，一条都不进 */
  async function createImported(userId, rows) {
    const allowed = await categoriesOf(userId)
    const values = rows.map((r, i) => {
      try {
        return normalize(r, { allowed, allowNoDate: true })
      } catch (e) {
        throw Object.assign(new HttpError(e.status ?? 400, `第 ${i + 1} 条：${e.message}`), { index: i })
      }
    })
    return tx(async (conn) => {
      for (const v of values) await insert(conn, userId, v, 'import')
      return values.length
    })
  }

  async function update(userId, rawId, input) {
    const id = parseItemId(rawId)
    return tx(async (conn) => {
      const cur = await lockOwned(conn, userId, id)
      const next = normalize({ ...cur, ...input }, { allowed: [...await categoriesOf(userId, conn), cur.category], allowNoDate: !!cur.needs_date })
      await conn.execute(
        `UPDATE expiry_item SET name = ?, category = ?, due_date = ?, needs_date = ?, remind_days = ?, amount = ?, note = ?, assignee_id = ?, owner_name = ?
         WHERE id = ? AND owner_id = ?`,
        [next.name, next.category, next.due_date, next.needs_date, next.remind_days, next.amount, next.note, next.assignee_id, next.owner_name, id, userId]
      )
      return { ...cur, ...next }
    })
  }

  async function remove(userId, rawId) {
    const id = parseItemId(rawId)
    return tx(async (conn) => {
      const cur = await lockOwned(conn, userId, id)
      await conn.execute('DELETE FROM expiry_item WHERE id = ? AND owner_id = ?', [id, userId])
      return cur
    })
  }

  /** 上传前先确认归属，非创建人的请求体不读 */
  async function assertOwner(userId, rawId) {
    const item = await get(userId, rawId)
    if (item.owner_id !== userId) throw new HttpError(403, '只有创建人能修改')
    return item
  }

  /** 换附件：返回旧文件名，由调用方在写库成功后删盘上的旧文件 */
  async function setAttachment(userId, rawId, meta) {
    const id = parseItemId(rawId)
    return tx(async (conn) => {
      const cur = await lockOwned(conn, userId, id)
      await conn.execute(
        `UPDATE expiry_item SET attachment_name = ?, attachment_file = ?, attachment_mime = ?, attachment_size = ?
         WHERE id = ? AND owner_id = ?`,
        [meta?.name ?? null, meta?.file ?? null, meta?.mime ?? null, meta?.size ?? null, id, userId]
      )
      return {
        item: { ...cur, attachment_name: meta?.name ?? null, attachment_file: meta?.file ?? null, attachment_mime: meta?.mime ?? null, attachment_size: meta?.size ?? null },
        previous: cur.attachment_file
      }
    })
  }

  /**
   * 提醒候选：已过期的和进了提醒期的。谁负责发给谁，没指定负责人发给创建人。缺日期的 DATEDIFF 是 NULL，自然不在里面。
   * 几点发、发不发按收提醒的人自己的设置，没设置过的是默认值
   */
  async function dueForReminder(today) {
    const [rows] = await pool.execute(
      `SELECT i.id, COALESCE(i.assignee_id, i.owner_id) AS user_id, i.name, i.due_date, i.last_notified_at, i.last_notified_tier,
         COALESCE(s.remind_hour, 9) AS remind_hour, COALESCE(s.notify_platform, 1) AS notify_platform
       FROM expiry_item i LEFT JOIN expiry_setting s ON s.user_id = COALESCE(i.assignee_id, i.owner_id)
       WHERE DATEDIFF(i.due_date, ?) <= i.remind_days ORDER BY user_id, i.due_date, i.id`,
      [today]
    )
    return rows
  }

  async function markNotified(ids, tier, at) {
    if (ids.length) await pool.query('UPDATE expiry_item SET last_notified_at = ?, last_notified_tier = ? WHERE id IN (?)', [at, tier, ids])
  }

  return { tx, list, stats, categoryCounts, assignees, rail, categoriesOf, visibleCategories, get, forDownload, create, createMany, createImported, update, remove, assertOwner, setAttachment, dueForReminder, markNotified }
}

/** 给 MCP 用：到期日接受随口说的日期 */
export function toolInput(args, today) {
  const due = parseDueWord(args.due_date, today)
  if (!due) throw new HttpError(400, `看不懂到期日「${args.due_date ?? ''}」，请用 2026-11-20、明天、30天后 这样的写法`)
  return { name: args.name, due_date: due, category: args.category }
}
