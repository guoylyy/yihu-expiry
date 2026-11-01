import test from 'node:test'
import assert from 'node:assert/strict'
import { addDays, clockIn, daysLeft, daysText, monthDayText, parseDate, parseDueWord, tierOf, todayIn } from '../src/dates.js'

test('剩余天数：同月', () => assert.equal(daysLeft('2026-11-20', '2026-11-05'), 15))
test('剩余天数：跨月（10 月 31 → 11 月 1）', () => assert.equal(daysLeft('2026-11-01', '2026-10-31'), 1))
test('剩余天数：跨闰年二月', () => assert.equal(daysLeft('2028-03-01', '2028-02-28'), 2))
test('剩余天数：跨年', () => assert.equal(daysLeft('2027-01-01', '2026-12-31'), 1))
test('剩余天数：跨整年', () => assert.equal(daysLeft('2027-10-30', '2026-10-30'), 365))
test('剩余天数：当天到期是 0', () => assert.equal(daysLeft('2026-10-30', '2026-10-30'), 0))
test('剩余天数：已过期是负数', () => assert.equal(daysLeft('2026-10-25', '2026-10-30'), -5))
test('剩余天数：已过期且跨年', () => assert.equal(daysLeft('2025-12-31', '2026-01-02'), -2))

for (const [days, tier] of [[-1, 'expired'], [0, 'red'], [1, 'red'], [7, 'red'], [8, 'yellow'], [30, 'yellow'], [31, 'gray']]) {
  test(`分档边界：${days} 天 → ${tier}`, () => assert.equal(tierOf(days), tier))
}

test('文案：日历标题的几月几日，不补零', () => {
  assert.equal(monthDayText('2026-11-06'), '11 月 6 日')
  assert.equal(monthDayText('2027-01-30'), '1 月 30 日')
})

test('文案：已过期 / 今天 / N 天后', () => {
  assert.equal(daysText(-5), '已过期 5 天')
  assert.equal(daysText(0), '今天到期')
  assert.equal(daysText(1), '1 天后')
  assert.equal(daysText(60), '60 天后')
})

test('「今天」按配置的时区算：UTC 16:30 在上海已是第二天', () => {
  const now = new Date('2026-10-30T16:30:00Z')
  assert.equal(todayIn('Asia/Shanghai', now), '2026-10-31')
  assert.equal(todayIn('UTC', now), '2026-10-30')
})

test('当地钟点：UTC 01:00 是上海 09:00', () => {
  assert.deepEqual(clockIn('Asia/Shanghai', new Date('2026-10-30T01:00:00Z')), { hour: 9, minute: 0 })
})

test('日期解析：横线、斜线、不补零', () => {
  assert.equal(parseDate('2026-11-20'), '2026-11-20')
  assert.equal(parseDate('2026/11/20'), '2026-11-20')
  assert.equal(parseDate('2026/1/5'), '2026-01-05')
})

test('日期解析：不是真实日期或手误的年份返回 null', () => {
  for (const s of ['2026-02-30', '2026-13-01', '下个月', '20261120', '', null, undefined, '0226-11-20']) assert.equal(parseDate(s), null, String(s))
})

test('随口说的日期（MCP 用）', () => {
  const today = '2026-10-30' // 周五
  assert.equal(parseDueWord('明天', today), '2026-10-31')
  assert.equal(parseDueWord('30天后', today), addDays(today, 30))
  assert.equal(parseDueWord('下周一', today), '2026-11-02')
  assert.equal(parseDueWord('2026/12/1', today), '2026-12-01')
  assert.equal(parseDueWord('随便', today), null)
})
