// 标题截断：切点不落在括号里。title.js 是浏览器脚本，这里放进 vm 跑
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const browser = {}
vm.runInNewContext(readFileSync('src/public/title.js', 'utf8'), browser)
const { cutTitle } = browser
const LONG = '华东区第三季度所有经销商返利对账与年度框架协议续签补充条款（含二零二六年修订版）法务审批稿'

test('标题截断：放得下的原样返回', () => {
  assert.equal(cutTitle(LONG, 52), LONG)
  assert.equal(cutTitle('甲乙丙', 3), '甲乙丙')
})

test('标题截断：切点在括号里，整段括号去掉再补 …', () => {
  assert.equal(cutTitle(LONG, 34), '华东区第三季度所有经销商返利对账与年度框架协议续签补充条款…')
  assert.equal(cutTitle('甲乙(丙丁戊己庚)辛', 6), '甲乙…')
  assert.equal(cutTitle('甲乙（丙丁戊己庚）辛', 9), '甲乙…') // 右括号正好被切掉，也算在括号里
})

test('标题截断：切点在括号外，括号完整保留', () => {
  assert.equal(cutTitle('甲（乙）丙丁戊己庚', 6), '甲（乙）丙…')
  assert.equal(cutTitle('甲乙丙丁（戊）', 4), '甲乙丙…')
})

test('标题截断：嵌套括号按最外层去掉，多余的右括号不算数', () => {
  assert.equal(cutTitle('甲（乙（丙）丁戊己庚）辛', 9), '甲…')
  assert.equal(cutTitle('甲）乙丙丁（戊己庚', 7), '甲）乙丙丁…')
})

test('标题截断：含 … 不超过上限，整个在括号里时只能照切', () => {
  for (const n of [26, 34, 44, 52]) assert.ok([...cutTitle(LONG.repeat(2), n)].length <= n)
  assert.equal(cutTitle('（甲乙丙丁戊己庚）', 5), '（甲乙丙…')
})
