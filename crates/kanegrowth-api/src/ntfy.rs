#![allow(dead_code)]
use crate::config::Config;

pub struct NtfyClient {
    pub url: Option<String>,
    pub topic: Option<String>,
}

impl NtfyClient {
    pub fn from_config(config: &Config) -> Self {
        Self {
            url: config.ntfy_url.clone(),
            topic: config.ntfy_topic.clone(),
        }
    }
    pub fn notify(&self, _title: &str, _body: &str) {
        // fire-and-forget scaffold; no-op if not configured
        if self.url.is_some() && self.topic.is_some() {
            // fire-and-forget scaffold
        }
    }
}
