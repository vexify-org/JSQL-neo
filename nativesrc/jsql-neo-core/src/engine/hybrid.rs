// HybridEngine — Redis 式存储引擎（内存缓存 + 异步刷盘 + LRU 驱逐 + 惰性加载）
// 模式:
//   - store_dir = None     → 纯内存（等同 MemoryEngine）
//   - store_dir = Some(..) → hybrid/disk：写内存并标记脏表，flush_dirty() 增量落盘；
//     表被 evict() 驱逐后，下一次访问自动从磁盘惰性加载

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::engine::{validate_table_name, Engine, MemoryEngine, Table};
use crate::types::{FieldSchema, TableDefinition};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
struct TableMeta {
    file: String,
    #[serde(with = "crate::types::schema_order_preserving")]
    schema: Vec<(String, FieldSchema)>,
}

pub struct HybridEngine {
    mem: RefCell<MemoryEngine>,
    store_dir: Option<PathBuf>,
    meta: RefCell<HashMap<String, TableMeta>>,
    dirty: RefCell<HashSet<String>>,
    last_access: RefCell<HashMap<String, u64>>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn table_file_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 5);
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    out.push_str(".jsql.json");
    out
}

impl HybridEngine {
    pub fn new() -> Self {
        Self {
            mem: RefCell::new(MemoryEngine::new()),
            store_dir: None,
            meta: RefCell::new(HashMap::new()),
            dirty: RefCell::new(HashSet::new()),
            last_access: RefCell::new(HashMap::new()),
        }
    }

    /// 打开磁盘存储目录（mode: 'hybrid' | 'disk' | 'memory'；memory 或空目录忽略）
    /// 每次 open 重置引擎状态，避免多个库目录/实例间残留表数据
    pub fn open(&mut self, dir: &str, mode: &str) -> Result<(), String> {
        self.mem.borrow_mut().clear();
        self.meta.borrow_mut().clear();
        self.dirty.borrow_mut().clear();
        self.last_access.borrow_mut().clear();
        if dir.is_empty() || mode == "memory" {
            self.store_dir = None;
            return Ok(());
        }
        let p = PathBuf::from(dir);
        fs::create_dir_all(&p).map_err(|e| format!("cannot create dir {}: {}", dir, e))?;
        let meta_path = p.join("meta.json");
        if meta_path.exists() {
            if let Ok(json) = fs::read_to_string(&meta_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) {
                    if let Some(tables) = parsed.get("tables").and_then(|v| v.as_object()) {
                        let mut meta = HashMap::new();
                        for (name, tv) in tables {
                            let tm: TableMeta = serde_json::from_value(tv.clone()).unwrap_or_else(|_| TableMeta {
                                file: table_file_name(name),
                                schema: Vec::new(),
                            });
                            meta.insert(name.clone(), tm);
                        }
                        self.meta = RefCell::new(meta);
                    }
                }
            }
        }
        self.store_dir = Some(p);
        Ok(())
    }

    pub fn close(&mut self) {
        if self.store_dir.is_none() { return; }
        self.flush_dirty();
        self.save_meta();
    }

    /// 磁盘上的表 schema（供 napi/Node 层获取已落盘表结构）
    pub fn table_schema(&self, name: &str) -> Option<Vec<(String, FieldSchema)>> {
        self.meta.borrow().get(name).map(|m| m.schema.clone())
    }

    /// 当前驻留内存的表数量（供 evict 剩余量统计）
    pub fn mem_count(&self) -> usize {
        self.mem.borrow().tables.len()
    }

    fn table_path(&self, name: &str, file: &str) -> PathBuf {
        self.store_dir.as_ref().map(|d| d.join(file)).unwrap_or_else(|| PathBuf::from(file))
    }

    fn save_meta(&self) {
        let dir = match &self.store_dir { Some(d) => d, None => return };
        let mut tables = serde_json::Map::new();
        for (name, tm) in self.meta.borrow().iter() {
            let mut sv = serde_json::Map::new();
            for (k, fs) in &tm.schema {
                if let Ok(fv) = serde_json::to_value(fs) {
                    sv.insert(k.clone(), fv);
                }
            }
            let mut tv = serde_json::Map::new();
            tv.insert("file".into(), serde_json::Value::String(tm.file.clone()));
            tv.insert("schema".into(), serde_json::Value::Object(sv));
            tables.insert(name.clone(), serde_json::Value::Object(tv));
        }
        let doc = serde_json::json!({ "version": 1, "tables": tables });
        let tmp = dir.join("meta.json.tmp");
        if fs::write(&tmp, serde_json::to_string_pretty(&doc).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&tmp, dir.join("meta.json"));
        }
    }

    fn touch(&self, name: &str) {
        self.last_access.borrow_mut().insert(name.to_string(), now_millis());
    }

    /// 惰性加载：表不在内存但从磁盘存在 → 读文件重建
    pub fn ensure_table(&self, name: &str) {
        if self.mem.borrow().tables.contains_key(name) { return; }
        if self.store_dir.is_none() { return; }
        let tm = self.meta.borrow().get(name).cloned();
        let Some(tm) = tm else { return };
        let path = self.table_path(name, &tm.file);
        let Ok(json) = fs::read_to_string(&path) else { return };
        let mut t = Table::new(name.to_string(), &tm.schema);
        if t.import_from_json(&json).is_err() { return; }
        self.mem.borrow_mut().tables.insert(name.to_string(), t);
        self.touch(name);
    }

    fn mark_dirty(&self, name: &str) {
        self.touch(name);
        self.dirty.borrow_mut().insert(name.to_string());
    }

    /// 把单个表写盘（原子：tmp + rename）
    pub fn flush_table(&self, name: &str) -> Result<(), String> {
        if self.store_dir.is_none() { return Ok(()); }
        let json = {
            let mem = self.mem.borrow();
            let t = mem.tables.get(name).ok_or_else(|| format!("table '{}' not found", name))?;
            t.export_all()
        };
        let file = {
            let mut meta = self.meta.borrow_mut();
            if let Some(tm) = meta.get_mut(name) {
                tm.file.clone()
            } else {
                let f = table_file_name(name);
                let schema = {
                    let mem = self.mem.borrow();
                    mem.tables.get(name)
                        .map(|t| t.field_order.iter()
                            .filter_map(|n| t.schema.get(n).map(|fs| (n.clone(), fs.clone())))
                            .collect())
                        .unwrap_or_default()
                };
                meta.insert(name.to_string(), TableMeta { file: f.clone(), schema });
                f
            }
        };
        let dir = match &self.store_dir { Some(d) => d, None => return Ok(()) };
        let tmp = dir.join(format!("{}.tmp", file));
        fs::write(&tmp, json).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
        let final_path = self.table_path(name, &file);
        fs::rename(&tmp, &final_path).map_err(|e| format!("rename {}: {}", final_path.display(), e))?;
        self.save_meta();
        Ok(())
    }

    /// 增量落盘所有脏表
    pub fn flush_dirty(&self) -> Result<usize, String> {
        if self.store_dir.is_none() { return Ok(0); }
        let names: Vec<String> = self.dirty.borrow().iter().cloned().collect();
        if names.is_empty() { return Ok(0); }
        let mut flushed = 0;
        for name in &names {
            if self.flush_table(name).is_ok() {
                self.dirty.borrow_mut().remove(name);
                flushed += 1;
            }
        }
        self.save_meta();
        Ok(flushed)
    }

    /// LRU 驱逐一个最冷已落盘表（返回被驱逐的表名）
    pub fn evict_one(&self) -> Option<String> {
        let names: Vec<String> = self.mem.borrow().tables.keys().cloned().collect();
        let dirty = self.dirty.borrow();
        let candidates: Vec<String> = names.into_iter()
            .filter(|n| !dirty.contains(n) && self.meta.borrow().contains_key(n))
            .collect();
        if candidates.is_empty() { return None; }
        let mut sorted = candidates;
        sorted.sort_by_key(|n| self.last_access.borrow().get(n).copied().unwrap_or(0));
        let victim = sorted.remove(0);
        self.mem.borrow_mut().tables.remove(&victim);
        Some(victim)
    }

    /// 批量二进制插入（native_client encodeBatch 格式），兼容原 jsql_insert_buf 性能路径
    pub fn insert_buf(&self, table: &str, buf: &[u8]) -> Result<Vec<u64>, String> {
        self.ensure_table(table);
        let mut mem = self.mem.borrow_mut();
        let t = mem.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        if buf.is_empty() { return Err("empty data".to_string()); }

        let mut off = 0usize;
        let n_fields = buf[off] as usize; off += 1;
        if n_fields == 0 || off + n_fields * 2 > buf.len() { return Err("invalid header".to_string()); }

        let mut field_names = Vec::with_capacity(n_fields);
        for _ in 0..n_fields {
            let name_len = buf[off] as usize; off += 1;
            if off + name_len > buf.len() { return Err("truncated header".to_string()); }
            let name = std::str::from_utf8(&buf[off..off + name_len]).map_err(|_| "bad field name")?.to_string();
            off += name_len;
            field_names.push(name);
        }

        if off + 4 > buf.len() { return Err("truncated".to_string()); }
        let row_count = u32::from_le_bytes([buf[off], buf[off+1], buf[off+2], buf[off+3]]) as usize;
        off += 4;
        if row_count == 0 { return Ok(Vec::new()); }

        let mut parse_fv = |off: &mut usize| -> Result<crate::engine::FieldValue, String> {
            if *off >= buf.len() { return Err("truncated row".into()); }
            let tag = buf[*off]; *off += 1;
            let fv = match tag {
                0 => crate::engine::FieldValue::Null,
                1 => {
                    if *off + 8 > buf.len() { return Err("truncated int".into()); }
                    let n = i64::from_le_bytes([buf[*off], buf[*off+1], buf[*off+2], buf[*off+3], buf[*off+4], buf[*off+5], buf[*off+6], buf[*off+7]]);
                    *off += 8;
                    crate::engine::FieldValue::Int(n)
                }
                2 => {
                    if *off + 8 > buf.len() { return Err("truncated float".into()); }
                    let n = f64::from_le_bytes([buf[*off], buf[*off+1], buf[*off+2], buf[*off+3], buf[*off+4], buf[*off+5], buf[*off+6], buf[*off+7]]);
                    *off += 8;
                    crate::engine::FieldValue::Float(n)
                }
                3 => {
                    if *off + 4 > buf.len() { return Err("truncated len".into()); }
                    let len = u32::from_le_bytes([buf[*off], buf[*off+1], buf[*off+2], buf[*off+3]]) as usize;
                    *off += 4;
                    if *off + len > buf.len() { return Err("truncated str".into()); }
                    let s = std::str::from_utf8(&buf[*off..*off+len]).map_err(|_| "bad utf8")?.to_string();
                    *off += len;
                    crate::engine::FieldValue::String(s)
                }
                4 => {
                    if *off >= buf.len() { return Err("truncated bool".into()); }
                    let b = buf[*off] != 0; *off += 1;
                    crate::engine::FieldValue::Bool(b)
                }
                5 => {
                    if *off + 4 > buf.len() { return Err("truncated i32".into()); }
                    let n = i32::from_le_bytes([buf[*off], buf[*off+1], buf[*off+2], buf[*off+3]]) as i64;
                    *off += 4;
                    crate::engine::FieldValue::Int(n)
                }
                _ => crate::engine::FieldValue::Null,
            };
            Ok(fv)
        };

        let mut row_batch: Vec<Vec<crate::engine::FieldValue>> = Vec::with_capacity(row_count);
        for _ in 0..row_count {
            let mut row = Vec::with_capacity(n_fields);
            for _ in 0..n_fields { row.push(parse_fv(&mut off)?); }
            row_batch.push(row);
        }
        let ids = t.add_rows_vec_fv(&field_names, row_batch);
        drop(mem);
        self.mark_dirty(table);
        Ok(ids)
    }
}

impl Default for HybridEngine {
    fn default() -> Self { Self::new() }
}

impl Engine for HybridEngine {
    fn create_table(&mut self, def: TableDefinition) -> Result<(), String> {
        validate_table_name(&def.name)?;
        if self.mem.borrow().tables.contains_key(&def.name) || self.meta.borrow().contains_key(&def.name) {
            return Err(format!("table '{}' already exists", def.name));
        }
        self.mem.borrow_mut().create_table(def.clone())?;
        if self.store_dir.is_some() {
            let file = table_file_name(&def.name);
            self.meta.borrow_mut().insert(def.name.clone(), TableMeta { file, schema: def.schema });
            self.save_meta();
        }
        Ok(())
    }

    fn drop_table(&mut self, name: &str) -> Result<(), String> {
        let in_mem = self.mem.borrow().tables.contains_key(name);
        let in_meta = self.meta.borrow().contains_key(name);
        if !in_mem && !in_meta { return Err(format!("table '{}' not found", name)); }
        if self.store_dir.is_some() {
            if let Some(tm) = self.meta.borrow().get(name) {
                let p = self.table_path(name, &tm.file);
                let _ = fs::remove_file(&p);
            }
            self.meta.borrow_mut().remove(name);
            self.dirty.borrow_mut().remove(name);
            self.save_meta();
        }
        if in_mem { self.mem.borrow_mut().drop_table(name)?; }
        Ok(())
    }

    fn has_table(&self, name: &str) -> bool {
        self.mem.borrow().tables.contains_key(name) || self.meta.borrow().contains_key(name)
    }

    fn list_tables(&self) -> Vec<String> {
        let mut names: HashSet<String> = self.mem.borrow().tables.keys().cloned().collect();
        names.extend(self.meta.borrow().keys().cloned());
        let mut v: Vec<String> = names.into_iter().collect();
        v.sort();
        v
    }

    fn insert(&mut self, table: &str, fields_batch: Vec<HashMap<String, serde_json::Value>>) -> Result<Vec<u64>, String> {
        self.ensure_table(table);
        let ids = self.mem.borrow_mut().insert(table, fields_batch)?;
        self.mark_dirty(table);
        Ok(ids)
    }

    fn find_by_id(&self, table: &str, id: u64) -> Result<Option<crate::types::Row>, String> {
        self.ensure_table(table);
        let r = self.mem.borrow().find_by_id(table, id);
        if r.is_ok() { self.touch(table); }
        r
    }

    fn find_by_id_json(&self, table: &str, id: u64) -> Result<Option<String>, String> {
        self.ensure_table(table);
        let r = self.mem.borrow().find_by_id_json(table, id);
        if r.is_ok() { self.touch(table); }
        r
    }

    fn find_by_ids_json(&self, table: &str, ids: &[u64]) -> Result<String, String> {
        self.ensure_table(table);
        let r = self.mem.borrow().find_by_ids_json(table, ids);
        if r.is_ok() { self.touch(table); }
        r
    }

    fn find(&self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
            limit: Option<usize>, offset: Option<usize>,
            cursor: Option<String>,
            order_by: &Option<String>, order: &Option<String>) -> Result<(Vec<crate::types::Row>, Option<String>, bool), String> {
        self.ensure_table(table);
        let r = self.mem.borrow().find(table, filter, limit, offset, cursor, order_by, order);
        if r.is_ok() { self.touch(table); }
        r
    }

    fn count(&self, table: &str) -> Result<usize, String> {
        self.ensure_table(table);
        let r = self.mem.borrow().count(table);
        if r.is_ok() { self.touch(table); }
        r
    }

    fn update_by_id(&mut self, table: &str, id: u64, data: HashMap<String, serde_json::Value>) -> Result<bool, String> {
        self.ensure_table(table);
        let r = self.mem.borrow_mut().update_by_id(table, id, data)?;
        if r { self.mark_dirty(table); }
        Ok(r)
    }

    fn update_by_ids(&mut self, table: &str, batch: Vec<(u64, HashMap<String, serde_json::Value>)>) -> Result<usize, String> {
        self.ensure_table(table);
        let n = self.mem.borrow_mut().update_by_ids(table, batch)?;
        if n > 0 { self.mark_dirty(table); }
        Ok(n)
    }

    fn remove_by_id(&mut self, table: &str, id: u64) -> Result<bool, String> {
        self.ensure_table(table);
        let r = self.mem.borrow_mut().remove_by_id(table, id)?;
        if r { self.mark_dirty(table); }
        Ok(r)
    }

    fn remove_by_ids(&mut self, table: &str, ids: &[u64]) -> Result<usize, String> {
        self.ensure_table(table);
        let n = self.mem.borrow_mut().remove_by_ids(table, ids)?;
        if n > 0 { self.mark_dirty(table); }
        Ok(n)
    }

    fn update_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
                        data: HashMap<String, serde_json::Value>) -> Result<usize, String> {
        self.ensure_table(table);
        let n = self.mem.borrow_mut().update_by_filter(table, filter, data)?;
        if n > 0 { self.mark_dirty(table); }
        Ok(n)
    }

    fn remove_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>) -> Result<usize, String> {
        self.ensure_table(table);
        let n = self.mem.borrow_mut().remove_by_filter(table, filter)?;
        if n > 0 { self.mark_dirty(table); }
        Ok(n)
    }

    fn begin_tx(&mut self) -> Result<String, String> {
        self.mem.borrow_mut().begin_tx()
    }

    fn commit_tx(&mut self, tx_id: &str) -> Result<(), String> {
        self.mem.borrow_mut().commit_tx(tx_id)
    }

    fn rollback_tx(&mut self, tx_id: &str) -> Result<(), String> {
        self.mem.borrow_mut().rollback_tx(tx_id)
    }
}
