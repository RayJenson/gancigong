use crate::models::{DictionaryStatus, FormItem, LookupHit};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone, Debug)]
pub struct DictForm {
    #[serde(default)]
    pub form: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Deserialize, Clone, Debug)]
struct RawEntry {
    #[serde(default)]
    w: String,
    #[serde(default)]
    p: String,
    #[serde(default)]
    m: String,
    #[serde(default)]
    f: Vec<DictForm>,
    #[serde(default)]
    t: Vec<String>,
}

pub struct Dictionary {
    entries: HashMap<String, RawEntry>,
    inflections: HashMap<String, String>,
    status: DictionaryStatus,
}

impl Dictionary {
    pub fn empty() -> Self {
        Self {
            entries: HashMap::new(),
            inflections: HashMap::new(),
            status: DictionaryStatus {
                loaded: false,
                count: 0,
                source: "未构建（运行 npm run dict:build）".into(),
                generated_at: String::new(),
                bytes: 0,
            },
        }
    }

    pub fn load(dirs: &[PathBuf]) -> Self {
        let Some(file) = find_file(dirs, "resources/dictionary/words.json") else {
            return Self::empty();
        };
        let bytes = std::fs::metadata(&file).map(|m| m.len() as i64).unwrap_or(0);
        let raw: Vec<RawEntry> = match std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
        {
            Some(v) => v,
            None => return Self::empty(),
        };
        let mut entries = HashMap::with_capacity(raw.len());
        let mut inflections: HashMap<String, String> = HashMap::new();
        for e in raw {
            let term = e.w.to_lowercase();
            if term.is_empty() {
                continue;
            }
            for f in &e.f {
                let form = f.form.to_lowercase();
                if form != term && !entries.contains_key(&form) && !inflections.contains_key(&form) {
                    inflections.insert(form, term.clone());
                }
            }
            entries.entry(term).or_insert(e);
        }
        let meta = find_file(dirs, "resources/dictionary/meta.json")
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
        let count = meta
            .as_ref()
            .and_then(|m| m.get("count"))
            .and_then(|v| v.as_i64())
            .unwrap_or(entries.len() as i64);
        let status = DictionaryStatus {
            loaded: true,
            count,
            source: meta
                .as_ref()
                .and_then(|m| m.get("source"))
                .and_then(|v| v.as_str())
                .unwrap_or("ECDICT (MIT)")
                .to_string(),
            generated_at: meta
                .as_ref()
                .and_then(|m| m.get("generatedAt"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            bytes: meta
                .as_ref()
                .and_then(|m| m.get("bytes"))
                .and_then(|v| v.as_i64())
                .unwrap_or(bytes),
        };
        Self {
            entries,
            inflections,
            status,
        }
    }

    pub fn status(&self) -> DictionaryStatus {
        self.status.clone()
    }

    pub fn lookup(&self, term: &str) -> Option<LookupHit> {
        let key = term.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        if let Some(e) = self.entries.get(&key) {
            return Some(to_hit(e, None));
        }
        let base = self.inflections.get(&key)?;
        let e = self.entries.get(base)?;
        Some(to_hit(e, Some(base.clone())))
    }
}

fn to_hit(e: &RawEntry, matched_via: Option<String>) -> LookupHit {
    LookupHit {
        term: e.w.clone(),
        phonetic: e.p.clone(),
        meaning: e.m.clone(),
        tags: e.t.clone(),
        forms: e
            .f
            .iter()
            .map(|f| FormItem {
                form: f.form.clone(),
                label: f.label.clone(),
            })
            .collect(),
        matched_via,
    }
}

pub fn find_file(dirs: &[PathBuf], rel: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|d| d.join(rel))
        .find(|p| Path::new(p).exists())
}
