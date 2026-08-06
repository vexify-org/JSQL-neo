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
use crate::types::{Row, TableDefinition};

pub trait Engine {
    fn create_table(&mut self, def: TableDefinition) -> Result<(), String>;
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
