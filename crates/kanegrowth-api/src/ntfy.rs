#![allow(dead_code)]

use crate::config::Config;
use std::time::Duration;

/// HTTP publisher for an ntfy topic.
///
/// Delivery is best-effort: callers treat a `publish` error as a logged failure on the
/// notification row, never as a request failure (issue #16, AC2).
#[derive(Clone)]
pub struct NtfyClient {
    url: Option<String>,
    topic: Option<String>,
    token: Option<String>,
    http: reqwest::Client,
    max_attempts: u32,
    /// Backoff is `backoff_base_ms * 1` before the second attempt and `backoff_base_ms * 3`
    /// before the third (200 ms and 600 ms in production).
    backoff_base_ms: u64,
}

const REQUEST_TIMEOUT_SECS: u64 = 5;
const DEFAULT_MAX_ATTEMPTS: u32 = 3;
const DEFAULT_BACKOFF_BASE_MS: u64 = 200;
const MAX_ERROR_BODY_CHARS: usize = 200;

/// Maps a priority name (or numeric string) onto ntfy's integer priority scale.
///
/// ntfy's JSON publish API rejects string priorities with `40024 invalid request: request body
/// must be valid JSON`; only the integer scale `1..=5` is accepted. Unknown names fall back to
/// the default priority `3`.
fn ntfy_priority(priority: &str) -> u8 {
    match priority.trim().to_ascii_lowercase().as_str() {
        "min" | "minimal" | "1" => 1,
        "low" | "2" => 2,
        "default" | "normal" | "3" | "" => 3,
        "high" | "4" => 4,
        "max" | "urgent" | "5" => 5,
        _ => 3,
    }
}

impl NtfyClient {
    pub fn from_config(config: &Config) -> Self {
        Self {
            url: config.ntfy_url.clone(),
            topic: config.ntfy_topic.clone(),
            token: config.ntfy_token.clone(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .unwrap_or_default(),
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            backoff_base_ms: DEFAULT_BACKOFF_BASE_MS,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.url
            .as_deref()
            .map(|u| !u.trim().is_empty())
            .unwrap_or(false)
            && self
                .topic
                .as_deref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false)
    }

    fn endpoint(&self) -> Option<String> {
        self.url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(|u| u.trim_end_matches('/').to_string())
    }

    /// Publishes a JSON message to the configured topic.
    ///
    /// 4xx responses (bad token/topic) are final; transport errors, 408, 429 and 5xx are retried
    /// up to `max_attempts` in total.
    pub async fn publish(
        &self,
        title: &str,
        message: &str,
        tags: &[&str],
        priority: &str,
    ) -> Result<(), String> {
        if !self.is_configured() {
            return Err("ntfy is not configured".to_string());
        }
        let endpoint = self
            .endpoint()
            .ok_or_else(|| "ntfy is not configured".to_string())?;
        let topic = self
            .topic
            .as_deref()
            .ok_or_else(|| "ntfy is not configured".to_string())?;
        let body = serde_json::json!({
            "topic": topic,
            "title": title,
            "message": message,
            "tags": tags,
            // ntfy's JSON API only accepts the integer priority scale (1..=5).
            "priority": ntfy_priority(priority),
        });

        let mut last_error = String::from("ntfy publish failed");
        for attempt in 1..=self.max_attempts {
            let mut request = self.http.post(&endpoint).json(&body);
            if let Some(token) = self.token.as_deref().filter(|t| !t.is_empty()) {
                request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
            }

            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return Ok(());
                    }
                    let retryable = status.as_u16() == 408
                        || status.as_u16() == 429
                        || status.is_server_error();
                    let text: String = response
                        .text()
                        .await
                        .unwrap_or_default()
                        .chars()
                        .take(MAX_ERROR_BODY_CHARS)
                        .collect();
                    last_error = format!("ntfy returned {}: {}", status.as_u16(), text);
                    if !retryable {
                        return Err(last_error);
                    }
                }
                Err(err) => {
                    last_error = format!("ntfy request failed: {err}");
                }
            }

            if attempt < self.max_attempts {
                let factor = 2 * attempt as u64 - 1;
                tokio::time::sleep(Duration::from_millis(self.backoff_base_ms * factor)).await;
            }
        }
        Err(last_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// Minimal HTTP listener that answers each accepted connection with the next status in
    /// `statuses`, closing the connection so every attempt opens a fresh socket.
    struct MockNtfy {
        base_url: String,
        requests: Arc<Mutex<Vec<String>>>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl MockNtfy {
        fn spawn(statuses: Vec<u16>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&requests);
            let handle = thread::spawn(move || {
                for status in statuses {
                    let Ok((mut stream, _)) = listener.accept() else {
                        return;
                    };
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    // Read until the headers and (small) JSON body arrive or the peer goes quiet.
                    loop {
                        match stream.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                raw.extend_from_slice(&buf[..n]);
                                if n < buf.len() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    captured
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&raw).to_string());
                    let response = format!(
                        "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
            });
            MockNtfy {
                base_url: format!("http://{addr}"),
                requests,
                handle: Some(handle),
            }
        }

        fn hits(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for MockNtfy {
        fn drop(&mut self) {
            // Unblock the accept loop by connecting once; the thread exits on the failed read.
            let _ = std::net::TcpStream::connect(self.base_url.trim_start_matches("http://"));
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn client_for(url: &str) -> NtfyClient {
        NtfyClient {
            url: Some(url.to_string()),
            topic: Some("test-topic".to_string()),
            token: None,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            max_attempts: 3,
            backoff_base_ms: 1,
        }
    }

    #[tokio::test]
    async fn publish_retries_server_errors_then_succeeds() {
        let mock = MockNtfy::spawn(vec![500, 500, 200]);
        let client = client_for(&mock.base_url);

        let result = client
            .publish("Budget alert", "Over budget", &["warning"], "high")
            .await;

        assert!(result.is_ok(), "publish failed: {result:?}");
        let hits = mock.hits();
        assert_eq!(hits.len(), 3, "expected 3 attempts, got {}", hits.len());
        assert!(hits[0].contains("\"topic\":\"test-topic\""));
        assert!(hits[0].contains("Budget alert"));
    }

    #[tokio::test]
    async fn publish_does_not_retry_client_errors() {
        let mock = MockNtfy::spawn(vec![401]);
        let client = client_for(&mock.base_url);

        let result = client.publish("Bill due", "Rent", &[], "default").await;

        let error = result.expect_err("a 401 must fail");
        assert!(error.contains("401"), "unexpected error: {error}");
        assert_eq!(mock.hits().len(), 1, "a 4xx must not be retried");
    }

    #[tokio::test]
    async fn publish_serializes_an_integer_priority() {
        // ntfy rejects the string form (`40024 request body must be valid JSON`); the JSON
        // publish body must carry the integer priority scale instead.
        let mock = MockNtfy::spawn(vec![200]);
        let client = client_for(&mock.base_url);

        client
            .publish("Budget alert", "Over budget", &["warning"], "default")
            .await
            .expect("publish should succeed");

        let hits = mock.hits();
        assert_eq!(hits.len(), 1, "expected a single attempt");
        assert!(
            hits[0].contains("\"priority\":3"),
            "expected an integer priority in the body: {}",
            hits[0]
        );
        assert!(
            !hits[0].contains("\"priority\":\"default\""),
            "a string priority is rejected by ntfy: {}",
            hits[0]
        );
    }

    #[test]
    fn priority_names_map_onto_the_integer_scale() {
        assert_eq!(ntfy_priority("min"), 1);
        assert_eq!(ntfy_priority("minimal"), 1);
        assert_eq!(ntfy_priority("low"), 2);
        assert_eq!(ntfy_priority("default"), 3);
        assert_eq!(ntfy_priority(""), 3);
        assert_eq!(ntfy_priority("high"), 4);
        assert_eq!(ntfy_priority("max"), 5);
        assert_eq!(ntfy_priority("urgent"), 5);
        assert_eq!(ntfy_priority("3"), 3);
        assert_eq!(ntfy_priority("something-else"), 3);
    }
}
