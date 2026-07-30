use std::cell::RefCell;
use std::collections::HashMap;
use jsql_neo_core::engine::{Engine, MemoryEngine, FieldValue, RowStore};
use jsql_neo_core::types::{FieldSchema, TableDefinition};
use napi_derive::napi;
use napi::JsBuffer;

thread_local! {
    static ENGINE: RefCell<MemoryEngine> = RefCell::new(MemoryEngine::new());
}

fn safe_json_result(result: Result<String, String>) -> String {
    match result {
        Ok(s) => s,
        Err(e) => format!(r#"{{"error":"{}"}}"#, e.replace('"', r#"\""#)),
    }
}

#[napi]
pub fn jsql_create_table(name: String, schema_json: String) -> String {
    let schema: HashMap<String, FieldSchema> = match serde_json::from_str(&schema_json) {
        Ok(s) => s,
        Err(e) => return format!(r#"{{"ok":false,"error":"invalid schema: {}"}}"#, e),
    };
    let def = TableDefinition { name: name.clone(), schema };
    ENGINE.with(|eng| match eng.borrow_mut().create_table(def) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_drop_table(name: String) -> String {
    ENGINE.with(|eng| match eng.borrow_mut().drop_table(&name) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_insert(table: String, data_json: String) -> String {
    ENGINE.with(|eng| {
        let data: Vec<HashMap<String, serde_json::Value>> = match serde_json::from_str(&data_json) {
            Ok(d) => d,
            Err(e) => return format!(r#"{{"error":"invalid data: {}"}}"#, e),
        };
        match eng.borrow_mut().insert(&table, data) {
            Ok(ids) => serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[inline(always)]
unsafe fn parse_field_value_unsafe(data: &[u8], off: &mut usize) -> FieldValue {
    let tag = *data.get_unchecked(*off); *off += 1;
    match tag {
        0 => FieldValue::Null,
        1 => {
            let n = i64::from_le_bytes([
                *data.get_unchecked(*off), *data.get_unchecked(*off+1),
                *data.get_unchecked(*off+2), *data.get_unchecked(*off+3),
                *data.get_unchecked(*off+4), *data.get_unchecked(*off+5),
                *data.get_unchecked(*off+6), *data.get_unchecked(*off+7),
            ]);
            *off += 8;
            FieldValue::Int(n)
        }
        2 => {
            let n = f64::from_le_bytes([
                *data.get_unchecked(*off), *data.get_unchecked(*off+1),
                *data.get_unchecked(*off+2), *data.get_unchecked(*off+3),
                *data.get_unchecked(*off+4), *data.get_unchecked(*off+5),
                *data.get_unchecked(*off+6), *data.get_unchecked(*off+7),
            ]);
            *off += 8;
            FieldValue::Float(n)
        }
        3 => {
            let len = u32::from_le_bytes([
                *data.get_unchecked(*off), *data.get_unchecked(*off+1),
                *data.get_unchecked(*off+2), *data.get_unchecked(*off+3),
            ]) as usize;
            *off += 4;
            let s = std::str::from_utf8_unchecked(std::slice::from_raw_parts(
                data.as_ptr().add(*off), len
            ));
            *off += len;
            FieldValue::String(s.to_string())
        }
        4 => { let b = *data.get_unchecked(*off) != 0; *off += 1; FieldValue::Bool(b) }
        5 => {
            let n = i32::from_le_bytes([
                *data.get_unchecked(*off), *data.get_unchecked(*off+1),
                *data.get_unchecked(*off+2), *data.get_unchecked(*off+3),
            ]) as i64;
            *off += 4;
            FieldValue::Int(n)
        }
        _ => FieldValue::Null,
    }
}

#[napi]
pub fn jsql_insert_buf(table: String, data: JsBuffer) -> String {
    let buf_val = match data.into_value() {
        Ok(v) => v,
        Err(_) => return r#"{"error":"invalid buffer"}"#.to_string(),
    };
    ENGINE.with(|eng| {
        let res = (|| -> Result<Vec<u64>, String> {
            let buf: &[u8] = buf_val.as_ref();
            let mut off = 0usize;
            if buf.is_empty() { return Err("empty data".to_string()); }

            let n_fields = unsafe { *buf.get_unchecked(off) } as usize; off += 1;
            if n_fields == 0 || off + n_fields * 2 > buf.len() {
                return Err("invalid header".to_string());
            }

            let mut field_names = Vec::with_capacity(n_fields);
            for _ in 0..n_fields {
                let name_len = unsafe { *buf.get_unchecked(off) } as usize; off += 1;
                if off + name_len > buf.len() { return Err("truncated header".to_string()); }
                let name = unsafe { std::str::from_utf8_unchecked(&buf[off..off + name_len]) };
                off += name_len;
                field_names.push(name.to_string());
            }

            let mut eng = eng.borrow_mut();
            let t = eng.tables.get_mut(&table).ok_or_else(|| format!("table '{}' not found", table))?;

            if off + 4 > buf.len() { return Err("truncated".to_string()); }
            let row_count = u32::from_le_bytes(unsafe { [
                *buf.get_unchecked(off),
                *buf.get_unchecked(off+1),
                *buf.get_unchecked(off+2),
                *buf.get_unchecked(off+3),
            ] }) as usize;
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
            t.values.reserve(row_count * t.field_order.len());
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let start_ri = t.rows.len();
            let num_fields = t.field_order.len();

            let order_matches = field_names.len() == num_fields
                && field_names.iter().zip(&t.field_order).all(|(a, b)| a == b);

            if order_matches {
                for ri in 0..row_count {
                    let id = start_id + ri as u64;
                    let values_start = t.values.len();
                    for _fi in 0..n_fields {
                        t.values.push(unsafe { parse_field_value_unsafe(buf, &mut off) });
                    }
                    if let Some(pi) = pk_idx {
                        t.values[values_start + pi] = FieldValue::Int(id as i64);
                    }
                    t.pk_index.insert(id, start_ri + ri);
                    t.rows.push(RowStore { id, values_start, num_values: num_fields, created_at: now, updated_at: now });
                }
            } else {
                let remap: Vec<Option<usize>> = t.field_order.iter()
                    .map(|name| field_names.iter().position(|n| n == name))
                    .collect();

                for ri in 0..row_count {
                    let id = start_id + ri as u64;
                    let values_start = t.values.len();
                    let mut batch_row: Vec<FieldValue> = Vec::with_capacity(n_fields);
                    for _fi in 0..n_fields {
                        batch_row.push(unsafe { parse_field_value_unsafe(buf, &mut off) });
                    }
                    for rp in &remap {
                        if let Some(bi) = rp {
                            if *bi < batch_row.len() {
                                t.values.push(std::mem::take(&mut batch_row[*bi]));
                            } else {
                                t.values.push(FieldValue::Null);
                            }
                        } else {
                            t.values.push(FieldValue::Null);
                        }
                    }
                    if let Some(pi) = pk_idx {
                        t.values[values_start + pi] = FieldValue::Int(id as i64);
                    }
                    t.pk_index.insert(id, start_ri + ri);
                    t.rows.push(RowStore { id, values_start, num_values: num_fields, created_at: now, updated_at: now });
                }
            }

            let ids: Vec<u64> = (start_id..start_id + row_count as u64).collect();
            Ok(ids)
        })();
        safe_json_result(res.map(|ids| serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())))
    })
}

#[napi]
pub fn jsql_find(table: String, filter_json: String, limit: i32, offset: i32) -> String {
    ENGINE.with(|eng| {
        let filter: Option<HashMap<String, serde_json::Value>> =
            if filter_json.is_empty() { None } else { serde_json::from_str(&filter_json).ok() };
        match eng.borrow().find(&table, &filter, Some(limit as usize), Some(offset as usize), None, &None, &None) {
            Ok((rows, _, _)) => serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_find_by_id(table: String, id: i64) -> String {
    ENGINE.with(|eng| {
        match eng.borrow().find_by_id_json(&table, id as u64) {
            Ok(Some(s)) => s,
            Ok(None) => "null".to_string(),
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}



#[napi]
pub fn jsql_count(table: String) -> String {
    ENGINE.with(|eng| match eng.borrow().count(&table) {
        Ok(c) => format!("{}", c),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_update_by_id(table: String, id: i64, data_json: String) -> String {
    ENGINE.with(|eng| {
        let data: HashMap<String, serde_json::Value> = match serde_json::from_str(&data_json) {
            Ok(d) => d,
            Err(e) => return format!(r#"{{"ok":false,"error":"invalid data: {}"}}"#, e),
        };
        match eng.borrow_mut().update_by_id(&table, id as u64, data) {
            Ok(true) => r#"{"ok":true}"#.to_string(),
            Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_remove_by_id(table: String, id: i64) -> String {
    ENGINE.with(|eng| match eng.borrow_mut().remove_by_id(&table, id as u64) {
        Ok(true) => r#"{"ok":true}"#.to_string(),
        Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    })
}

#[napi]
pub fn jsql_remove_by_ids(table: String, ids_json: String) -> String {
    ENGINE.with(|eng| {
        let ids: Vec<u64> = match serde_json::from_str(&ids_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
        };
        match eng.borrow_mut().remove_by_ids(&table, &ids) {
            Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_update_by_ids(table: String, batch_json: String) -> String {
    ENGINE.with(|eng| {
        let batch: Vec<(u64, HashMap<String, serde_json::Value>)> = match serde_json::from_str(&batch_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid batch: {}"}}"#, e),
        };
        match eng.borrow_mut().update_by_ids(&table, batch) {
            Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    })
}

#[napi]
pub fn jsql_find_by_ids(table: String, ids_json: String) -> String {
    ENGINE.with(|eng| {
        let ids: Vec<u64> = match serde_json::from_str(&ids_json) {
            Ok(v) => v,
            Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
        };
        match eng.borrow().find_by_ids_json(&table, &ids) {
            Ok(s) => s,
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    })
}
