use std::collections::HashMap;
use crate::engine::table::{Table, matches_filter};
use crate::engine::{validate_table_name, Engine};
use crate::types::{Row, TableDefinition};

pub struct MemoryEngine {
    pub tables: HashMap<String, Table>,
    txs: HashMap<String, HashMap<String, Table>>,
    next_tx_id: u64,
}

impl MemoryEngine {
    pub fn new() -> Self {
        Self { tables: HashMap::new(), txs: HashMap::new(), next_tx_id: 1 }
    }

    pub fn clear(&mut self) {
        self.tables.clear();
        self.txs.clear();
        self.next_tx_id = 1;
    }

    fn snapshot(&self) -> HashMap<String, Table> {
        self.tables.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
}

impl Engine for MemoryEngine {
    fn create_table(&mut self, def: TableDefinition) -> Result<(), String> {
        validate_table_name(&def.name)?;
        if self.tables.contains_key(&def.name) {
            return Err(format!("table '{}' already exists", def.name));
        }
        self.tables.insert(def.name.clone(), Table::new(def.name, &def.schema));
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

    fn find_json(&self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
                 limit: Option<usize>, offset: Option<usize>,
                 cursor: Option<String>,
                 order_by: &Option<String>, order: &Option<String>) -> Result<(String, Option<String>, bool), String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let off = cursor.as_deref().and_then(|c| c.strip_prefix('c')?.parse().ok()).or(offset);
        let off_val = off.unwrap_or(0);
        let (json, has_more) = t.find_rows_json(filter, limit, off, order_by, order);
        let next_cursor = if has_more { Some(format!("c{}", off_val + limit.unwrap())) } else { None };
        Ok((json, next_cursor, has_more))
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

    fn update_by_ids(&mut self, table: &str, batch: Vec<(u64, HashMap<String, serde_json::Value>)>) -> Result<usize, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.update_rows(batch))
    }

    fn update_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
                        data: HashMap<String, serde_json::Value>) -> Result<usize, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let ids: Vec<u64> = match filter {
            Some(f) => {
                let conds = t.parse_filter(f);
                t.rows.iter()
                    .filter(|r| matches_filter(t.get_row_values(r), &conds))
                    .map(|r| r.id)
                    .collect()
            }
            None => t.rows.iter().map(|r| r.id).collect(),
        };
        let count = ids.len();
        for id in &ids {
            t.update_row_ref(*id, &data);
        }
        Ok(count)
    }

    fn remove_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>) -> Result<usize, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let len_before = t.rows.len();
        let f = match filter {
            None => {
                t.rows.clear();
                t.pk_index.clear();
                return Ok(len_before);
            }
            Some(f) => f,
        };
        let conds = t.parse_filter(f);
        let to_remove: Vec<usize> = t.rows.iter().enumerate()
            .filter(|(_, r)| matches_filter(t.get_row_values(r), &conds))
            .map(|(i, _)| i)
            .collect();
        for i in to_remove.into_iter().rev() {
            t.remove_row_by_idx(i);
        }
        Ok(len_before - t.rows.len())
    }

    fn begin_tx(&mut self) -> Result<String, String> {
        let tx_id = format!("tx{}", self.next_tx_id);
        self.next_tx_id += 1;
        self.txs.insert(tx_id.clone(), self.snapshot());
        Ok(tx_id)
    }

    fn commit_tx(&mut self, tx_id: &str) -> Result<(), String> {
        self.txs.remove(tx_id)
            .map(|_| ())
            .ok_or_else(|| format!("transaction '{}' not found", tx_id))
    }

    fn rollback_tx(&mut self, tx_id: &str) -> Result<(), String> {
        let snap = self.txs.remove(tx_id)
            .ok_or_else(|| format!("transaction '{}' not found", tx_id))?;
        self.tables = snap;
        Ok(())
    }
}
