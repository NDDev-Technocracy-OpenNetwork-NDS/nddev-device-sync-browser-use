//! What may be kept of page data (docs/observability.md): secrets are removed before a record is
//! written, in every field that can carry one.
//!
//! The secret-name list, the URL and body redaction and the telemetry host list are adapted from
//! Playwriter's playwriter/src/action-recorder.ts (MIT License, Copyright (c) 2026 Tommy D. Rossi,
//! https://github.com/remorses/playwriter).

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

pub const REDACTED: &str = "[redacted]";

/// Field names that are a secret only as a whole word, and names a secret ends with.
const EXACT: &[&str] = &[
    "auth", "card", "code", "cvc", "cvv", "jwt", "key", "otp", "pin", "pwd", "session", "sig",
    "ssn",
];
const SUFFIX: &[&str] = &[
    "accesstoken",
    "apikey",
    "authcode",
    "authorization",
    "cardnumber",
    "cookie",
    "credential",
    "csrf",
    "idtoken",
    "onetimecode",
    "passcode",
    "passwd",
    "password",
    "privatekey",
    "refreshtoken",
    "secret",
    "securitycode",
    "sessionid",
    "signature",
    "token",
    "verificationcode",
    "xamzcredential",
    "xamzsecuritytoken",
    "xamzsignature",
    "xsrf",
];
const SECRET_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
];
const TELEMETRY_HOSTS: &[&str] = &[
    "amplitude.com",
    "bat.bing.com",
    "clarity.ms",
    "doubleclick.net",
    "facebook.net",
    "fullstory.com",
    "google-analytics.com",
    "googleadservices.com",
    "googlesyndication.com",
    "googletagmanager.com",
    "hotjar.com",
    "mc.yandex.ru",
    "mixpanel.com",
    "newrelic.com",
    "nr-data.net",
    "segment.com",
    "segment.io",
    "sentry.io",
];

/// Credential-shaped text anywhere: JWTs, bearer values and vendor keys.
static SECRET_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|\bBearer\s+[\w.~+/-]{16,}|\b(?:sk|pk|rk|ghp|gho|ghs|glpat|xox[abpr])[-_][\w-]{16,}",
    )
    .expect("static pattern")
});
/// A literal agent code typed into a field: `.fill("v")`, `.fill("#sel", "v")` and the like.
static TYPED: LazyLock<Regex> = LazyLock::new(|| {
    let literal = r#"(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)"#;
    Regex::new(&format!(
        r"(\.(?:fill|type|pressSequentially|insertText)\(\s*(?:{literal}\s*,\s*)?){literal}"
    ))
    .expect("static pattern")
});
/// A locator naming a field whose typed value is a secret.
static SECRET_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)pass|pwd|otp|one-?time|passcode|\bpin\b|cvv|cvc|card|secret|token|api.?key")
        .expect("static pattern")
});

pub fn secret_name(name: &str) -> bool {
    let plain: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect();
    EXACT.contains(&plain.as_str()) || SUFFIX.iter().any(|secret| plain.ends_with(secret))
}

pub fn secret_field(locator: &str) -> bool {
    SECRET_FIELD.is_match(locator)
}

/// At most `limit` characters, ending on a character boundary.
pub fn bounded(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((index, _)) => format!("{}…", &text[..index]),
        None => text.to_owned(),
    }
}

/// Text an agent or a page produced, without credential-shaped strings.
pub fn text(value: &str, limit: usize) -> String {
    bounded(&SECRET_TEXT.replace_all(value, REDACTED), limit)
}

fn decoded(name: &str) -> String {
    percent_encoding::percent_decode_str(&name.replace('+', " "))
        .decode_utf8_lossy()
        .into_owned()
}

fn clean_pairs(query: &str) -> String {
    query
        .split('&')
        .map(|pair| {
            let name = pair.split('=').next().unwrap_or_default();
            if secret_name(&decoded(name)) {
                format!("{name}={REDACTED}")
            } else {
                pair.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// The URL without credentials, fragment or secret query values.
pub fn url(value: &str) -> String {
    let value = value.split('#').next().unwrap_or_default();
    let (base, query) = value
        .split_once('?')
        .map_or((value, None), |(base, query)| (base, Some(query)));
    let base = match base.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest
                .split_once('/')
                .map_or((rest, None), |(authority, path)| (authority, Some(path)));
            let authority = authority.rsplit_once('@').map_or_else(
                || authority.to_owned(),
                |(_, host)| format!("{REDACTED}@{host}"),
            );
            match path {
                Some(path) => format!("{scheme}://{authority}/{path}"),
                None => format!("{scheme}://{authority}"),
            }
        }
        None => base.to_owned(),
    };
    let whole = match query {
        Some(query) => format!("{base}?{}", clean_pairs(query)),
        None => base,
    };
    text(&whole, 2000)
}

pub fn host(value: &str) -> &str {
    let rest = value.split_once("://").map_or(value, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    host.rsplit_once(':')
        .filter(|(_, port)| port.bytes().all(|byte| byte.is_ascii_digit()))
        .map_or(host, |(host, _)| host)
}

/// Requests to analytics and advertising hosts are noise.
pub fn telemetry(value: &str) -> bool {
    let host = host(value).to_ascii_lowercase();
    TELEMETRY_HOSTS
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

fn json(value: &Value) -> Value {
    match value {
        Value::Array(items) => items.iter().map(json).collect(),
        Value::Object(fields) => fields
            .iter()
            .map(|(name, item)| {
                let kept = if secret_name(name) {
                    REDACTED.into()
                } else {
                    json(item)
                };
                (name.clone(), kept)
            })
            .collect::<Map<_, _>>()
            .into(),
        Value::String(text) => SECRET_TEXT.replace_all(text, REDACTED).into_owned().into(),
        other => other.clone(),
    }
}

/// Whether bodies of this content type are text worth keeping.
pub fn textual(content_type: &str) -> bool {
    let media = content_type.to_ascii_lowercase();
    [
        "json",
        "text",
        "xml",
        "x-www-form-urlencoded",
        "graphql",
        "javascript",
    ]
    .iter()
    .any(|kind| media.contains(kind))
}

/// A request or response body as far as it may be kept: secrets out, binary and parts omitted.
pub fn body(value: &str, content_type: &str) -> String {
    let media = content_type.to_ascii_lowercase();
    if media.contains("json") {
        return serde_json::from_str::<Value>(value).map_or_else(
            |_| "[omitted invalid JSON]".to_owned(),
            |parsed| json(&parsed).to_string(),
        );
    }
    if media.contains("x-www-form-urlencoded") {
        return clean_pairs(value);
    }
    if media.contains("multipart") {
        return "[omitted multipart body]".to_owned();
    }
    if !textual(&media) {
        return "[omitted binary body]".to_owned();
    }
    SECRET_TEXT.replace_all(value, REDACTED).into_owned()
}

/// Agent code with every literal it typed into a field left out; actions keep safe values.
pub fn code(value: &str, limit: usize) -> String {
    let typed = TYPED.replace_all(value, format!("${{1}}\"{REDACTED}\""));
    text(&typed, limit)
}

/// Request headers without credentials, each value bounded.
pub fn headers(value: &Value) -> Value {
    value
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .filter(|(name, _)| {
                    !SECRET_HEADERS.contains(&name.to_ascii_lowercase().as_str())
                        && !secret_name(name)
                })
                .take(64)
                .map(|(name, item)| {
                    (
                        bounded(name, 128),
                        text(item.as_str().unwrap_or_default(), 500).into(),
                    )
                })
                .collect::<Map<_, _>>()
                .into()
        })
        .unwrap_or_else(|| Value::Object(Map::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

    #[test]
    fn secret_names_are_whole_words_or_endings_and_ordinary_words_stay() {
        for secret in [
            "password",
            "access_token",
            "X-Amz-Signature",
            "otp",
            "apiKey",
            "code",
            "client_secret",
        ] {
            assert!(secret_name(secret), "{secret}");
        }
        for plain in [
            "zipcode", "monkey", "postcode", "keyboard", "id", "q", "page", "pinned",
        ] {
            assert!(!secret_name(plain), "{plain}");
        }
    }

    #[test]
    fn a_url_keeps_its_path_and_plain_query_and_loses_credentials_secrets_and_fragment() {
        assert_eq!(
            url("https://user:pw@shop.test/orders?id=7&access_token=abc&X-Amz-Signature=s#k"),
            "https://[redacted]@shop.test/orders?id=7&access_token=[redacted]&X-Amz-Signature=[redacted]"
        );
        assert_eq!(
            url("https://shop.test/search?q=shoes&page=2"),
            "https://shop.test/search?q=shoes&page=2"
        );
        assert_eq!(
            url(&format!("https://api.test/v1/{JWT}/me")),
            "https://api.test/v1/[redacted]/me"
        );
        assert_eq!(host("https://a:b@cdn.shop.test:8443/x?y"), "cdn.shop.test");
        assert!(telemetry("https://www.google-analytics.com/g/collect?v=2"));
        assert!(!telemetry("https://notgoogle-analytics.com/"));
    }

    #[test]
    fn a_body_keeps_plain_fields_and_loses_secrets_parts_and_binary_data() {
        let kept = body(
            &json!({ "user": "ann", "password": "hunter2", "nested": { "apiKey": "k", "items": [{ "token": "t" }] } })
                .to_string(),
            "application/json; charset=utf-8",
        );
        assert_eq!(
            serde_json::from_str::<Value>(&kept).unwrap(),
            json!({ "user": "ann", "password": "[redacted]", "nested": { "apiKey": "[redacted]", "items": [{ "token": "[redacted]" }] } })
        );
        assert_eq!(
            body(
                "q=shoes&otp=123456&session_id=9",
                "application/x-www-form-urlencoded"
            ),
            "q=shoes&otp=[redacted]&session_id=[redacted]"
        );
        assert_eq!(
            body("--b\r\nfile", "multipart/form-data; boundary=b"),
            "[omitted multipart body]"
        );
        assert_eq!(
            body("\u{0}\u{1}", "application/octet-stream"),
            "[omitted binary body]"
        );
        assert_eq!(
            body("{broken", "application/json"),
            "[omitted invalid JSON]"
        );
        assert_eq!(
            body(&format!("Authorization: Bearer {JWT}"), "text/plain"),
            "Authorization: [redacted]"
        );
    }

    #[test]
    fn agent_code_keeps_its_steps_and_loses_every_literal_typed_into_a_field() {
        assert_eq!(
            code(
                r##"await page.fill("#email", "ann@test"); await page.locator('#pw').fill('hunter2'); await field.type(`otp ${x}`); await page.click("#go")"##,
                20_000
            ),
            r##"await page.fill("#email", "[redacted]"); await page.locator('#pw').fill("[redacted]"); await field.type("[redacted]"); await page.click("#go")"##
        );
        assert_eq!(
            code(r#"const key = "sk-proj-0123456789abcdefghij";"#, 100),
            r#"const key = "[redacted]";"#
        );
    }

    #[test]
    fn headers_lose_credentials_and_text_is_bounded() {
        assert_eq!(
            headers(
                &json!({ "Accept": "application/json", "Authorization": "Bearer x", "Cookie": "a=b", "X-Request-Id": "7" })
            ),
            json!({ "Accept": "application/json", "X-Request-Id": "7" })
        );
        assert_eq!(text(&format!("token {JWT} ok"), 100), "token [redacted] ok");
        assert_eq!(text(&"x".repeat(5000), 2000).chars().count(), 2001);
        assert!(secret_field("#password") && secret_field("internal:label=\"One-time code\"i"));
        assert!(!secret_field("#email"));
    }
}
