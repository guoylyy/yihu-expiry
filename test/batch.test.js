import test from 'node:test'
import assert from 'node:assert/strict'
import { BATCH_MAX, parseBatch } from '../src/batch.js'

test('正常 3 行', () => {
  const { rows, errors } = parseBatch('A 合同, 2026-11-20, 合同\nB 证, 2026/11/21, 证照\nC 险, 2027-01-01, 保险')
  assert.deepEqual(errors, [])
  assert.deepEqual(rows.map((r) => [r.line, r.name, r.due_date, r.category]), [
    [1, 'A 合同', '2026-11-20', '合同'], [2, 'B 证', '2026-11-21', '证照'], [3, 'C 险', '2027-01-01', '保险']
  ])
})

test('中文逗号、Windows 换行、BOM 都认', () => {
  const { rows, errors } = parseBatch('﻿A，2026-11-20，合同\r\nB，2026/11/21，其他\r\n')
  assert.equal(errors.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'A')
})

test('坏行报行号和原因，好行不受影响', () => {
  const { rows, errors } = parseBatch('好的, 2026-11-20, 合同\n日期乱写, 明年吧, 合同\n缺列的行\n假日期, 2026-02-30, 合同\n类别不对, 2026-11-20, 发票\n,2026-11-20,合同\n也是好的, 2026/12/01, 设备')
  assert.deepEqual(rows.map((r) => r.line), [1, 7])
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 5, 6])
  assert.match(errors[0].reason, /到期日「明年吧」不对/)
  assert.match(errors[1].reason, /缺列/)
  assert.match(errors[2].reason, /到期日/)
  assert.match(errors[3].reason, /类别「发票」不对/)
  assert.match(errors[4].reason, /名称是空的/)
  assert.equal(errors[1].raw, '缺列的行')
})

test('只有两列（少了类别）算缺列', () => {
  const { rows, errors } = parseBatch('A, 2026-11-20')
  assert.equal(rows.length, 0)
  assert.match(errors[0].reason, /缺列.*2 列/)
})

test('多了列要说清楚，不瞎猜', () => {
  const { errors } = parseBatch('A, B, 2026-11-20, 合同')
  assert.match(errors[0].reason, /多了列.*4 列/)
})

test('空行跳过，但行号按原文算', () => {
  const { rows, errors } = parseBatch('\n\nA, 2026-11-20, 合同\n\n坏行\n')
  assert.deepEqual(rows.map((r) => r.line), [3])
  assert.deepEqual(errors.map((e) => e.line), [5])
})

test('空文本', () => assert.deepEqual(parseBatch('   \n '), { rows: [], errors: [] }))

test('超过上限整体拒绝', () => {
  const text = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `A${i}, 2026-11-20, 合同`).join('\n')
  assert.throws(() => parseBatch(text), /最多/)
})
