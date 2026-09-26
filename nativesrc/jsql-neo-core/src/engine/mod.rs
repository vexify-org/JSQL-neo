pub mod table;
mod memory;
#[cfg(not(feature = "wasm"))]
pub mod hybrid;

pub use memory::MemoryEngine;
#[cfg(not(feature = "wasm"))]
pub use hybrid::HybridEngine;
pub use table::{Table, RowStore, FieldValue, default_value};

pub fn validate_table_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("table name must not be empty".to_string());
    }
    if name.len() > 64 {
        return Err("table name too long (max 64 chars)".to_string());
    }
    if name == "." || name == ".." {
        return Err(format!("invalid table name '{}'", name));
    }
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_control() || c == '/' || c == '\\' {
            return Err(format!("invalid character in table name '{}'", name));
        }
        if c == '.' && (i > 0 && name.as_bytes()[i - 1] == b'.') {
            return Err(format!("invalid table name '{}' ('..' sequences are not allowed)", name));
        }
    }
    Ok(())
}

use std::collections::HashMap;
use crate::types::{Row, TableDefinition, FieldSchema};

pub trait Engine {
    fn create_table(&mut self, def: TableDefinition) -> Result<(), String>;
    /// 运行期加列：扩展表结构并为已有行回填默认值（见 `Table::add_column`）。
    fn add_column(&mut self, table: &str, name: &str, fs: FieldSchema) -> Result<(), String>;
    fn drop_table(&mut self, name: &str) -> Result<(), String>;
    fn has_table(&self, name: &str) -> bool;
    fn list_tables(&self) -> Vec<String>;

    fn insert(&mut self, table: &str, fields: Vec<HashMap<String, serde_json::Value>>) -> Result<Vec<u64>, String>;
    fn find_by_id(&self, table: &str, id: u64) -> Result<Option<Row>, String>;
    fn find_by_id_json(&self, table: &str, id: u64) -> Result<Option<String>, String>;
    fn find_by_ids_json(&self, table: &str, ids: &[u64]) -> Result<String, String>;
    fn find(&self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
            limit: Option<usize>, offset: Option<usize>,
            cursor: Option<String>,
            order_by: &Option<String>, order: &Option<String>) -> Result<(Vec<Row>, Option<String>, bool), String>;
    /// 与 `find` 等价，但直接产出 JSON 字符串，省掉 `Row` / `HashMap<String, Value>`
    /// 中间表示与随之而来的二次序列化。默认实现回退到 `find`。
    fn find_json(&self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
                 limit: Option<usize>, offset: Option<usize>,
                 cursor: Option<String>,
                 order_by: &Option<String>, order: &Option<String>) -> Result<(String, Option<String>, bool), String> {
        let (rows, cursor, has_more) = self.find(table, filter, limit, offset, cursor, order_by, order)?;
        let json = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string());
        Ok((json, cursor, has_more))
    }
    fn count(&self, table: &str) -> Result<usize, String>;
    fn update_by_id(&mut self, table: &str, id: u64, data: HashMap<String, serde_json::Value>) -> Result<bool, String>;
    fn update_by_ids(&mut self, table: &str, batch: Vec<(u64, HashMap<String, serde_json::Value>)>) -> Result<usize, String>;
    fn remove_by_id(&mut self, table: &str, id: u64) -> Result<bool, String>;
    fn remove_by_ids(&mut self, table: &str, ids: &[u64]) -> Result<usize, String>;

    fn update_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
                        data: HashMap<String, serde_json::Value>) -> Result<usize, String>;
    fn remove_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>) -> Result<usize, String>;

    fn begin_tx(&mut self) -> Result<String, String>;
    fn commit_tx(&mut self, tx_id: &str) -> Result<(), String>;
    fn rollback_tx(&mut self, tx_id: &str) -> Result<(), String>;
}
