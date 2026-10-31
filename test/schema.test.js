import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { ADDED_COLUMNS, createPool, ensureColumn, ensureSchema } from '../src/db.js'

let pool
before(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL)
  await ensureSchema(pool)
})
after(() => pool.end())

test('建表幂等：重复执行不报错', async () => {
  await ensureSchema(pool)
  await ensureSchema(pool)
})

test('索引和约定一致', async () => {
  const [rows] = await pool.query('SHOW INDEX FROM expiry_item')
  const idx = {}
  for (const r of rows) (idx[r.Key_name] ??= []).push(r.Column_name)
  assert.deepEqual(idx.idx_owner_due, ['owner_id', 'due_date'])
  assert.deepEqual(idx.idx_assignee_due, ['assignee_id', 'due_date'])
})

test('ensureColumn：缺列才加，再跑一次不动', async () => {
  await pool.query('DROP TABLE IF EXISTS expiry_col_test')
  await pool.query('CREATE TABLE expiry_col_test (id INT PRIMARY KEY)')
  const col = { table: 'expiry_col_test', column: 'extra', ddl: 'VARCHAR(20) NULL' }
  assert.equal(await ensureColumn(pool, col), true)
  assert.equal(await ensureColumn(pool, col), false)
  await pool.query('DROP TABLE expiry_col_test')
})

test('新增列清单当前为空（v0.1 是初始结构）', () => assert.deepEqual(ADDED_COLUMNS, []))
