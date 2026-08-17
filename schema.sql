-- 评标工作台 D1 schema
-- 项目设置/供应商/维度/评委/会议信息 整体存 JSON blob（key='state'），打分单独存表便于并发

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  vendor_id TEXT NOT NULL,
  judge_id TEXT NOT NULL,
  dim_id TEXT NOT NULL,
  value REAL,
  comment TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vendor_id, judge_id, dim_id)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  text TEXT NOT NULL
);

-- 评委级元数据：手写签名 + 锁定状态
CREATE TABLE IF NOT EXISTS judge_meta (
  judge_id TEXT PRIMARY KEY,
  signature TEXT,
  signed_at INTEGER,
  locked INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 评委对每家供应商的总评
CREATE TABLE IF NOT EXISTS vendor_comments (
  vendor_id TEXT NOT NULL,
  judge_id TEXT NOT NULL,
  comment TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vendor_id, judge_id)
);
