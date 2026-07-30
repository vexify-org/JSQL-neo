use std::collections::HashMap;
use crate::engine::table::Table;
use crate::engine::Engine;
use crate::types::{Row, TableDefinition};

pub struct MemoryEngine {
    pub tables: HashMap<String, Table>,
}

impl MemoryEngine {
    pub fn new() -> Self {
        Self { tables: HashMap::new() }
    }
}

impl Engine for MemoryEngine {
    fn create_table(&mut self, def: TableDefinition) -> Result<(), String> {
        if self.tables.contains_key(&def.name) {
            return Err(format!("table '{}' already exists", def.name));
        }
        self.tables.insert(def.name.clone(), Table::new(def.name, def.schema));
        Ok(())
    }

    fn drop_table(&mut self, name: &str) -> Result<(), String> {
        self.tables.remove(name).map(|_| ()).ok_or_else(|| format!("table '{}' not found", name))
    }

    fn has_table(&self, name: &str) -> bool {
        self.tables.contains_key(name)
    }

    fn list_tables(&self) -> Vec<String> {
        self.tables.keys().cloned().collect()
    }

    fn insert(&mut self, table: &str, fields_batch: Vec<HashMap<String, serde_json::Value>>) -> Result<Vec<u64>, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.add_rows(fields_batch))
    }

    fn find_by_id(&self, table: &str, id: u64) -> Result<Option<Row>, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.get_row(id))
    }

    fn find_by_id_json(&self, table: &str, id: u64) -> Result<Option<String>, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.get_row_json(id))
    }

    fn find_by_ids_json(&self, table: &str, ids: &[u64]) -> Result<String, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.get_rows_json(ids))
    }

    fn find(&self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
            limit: Option<usize>, offset: Option<usize>,
            cursor: Option<String>,
            order_by: &Option<String>, order: &Option<String>) -> Result<(Vec<Row>, Option<String>, bool), String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let off = cursor.as_deref().and_then(|c| c.strip_prefix('c')?.parse().ok()).or(offset);
        let off_val = off.unwrap_or(0);
        let probe_limit = limit.map(|l| l + 1);
        let all = t.find_rows(filter, probe_limit, off, order_by, order);
        let has_more = limit.map_or(false, |l| all.len() > l);
        let rows: Vec<Row> = all.into_iter().take(limit.unwrap_or(usize::MAX)).collect();
        let next_cursor = if has_more { Some(format!("c{}", off_val + limit.unwrap())) } else { None };
        Ok((rows, next_cursor, has_more))
    }

    fn count(&self, table: &str) -> Result<usize, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.count())
    }

    fn update_by_id(&mut self, table: &str, id: u64, data: HashMap<String, serde_json::Value>) -> Result<bool, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.update_row(id, data))
    }

    fn remove_by_id(&mut self, table: &str, id: u64) -> Result<bool, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.remove_row(id))
    }

    fn remove_by_ids(&mut self, table: &str, ids: &[u64]) -> Result<usize, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.remove_rows(ids))
    }

    fn update_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
                        data: HashMap<String, serde_json::Value>) -> Result<usize, String> {
        let ids: Vec<u64> = {
            let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
            t.rows.iter()
                .filter(|r| filter.as_ref().map_or(true, |f| t.row_matches(r, f)))
                .map(|r| r.id)
                .collect()
        };
        let count = ids.len();
        for id in &ids {
            let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
            t.update_row(*id, data.clone());
        }
        Ok(count)
    }

    fn remove_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>) -> Result<usize, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let len_before = t.rows.len();
        if filter.is_none() {
            t.rows.clear();
            t.pk_index.clear();
            return Ok(len_before);
        }
        let f = filter.as_ref().unwrap();
        let mut to_remove = Vec::new();
        for (i, r) in t.rows.iter().enumerate() {
            let matches = f.iter().all(|(k, v)| {
                t.field_index.get(k).and_then(|&pos| t.get_row_values(r).get(pos)).map_or(false, |fv| fv.eq_json(v))
            });
            if matches { to_remove.push(i); }
        }
        for i in to_remove.into_iter().rev() {
            t.remove_row_by_idx(i);
        }
        Ok(len_before - t.rows.len())
    }

    fn begin_tx(&mut self) -> Result<String, String> {
        Err("transactions not supported on MemoryEngine directly".into())
    }

    fn commit_tx(&mut self, _tx_id: &str) -> Result<(), String> {
        Err("transactions not supported on MemoryEngine directly".into())
    }

    fn rollback_tx(&mut self, _tx_id: &str) -> Result<(), String> {
        Err("transactions not supported on MemoryEngine directly".into())
    }
}
