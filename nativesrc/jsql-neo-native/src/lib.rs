use std::cell::RefCell;
use std::collections::HashMap;
use jsql_neo_core::engine::{Engine, HybridEngine, FieldValue, RowStore};
use jsql_neo_core::types::{FieldSchema, TableDefinition, schema_order_preserving};
use napi_derive::napi;
use napi::JsBuffer;

/// 每个 JS `Database` 实例对应一个独立引擎句柄。
///
/// 历史问题（≤6.3.3）：整个进程只有一个 `thread_local! ENGINE`，
/// 于是 `new Database(dirA)` 之后再 `new Database(dirB)` 会把 dirA 的表
/// 全部 `clear()` 掉（见 `HybridEngine::open`），同进程无法并存两个库；
/// 且在引擎回调里重入调用会直接返回 "engine busy (reentrant call)"。
/// 对一个自称「嵌入式数据库」的库，这是硬伤。
///
/// 现在改为「句柄注册表」：句柄 0 是为向后兼容保留的默认实例，
/// 新实例从 1 开始分配，各自持有独立的 HybridEngine，互不影响。
thread_local! {
    static ENGINES: RefCell<HashMap<u32, RefCell<HybridEngine>>> =
        RefCell::new(HashMap::new());
    static NEXT_HANDLE: RefCell<u32> = const { RefCell::new(1) };
}

/// 保留的默认句柄，维持既有 `jsql_*` 无句柄 API 的行为。
const DEFAULT_HANDLE: u32 = 0;

/// 确保默认实例存在。
///
/// 旧版是 `thread_local! static ENGINE`，加载即有，因此无句柄 API 一直可用。
/// 改为注册表后必须显式创建句柄 0，否则 `jsqlOpen(...)` 这类旧调用会报
/// "no such database instance: 0" —— 那就是破坏性变更。
fn ensure_default_instance() {
    ENGINES.with(|m| {
        let mut map = m.borrow_mut();
        map.entry(DEFAULT_HANDLE)
            .or_insert_with(|| RefCell::new(HybridEngine::new()));
    });
}

fn no_instance(handle: u32) -> String {
    format!(r#"{{"ok":false,"error":"no such database instance: {}"}}"#, handle)
}

/// 创建一个新的独立引擎实例，返回其句柄。
#[napi]
pub fn jsql_instance_new() -> u32 {
    NEXT_HANDLE.with(|h| {
        let mut next = h.borrow_mut();
        let handle = *next;
        *next = next.wrapping_add(1);
        if *next == DEFAULT_HANDLE {
            *next = 1;
        }
        ENGINES.with(|m| {
            m.borrow_mut()
                .insert(handle, RefCell::new(HybridEngine::new()));
        });
        handle
    })
}

/// 关闭并销毁一个实例，释放其占用的内存与文件句柄。
#[napi]
pub fn jsql_instance_free(handle: u32) -> String {
    ENGINES.with(|m| {
        let mut map = m.borrow_mut();
        if let Some(cell) = map.remove(&handle) {
            // 尽力刷盘，失败也不阻塞销毁
            let _ = cell.borrow_mut().close();
            r#"{"ok":true}"#.to_string()
        } else {
            no_instance(handle)
        }
    })
}

/// 当前显式创建的实例数（诊断用，不含为向后兼容保留的默认实例 0）。
#[napi]
pub fn jsql_instance_count() -> i32 {
    ENGINES.with(|m| {
        m.borrow()
            .keys()
            .filter(|h| **h != DEFAULT_HANDLE)
            .count() as i32
    })
}

fn with_engine_mut<F>(f: F) -> String
where
    F: FnOnce(&mut HybridEngine) -> String,
{
    ensure_default_instance();
    with_engine_handle_mut(DEFAULT_HANDLE, f)
}

fn with_engine_handle_mut<F>(handle: u32, f: F) -> String
where
    F: FnOnce(&mut HybridEngine) -> String,
{
    ENGINES.with(|m| {
        let map = m.borrow();
        let cell = match map.get(&handle) {
            Some(c) => c,
            None => return no_instance(handle),
        };
        // 先取出结果再返回，确保 RefMut 在 map 之前被 drop
        let out = match cell.try_borrow_mut() {
            Ok(mut eng) => f(&mut eng),
            Err(_) => r#"{"ok":false,"error":"engine busy (reentrant call)"}"#.to_string(),
        };
        out
    })
}

fn safe_json_result(result: Result<String, String>) -> String {
    match result {
        Ok(s) => s,
        Err(e) => format!(r#"{{"error":"{}"}}"#, e.replace('"', r#"\""#)),
    }
}

/// 为每个操作生成「旧版无句柄」+「新版带句柄」两个入口。
/// 旧版走默认实例以保持向后兼容，新版按句柄路由到各自独立的引擎。
/// `$eng` 是引擎变量名，在 body 中直接引用。
macro_rules! napi_engine_fn {
    ($plain:ident, $h:ident, ($($arg:ident : $ty:ty),*) => |$eng:ident| $body:block) => {
        #[napi]
        pub fn $plain($($arg : $ty),*) -> String {
            with_engine_mut(|$eng: &mut HybridEngine| $body)
        }

        #[napi]
        pub fn $h(handle: u32, $($arg : $ty),*) -> String {
            with_engine_handle_mut(handle, |$eng: &mut HybridEngine| $body)
        }
    };
}

#[napi]
pub fn jsql_open(dir: String, mode: String) -> String {
    with_engine_mut(|eng| do_open(eng, &dir, &mode))
}

#[napi]
pub fn jsql_open_h(handle: u32, dir: String, mode: String) -> String {
    with_engine_handle_mut(handle, |eng| do_open(eng, &dir, &mode))
}

fn do_open(eng: &mut HybridEngine, dir: &str, mode: &str) -> String {
    let open_res = eng.open(dir, mode);
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
}

napi_engine_fn!(jsql_flush_dirty, jsql_flush_dirty_h, () => |eng| {
    match eng.flush_dirty() {
        Ok(n) => format!(r#"{{"ok":true,"flushed":{}}}"#, n),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e.replace('"', r#"\""#)),
    }
});

napi_engine_fn!(jsql_evict, jsql_evict_h, () => |eng| {
    match eng.evict_one() {
        Some(name) => format!(r#"{{"ok":true,"evicted":"{}","remaining":{}}}"#, name, eng.mem_count()),
        None => r#"{"ok":true,"evicted":null,"remaining":0}"#.to_string(),
    }
});

napi_engine_fn!(jsql_close, jsql_close_h, () => |eng| {
    eng.close();
    r#"{"ok":true}"#.to_string()
});

#[napi]
pub fn jsql_create_table(name: String, schema_json: String) -> String {
    with_engine_mut(|eng| do_create_table(eng, &name, &schema_json))
}

#[napi]
pub fn jsql_create_table_h(handle: u32, name: String, schema_json: String) -> String {
    with_engine_handle_mut(handle, |eng| do_create_table(eng, &name, &schema_json))
}

fn do_create_table(eng: &mut HybridEngine, name: &str, schema_json: &str) -> String {
    use schema_order_preserving;
    let mut d = serde_json::Deserializer::from_str(schema_json);
    let schema: Vec<(String, FieldSchema)> = match schema_order_preserving::deserialize(&mut d) {
        Ok(s) => s,
        Err(e) => return format!(r#"{{"ok":false,"error":"invalid schema: {}"}}"#, e),
    };
    let def = TableDefinition { name: name.to_string(), schema };
    match eng.create_table(def) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
}

napi_engine_fn!(jsql_add_column, jsql_add_column_h,
    (table: String, name: String, fs_json: String) => |eng| {
        let fs: FieldSchema = match serde_json::from_str(&fs_json) {
            Ok(f) => f,
            Err(e) => return format!(r#"{{"ok":false,"error":"invalid field schema: {}"}}"#, e),
        };
        match eng.add_column(&table, &name, fs) {
            Ok(()) => r#"{"ok":true}"#.to_string(),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    }
);

napi_engine_fn!(jsql_drop_table, jsql_drop_table_h, (name: String) => |eng| {
    match eng.drop_table(&name) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_insert, jsql_insert_h, (table: String, data_json: String) => |eng| {
    let data: Vec<HashMap<String, serde_json::Value>> = match serde_json::from_str(&data_json) {
        Ok(d) => d,
        Err(e) => return format!(r#"{{"error":"invalid data: {}"}}"#, e),
    };
    match eng.insert(&table, data) {
        Ok(ids) => serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    }
});

#[napi]
pub fn jsql_insert_buf(table: String, data: JsBuffer) -> String {
    let buf_val = match data.into_value() {
        Ok(v) => v,
        Err(_) => return r#"{"error":"invalid buffer"}"#.to_string(),
    };
    with_engine_mut(|eng| do_insert_buf(eng, &table, buf_val))
}

#[napi]
pub fn jsql_insert_buf_h(handle: u32, table: String, data: JsBuffer) -> String {
    let buf_val = match data.into_value() {
        Ok(v) => v,
        Err(_) => return r#"{"error":"invalid buffer"}"#.to_string(),
    };
    with_engine_handle_mut(handle, |eng| do_insert_buf(eng, &table, buf_val))
}

fn do_insert_buf(eng: &mut HybridEngine, table: &str, buf_val: napi::JsBufferValue) -> String {
    let buf: &[u8] = buf_val.as_ref();
    let res = eng.insert_buf(table, buf)
        .map(|ids| serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()));
    safe_json_result(res)
}

napi_engine_fn!(jsql_find, jsql_find_h,
    (table: String, filter_json: String, limit: i32, offset: i32) => |eng| {
        let filter: Option<HashMap<String, serde_json::Value>> =
            if filter_json.is_empty() { None } else { serde_json::from_str(&filter_json).ok() };
        match eng.find_json(&table, &filter, Some(limit as usize), Some(offset as usize), None, &None, &None) {
            Ok((json, _, _)) => json,
            Err(e) => format!(r#"{{"error":"{}"}}"#, e),
        }
    }
);

napi_engine_fn!(jsql_find_by_id, jsql_find_by_id_h, (table: String, id: i64) => |eng| {
    match eng.find_by_id_json(&table, id as u64) {
        Ok(Some(s)) => s,
        Ok(None) => "null".to_string(),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_count, jsql_count_h, (table: String) => |eng| {
    match eng.count(&table) {
        Ok(c) => format!("{}", c),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_update_by_id, jsql_update_by_id_h,
    (table: String, id: i64, data_json: String) => |eng| {
        let data: HashMap<String, serde_json::Value> = match serde_json::from_str(&data_json) {
            Ok(d) => d,
            Err(e) => return format!(r#"{{"ok":false,"error":"invalid data: {}"}}"#, e),
        };
        match eng.update_by_id(&table, id as u64, data) {
            Ok(true) => r#"{"ok":true}"#.to_string(),
            Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
            Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
        }
    }
);

napi_engine_fn!(jsql_remove_by_id, jsql_remove_by_id_h, (table: String, id: i64) => |eng| {
    match eng.remove_by_id(&table, id as u64) {
        Ok(true) => r#"{"ok":true}"#.to_string(),
        Ok(false) => r#"{"ok":false,"error":"not found"}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_remove_by_ids, jsql_remove_by_ids_h, (table: String, ids_json: String) => |eng| {
    let ids: Vec<u64> = match serde_json::from_str(&ids_json) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
    };
    match eng.remove_by_ids(&table, &ids) {
        Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_update_by_ids, jsql_update_by_ids_h, (table: String, batch_json: String) => |eng| {
    let batch: Vec<(u64, HashMap<String, serde_json::Value>)> = match serde_json::from_str(&batch_json) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"error":"invalid batch: {}"}}"#, e),
    };
    match eng.update_by_ids(&table, batch) {
        Ok(n) => format!(r#"{{"ok":true,"count":{}}}"#, n),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_find_by_ids, jsql_find_by_ids_h, (table: String, ids_json: String) => |eng| {
    let ids: Vec<u64> = match serde_json::from_str(&ids_json) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"error":"invalid ids: {}"}}"#, e),
    };
    match eng.find_by_ids_json(&table, &ids) {
        Ok(s) => s,
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_begin_tx, jsql_begin_tx_h, () => |eng| {
    match eng.begin_tx() {
        Ok(tx_id) => serde_json::json!({ "ok": true, "txId": tx_id }).to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_commit_tx, jsql_commit_tx_h, (tx_id: String) => |eng| {
    match eng.commit_tx(&tx_id) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
});

napi_engine_fn!(jsql_rollback_tx, jsql_rollback_tx_h, (tx_id: String) => |eng| {
    match eng.rollback_tx(&tx_id) {
        Ok(()) => r#"{"ok":true}"#.to_string(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
});
