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

test('新增列都可空或有默认值：回滚只回代码不回库', () => {
  assert.deepEqual(ADDED_COLUMNS.map((c) => c.column), ['needs_date', 'file_name', 'owner_name', 'expire_at'])
  for (const c of ADDED_COLUMNS) assert.match(c.ddl, /NULL$|DEFAULT|GENERATED/, c.column)
})

test('v0.1 的库升上来：due_date 放开 NULL，source 认 import，老数据不动，expire_at 跟着 due_date', async () => {
  await pool.query('DROP TABLE IF EXISTS expiry_item')
  await pool.query(`CREATE TABLE expiry_item (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, owner_id INT NOT NULL, assignee_id INT NULL, name VARCHAR(200) NOT NULL,
    category VARCHAR(8) NOT NULL DEFAULT '其他', due_date DATE NOT NULL, remind_days INT NOT NULL DEFAULT 30, amount DECIMAL(14,2) NULL, note TEXT NULL,
    attachment_name VARCHAR(255) NULL, attachment_file VARCHAR(100) NULL, attachment_mime VARCHAR(100) NULL, attachment_size INT UNSIGNED NULL,
    last_notified_at DATETIME NULL, last_notified_tier VARCHAR(10) NULL, source ENUM('self','batch','ai') NOT NULL DEFAULT 'self',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_owner_due (owner_id, due_date), INDEX idx_assignee_due (assignee_id, due_date), INDEX idx_due (due_date))`)
  await pool.query("INSERT INTO expiry_item (owner_id, name, category, due_date) VALUES (1, '老合同', '合同', '2027-01-01')")
  await ensureSchema(pool)
  await ensureSchema(pool)
  await pool.query("INSERT INTO expiry_item (owner_id, name, due_date, needs_date, source) VALUES (1, '缺日期', NULL, 1, 'import')")
  const [rows] = await pool.query('SELECT name, category, expire_at, needs_date, source FROM expiry_item ORDER BY id')
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { name: '老合同', category: '合同', expire_at: '2027-01-01', needs_date: 0, source: 'self' },
    { name: '缺日期', category: '其他', expire_at: null, needs_date: 1, source: 'import' }
  ])
  await pool.query('DELETE FROM expiry_item')
})
