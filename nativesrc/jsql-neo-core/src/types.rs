use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    pub id: u64,
    pub fields: HashMap<String, serde_json::Value>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDefinition {
    pub name: String,
    #[serde(with = "schema_order_preserving")]
    pub schema: Vec<(String, FieldSchema)>,
}

/// 保序的对象序列化：JSON 对象 ↔ Vec<(String, FieldSchema)>
pub mod schema_order_preserving {
    use serde::{Deserialize, Deserializer, Serializer};
    use super::FieldSchema;

    pub fn serialize<S>(v: &[(String, FieldSchema)], s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(v.len()))?;
        for (k, f) in v {
            m.serialize_entry(k, f)?;
        }
        m.end()
    }

    pub fn deserialize<'de, D>(d: D) -> Result<Vec<(String, FieldSchema)>, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V<'a>(&'a mut Vec<(String, FieldSchema)>);
        impl<'de, 'a> serde::de::Visitor<'de> for V<'a> {
            type Value = ();
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a schema object")
            }
            fn visit_map<A>(self, mut a: A) -> Result<(), A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                while let Some((k, f)) = a.next_entry::<String, FieldSchema>()? {
                    self.0.push((k, f));
                }
                Ok(())
            }
        }
        let mut out = Vec::new();
        d.deserialize_map(V(&mut out))?;
        Ok(out)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSchema {
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default)]
    pub auto_increment: bool,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub length: Option<usize>,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Integer,
    Float,
    String,
    Boolean,
}

impl Default for FieldType {
    fn default() -> Self {
        FieldType::String
    }
}