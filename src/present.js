// 库里的行 → 页面要的样子，还有筛选条件和查询串的来回转换
import { daysLeft, daysText, isMonth, isValidDate, monthRange, monthWeeks, tierOf } from './dates.js'
import { WINDOWS } from './items.js'

export const VIEWS = ['list', 'calendar']
const TIER_ORDER = ['none', 'gray', 'yellow', 'red', 'expired']

/** 12345.60 → 12,345.60。金额是字符串，不转浮点 */
export const formatAmount = (v) => {
  if (v === null || v === undefined) return ''
  const [int, dec] = String(v).split('.')
  return `¥${int.replace(/\B(?=(\d{3})+$)/g, ',')}${dec && Number(dec) ? `.${dec}` : ''}`
}

/** 查询串里的筛选条件，不认识的值当没传 */
export const filterOf = (q, categories, month) => {
  const who = String(q.who ?? '')
  const view = VIEWS.includes(q.view) ? q.view : 'list'
  return {
    category: categories.includes(q.cat) ? q.cat : '',
    who: who === 'none' || /^[1-9]\d{0,9}$/.test(who) ? who : '',
    window: view === 'list' && WINDOWS.includes(q.w) ? q.w : '',
    view,
    month: isMonth(q.month) ? q.month : month,
    day: isValidDate(q.day) ? q.day : ''
  }
}

/** 日历视图下「当前筛选」的日期范围：选了某天就是那天，否则是整月 */
export const calendarRange = (filter) => {
  if (filter.view !== 'calendar') return {}
  const [from, to] = filter.day ? [filter.day, filter.day] : monthRange(filter.month)
  return { from, to }
}

export const hrefOf = (filter, thisMonth) => (patch) => {
  const calendar = (patch.view ?? filter.view) === 'calendar'
  const next = {
    view: calendar ? 'calendar' : '',
    cat: filter.category,
    who: filter.who,
    w: calendar ? '' : filter.window,
    month: calendar && filter.month !== thisMonth ? filter.month : '',
    day: calendar ? filter.day : '',
    ...patch
  }
  if (patch.view === 'list') { next.view = ''; next.month = ''; next.day = '' }
  const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString()
  return qs ? `?${qs}` : './'
}

export function decorate(t, me, today, names = new Map()) {
  const days = t.due_date ? daysLeft(t.due_date, today) : null
  const mine = t.owner_id === me.id
  const nameOf = (id) => (id === me.id ? me.name : names.get(id) || `用户 ${id}`)
  const assignee = t.assignee_id ? nameOf(t.assignee_id) : ''
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    due_date: t.due_date,
    needs_date: !t.due_date,
    days,
    days_text: t.due_date ? daysText(days) : '待补到期日',
    tier: t.due_date ? tierOf(days) : 'none',
    remind_days: t.remind_days,
    amount: t.amount,
    amount_text: formatAmount(t.amount),
    mine,
    assignee_id: t.assignee_id,
    assignee,
    owner_name: t.owner_name,
    owner: assignee || t.owner_name || '',
    from: mine ? '' : nameOf(t.owner_id),
    source: t.source,
    file_name: t.file_name,
    attachment: t.attachment_file ? { name: t.attachment_name, size: t.attachment_size, url: `attachments/${t.id}` } : null
  }
}

/** 一个月的格子。每天取当天最紧急的档位上色，点进去筛当天 */
export function calendarOf(month, today, items, selected) {
  const byDay = new Map()
  for (const t of items) {
    if (!t.due_date) continue
    const cur = byDay.get(t.due_date) ?? { count: 0, tier: 'none' }
    byDay.set(t.due_date, { count: cur.count + 1, tier: TIER_ORDER.indexOf(t.tier) > TIER_ORDER.indexOf(cur.tier) ? t.tier : cur.tier })
  }
  return monthWeeks(month).map((week) => week.map((date) => ({
    date,
    day: Number(date.slice(8)),
    inMonth: date.startsWith(month),
    isToday: date === today,
    selected: date === selected,
    count: byDay.get(date)?.count ?? 0,
    tier: byDay.get(date)?.tier ?? 'none'
  })))
}
