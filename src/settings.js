// 每人一份的应用设置，存在本应用的库里（换设备也在），每次请求现读，改完下一次操作就生效，不用重启
import { CATEGORY_MAX, DEFAULT_CATEGORY, HttpError, REMIND_DEFAULT, REMIND_MAX } from './items.js'

export const CATEGORIES_MAX = 30
export const DEFAULTS = { default_remind_days: REMIND_DEFAULT, remind_hour: 9, default_assignee_id: null, notify_platform: true, notify_inapp: true }

const parseRemind = (v) => {
  const n = v === '' || v === null ? NaN : Number(v)
  if (!Number.isInteger(n) || n < 0 || n > REMIND_MAX) throw new HttpError(400, `默认提醒天数要是 0 到 ${REMIND_MAX} 的整数`)
  return n
}
const parseHour = (v) => {
  const n = v === '' || v === null ? NaN : Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new HttpError(400, '提醒时间要在 0 到 23 点之间')
  return n
}
const parseAssignee = (v) => {
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '负责人不对')
  return n
}
const parseSwitch = (v) => {
  if (typeof v !== 'boolean') throw new HttpError(400, '开关只能是开或关')
  return v
}

/** 分类名：去空白、不能空、不超列宽。不带分隔符，批量录入和导出才不会被切开 */
export function parseCategoryName(v) {
  const name = String(v ?? '').trim()
  if (!name) throw new HttpError(400, '分类名不能为空')
  if ([...name].length > CATEGORY_MAX) throw new HttpError(400, `分类名不能超过 ${CATEGORY_MAX} 字`)
  if (/[,，\n\r\t]/.test(name)) throw new HttpError(400, '分类名不能带逗号或换行')
  return name
}

export function createSettings({ pool, items }) {
  async function get(userId) {
    const [rows] = await pool.execute('SELECT default_remind_days, remind_hour, default_assignee_id, notify_platform, notify_inapp FROM expiry_setting WHERE user_id = ?', [userId])
    if (!rows.length) return { ...DEFAULTS }
    const r = rows[0]
    return { default_remind_days: r.default_remind_days, remind_hour: r.remind_hour, default_assignee_id: r.default_assignee_id, notify_platform: !!r.notify_platform, notify_inapp: !!r.notify_inapp }
  }

  /** 部分更新：一次只改一项，页面改一项存一项 */
  async function save(userId, input) {
    const cur = await get(userId)
    const next = {
      default_remind_days: 'default_remind_days' in input ? parseRemind(input.default_remind_days) : cur.default_remind_days,
      remind_hour: 'remind_hour' in input ? parseHour(input.remind_hour) : cur.remind_hour,
      default_assignee_id: 'default_assignee_id' in input ? parseAssignee(input.default_assignee_id) : cur.default_assignee_id,
      notify_platform: 'notify_platform' in input ? parseSwitch(input.notify_platform) : cur.notify_platform,
      notify_inapp: 'notify_inapp' in input ? parseSwitch(input.notify_inapp) : cur.notify_inapp
    }
    await pool.execute(
      `INSERT INTO expiry_setting (user_id, default_remind_days, remind_hour, default_assignee_id, notify_platform, notify_inapp) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE default_remind_days = VALUES(default_remind_days), remind_hour = VALUES(remind_hour), default_assignee_id = VALUES(default_assignee_id),
         notify_platform = VALUES(notify_platform), notify_inapp = VALUES(notify_inapp)`,
      [userId, next.default_remind_days, next.remind_hour, next.default_assignee_id, next.notify_platform ? 1 : 0, next.notify_inapp ? 1 : 0]
    )
    return next
  }

  /** 表单没填的部分补上这个人的默认值。传了 null 表示明确不要负责人，不补 */
  async function withDefaults(userId, input) {
    const cfg = await get(userId)
    const out = { ...input }
    if (out.remind_days === undefined || out.remind_days === null || out.remind_days === '') out.remind_days = cfg.default_remind_days
    if (out.assignee_id === undefined && !out.owner_name) out.assignee_id = cfg.default_assignee_id
    return out
  }

  const writeList = (conn, userId, list) => conn.execute(
    'INSERT INTO expiry_setting (user_id, categories) VALUES (?, ?) ON DUPLICATE KEY UPDATE categories = VALUES(categories)',
    [userId, JSON.stringify(list)]
  )

  const categories = (userId) => items.categoriesOf(userId)

  async function addCategory(userId, raw) {
    const name = parseCategoryName(raw)
    const list = await categories(userId)
    if (list.includes(name)) throw new HttpError(400, `已经有「${name}」了`)
    if (list.length >= CATEGORIES_MAX) throw new HttpError(400, `分类最多 ${CATEGORIES_MAX} 个`)
    // 新分类排在「其他」前面，「其他」留在最后
    const at = list.indexOf(DEFAULT_CATEGORY)
    const next = at < 0 ? [...list, name] : [...list.slice(0, at), name, ...list.slice(at)]
    await writeList(pool, userId, next)
    return next
  }

  /** 改名和删除要连条目一起动，放一个事务里。只动自己创建的条目 */
  async function renameCategory(userId, rawFrom, rawTo) {
    const to = parseCategoryName(rawTo)
    return items.tx(async (conn) => {
      const list = await items.categoriesOf(userId, conn)
      if (rawFrom === DEFAULT_CATEGORY) throw new HttpError(400, `「${DEFAULT_CATEGORY}」是兜底分类，不能改名`)
      if (!list.includes(rawFrom)) throw new HttpError(404, '没有这个分类')
      if (to === rawFrom) return list
      if (list.includes(to)) throw new HttpError(400, `已经有「${to}」了`)
      await conn.execute('UPDATE expiry_item SET category = ? WHERE owner_id = ? AND category = ?', [to, userId, rawFrom])
      const next = list.map((c) => (c === rawFrom ? to : c))
      await writeList(conn, userId, next)
      return next
    })
  }

  async function removeCategory(userId, name) {
    return items.tx(async (conn) => {
      const list = await items.categoriesOf(userId, conn)
      if (name === DEFAULT_CATEGORY) throw new HttpError(400, `「${DEFAULT_CATEGORY}」是兜底分类，不能删除`)
      if (!list.includes(name)) throw new HttpError(404, '没有这个分类')
      const [r] = await conn.execute('UPDATE expiry_item SET category = ? WHERE owner_id = ? AND category = ?', [DEFAULT_CATEGORY, userId, name])
      const next = list.filter((c) => c !== name)
      await writeList(conn, userId, next.includes(DEFAULT_CATEGORY) ? next : [...next, DEFAULT_CATEGORY])
      return { categories: await items.categoriesOf(userId, conn), moved: r.affectedRows }
    })
  }

  /** 排序：只能是现有分类换个顺序，不能借机增删 */
  async function orderCategories(userId, names) {
    const list = await categories(userId)
    const same = Array.isArray(names) && names.length === list.length && new Set(names).size === list.length && names.every((n) => list.includes(n))
    if (!same) throw new HttpError(400, '分类已经变了，刷新后再排')
    await writeList(pool, userId, names)
    return names
  }

  return { get, save, withDefaults, categories, addCategory, renameCategory, removeCategory, orderCategories }
}
