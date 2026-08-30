use jsql_neo_core::engine::{Engine, MemoryEngine, FieldValue, RowStore, default_value};
use jsql_neo_core::types::{schema_order_preserving, FieldSchema};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

thread_local! {
    static ENGINE: RefCell<MemoryEngine> = RefCell::new(MemoryEngine::new());
}

#[wasm_bindgen]
pub fn jsql_reset() {
    ENGINE.with(|eng| {
        eng.borrow_mut().clear();
    });
}

#[wasm_bindgen]
pub fn jsql_create_table(name: &str, schema_json: &str) -> String {
    ENGINE.with(|eng| {
        let schema: Vec<(String, FieldSchema)> = match schema_order_preserving::deserialize(
            &mut serde_json::Deserializer::from_str(schema_json),
        ) {
            Ok(s) => s,
            Err(e) => return format!(r#"{{"ok":false,"error":"invalid schema: {}"}}"#, e),
        };
        let def = jsql_neo_core::types::TableDefinition {
            name: name.to_string(),
            schema,
        };
        match eng.borrow_mut().create_table(def) {
            Ok(()) => r#"{"ok":true}"#.to_string(),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_drop_table(name: &str) -> String {
    ENGINE.with(|eng| match eng.borrow_mut().drop_table(name) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[wasm_bindgen]
pub fn jsql_insert(table: &str, data_json: &str) -> String {
    ENGINE.with(|eng| {
        let data: Vec<std::collections::HashMap<String, serde_json::Value>> =
            match serde_json::from_str(data_json) {
                Ok(d) => d,
                Err(e) => return format!(r#"{{"error":"invalid data: {}"}}"#, e),
            };
        match eng.borrow_mut().insert(table, data) {
            Ok(ids) => serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_insert_json(table: &str, json: &str) -> String {
    ENGINE.with(|eng| {
        let res = (|| -> Result<Vec<u64>, String> {
            let mut eng = eng.borrow_mut();
            let t = eng.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;

            let data: Vec<serde_json::Value> = serde_json::from_str(json)
                .map_err(|e| format!("invalid JSON: {}", e))?;
            let n = data.len();
            if n == 0 { return Ok(Vec::new()); }

            let first = data[0].as_object()
                .ok_or_else(|| "expected array of objects".to_string())?;
            let field_names: Vec<String> = first.keys().cloned().collect();

            let remap: Vec<Option<usize>> = t.field_order.iter()
                .map(|name| field_names.iter().position(|n| n == name))
                .collect();

            let pk_idx = t.pk_field.as_ref().and_then(|pk| {
                t.schema.get(pk.as_str()).and_then(|fs| {
                    if fs.auto_increment { t.field_index.get(pk.as_str()).copied() } else { None }
                })
            });

            let now = js_sys::Date::now() as u64;
            let start_id = t.next_id;
            t.next_id += n as u64;
            t.pk_index.reserve(n);
            t.rows.reserve(n);
            t.values.reserve(t.field_order.len());
            let start_ri = t.rows.len();

            for (ri, row_val) in data.iter().enumerate() {
                let auto_id = start_id + ri as u64;
                let mut id = auto_id;
                let obj = row_val.as_object()
                    .ok_or_else(|| "non-object in array".to_string())?;

                let mut values = Vec::with_capacity(t.field_order.len());
                for (i, rp) in remap.iter().enumerate() {
                    if let Some(fi) = rp {
                        let key = &field_names[*fi];
                        if let Some(jv) = obj.get(key) {
                            values.push(FieldValue::from_json(jv.clone()));
                            continue;
                        }
                    } else if let Some(pi) = pk_idx {
                        if pi == i {
                            values.push(FieldValue::Int(id as i64));
                            continue;
                        }
                    }
                    if let Some(name) = t.field_order.get(i) {
                        if let Some(fs) = t.schema.get(name) {
                            if let Some(ref default) = fs.default {
                                values.push(FieldValue::from_json(default.clone()));
                                continue;
                            }
                            if !fs.nullable {
                                values.push(default_value(&fs.field_type));
                                continue;
                            }
                        }
                    }
                    values.push(FieldValue::Null);
                }

                // auto-increment PK: keep explicit positive value, else fill with auto id
                if let Some(pi) = pk_idx {
                    if let Some(v) = values.get_mut(pi) {
                        match v {
                            FieldValue::Null => *v = FieldValue::Int(id as i64),
                            FieldValue::Int(e) if *e > 0 => {
                                id = *e as u64;
                                t.next_id = t.next_id.max(id + 1);
                            }
                            _ => {}
                        }
                    }
                }

                t.pk_index.insert(id, start_ri + ri);
                let vs = t.values.len();
                t.values.extend(values);
                t.rows.push(RowStore { id, values_start: vs, num_values: t.field_order.len(), created_at: now, updated_at: now });
            }

            let ids: Vec<u64> = (start_id..start_id + n as u64).collect();
            Ok(ids)
        })();
        match res {
            Ok(ids) => serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

fn insert_buf_parse(eng: &mut MemoryEngine, table: &str, data: &[u8]) -> Result<Vec<u64>, String> {
    let t = eng.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;

    let mut off = 0usize;
    let n_fields = *data.get(off).ok_or_else(|| "truncated header".to_string())? as usize;
    off += 1;
    if n_fields == 0 {
        return Err("invalid header".to_string());
    }
    let mut field_names = Vec::with_capacity(n_fields);
    for _ in 0..n_fields {
        let name_len = *data.get(off).ok_or_else(|| "truncated header".to_string())? as usize;
        off += 1;
        let name = std::str::from_utf8(
            data.get(off..off + name_len).ok_or_else(|| "truncated header".to_string())?,
        )
        .map_err(|_| "invalid utf8 in header".to_string())?
        .to_string();
        off += name_len;
        field_names.push(name);
    }

    let seg4 = data.get(off..off + 4).ok_or_else(|| "truncated".to_string())?;
    let row_count = u32::from_le_bytes([seg4[0], seg4[1], seg4[2], seg4[3]]) as usize;
    off += 4;
    if row_count == 0 {
        return Ok(Vec::new());
    }

    let pk_idx = t.pk_field.as_ref().and_then(|pk| {
        t.schema.get(pk.as_str()).and_then(|fs| {
            if fs.auto_increment { t.field_index.get(pk.as_str()).copied() } else { None }
        })
    });

    let order_matches = field_names.len() == t.field_order.len()
        && field_names.iter().zip(&t.field_order).all(|(a, b)| a == b);
    let remap: Vec<Option<usize>> = t.field_order.iter()
        .map(|name| field_names.iter().position(|n| n == name))
        .collect();

    let start_id = t.next_id;
    t.next_id += row_count as u64;
    t.pk_index.reserve(row_count);
    t.rows.reserve(row_count);
    t.values.reserve(t.field_order.len() * row_count);
    let now = js_sys::Date::now() as u64;
    let start_ri = t.rows.len();

    for ri in 0..row_count {
        let auto_id = start_id + ri as u64;
        let mut id = auto_id;
        let mut row_vals = Vec::with_capacity(n_fields);
        for _fi in 0..n_fields {
            let tag = *data.get(off).ok_or_else(|| "truncated row data".to_string())?;
            off += 1;
            match tag {
                0 => row_vals.push(FieldValue::Null),
                1 => {
                    let b = data.get(off..off + 8).ok_or_else(|| "truncated row data".to_string())?;
                    off += 8;
                    row_vals.push(FieldValue::Int(i64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])));
                }
                2 => {
                    let b = data.get(off..off + 8).ok_or_else(|| "truncated row data".to_string())?;
                    off += 8;
                    row_vals.push(FieldValue::Float(f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])));
                }
                3 => {
                    let seg = data.get(off..off + 4).ok_or_else(|| "truncated row data".to_string())?;
                    let len = u32::from_le_bytes([seg[0], seg[1], seg[2], seg[3]]) as usize;
                    off += 4;
                    let s = std::str::from_utf8(
                        data.get(off..off + len).ok_or_else(|| "truncated row data".to_string())?,
                    )
                    .map_err(|_| "invalid utf8 in row data".to_string())?
                    .to_string();
                    off += len;
                    row_vals.push(FieldValue::String(s));
                }
                4 => {
                    let b = *data.get(off).ok_or_else(|| "truncated row data".to_string())?;
                    off += 1;
                    row_vals.push(FieldValue::Bool(b != 0));
                }
                5 => {
                    let b = data.get(off..off + 4).ok_or_else(|| "truncated row data".to_string())?;
                    off += 4;
                    row_vals.push(FieldValue::Int(i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as i64));
                }
                _ => row_vals.push(FieldValue::Null),
            };
        }

        let mut values = Vec::with_capacity(t.field_order.len());
        if order_matches {
            values = row_vals;
            if values.len() < t.field_order.len() {
                values.resize(t.field_order.len(), FieldValue::Null);
            }
        } else {
            for (i, rp) in remap.iter().enumerate() {
                if let Some(si) = rp {
                    if *si < row_vals.len() {
                        values.push(std::mem::take(&mut row_vals[*si]));
                        continue;
                    }
                }
                if let Some(pi) = pk_idx {
                    if pi == i {
                        values.push(FieldValue::Int(id as i64));
                        continue;
                    }
                }
                if let Some(name) = t.field_order.get(i) {
                    if let Some(fs) = t.schema.get(name) {
                        if let Some(ref default) = fs.default {
                            values.push(FieldValue::from_json(default.clone()));
                            continue;
                        }
                    }
                }
                values.push(FieldValue::Null);
            }
        }

        // auto-increment PK: keep explicit positive value (row id = pk), else fill with auto id
        if let Some(pi) = pk_idx {
            if let Some(v) = values.get_mut(pi) {
                match v {
                    FieldValue::Null => *v = FieldValue::Int(id as i64),
                    FieldValue::Int(e) if *e > 0 => {
                        id = *e as u64;
                        t.next_id = t.next_id.max(id + 1);
                    }
                    _ => {}
                }
            }
        }

        t.pk_index.insert(id, start_ri + ri);
        let vs = t.values.len();
        t.values.extend(values);
        t.rows.push(RowStore { id, values_start: vs, num_values: t.field_order.len(), created_at: now, updated_at: now });
    }

    Ok((start_id..start_id + row_count as u64).collect())
}

#[wasm_bindgen]
pub fn jsql_insert_buf(table: &str, data: &[u8]) -> String {
    ENGINE.with(|eng| {
        match insert_buf_parse(&mut eng.borrow_mut(), table, data) {
            Ok(ids) => serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}
#[wasm_bindgen]
pub fn jsql_insert_buf_count(table: &str, data: &[u8]) -> String {
    ENGINE.with(|eng| {
        match insert_buf_parse(&mut eng.borrow_mut(), table, data) {
            Ok(ids) => format!("{}", ids.len()),
            Err(_) => "0".to_string(),
        }
    })
}
#[wasm_bindgen]
pub fn jsql_find(table: &str, filter_json: &str, limit: usize, offset: usize) -> String {
    ENGINE.with(|eng| {
        let filter: Option<std::collections::HashMap<String, serde_json::Value>> =
            if filter_json.is_empty() { None } else { serde_json::from_str(filter_json).ok() };
        match eng.borrow().find(table, &filter, Some(limit), Some(offset), None, &None, &None) {
            Ok((rows, _, _)) => serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_find_by_id(table: &str, id: u64) -> String {
    ENGINE.with(|eng| {
        match eng.borrow().find_by_id_json(table, id) {
            Ok(Some(s)) => s,
            Ok(None) => "null".to_string(),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_count(table: &str) -> String {
    ENGINE.with(|eng| match eng.borrow().count(table) {
        Ok(c) => format!("{}", c),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    })
}

#[wasm_bindgen]
pub fn jsql_update_by_id(table: &str, id: u64, data_json: &str) -> String {
    ENGINE.with(|eng| {
        let data: std::collections::HashMap<String, serde_json::Value> =
            match serde_json::from_str(data_json) {
                Ok(d) => d,
                Err(e) => return format!(r#"{{"ok":false,"error":"invalid data: {}"}}"#, e),
            };
        match eng.borrow_mut().update_by_id(table, id, data) {
            Ok(true) => r#"{"ok":true}"#.to_string(),
            Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_remove_by_id(table: &str, id: u64) -> String {
    ENGINE.with(|eng| match eng.borrow_mut().remove_by_id(table, id) {
        Ok(true) => r#"{"ok":true}"#.to_string(),
        Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[wasm_bindgen]
pub fn jsql_remove_by_ids(table: &str, ids_json: &str) -> String {
    ENGINE.with(|eng| {
        let ids: Vec<u64> = match serde_json::from_str(ids_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
        };
        match eng.borrow_mut().remove_by_ids(table, &ids) {
            Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_update_by_ids(table: &str, batch_json: &str) -> String {
    ENGINE.with(|eng| {
        let batch: Vec<(u64, std::collections::HashMap<String, serde_json::Value>)> =
            match serde_json::from_str(batch_json) {
                Ok(v) => v,
                Err(e) => return format!(r#"{{"error":"invalid batch: {}"}}"#, e),
            };
        match eng.borrow_mut().update_by_ids(table, batch) {
            Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_find_by_ids(table: &str, ids_json: &str) -> String {
    ENGINE.with(|eng| {
        let ids: Vec<u64> = match serde_json::from_str(ids_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
        };
        match eng.borrow().find_by_ids_json(table, &ids) {
            Ok(s) => s,
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_begin_tx() -> String {
    ENGINE.with(|eng| match eng.borrow_mut().begin_tx() {
        Ok(tx_id) => serde_json::json!({ "ok": true, "txId": tx_id }).to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[wasm_bindgen]
pub fn jsql_commit_tx(tx_id: &str) -> String {
    ENGINE.with(|eng| match eng.borrow_mut().commit_tx(tx_id) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[wasm_bindgen]
pub fn jsql_rollback_tx(tx_id: &str) -> String {
    ENGINE.with(|eng| match eng.borrow_mut().rollback_tx(tx_id) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}
