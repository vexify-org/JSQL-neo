use std::collections::HashMap;
use rustc_hash::FxHashMap;
use serde::Serialize;
use crate::types::{Row, FieldSchema, FieldType};
use std::fmt::Write;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum FieldValue {
    #[default]
    Null,
    Bool(bool),
    Int(i64),
    /// 只用于能放进 u64 但超出 i64 的值（Issue #38）；列存储仍以 i64 为主。
    UInt(u64),
    Float(f64),
    String(String),
}

/// BigInt 在 JSON 中无法直接表示，JS 层（lib/bigint_json.js）用
/// `{"__jsql_bigint__":"<十进制>"}` 无损传递；Rust 绑定层识别并还原。
const BIGINT_MARKER: &str = "__jsql_bigint__";

/// JS 能精确表示的整数上界（Number.MAX_SAFE_INTEGER）。
const JS_SAFE_INT_MAX: i64 = 9_007_199_254_740_991;

fn is_js_safe_i64(n: i64) -> bool {
    (-JS_SAFE_INT_MAX..=JS_SAFE_INT_MAX).contains(&n)
}

fn marker_i128(jv: &serde_json::Value) -> Option<i128> {
    if let serde_json::Value::Object(map) = jv {
        if map.len() == 1 {
            if let Some(serde_json::Value::String(s)) = map.get(BIGINT_MARKER) {
                return s.parse::<i128>().ok();
            }
        }
    }
    None
}

/// 把 JSON 数字 / BigInt 标记 / 十进制字符串解析成 i128，供过滤比较使用。
fn json_as_i128(jv: &serde_json::Value) -> Option<i128> {
    match jv {
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(|v| v as i128)
            .or_else(|| n.as_u64().map(|v| v as i128)),
        serde_json::Value::String(s) => s.trim().parse::<i128>().ok(),
        other => marker_i128(other),
    }
}

/// 严格十进制整数解析（不接受空串 / 小数 / 科学计数法）。
fn parse_decimal_i128(s: &str) -> Option<i128> {
    let t = s.trim();
    if t.is_empty() || t.len() > 40 {
        return None;
    }
    let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse::<i128>().ok()
}

impl serde::Serialize for FieldValue {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            FieldValue::Null => s.serialize_unit(),
            FieldValue::Bool(b) => s.serialize_bool(*b),
            FieldValue::Int(n) => {
                // 超出 JS 安全范围时以十进制字符串输出，避免 JSON.parse 丢精度。
                if is_js_safe_i64(*n) {
                    s.serialize_i64(*n)
                } else {
                    s.serialize_str(&n.to_string())
                }
            }
            FieldValue::UInt(n) => {
                if (*n as i64) <= JS_SAFE_INT_MAX && *n <= JS_SAFE_INT_MAX as u64 {
                    s.serialize_u64(*n)
                } else {
                    s.serialize_str(&n.to_string())
                }
            }
            FieldValue::Float(f) => s.serialize_f64(*f),
            FieldValue::String(st) => s.serialize_str(st),
        }
    }
}

impl FieldValue {
    pub fn from_json(jv: serde_json::Value) -> Self {
        match jv {
            serde_json::Value::Null => FieldValue::Null,
            serde_json::Value::Bool(b) => FieldValue::Bool(b),
            serde_json::Value::Number(n) => {
                n.as_i64().map(FieldValue::Int)
                    .or_else(|| n.as_u64().map(FieldValue::UInt))
                    .or_else(|| n.as_f64().map(FieldValue::Float))
                    .unwrap_or(FieldValue::Null)
            }
            serde_json::Value::String(s) => FieldValue::String(s),
            ref v if marker_i128(v).is_some() => {
                let b = marker_i128(v).unwrap();
                if let Ok(i) = i64::try_from(b) {
                    FieldValue::Int(i)
                } else if let Ok(u) = u64::try_from(b) {
                    FieldValue::UInt(u)
                } else {
                    FieldValue::Null
                }
            }
            _ => FieldValue::Null,
        }
    }

    /// 按列类型解析（Issue #38）：
    /// - integer / bigint 列接受 BigInt 标记、JSON 整数、十进制字符串；
    /// - 拒绝小数 / 布尔 / 越界值（与 lib/table.js 的 1292 语义一致）。
    pub fn from_json_typed(ft: &crate::types::FieldType, jv: serde_json::Value) -> Result<Self, String> {
        use crate::types::FieldType;
        match ft {
            FieldType::Integer | FieldType::BigInt => {
                let (b, raw) = match &jv {
                    serde_json::Value::Null => return Ok(FieldValue::Null),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            (i as i128, n.to_string())
                        } else if let Some(u) = n.as_u64() {
                            (u as i128, n.to_string())
                        } else {
                            return Err(truncated_int_error(&n.to_string()));
                        }
                    }
                    serde_json::Value::String(s) => match parse_decimal_i128(s) {
                        Some(v) => (v, s.clone()),
                        None => return Err(truncated_int_error(s)),
                    },
                    other => match marker_i128(other) {
                        Some(v) => (v, v.to_string()),
                        None => return Err(truncated_int_error(&other.to_string())),
                    },
                };
                if b < i64::MIN as i128 || b > i64::MAX as i128 {
                    return Err(truncated_int_error(&raw));
                }
                Ok(FieldValue::Int(b as i64))
            }
            _ => Ok(FieldValue::from_json(jv)),
        }
    }

    fn to_json(&self) -> serde_json::Value {
        match self {
            FieldValue::Null => serde_json::Value::Null,
            FieldValue::Bool(b) => serde_json::Value::Bool(*b),
            FieldValue::Int(n) => {
                if is_js_safe_i64(*n) {
                    serde_json::Value::Number((*n).into())
                } else {
                    serde_json::Value::String(n.to_string())
                }
            }
            FieldValue::UInt(n) => {
                if *n <= JS_SAFE_INT_MAX as u64 {
                    serde_json::Value::Number((*n).into())
                } else {
                    serde_json::Value::String(n.to_string())
                }
            }
            FieldValue::Float(f) => serde_json::Number::from_f64(*f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            FieldValue::String(s) => serde_json::Value::String(s.clone()),
        }
    }

    pub fn write_json(&self, out: &mut String) {
        match self {
            FieldValue::Null => out.push_str("null"),
            FieldValue::Bool(true) => out.push_str("true"),
            FieldValue::Bool(false) => out.push_str("false"),
            FieldValue::Int(n) => {
                if is_js_safe_i64(*n) {
                    out.push_str(itoa::Buffer::new().format(*n));
                } else {
                    write_json_string(out, &n.to_string());
                }
            }
            FieldValue::UInt(n) => {
                if *n <= JS_SAFE_INT_MAX as u64 {
                    out.push_str(itoa::Buffer::new().format(*n));
                } else {
                    write_json_string(out, &n.to_string());
                }
            }
            FieldValue::Float(f) => {
                out.push_str(ryu::Buffer::new().format_finite(*f));
            }
            FieldValue::String(s) => {
                write_json_string(out, s);
            }
        }
    }

    pub fn eq_json(&self, jv: &serde_json::Value) -> bool {
        match (self, jv) {
            (FieldValue::Null, serde_json::Value::Null) => true,
            (FieldValue::Bool(a), serde_json::Value::Bool(b)) => a == b,
            (FieldValue::Int(a), _) => json_as_i128(jv).map_or(false, |b| *a as i128 == b),
            (FieldValue::UInt(a), _) => json_as_i128(jv).map_or(false, |b| *a as i128 == b),
            (FieldValue::Float(a), serde_json::Value::Number(n)) => n.as_f64() == Some(*a),
            (FieldValue::String(a), serde_json::Value::String(b)) => a == b,
            _ => false,
        }
    }
}

fn truncated_int_error(raw: &str) -> String {
    format!(
        "ER_TRUNCATED_WRONG_VALUE: Truncated incorrect INTEGER value: '{}'",
        raw
    )
}

#[derive(Debug, Clone)]
pub struct RowStore {
    pub id: u64,
    pub values_start: usize,
    pub num_values: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone)]
pub struct Table {
    pub name: String,
    pub schema: HashMap<String, FieldSchema>,
    pub field_order: Vec<String>,
    pub field_index: HashMap<String, usize>,
    pub rows: Vec<RowStore>,
    pub values: Vec<FieldValue>,
    pub next_id: u64,
    pub pk_field: Option<String>,
    pub pk_index: FxHashMap<u64, usize>,
    /// 主键是否为自增整型：只有这时内部行 id 才等于主键值，
    /// `pk_index` 才能直接用于 O(1) 主键点查。
    pub pk_auto: bool,
}

pub fn default_value(ft: &FieldType) -> FieldValue {
    match ft {
        FieldType::Integer | FieldType::BigInt => FieldValue::Int(0),
        FieldType::Float => FieldValue::Float(0.0),
        FieldType::String => FieldValue::String(String::new()),
        FieldType::Boolean => FieldValue::Bool(false),
    }
}

/// 自动/显式主键的 u64 值序列化：超出 JS 安全范围时输出十进制字符串。
fn write_u64_json(out: &mut String, n: u64) {
    if n <= JS_SAFE_INT_MAX as u64 {
        out.push_str(itoa::Buffer::new().format(n));
    } else {
        write_json_string(out, &n.to_string());
    }
}

fn u64_field(n: u64) -> FieldValue {
    if n <= i64::MAX as u64 {
        FieldValue::Int(n as i64)
    } else {
        FieldValue::UInt(n)
    }
}

fn now_millis() -> u64 {
    #[cfg(feature = "wasm")]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(not(feature = "wasm"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                write!(out, "\\u{:04x}", c as u32).unwrap();
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn millis_to_string(ms: u64) -> String {
    #[cfg(feature = "wasm")]
    {
        let d = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ms as f64));
        d.to_iso_string().as_string().unwrap_or_else(|| "2026-01-01T00:00:00Z".into())
    }
    #[cfg(not(feature = "wasm"))]
    {
        let secs = ms / 1000;
        let nanos = ((ms % 1000) * 1_000_000) as u32;
        let dt = chrono::DateTime::from_timestamp(secs as i64, nanos)
            .unwrap_or_default();
        dt.to_rfc3339()
    }
}

/// 行内时间戳格式化缓存：批量写入的行共享同一个毫秒时间戳，
/// 命中缓存可避免每行都做一次 chrono/JS Date 格式化与字符串分配。
#[derive(Default)]
pub struct TimeCache {
    last_ms: u64,
    last_str: String,
    valid: bool,
}

impl TimeCache {
    pub fn new() -> Self {
        Self { last_ms: 0, last_str: String::new(), valid: false }
    }

    #[inline]
    fn write(&mut self, out: &mut String, ms: u64) {
        if !self.valid || self.last_ms != ms {
            self.last_str.clear();
            self.last_str.push_str(&millis_to_string(ms));
            self.last_ms = ms;
            self.valid = true;
        }
        out.push_str(&self.last_str);
    }
}

impl Table {
    pub fn new(name: String, schema: &[(String, FieldSchema)]) -> Self {
        let pk_field = schema.iter()
            .find(|(_, f)| f.primary_key)
            .map(|(name, _)| name.clone());
        let pk_auto = schema.iter()
            .find(|(_, f)| f.primary_key)
            .map(|(_, f)| f.auto_increment)
            .unwrap_or(false);

        let field_order: Vec<String> = schema.iter().map(|(n, _)| n.clone()).collect();
        let field_index: HashMap<String, usize> = field_order.iter()
            .enumerate().map(|(i, n)| (n.clone(), i)).collect();
        let schema: HashMap<String, FieldSchema> = schema.iter()
            .map(|(k, v)| (k.clone(), v.clone())).collect();

        Self {
            name, schema, field_order, field_index,
            rows: Vec::new(), values: Vec::new(), next_id: 1, pk_field,
            pk_index: FxHashMap::default(), pk_auto,
        }
    }

    /// 若过滤条件恰好是「自增主键 = 整数」则返回该主键值。
    /// 这种查询可以直接走 `pk_index`，把 O(n) 全表扫描降到 O(1)。
    pub(crate) fn pk_eq_id(&self, filter: &HashMap<String, serde_json::Value>) -> Option<u64> {
        if !self.pk_auto || filter.len() != 1 {
            return None;
        }
        let pk = self.pk_field.as_ref()?;
        let id = filter.get(pk)?.as_i64()?;
        if id <= 0 {
            return None;
        }
        Some(id as u64)
    }

    pub fn to_row_map(&self, values: &[FieldValue]) -> HashMap<String, serde_json::Value> {
        let mut map = HashMap::with_capacity(self.field_order.len());
        for (i, name) in self.field_order.iter().enumerate() {
            if let Some(v) = values.get(i) {
                map.insert(name.clone(), v.to_json());
            }
        }
        map
    }

    pub fn push_row_values(&mut self, id: u64, values: Vec<FieldValue>, now: u64) {
        let num_values = values.len();
        let values_start = self.values.len();
        self.values.extend(values);
        self.rows.push(RowStore { id, values_start, num_values, created_at: now, updated_at: now });
    }

    pub fn get_row_values(&self, rs: &RowStore) -> &[FieldValue] {
        &self.values[rs.values_start..][..rs.num_values]
    }

    pub fn get_row_values_mut(&mut self, rs: &RowStore) -> &mut [FieldValue] {
        let start = rs.values_start;
        &mut self.values[start..][..rs.num_values]
    }

    fn to_row(&self, rs: &RowStore) -> Row {
        Row {
            id: rs.id,
            fields: self.to_row_map(self.get_row_values(rs)),
            created_at: Some(millis_to_string(rs.created_at)),
            updated_at: Some(millis_to_string(rs.updated_at)),
        }
    }

    /// 运行期加列（供 `db.addColumn` 使用）：扩展 schema / field_order / field_index，
    /// 并为已有行按「default → 非空类型默认值 → null」的既有语义回填新列的值。
    /// 返回 true 表示新增成功；false 表示该列已存在（no-op）。
    pub fn add_column(&mut self, name: &str, fs: &FieldSchema) -> bool {
        if self.field_index.contains_key(name) {
            return false;
        }
        let fill = match &fs.default {
            Some(dv) => FieldValue::from_json_typed(&fs.field_type, dv.clone())
                .unwrap_or(FieldValue::Null),
            None => if !fs.nullable { default_value(&fs.field_type) } else { FieldValue::Null },
        };
        let pos = self.field_order.len();
        self.schema.insert(name.to_string(), fs.clone());
        self.field_order.push(name.to_string());
        self.field_index.insert(name.to_string(), pos);
        // Fix (issue #22): Vec::insert 原地右移后续元素但未同步更新后续行
        // values_start，导致 >1 行表添加列后数据损坏。重建 values 并重算
        // 每个 values_start，避免静默数据损坏。
        let mut new_values = Vec::with_capacity(self.values.len() + self.rows.len());
        let mut new_starts = Vec::with_capacity(self.rows.len());
        for rs in &self.rows {
            let vals = self.get_row_values(rs);
            new_starts.push(new_values.len());
            new_values.extend_from_slice(vals);
            new_values.push(fill.clone());
        }
        self.values = new_values;
        for (i, rs) in self.rows.iter_mut().enumerate() {
            rs.values_start = new_starts[i];
            rs.num_values += 1;
        }
        true
    }

    /// 主键冲突错误：消息与 JS 侧 ER_DUP_ENTRY 保持一致
    /// （`Duplicate entry '<id>' for key '<pk>'`），前缀带错误码，便于上层 JS
    /// 还原成 code/errno 相同的异常（两引擎同输入 → 同报错）。
    fn dup_pk_error(&self, id: u64) -> String {
        let pk = self.pk_field.clone().unwrap_or_else(|| "id".to_string());
        format!("ER_DUP_ENTRY: Duplicate entry '{}' for key '{}'", id, pk)
    }

    pub fn add_rows(&mut self, fields_batch: Vec<HashMap<String, serde_json::Value>>) -> Result<Vec<u64>, String> {
        let now = now_millis();
        let batch_len = fields_batch.len();
        let mut ids = Vec::with_capacity(batch_len);
        self.pk_index.reserve(batch_len);
        self.rows.reserve(batch_len);
        self.values.reserve(batch_len * self.field_order.len());

        let pk_auto_key = self.pk_field.as_deref().and_then(|pk| {
            self.schema.get(pk).and_then(|fs| {
                if fs.auto_increment { Some(pk.to_string()) } else { None }
            })
        });

        for mut fields in fields_batch {
            let auto_id = self.next_id;
            self.next_id += 1;
            let mut id = auto_id;

            if let Some(ref pk_key) = pk_auto_key {
                match fields.get(pk_key) {
                    Some(v) if v.is_null() => {
                        fields.insert(pk_key.clone(), serde_json::Value::Number(auto_id.into()));
                    }
                    Some(v) => {
                        if let Some(b) = json_as_i128(v) {
                            if b > 0 && b <= i64::MAX as i128 {
                                id = b as u64;
                                self.next_id = self.next_id.max(id + 1);
                            }
                        }
                    }
                    None => {
                        fields.insert(pk_key.clone(), serde_json::Value::Number(auto_id.into()));
                    }
                }
            }

            // 显式指定的主键已存在：报错而不是覆盖 pk_index（否则原行变影子行）
            if self.pk_index.contains_key(&id) {
                return Err(self.dup_pk_error(id));
            }

            let mut row_vals = Vec::with_capacity(self.field_order.len());
            if fields.len() < self.schema.len() {
                for name in &self.field_order {
                    if let Some(v) = fields.remove(name) {
                        let fv = match self.schema.get(name) {
                            Some(fs) => FieldValue::from_json_typed(&fs.field_type, v)?,
                            None => FieldValue::from_json(v),
                        };
                        row_vals.push(fv);
                        continue;
                    }
                    match self.schema.get(name).and_then(|fs| fs.default.clone()) {
                        Some(dv) => {
                            let fv = match self.schema.get(name) {
                                Some(fs) => FieldValue::from_json_typed(&fs.field_type, dv)?,
                                None => FieldValue::from_json(dv),
                            };
                            row_vals.push(fv);
                        }
                        None => {
                            if let Some(fs) = self.schema.get(name) {
                                if !fs.nullable {
                                    row_vals.push(default_value(&fs.field_type));
                                } else {
                                    row_vals.push(FieldValue::Null);
                                }
                            } else {
                                row_vals.push(FieldValue::Null);
                            }
                        }
                    }
                }
            } else {
                for name in &self.field_order {
                    let fv = match fields.remove(name) {
                        Some(v) => match self.schema.get(name) {
                            Some(fs) => FieldValue::from_json_typed(&fs.field_type, v)?,
                            None => FieldValue::from_json(v),
                        },
                        None => FieldValue::Null,
                    };
                    row_vals.push(fv);
                }
            }
            let values_start = self.values.len();
            self.values.extend(row_vals);

            let idx = self.rows.len();
            self.pk_index.insert(id, idx);
            self.rows.push(RowStore { id, values_start, num_values: self.field_order.len(), created_at: now, updated_at: now });
            ids.push(id);
        }
        Ok(ids)
    }

    pub fn add_rows_vec(&mut self, field_names: &[String], batch: Vec<Vec<serde_json::Value>>) -> Result<Vec<u64>, String> {
        let batch_fv: Vec<Vec<FieldValue>> = batch.into_iter()
            .map(|row| row.into_iter().map(FieldValue::from_json).collect())
            .collect();
        self.add_rows_vec_fv(field_names, batch_fv)
    }

    pub fn add_rows_vec_fv(&mut self, field_names: &[String], batch: Vec<Vec<FieldValue>>) -> Result<Vec<u64>, String> {
        let now = now_millis();
        let batch_len = batch.len();
        let mut ids = Vec::with_capacity(batch_len);
        self.pk_index.reserve(batch_len);
        self.rows.reserve(batch_len);
        self.values.reserve(batch_len * self.field_order.len());

        let pk_auto_key = self.pk_field.as_deref().and_then(|pk| {
            self.schema.get(pk).and_then(|fs| {
                if fs.auto_increment { Some(pk.to_string()) } else { None }
            })
        });

        // fast path: field_names match field_order
        if field_names.len() == self.field_order.len()
            && field_names.iter().zip(&self.field_order).all(|(a, b)| a == b)
        {
            let pk_idx = pk_auto_key.as_ref().and_then(|pk| self.field_index.get(pk.as_str()).copied());
            for mut row_vals in batch {
                let auto_id = self.next_id;
                self.next_id += 1;
                let mut id = auto_id;
                if row_vals.len() < self.field_order.len() {
                    row_vals.resize(self.field_order.len(), FieldValue::Null);
                }
                if let Some(pi) = pk_idx {
                    if pi < row_vals.len() {
                        match row_vals[pi] {
                            FieldValue::Null => row_vals[pi] = u64_field(auto_id),
                            FieldValue::Int(e) if e > 0 => {
                                id = e as u64;
                                self.next_id = self.next_id.max(id + 1);
                            }
                            _ => {}
                        }
                    }
                }
                if self.pk_index.contains_key(&id) {
                    return Err(self.dup_pk_error(id));
                }
                let values_start = self.values.len();
                self.values.append(&mut row_vals);
                let idx = self.rows.len();
                self.pk_index.insert(id, idx);
                self.rows.push(RowStore { id, values_start, num_values: self.field_order.len(), created_at: now, updated_at: now });
                ids.push(id);
            }
            return Ok(ids);
        }

        // slow path: remap field names
        let remap: Vec<Option<usize>> = self.field_order.iter()
            .map(|name| field_names.iter().position(|fname| fname == name))
            .collect();
        let explicit_pk_si = pk_auto_key.as_ref()
            .and_then(|pk| field_names.iter().position(|n| n == pk));
        let pk_idx = pk_auto_key.as_ref().and_then(|pk| self.field_index.get(pk.as_str()).copied());

        for mut row_vals in batch {
            let auto_id = self.next_id;
            self.next_id += 1;
            let mut id = auto_id;
            if let Some(si) = explicit_pk_si {
                if let Some(FieldValue::Int(e)) = row_vals.get(si) {
                    if *e > 0 {
                        id = *e as u64;
                        self.next_id = self.next_id.max(id + 1);
                    }
                }
            }
            if self.pk_index.contains_key(&id) {
                return Err(self.dup_pk_error(id));
            }
            let values_start = self.values.len();
            for (i, remapped_si) in remap.iter().enumerate() {
                if let Some(si) = *remapped_si {
                    if si < row_vals.len() {
                        self.values.push(std::mem::take(&mut row_vals[si]));
                        continue;
                    }
                }
                if let Some(ref pk_key) = pk_auto_key {
                    if self.field_order[i] == *pk_key {
                        self.values.push(u64_field(id));
                        continue;
                    }
                }
                if let Some(name) = self.field_order.get(i) {
                    if let Some(fs) = self.schema.get(name) {
                        if let Some(ref default) = fs.default {
                            self.values.push(FieldValue::from_json(default.clone()));
                        } else if !fs.nullable {
                            self.values.push(default_value(&fs.field_type));
                        } else {
                            self.values.push(FieldValue::Null);
                        }
                    } else {
                        self.values.push(FieldValue::Null);
                    }
                }
            }
            // 显式传入 null 的主键：回填自动 id，保证 pk 值与行 id 一致
            if let Some(pi) = pk_idx {
                if let Some(v) = self.values.get_mut(values_start + pi) {
                    if *v == FieldValue::Null {
                        *v = u64_field(id);
                    }
                }
            }
            let idx = self.rows.len();
            self.pk_index.insert(id, idx);
            self.rows.push(RowStore { id, values_start, num_values: self.field_order.len(), created_at: now, updated_at: now });
            ids.push(id);
        }
        Ok(ids)
    }

    pub fn row_matches(&self, r: &RowStore, filter: &HashMap<String, serde_json::Value>) -> bool {
        let conds = self.parse_filter(filter);
        matches_filter(self.get_row_values(r), &conds)
    }

    /// 预解析过滤条件：字段名 → 行内下标 + 条件，避免逐行重复做 HashMap 查找。
    /// 支持字段级操作符（$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$between/$exists/$like/$regex），
    /// 一个字段多个操作符（如 {$gte:18,$lte:65}）会展开成多条，需同时满足。
    pub(crate) fn parse_filter<'a>(&self, filter: &'a HashMap<String, serde_json::Value>)
        -> Vec<(usize, Cond<'a>)>
    {
        let mut out = Vec::with_capacity(filter.len());
        for (k, v) in filter {
            // 未知字段用哨兵下标，按「字段不存在」参与匹配（不再静默放行）
            let pos = self.field_index.get(k).copied().unwrap_or(ABSENT_FIELD);
            match v {
                serde_json::Value::Object(map)
                    if !map.is_empty() && map.keys().all(|kk| kk.starts_with('$')) =>
                {
                    for (op, target) in map {
                        out.push((pos, parse_op(op, target)));
                    }
                }
                other => out.push((pos, Cond::Eq(other))),
            }
        }
        out
    }

    pub fn get_row(&self, id: u64) -> Option<Row> {
        let idx = *self.pk_index.get(&id)?;
        self.rows.get(idx).map(|r| self.to_row(r))
    }

    pub fn get_row_json(&self, id: u64) -> Option<String> {
        let idx = *self.pk_index.get(&id)?;
        self.rows.get(idx).map(|r| self.to_row_json_string(r))
    }

    pub fn get_rows_json(&self, ids: &[u64]) -> String {
        let mut out = String::with_capacity(ids.len() * 128);
        let mut tc = TimeCache::new();
        out.push('[');
        let mut first = true;
        for &id in ids {
            if let Some(&idx) = self.pk_index.get(&id) {
                if let Some(rs) = self.rows.get(idx) {
                    if !first { out.push(','); }
                    first = false;
                    self.write_row_json_into(rs, &mut out, &mut tc);
                }
            }
        }
        out.push(']');
        out
    }

    fn to_row_json_compact(&self, rs: &RowStore) -> String {
        let vals = self.get_row_values(rs);
        let mut out = String::with_capacity(64);
        out.push('[');
        write_u64_json(&mut out, rs.id);
        for v in vals {
            out.push(',');
            v.write_json(&mut out);
        }
        out.push(']');
        out
    }

    fn to_row_json_string(&self, rs: &RowStore) -> String {
        let mut out = String::with_capacity(160);
        let mut tc = TimeCache::new();
        self.write_row_json_into(rs, &mut out, &mut tc);
        out
    }

    /// 直接把一行写成 JSON 追加到 `out`。
    /// 相比先构造 `Row`（HashMap<String, Value>）再 serde 序列化，
    /// 省掉了每个字段一次的字符串分配与一次完整的二次序列化。
    pub fn write_row_json_into(&self, rs: &RowStore, out: &mut String, tc: &mut TimeCache) {
        let vals = self.get_row_values(rs);
        out.push_str(r#"{"id":"#);
        write_u64_json(out, rs.id);
        out.push_str(r#","fields":{"#);
        for (i, name) in self.field_order.iter().enumerate() {
            if i > 0 { out.push(','); }
            write_json_string(out, name);
            out.push(':');
            match vals.get(i) {
                Some(v) => v.write_json(out),
                None => out.push_str("null"),
            }
        }
        out.push_str(r#"},"created_at":""#);
        tc.write(out, rs.created_at);
        out.push_str(r#"","updated_at":""#);
        tc.write(out, rs.updated_at);
        out.push_str(r#""}"#);
    }

    pub fn update_row(&mut self, id: u64, data: HashMap<String, serde_json::Value>) -> Result<bool, String> {
        self.update_row_ref(id, &data)
    }

    /// 借用版本：批量按 filter 更新时复用同一份 data，避免每行都克隆整个 HashMap。
    pub fn update_row_ref(&mut self, id: u64, data: &HashMap<String, serde_json::Value>) -> Result<bool, String> {
        let idx = match self.pk_index.get(&id) {
            Some(i) => *i,
            None => return Ok(false),
        };
        // Use raw index access to update values without borrow conflicts
        if idx < self.rows.len() {
            let row = &mut self.rows[idx];
            let nv = row.num_values;
            let s = row.values_start;
            let mut staged: Vec<(usize, FieldValue)> = Vec::new();
            for (k, v) in data {
                if let Some(&pos) = self.field_index.get(k) {
                    if pos < nv {
                        let fv = match self.schema.get(k) {
                            Some(fs) => FieldValue::from_json_typed(&fs.field_type, v.clone())?,
                            None => FieldValue::from_json(v.clone()),
                        };
                        staged.push((s + pos, fv));
                    }
                }
            }
            for (pos, fv) in staged {
                self.values[pos] = fv;
            }
            self.rows[idx].updated_at = now_millis();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn update_rows(&mut self, batch: Vec<(u64, HashMap<String, serde_json::Value>)>) -> Result<usize, String> {
        let mut count = 0;
        let now = now_millis();
        for (id, data) in batch {
            if let Some(&idx) = self.pk_index.get(&id) {
                if idx < self.rows.len() {
                    let row = &mut self.rows[idx];
                    let nv = row.num_values;
                    let s = row.values_start;
                    let mut staged: Vec<(usize, FieldValue)> = Vec::new();
                    for (k, v) in &data {
                        if let Some(&pos) = self.field_index.get(k) {
                            if pos < nv {
                                let fv = match self.schema.get(k) {
                                    Some(fs) => FieldValue::from_json_typed(&fs.field_type, v.clone())?,
                                    None => FieldValue::from_json(v.clone()),
                                };
                                staged.push((s + pos, fv));
                            }
                        }
                    }
                    for (pos, fv) in staged {
                        self.values[pos] = fv;
                    }
                    self.rows[idx].updated_at = now;
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    pub fn remove_row(&mut self, id: u64) -> bool {
        let idx = match self.pk_index.get(&id) {
            Some(i) => *i,
            None => return false,
        };
        self.pk_index.remove(&id);
        let last = self.rows.len() - 1;
        if idx != last {
            self.pk_index.insert(self.rows[last].id, idx);
        }
        self.rows.swap_remove(idx);
        true
    }

    pub fn remove_rows(&mut self, ids: &[u64]) -> usize {
        let mut count = 0;
        let mut indices: Vec<(usize, u64)> = Vec::with_capacity(ids.len());
        for &id in ids {
            if let Some(&idx) = self.pk_index.get(&id) {
                indices.push((idx, id));
                count += 1;
            }
        }
        indices.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        for (idx, id) in indices {
            self.pk_index.remove(&id);
            let last = self.rows.len() - 1;
            if idx != last {
                self.pk_index.insert(self.rows[last].id, idx);
            }
            self.rows.swap_remove(idx);
        }
        count
    }

    pub fn remove_row_by_idx(&mut self, idx: usize) {
        let last = self.rows.len() - 1;
        if idx < last {
            let swapped_id = self.rows[last].id;
            self.pk_index.insert(swapped_id, idx);
        }
        self.pk_index.remove(&self.rows[idx].id);
        self.rows.swap_remove(idx);
    }

    pub fn count(&self) -> usize {
        self.rows.len()
    }

    // ============================================================
    // 磁盘持久化导出 / 导入（供 HybridEngine 使用）
    // ============================================================

    pub fn export_all(&self) -> String {
        let mut out = String::with_capacity(64 + self.rows.len() * 96);
        out.push_str(r#"{"next_id":"#);
        out.push_str(itoa::Buffer::new().format(self.next_id));
        out.push_str(r#","rows":["#);
        for (i, rs) in self.rows.iter().enumerate() {
            if i > 0 { out.push(','); }
            out.push_str(r#"{"id":"#);
            out.push_str(itoa::Buffer::new().format(rs.id));
            out.push_str(r#","created_at":"#);
            out.push_str(itoa::Buffer::new().format(rs.created_at));
            out.push_str(r#","updated_at":"#);
            out.push_str(itoa::Buffer::new().format(rs.updated_at));
            out.push_str(r#","fields":{"#);
            let vals = self.get_row_values(rs);
            for (fi, name) in self.field_order.iter().enumerate() {
                if fi > 0 { out.push(','); }
                write_json_string(&mut out, name);
                out.push(':');
                if let Some(v) = vals.get(fi) {
                    v.write_json(&mut out);
                } else {
                    out.push_str("null");
                }
            }
            out.push_str("}}");
        }
        out.push_str("]}");
        out
    }

    pub fn import_from_json(&mut self, json: &str) -> Result<(), String> {
        let parsed: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| format!("invalid table file: {}", e))?;
        let next_id = parsed.get("next_id").and_then(|v| v.as_u64()).unwrap_or(1);
        self.next_id = next_id;
        let rows = parsed.get("rows").and_then(|v| v.as_array()).ok_or("table file missing rows")?;
        let pk_auto_key = self.pk_field.as_deref().and_then(|pk| {
            self.schema.get(pk).and_then(|fs| if fs.auto_increment { Some(pk.to_string()) } else { None })
        });
        self.rows.reserve(rows.len());
        self.values.reserve(rows.len() * self.field_order.len());
        self.pk_index.reserve(rows.len());
        for rv in rows {
            let id = rv.get("id").and_then(|v| v.as_u64()).ok_or("row missing id")?;
            let created_at = rv.get("created_at").and_then(|v| v.as_u64()).unwrap_or_else(now_millis);
            let updated_at = rv.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(created_at);
            let fields = rv.get("fields").and_then(|v| v.as_object()).ok_or("row missing fields")?;
            // 落盘数据里出现重复主键：报错而非静默覆盖（异常数据不应遮蔽真实行）
            if self.pk_index.contains_key(&id) {
                return Err(self.dup_pk_error(id));
            }
            let mut row_vals = Vec::with_capacity(self.field_order.len());
            for name in &self.field_order {
                if let Some(jv) = fields.get(name) {
                    let fv = match self.schema.get(name) {
                        Some(fs) => FieldValue::from_json_typed(&fs.field_type, jv.clone())?,
                        None => FieldValue::from_json(jv.clone()),
                    };
                    row_vals.push(fv);
                } else if let Some(ref pk_key) = pk_auto_key {
                    if *pk_key == *name {
                        row_vals.push(u64_field(id));
                    } else {
                        row_vals.push(FieldValue::Null);
                    }
                } else {
                    row_vals.push(FieldValue::Null);
                }
            }
            let values_start = self.values.len();
            self.values.extend(row_vals);
            let idx = self.rows.len();
            self.pk_index.insert(id, idx);
            self.rows.push(RowStore { id, values_start, num_values: self.field_order.len(), created_at, updated_at });
        }
        Ok(())
    }

    /// 与 `find_rows` 语义一致，但直接把结果写成 JSON 字符串。
    /// - 无排序时流式扫描，凑够 limit 立刻停止，不再先收集全表行指针
    /// - 命中 limit 后仍多探一行，用于判断是否还有下一页（has_more）
    /// 返回 (json, has_more)
    pub fn find_rows_json(&self,
                          filter: &Option<HashMap<String, serde_json::Value>>,
                          limit: Option<usize>, offset: Option<usize>,
                          order_by: &Option<String>, order: &Option<String>) -> (String, bool) {
        let o = offset.unwrap_or(0);
        let cap = limit.unwrap_or(usize::MAX);

        // 主键点查直通：一次哈希查找定位到行，不再逐行 parse_filter/matches_filter。
        if let Some(id) = filter.as_ref().and_then(|f| self.pk_eq_id(f)) {
            let mut out = String::with_capacity(160);
            out.push('[');
            if o == 0 && cap > 0 {
                if let Some(&idx) = self.pk_index.get(&id) {
                    if let Some(rs) = self.rows.get(idx) {
                        let mut tc = TimeCache::new();
                        self.write_row_json_into(rs, &mut out, &mut tc);
                    }
                }
            }
            out.push(']');
            return (out, false);
        }

        let conds = filter.as_ref().map(|f| self.parse_filter(f)).unwrap_or_default();

        let mut out = String::with_capacity(128);
        out.push('[');
        let mut written = 0usize;
        let mut has_more = false;
        let mut tc = TimeCache::new();

        let ordered = order_by.as_ref().and_then(|f| {
            self.field_index.get(f).map(|&p| (p, order.as_deref() == Some("desc")))
        });

        match ordered {
            Some((pos, desc)) => {
                // 排序路径必须先收集全部匹配行
                let mut matched: Vec<&RowStore> = self.rows.iter()
                    .filter(|r| matches_filter(self.get_row_values(r), &conds))
                    .collect();
                matched.sort_by(|a, b| {
                    let cmp = cmp_field_values(
                        self.get_row_values(a).get(pos),
                        self.get_row_values(b).get(pos),
                    );
                    if desc { cmp.reverse() } else { cmp }
                });
                has_more = limit.is_some() && matched.len().saturating_sub(o) > cap;
                for r in matched.into_iter().skip(o).take(cap) {
                    if written > 0 { out.push(','); }
                    self.write_row_json_into(r, &mut out, &mut tc);
                    written += 1;
                }
            }
            None => {
                let mut skipped = 0usize;
                for r in &self.rows {
                    if !matches_filter(self.get_row_values(r), &conds) { continue; }
                    if skipped < o { skipped += 1; continue; }
                    if written >= cap { has_more = true; break; }
                    if written > 0 { out.push(','); }
                    self.write_row_json_into(r, &mut out, &mut tc);
                    written += 1;
                }
            }
        }

        out.push(']');
        (out, has_more)
    }

    pub fn find_rows(&self, filter: &Option<HashMap<String, serde_json::Value>>,
                     limit: Option<usize>, offset: Option<usize>,
                     order_by: &Option<String>, order: &Option<String>) -> Vec<Row> {
        let o = offset.unwrap_or(0);
        let l = limit.unwrap_or(usize::MAX);

        // 主键点查直通（与 find_rows_json 一致）。
        if let Some(id) = filter.as_ref().and_then(|f| self.pk_eq_id(f)) {
            if o == 0 && l > 0 {
                if let Some(&idx) = self.pk_index.get(&id) {
                    if let Some(rs) = self.rows.get(idx) {
                        return vec![self.to_row(rs)];
                    }
                }
            }
            return Vec::new();
        }

        let conds = filter.as_ref().map(|f| self.parse_filter(f)).unwrap_or_default();

        if let Some(field) = order_by.as_ref().filter(|f| self.field_index.contains_key(*f)) {
            let pos = self.field_index[field];
            let desc = order.as_deref() == Some("desc");
            let mut results: Vec<&RowStore> = self.rows.iter()
                .filter(|r| matches_filter(self.get_row_values(r), &conds))
                .collect();
            results.sort_by(|a, b| {
                let cmp = cmp_field_values(
                    self.get_row_values(a).get(pos),
                    self.get_row_values(b).get(pos),
                );
                if desc { cmp.reverse() } else { cmp }
            });
            return results.into_iter().skip(o).take(l).map(|r| self.to_row(r)).collect();
        }

        // 无排序：流式扫描，凑够 limit 立刻停止，不先收集全表行指针
        let mut out = Vec::with_capacity(l.min(self.rows.len()));
        let mut skipped = 0usize;
        for r in &self.rows {
            if !matches_filter(self.get_row_values(r), &conds) { continue; }
            if skipped < o { skipped += 1; continue; }
            if out.len() >= l { break; }
            out.push(self.to_row(r));
        }
        out
    }
}

/// 过滤条件里出现 schema 之外的字段时用它作为哨兵下标：
/// `vals.get(SENTINEL)` 恒为 None，等价于「该字段不存在」，
/// 于是 {$exists:false}/{$ne:x} 等语义与 lib/table.js 的 `_matchRow` 一致，
/// 而 `{noSuchField: 5}` 会正确地匹配 0 行（旧实现会静默放行全部行）。
const ABSENT_FIELD: usize = usize::MAX;

/// 单字段查询条件（字段名已在解析阶段降为行内下标）
pub(crate) enum Cond<'a> {
    Eq(&'a serde_json::Value),
    Ne(&'a serde_json::Value),
    Gt(&'a serde_json::Value),
    Gte(&'a serde_json::Value),
    Lt(&'a serde_json::Value),
    Lte(&'a serde_json::Value),
    In(&'a serde_json::Value),
    Nin(&'a serde_json::Value),
    /// 闭区间 [lo, hi]
    Between(&'a serde_json::Value),
    Exists(bool),
    /// `$like`：SQL 风格通配（`%` = 任意多字符，`_` = 单字符），大小写不敏感。
    /// 模式在解析阶段编译一次，逐行只做匹配。
    Like(Box<regex_lite::Regex>),
    /// `$regex`：JavaScript 风格正则，大小写敏感。
    Regex(Box<regex_lite::Regex>),
    /// 不认识的写法：永不匹配（与旧的等值语义一致，避免静默放行全部行）
    Never,
}

/// 解析单个操作符。语义对齐 lib/table.js 的 `_matchOperator`。
pub(crate) fn parse_op<'a>(op: &str, target: &'a serde_json::Value) -> Cond<'a> {
    match op {
        "$eq" => Cond::Eq(target),
        "$ne" => Cond::Ne(target),
        "$gt" => Cond::Gt(target),
        "$gte" => Cond::Gte(target),
        "$lt" => Cond::Lt(target),
        "$lte" => Cond::Lte(target),
        "$in" => Cond::In(target),
        "$nin" => Cond::Nin(target),
        "$between" => Cond::Between(target),
        "$exists" => Cond::Exists(target.as_bool().unwrap_or(true)),
        // $like / $regex 目标必须是字符串；非法或编译失败的模式退化为「永不匹配」。
        // regex-lite 为线性时间引擎，不存在灾难性回溯，无需 JS 侧 isSafeRegex 的长度拦截。
        "$like" => match target.as_str() {
            Some(p) => regex_lite::Regex::new(&like_to_regex(p))
                .map(|re| Cond::Like(Box::new(re)))
                .unwrap_or(Cond::Never),
            None => Cond::Never,
        },
        "$regex" => match target.as_str() {
            Some(p) => regex_lite::Regex::new(p)
                .map(|re| Cond::Regex(Box::new(re)))
                .unwrap_or(Cond::Never),
            None => Cond::Never,
        },
        _ => Cond::Never,
    }
}

/// 把 SQL LIKE 模式转成锚定的、大小写不敏感的正则：
/// 先转义正则元字符，再把 `%` 视作 `.*`、`_` 视作 `.`，
/// 与 lib/table.js 的 `$like` 实现逐字符对齐。
fn like_to_regex(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    out.push_str("(?i)^");
    for ch in pattern.chars() {
        match ch {
            '%' => out.push_str(".*"),
            '_' => out.push('.'),
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            c => out.push(c),
        }
    }
    out.push('$');
    out
}

/// 把存储值转成 JS `String(value)` 的等价字符串（供 `$regex` 语义使用）。
fn field_value_to_string(v: &FieldValue) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    match v {
        FieldValue::Null => Cow::Borrowed("null"),
        FieldValue::Bool(b) => Cow::Owned(b.to_string()),
        FieldValue::Int(n) => Cow::Owned(n.to_string()),
        FieldValue::UInt(n) => Cow::Owned(n.to_string()),
        FieldValue::Float(f) => Cow::Owned(f.to_string()),
        FieldValue::String(s) => Cow::Borrowed(s),
    }
}

#[inline]
pub(crate) fn matches_filter(vals: &[FieldValue], conds: &[(usize, Cond)]) -> bool {
    // 最常见形态（单字段等值，如按主键点查）走直通，避免逐行做枚举分派
    if let [(pos, Cond::Eq(t))] = conds {
        return vals.get(*pos).map_or(false, |fv| fv.eq_json(t));
    }
    conds.iter().all(|(pos, c)| match_cond(vals.get(*pos), c))
}

#[inline]
fn match_cond(fv: Option<&FieldValue>, cond: &Cond) -> bool {
    use std::cmp::Ordering;
    let cmp = |t: &serde_json::Value, want: fn(Ordering) -> bool| {
        fv.and_then(|v| cmp_to_json(v, t)).map_or(false, want)
    };
    match cond {
        Cond::Never => false,
        Cond::Exists(want) => fv.is_some() == *want,
        Cond::Eq(t) => fv.map_or(false, |v| v.eq_json(t)),
        Cond::Ne(t) => !fv.map_or(false, |v| v.eq_json(t)),
        Cond::In(t) => match t.as_array() {
            Some(arr) => fv.map_or(false, |v| arr.iter().any(|e| v.eq_json(e))),
            None => false,
        },
        Cond::Nin(t) => match t.as_array() {
            Some(arr) => !fv.map_or(false, |v| arr.iter().any(|e| v.eq_json(e))),
            None => false,
        },
        Cond::Gt(t) => cmp(t, |o| o == Ordering::Greater),
        Cond::Gte(t) => cmp(t, |o| o != Ordering::Less),
        Cond::Lt(t) => cmp(t, |o| o == Ordering::Less),
        Cond::Lte(t) => cmp(t, |o| o != Ordering::Greater),
        Cond::Between(t) => match t.as_array() {
            Some(arr) if arr.len() == 2 => {
                cmp(&arr[0], |o| o != Ordering::Less) && cmp(&arr[1], |o| o != Ordering::Greater)
            }
            _ => false,
        },
        // $like 只对字符串字段生效（对齐 lib/table.js：非字符串直接 false）
        Cond::Like(re) => matches!(fv, Some(FieldValue::String(s)) if re.is_match(s)),
        // $regex 先把值字符串化再匹配（对齐 lib/table.js 的 String(value)）
        Cond::Regex(re) => fv.map_or(false, |v| re.is_match(&field_value_to_string(v))),
    }
}

/// 存储值与 JSON 目标值比较；类型不可比或含 null/NaN 时返回 None（视为不匹配，
/// 对齐 JS 里 `value !== null && value > expected` 的写法）。
fn cmp_numeric_to_json(a: i128, jv: &serde_json::Value) -> Option<std::cmp::Ordering> {
    use serde_json::Value as J;
    if let Some(b) = json_as_i128(jv) {
        return Some(a.cmp(&b));
    }
    match jv {
        J::Number(n) => n.as_f64().and_then(|b| (a as f64).partial_cmp(&b)),
        _ => None,
    }
}

fn cmp_to_json(fv: &FieldValue, jv: &serde_json::Value) -> Option<std::cmp::Ordering> {
    use serde_json::Value as J;
    match (fv, jv) {
        (FieldValue::Null, _) | (_, J::Null) => None,
        (FieldValue::Int(a), _) => cmp_numeric_to_json(*a as i128, jv),
        (FieldValue::UInt(a), _) => cmp_numeric_to_json(*a as i128, jv),
        (FieldValue::Float(a), J::Number(n)) => n.as_f64().and_then(|b| a.partial_cmp(&b)),
        (FieldValue::Bool(a), J::Bool(b)) => Some(a.cmp(b)),
        (FieldValue::String(a), J::String(b)) => Some(a.as_str().cmp(b.as_str())),
        _ => None,
    }
}

fn numeric_field_i128(v: &FieldValue) -> Option<i128> {
    match v {
        FieldValue::Int(n) => Some(*n as i128),
        FieldValue::UInt(n) => Some(*n as i128),
        _ => None,
    }
}

fn cmp_field_values(a: Option<&FieldValue>, b: Option<&FieldValue>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(va), Some(vb)) if numeric_field_i128(va).is_some() && numeric_field_i128(vb).is_some() => {
            numeric_field_i128(va).unwrap().cmp(&numeric_field_i128(vb).unwrap())
        }
        (Some(FieldValue::Float(na)), Some(FieldValue::Float(nb))) => na.partial_cmp(nb).unwrap_or(std::cmp::Ordering::Equal),
        (Some(FieldValue::String(sa)), Some(FieldValue::String(sb))) => sa.cmp(sb),
        (Some(FieldValue::Bool(ba)), Some(FieldValue::Bool(bb))) => ba.cmp(bb),
        (Some(a), Some(b)) => format!("{:?}", a).cmp(&format!("{:?}", b)),
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FieldSchema, FieldType};

    fn fs(ft: FieldType, nullable: bool, default: Option<serde_json::Value>) -> FieldSchema {
        FieldSchema {
            field_type: ft,
            primary_key: false,
            auto_increment: false,
            nullable,
            unique: false,
            length: None,
            default,
        }
    }

    #[test]
    fn add_column_multi_row_no_corruption() {
        let mut t = Table::new("t".into(), &[
            ("id".into(),   fs(FieldType::Integer, false, None)),
            ("name".into(), fs(FieldType::String,  false, None)),
        ]);
        t.add_rows(vec![
            HashMap::from([("id".to_string(), serde_json::json!(1)), ("name".to_string(), serde_json::json!("a"))]),
            HashMap::from([("id".to_string(), serde_json::json!(2)), ("name".to_string(), serde_json::json!("b"))]),
        ]).unwrap();

        assert!(t.add_column("age", &fs(FieldType::Integer, true, Some(serde_json::json!(0)))));

        // 修复前：行 1 因 values_start 未更新而损坏
        let row0 = t.get_row_values(&t.rows[0]);
        let row1 = t.get_row_values(&t.rows[1]);
        assert_eq!(row0, &[FieldValue::Int(1), FieldValue::String("a".into()), FieldValue::Int(0)]);
        assert_eq!(row1, &[FieldValue::Int(2), FieldValue::String("b".into()), FieldValue::Int(0)]);
    }

    #[test]
    fn add_column_single_row_ok() {
        let mut t = Table::new("t".into(), &[
            ("id".into(), fs(FieldType::Integer, false, None)),
        ]);
        t.add_rows(vec![HashMap::from([("id".to_string(), serde_json::json!(7))])]).unwrap();
        assert!(t.add_column("x", &fs(FieldType::Integer, true, Some(serde_json::json!(0)))));
        let row = t.get_row_values(&t.rows[0]);
        assert_eq!(row, &[FieldValue::Int(7), FieldValue::Int(0)]);
    }
}
