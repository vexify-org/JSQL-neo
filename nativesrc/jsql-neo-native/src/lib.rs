use std::cell::RefCell;
use std::collections::HashMap;
use jsql_neo_core::engine::{Engine, HybridEngine, FieldValue, RowStore};
use jsql_neo_core::types::{FieldSchema, TableDefinition, schema_order_preserving};
use napi_derive::napi;
use napi::JsBuffer;

thread_local! {
    static ENGINE: RefCell<HybridEngine> = RefCell::new(HybridEngine::new());
}

fn with_engine_mut<F>(f: F) -> String
where
    F: FnOnce(&mut HybridEngine) -> String,
{
    ENGINE.with(|cell| match cell.try_borrow_mut() {
        Ok(mut eng) => f(&mut eng),
        Err(_) => r#"{"ok":false,"error":"engine busy (reentrant call)"}"#.to_string(),
    })
}

fn with_engine_ro<F>(f: F) -> String
where
    F: FnOnce(&HybridEngine) -> String,
{
    ENGINE.with(|cell| match cell.try_borrow() {
        Ok(eng) => f(&eng),
        Err(_) => r#"{"ok":false,"error":"engine busy (reentrant call)"}"#.to_string(),
    })
}

fn safe_json_result(result: Result<String, String>) -> String {
    match result {
        Ok(s) => s,
        Err(e) => format!(r#"{{"error":"{}"}}"#, e.replace('"', r#"\""#)),
    }
}

#[napi]
pub fn jsql_open(dir: String, mode: String) -> String {
    with_engine_mut(|eng| {
        let open_res = eng.open(&dir, &mode);
        match open_res {
            Ok(()) => {
                let names = eng.list_tables();
                let mut out = serde_json::Map::new();
                out.insert("ok".into(), serde_json::Value::Bool(true));
                out.insert("tables".into(), serde_json::Value::Array(
                    names.iter().map(|n| serde_json::Value::String(n.clone())).collect()
                ));
                let mut schemas = serde_json::Map::new();
                for n in &names {
                    if let Some(s) = eng.table_schema(n) {
                        let mut v = serde_json::Map::new();
                        for (k, fs) in &s {
                            if let Ok(fv) = serde_json::to_value(fs) {
                                v.insert(k.clone(), fv);
                            }
                        }
                        schemas.insert(n.clone(), serde_json::Value::Object(v));
                    }
                }
                out.insert("schemas".into(), serde_json::Value::Object(schemas));
                serde_json::to_string(&out).unwrap_or_else(|_| r#"{"ok":true}"#.to_string())
            }
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e.replace('"', r#"\""#)),
        }
    })
}

#[napi]
pub fn jsql_flush_dirty() -> String {
    with_engine_mut(|eng| {
        match eng.flush_dirty() {
            Ok(n) => format!(r#"{{"ok":true,"flushed":{}}}"#, n),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e.replace('"', r#"\""#)),
        }
    })
}

#[napi]
pub fn jsql_evict() -> String {
    with_engine_mut(|eng| {
        match eng.evict_one() {
            Some(name) => format!(r#"{{"ok":true,"evicted":"{}","remaining":{}}}"#, name, eng.mem_count()),
            None => r#"{"ok":true,"evicted":null,"remaining":0}"#.to_string(),
        }
    })
}

#[napi]
pub fn jsql_close() -> String {
    with_engine_mut(|eng| {
        eng.close();
        r#"{"ok":true}"#.to_string()
    })
}

#[napi]
pub fn jsql_create_table(name: String, schema_json: String) -> String {
    use schema_order_preserving;
    let mut d = serde_json::Deserializer::from_str(&schema_json);
    let schema: Vec<(String, FieldSchema)> = match schema_order_preserving::deserialize(&mut d) {
        Ok(s) => s,
        Err(e) => return format!(r#"{{"ok":false,"error":"invalid schema: {}"}}"#, e),
    };
    let def = TableDefinition { name: name.clone(), schema };
    with_engine_mut(|eng| match eng.create_table(def) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_drop_table(name: String) -> String {
    with_engine_mut(|eng| match eng.drop_table(&name) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_insert(table: String, data_json: String) -> String {
    with_engine_mut(|eng| {
        let data: Vec<HashMap<String, serde_json::Value>> = match serde_json::from_str(&data_json) {
            Ok(d) => d,
            Err(e) => return format!(r#"{{"error":"invalid data: {}"}}"#, e),
        };
        match eng.insert(&table, data) {
            Ok(ids) => serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_insert_buf(table: String, data: JsBuffer) -> String {
    let buf_val = match data.into_value() {
        Ok(v) => v,
        Err(_) => return r#"{"error":"invalid buffer"}"#.to_string(),
    };
    with_engine_mut(|eng| {
        let buf: &[u8] = buf_val.as_ref();
        let res = eng.insert_buf(&table, buf)
            .map(|ids| serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()));
        safe_json_result(res.map_err(|e| e))
    })
}

#[napi]
pub fn jsql_find(table: String, filter_json: String, limit: i32, offset: i32) -> String {
    with_engine_ro(|eng| {
        let filter: Option<HashMap<String, serde_json::Value>> =
            if filter_json.is_empty() { None } else { serde_json::from_str(&filter_json).ok() };
        match eng.find(&table, &filter, Some(limit as usize), Some(offset as usize), None, &None, &None) {
            Ok((rows, _, _)) => serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_find_by_id(table: String, id: i64) -> String {
    with_engine_ro(|eng| {
        match eng.find_by_id_json(&table, id as u64) {
            Ok(Some(s)) => s,
            Ok(None) => "null".to_string(),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_count(table: String) -> String {
    with_engine_ro(|eng| match eng.count(&table) {
        Ok(c) => format!("{}", c),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_update_by_id(table: String, id: i64, data_json: String) -> String {
    with_engine_mut(|eng| {
        let data: HashMap<String, serde_json::Value> = match serde_json::from_str(&data_json) {
            Ok(d) => d,
            Err(e) => return format!(r#"{{"ok":false,"error":"invalid data: {}"}}"#, e),
        };
        match eng.update_by_id(&table, id as u64, data) {
            Ok(true) => r#"{"ok":true}"#.to_string(),
            Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_remove_by_id(table: String, id: i64) -> String {
    with_engine_mut(|eng| match eng.remove_by_id(&table, id as u64) {
        Ok(true) => r#"{"ok":true}"#.to_string(),
        Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_remove_by_ids(table: String, ids_json: String) -> String {
    with_engine_mut(|eng| {
        let ids: Vec<u64> = match serde_json::from_str(&ids_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
        };
        match eng.remove_by_ids(&table, &ids) {
            Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_update_by_ids(table: String, batch_json: String) -> String {
    with_engine_mut(|eng| {
        let batch: Vec<(u64, HashMap<String, serde_json::Value>)> = match serde_json::from_str(&batch_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid batch: {}"}}"#, e),
        };
        match eng.update_by_ids(&table, batch) {
            Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_find_by_ids(table: String, ids_json: String) -> String {
    with_engine_ro(|eng| {
        let ids: Vec<u64> = match serde_json::from_str(&ids_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
        };
        match eng.find_by_ids_json(&table, &ids) {
            Ok(s) => s,
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_begin_tx() -> String {
    with_engine_mut(|eng| match eng.begin_tx() {
        Ok(tx_id) => serde_json::json!({ "ok": true, "txId": tx_id }).to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_commit_tx(tx_id: String) -> String {
    with_engine_mut(|eng| match eng.commit_tx(&tx_id) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_rollback_tx(tx_id: String) -> String {
    with_engine_mut(|eng| match eng.rollback_tx(&tx_id) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}
