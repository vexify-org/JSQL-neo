use jsql_neo_core::engine::{Engine, MemoryEngine, FieldValue, RowStore};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

thread_local! {
    static ENGINE: RefCell<MemoryEngine> = RefCell::new(MemoryEngine::new());
}

#[wasm_bindgen]
pub fn jsql_create_table(name: &str, schema_json: &str) -> String {
    ENGINE.with(|eng| {
        let schema: std::collections::HashMap<String, jsql_neo_core::types::FieldSchema> =
            match serde_json::from_str(schema_json) {
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
                let id = start_id + ri as u64;
                let obj = row_val.as_object()
                    .ok_or_else(|| "non-object in array".to_string())?;

                let mut values = Vec::with_capacity(t.field_order.len());
                for (i, rp) in remap.iter().enumerate() {
                    if let Some(fi) = rp {
                        let key = &field_names[*fi];
                        if let Some(jv) = obj.get(key) {
                            values.push(FieldValue::from_json(jv.clone()));
                        } else {
                            values.push(FieldValue::Null);
                        }
                    } else if let Some(pi) = pk_idx {
                        if pi == i { values.push(FieldValue::Int(id as i64)); }
                        else { values.push(FieldValue::Null); }
                    } else {
                        values.push(FieldValue::Null);
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

#[wasm_bindgen]
pub fn jsql_insert_buf(table: &str, data: &[u8]) -> String {
    ENGINE.with(|eng| {
        let mut off = 0usize;
        let n_fields = data[off] as usize; off += 1;
        if n_fields == 0 || off + n_fields * 2 > data.len() {
            return r#"{"error":"invalid header"}"#.to_string();
        }

        let mut field_names = Vec::with_capacity(n_fields);
        for _ in 0..n_fields {
            let name_len = data[off] as usize; off += 1;
            if off + name_len > data.len() { return r#"{"error":"truncated header"}"#.to_string(); }
            let name = unsafe { std::str::from_utf8_unchecked(&data[off..off + name_len]) };
            off += name_len;
            field_names.push(name.to_string());
        }

        let res = (|| -> Result<Vec<u64>, String> {
            let mut eng = eng.borrow_mut();
            let t = eng.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;

            if off + 4 > data.len() { return Err("truncated".to_string()); }
            let row_count = u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as usize;
            off += 4;
            if row_count == 0 { return Ok(Vec::new()); }

            let pk_idx = t.pk_field.as_ref().and_then(|pk| {
                t.schema.get(pk.as_str()).and_then(|fs| {
                    if fs.auto_increment { t.field_index.get(pk.as_str()).copied() } else { None }
                })
            });

            let start_id = t.next_id;
            t.next_id += row_count as u64;
            t.pk_index.reserve(row_count);
            t.rows.reserve(row_count);
            t.values.reserve(t.field_order.len());
            let now = js_sys::Date::now() as u64;
            let start_ri = t.rows.len();

            // pre-compute remap from binary order to field_order
            let order_matches = field_names.len() == t.field_order.len()
                && field_names.iter().zip(&t.field_order).all(|(a, b)| a == b);

            if order_matches {
                for ri in 0..row_count {
                    let id = start_id + ri as u64;
                    let mut values = Vec::with_capacity(n_fields);
                    for _fi in 0..n_fields {
                        let tag = data[off]; off += 1;
                        match tag {
                            0 => values.push(FieldValue::Null),
                            1 => {
                                let n = i64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                values.push(FieldValue::Int(n));
                            }
                            2 => {
                                let n = f64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                values.push(FieldValue::Float(n));
                            }
                            3 => {
                                let len = u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as usize;
                                off += 4;
                                let s = unsafe { std::str::from_utf8_unchecked(&data[off..off + len]) };
                                off += len;
                                values.push(FieldValue::String(s.to_string()));
                            }
                            4 => { let b = data[off] != 0; off += 1; values.push(FieldValue::Bool(b)); }
                            5 => { let n = i32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as i64; off += 4; values.push(FieldValue::Int(n)); }
                            _ => values.push(FieldValue::Null),
                        };
                    }
                    if let Some(pi) = pk_idx {
                        values[pi] = FieldValue::Int(id as i64);
                    }
                    t.pk_index.insert(id, start_ri + ri);
                    let vs = t.values.len();
                    t.values.extend(values);
                    t.rows.push(RowStore { id, values_start: vs, num_values: t.field_order.len(), created_at: now, updated_at: now });
                }
            } else {
                let remap: Vec<Option<usize>> = t.field_order.iter()
                    .map(|name| field_names.iter().position(|n| n == name))
                    .collect();

                for ri in 0..row_count {
                    let id = start_id + ri as u64;
                    let mut batch_row: Vec<FieldValue> = Vec::with_capacity(n_fields);
                    for _fi in 0..n_fields {
                        let tag = data[off]; off += 1;
                        match tag {
                            0 => batch_row.push(FieldValue::Null),
                            1 => {
                                let n = i64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                batch_row.push(FieldValue::Int(n));
                            }
                            2 => {
                                let n = f64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                batch_row.push(FieldValue::Float(n));
                            }
                            3 => {
                                let len = u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as usize;
                                off += 4;
                                let s = unsafe { std::str::from_utf8_unchecked(&data[off..off + len]) };
                                off += len;
                                batch_row.push(FieldValue::String(s.to_string()));
                            }
                            4 => { let b = data[off] != 0; off += 1; batch_row.push(FieldValue::Bool(b)); }
                            5 => { let n = i32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as i64; off += 4; batch_row.push(FieldValue::Int(n)); }
                            _ => batch_row.push(FieldValue::Null),
                        };
                    }
                    let mut values = Vec::with_capacity(t.field_order.len());
                    for rp in &remap {
                        if let Some(bi) = rp {
                            values.push(std::mem::take(&mut batch_row[*bi]));
                        } else {
                            values.push(FieldValue::Null);
                        }
                    }
                    if let Some(pi) = pk_idx {
                        values[pi] = FieldValue::Int(id as i64);
                    }
                    t.pk_index.insert(id, start_ri + ri);
                    let vs = t.values.len();
                    t.values.extend(values);
                    t.rows.push(RowStore { id, values_start: vs, num_values: t.field_order.len(), created_at: now, updated_at: now });
                }
            }

            let ids: Vec<u64> = (start_id..start_id + row_count as u64).collect();
            Ok(ids)
        })();
        match res {
            Ok(ids) => serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[wasm_bindgen]
pub fn jsql_insert_buf_count(table: &str, data: &[u8]) -> String {
    ENGINE.with(|eng| {
        let mut off = 0usize;
        let n_fields = data[off] as usize; off += 1;
        if n_fields == 0 || off + n_fields * 2 > data.len() {
            return r#"0"#.to_string();
        }

        let mut field_names = Vec::with_capacity(n_fields);
        for _ in 0..n_fields {
            let name_len = data[off] as usize; off += 1;
            if off + name_len > data.len() { return r#"0"#.to_string(); }
            let name = unsafe { std::str::from_utf8_unchecked(&data[off..off + name_len]) };
            off += name_len;
            field_names.push(name.to_string());
        }

        let res = (|| -> Result<usize, String> {
            let mut eng = eng.borrow_mut();
            let t = eng.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;

            if off + 4 > data.len() { return Err("truncated".to_string()); }
            let row_count = u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as usize;
            off += 4;
            if row_count == 0 { return Ok(0); }

            let pk_idx = t.pk_field.as_ref().and_then(|pk| {
                t.schema.get(pk.as_str()).and_then(|fs| {
                    if fs.auto_increment { t.field_index.get(pk.as_str()).copied() } else { None }
                })
            });

            let start_id = t.next_id;
            t.next_id += row_count as u64;
            t.pk_index.reserve(row_count);
            t.rows.reserve(row_count);
            t.values.reserve(t.field_order.len());
            let now = js_sys::Date::now() as u64;
            let start_ri = t.rows.len();

            let order_matches = field_names.len() == t.field_order.len()
                && field_names.iter().zip(&t.field_order).all(|(a, b)| a == b);

            if order_matches {
                for ri in 0..row_count {
                    let id = start_id + ri as u64;
                    let mut values = Vec::with_capacity(n_fields);
                    for _fi in 0..n_fields {
                        let tag = data[off]; off += 1;
                        match tag {
                            0 => values.push(FieldValue::Null),
                            1 => {
                                let n = i64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                values.push(FieldValue::Int(n));
                            }
                            2 => {
                                let n = f64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                values.push(FieldValue::Float(n));
                            }
                            3 => {
                                let len = u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as usize;
                                off += 4;
                                let s = unsafe { std::str::from_utf8_unchecked(&data[off..off + len]) };
                                off += len;
                                values.push(FieldValue::String(s.to_string()));
                            }
                            4 => { let b = data[off] != 0; off += 1; values.push(FieldValue::Bool(b)); }
                            5 => { let n = i32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as i64; off += 4; values.push(FieldValue::Int(n)); }
                            _ => values.push(FieldValue::Null),
                        };
                    }
                    if let Some(pi) = pk_idx {
                        values[pi] = FieldValue::Int(id as i64);
                    }
                    t.pk_index.insert(id, start_ri + ri);
                    let vs = t.values.len();
                    t.values.extend(values);
                    t.rows.push(RowStore { id, values_start: vs, num_values: t.field_order.len(), created_at: now, updated_at: now });
                }
            } else {
                let remap: Vec<Option<usize>> = t.field_order.iter()
                    .map(|name| field_names.iter().position(|n| n == name))
                    .collect();

                for ri in 0..row_count {
                    let id = start_id + ri as u64;
                    let mut batch_row: Vec<FieldValue> = Vec::with_capacity(n_fields);
                    for _fi in 0..n_fields {
                        let tag = data[off]; off += 1;
                        match tag {
                            0 => batch_row.push(FieldValue::Null),
                            1 => {
                                let n = i64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                batch_row.push(FieldValue::Int(n));
                            }
                            2 => {
                                let n = f64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3], data[off+4], data[off+5], data[off+6], data[off+7]]);
                                off += 8;
                                batch_row.push(FieldValue::Float(n));
                            }
                            3 => {
                                let len = u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as usize;
                                off += 4;
                                let s = unsafe { std::str::from_utf8_unchecked(&data[off..off + len]) };
                                off += len;
                                batch_row.push(FieldValue::String(s.to_string()));
                            }
                            4 => { let b = data[off] != 0; off += 1; batch_row.push(FieldValue::Bool(b)); }
                            5 => { let n = i32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as i64; off += 4; batch_row.push(FieldValue::Int(n)); }
                            _ => batch_row.push(FieldValue::Null),
                        };
                    }
                    let mut values = Vec::with_capacity(t.field_order.len());
                    for rp in &remap {
                        if let Some(bi) = rp {
                            values.push(std::mem::take(&mut batch_row[*bi]));
                        } else {
                            values.push(FieldValue::Null);
                        }
                    }
                    if let Some(pi) = pk_idx {
                        values[pi] = FieldValue::Int(id as i64);
                    }
                    t.pk_index.insert(id, start_ri + ri);
                    let vs = t.values.len();
                    t.values.extend(values);
                    t.rows.push(RowStore { id, values_start: vs, num_values: t.field_order.len(), created_at: now, updated_at: now });
                }
            }
            Ok(row_count)
        })();
        match res {
            Ok(count) => format!("{}", count),
            Err(_) => r#"0"#.to_string(),
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
