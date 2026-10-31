// 日期一律用 'YYYY-MM-DD' 字符串，只在这里做计算：容器时区是 UTC，用户的「今天」要按 EXPIRY_TZ 算
const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
const DAY_MS = 86400_000
const YEAR_MIN = 1970
const YEAR_MAX = 2199

export const tzName = () => process.env.EXPIRY_TZ || 'Asia/Shanghai'

const utc = (d) => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day) }
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10)

export const addDays = (d, n) => fmt(utc(d) + n * DAY_MS)
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY_MS)
export const weekdayOf = (d) => new Date(utc(d)).getUTCDay()

function localParts(now, tz) {
  const parts = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now)) parts[p.type] = p.value
  return parts
}

export function todayIn(tz = tzName(), now = new Date()) {
  const p = localParts(now, tz)
  return `${p.year}-${p.month}-${p.day}`
}

/** 当地的 { hour, minute }，每日提醒用 */
export function clockIn(tz = tzName(), now = new Date()) {
  const p = localParts(now, tz)
  return { hour: Number(p.hour), minute: Number(p.minute) }
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return fmt(utc(s)) === s
}

/** 接受 2026-11-20、2026/11/20，月日可不补零；不是真实日期或年份离谱（多半是手误）返回 null */
export function parseDate(input) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(input ?? '').trim())
  if (!m) return null
  const s = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  const year = Number(m[1])
  return isValidDate(s) && year >= YEAR_MIN && year <= YEAR_MAX ? s : null
}

/** 剩余天数：到期当天是 0，已过期为负 */
export const daysLeft = (due, today) => daysBetween(today, due)

/** 分档：expired 已过期、red ≤7 天、yellow ≤30 天、gray 其余。列表颜色和提醒去重用的是同一套档位 */
export function tierOf(days) {
  if (days < 0) return 'expired'
  if (days <= 7) return 'red'
  if (days <= 30) return 'yellow'
  return 'gray'
}

export function daysText(days) {
  if (days < 0) return `已过期 ${-days} 天`
  if (days === 0) return '今天到期'
  return `${days} 天后`
}

/**
 * 把随口说的日期解析成 YYYY-MM-DD：MCP 的到期日参数用（平台规范要求参数宽容）。
 * 支持 2026-11-03、2026/11/03、今天、明天、后天、周三、星期三、下周三、3天后。认不出返回 null
 */
export function parseDueWord(input, today) {
  const s = String(input ?? '').trim().replace(/\s+/g, '')
  if (!s) return null
  const exact = parseDate(s)
  if (exact) return exact
  if (s === '今天' || s === '今日') return today
  if (s === '明天' || s === '明日') return addDays(today, 1)
  if (s === '后天') return addDays(today, 2)
  const later = /^(\d{1,4})天(后|之后)$/.exec(s)
  if (later) return addDays(today, Number(later[1]))
  const week = /^(下下|下|本|这)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(s)
  if (!week) return null
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7))
  const offset = (CN_WEEKDAY[week[2]] + 6) % 7
  const inWeek = addDays(monday, offset)
  if (week[1] === '下') return addDays(inWeek, 7)
  if (week[1] === '下下') return addDays(inWeek, 14)
  if (week[1]) return inWeek
  // 没说「下」：这周已过就是下一周的这天
  return inWeek < today ? addDays(inWeek, 7) : inWeek
}
