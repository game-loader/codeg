//! Deterministic identifier resolution and evidence gates around untrusted agent output.
use super::types::ArxivCandidate;
use regex::Regex;
use std::time::Duration;

pub fn arxiv_id(value: &str) -> Option<String> {
    let value = value.trim();
    let candidate = if value.starts_with("https://") || value.starts_with("http://") {
        let url = url::Url::parse(value).ok()?;
        if !matches!(
            url.host_str(),
            Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")
        ) || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        url.path()
            .strip_prefix("/abs/")
            .or_else(|| url.path().strip_prefix("/pdf/"))?
            .trim_end_matches(".pdf")
            .to_string()
    } else {
        value
            .strip_prefix("arXiv:")
            .or_else(|| value.strip_prefix("arxiv:"))
            .unwrap_or(value)
            .trim()
            .to_string()
    };
    let re = Regex::new(r"(?i)^(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]+/\d{7})(?:v[1-9]\d*)?$").ok()?;
    re.is_match(&candidate).then_some(candidate)
}

pub fn metadata_arxiv(url: Option<&str>, doi: Option<&str>, extra: &str) -> Option<String> {
    url.and_then(arxiv_id)
        .or_else(|| doi.and_then(|doi| doi.strip_prefix("10.48550/arXiv.").and_then(arxiv_id)))
        .or_else(|| {
            extra.lines().find_map(|line| {
                let (label, value) = line.split_once(':')?;
                matches!(
                    label.trim().to_ascii_lowercase().as_str(),
                    "arxiv" | "arxiv id" | "arxivid"
                )
                .then(|| arxiv_id(value))
                .flatten()
            })
        })
}

pub fn repository_url(raw: &str) -> Result<String, String> {
    // Reject encoded path tricks before URL normalization can erase them.
    if raw.contains('%') || raw.contains('\\') || raw.split('/').any(|p| matches!(p, "." | "..")) {
        return Err("Repository URL contains invalid path segments".into());
    }
    let url = url::Url::parse(raw).map_err(|_| "Invalid repository URL")?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("github.com" | "gitlab.com" | "bitbucket.org")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Only public HTTPS GitHub, GitLab or Bitbucket repository URLs are supported".into(),
        );
    }
    let path = url.path().trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || p.starts_with('.')
                || p.starts_with('-')
                || !p
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        })
    {
        return Err("Expected a repository URL with owner and repository name".into());
    }
    Ok(format!(
        "https://{}{path}",
        url.host_str().unwrap_or_default()
    ))
}

fn normalized(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn verify_evidence(repo: &str, quote: &str, corpus: &str) -> Result<String, String> {
    let canonical = repository_url(repo)?;
    let quote = normalized(quote);
    if quote.len() < 20 || quote.len() > 3000 || !normalized(corpus).contains(&quote) {
        return Err("The claimed code evidence is not an exact quote from this paper".into());
    }
    let lower = quote.to_ascii_lowercase();
    if ![
        "our code",
        "code is available",
        "code available",
        "source code is available",
        "official implementation",
        "implementation is available",
        "implementation available",
        "our implementation",
    ]
    .iter()
    .any(|p| lower.contains(p))
    {
        return Err("The paper does not explicitly identify this link as its code".into());
    }
    let re =
        Regex::new(r#"https://(?:github\.com|gitlab\.com|bitbucket\.org)/[^\s<>\[\](){}\"']+"#)
            .map_err(|e| e.to_string())?;
    if !re.find_iter(&quote).any(|m| {
        repository_url(m.as_str().trim_end_matches(['.', ',', ';', ':']))
            .ok()
            .as_deref()
            == Some(canonical.as_str())
    }) {
        return Err("Evidence does not contain the proposed repository URL".into());
    }
    Ok(canonical)
}

/// Metadata identifiers are authoritative; title/author search always requires a user choice.
pub fn resolve_candidate(known_id: Option<&str>, candidates: &[ArxivCandidate]) -> Option<String> {
    let known = known_id?;
    let unversioned = |id: &str| {
        regex::Regex::new(r"v[0-9]+$")
            .expect("literal regex")
            .replace(id, "")
            .into_owned()
    };
    candidates
        .iter()
        .find(|c| unversioned(&c.id) == unversioned(known))
        .map(|c| c.id.clone())
}

pub async fn arxiv_candidates(
    title: &str,
    authors: &[String],
    id: Option<&str>,
) -> Result<Vec<ArxivCandidate>, String> {
    // arXiv asks clients to issue at most one request every three seconds.
    static REQUEST_GATE: std::sync::OnceLock<tokio::sync::Mutex<Option<tokio::time::Instant>>> =
        std::sync::OnceLock::new();
    let mut last_start = REQUEST_GATE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    if let Some(last) = *last_start {
        tokio::time::sleep_until(last + Duration::from_secs(3)).await;
    }
    *last_start = Some(tokio::time::Instant::now());
    let mut url =
        url::Url::parse("https://export.arxiv.org/api/query").map_err(|e| e.to_string())?;
    if let Some(id) = id {
        url.query_pairs_mut().append_pair("id_list", id);
    } else {
        let words = title
            .split_whitespace()
            .take(18)
            .collect::<Vec<_>>()
            .join(" ")
            .replace(['"', ':', '(', ')'], " ");
        let mut query = format!("ti:\"{words}\"");
        if let Some(author) = authors
            .first()
            .and_then(|name| name.split_whitespace().last())
        {
            let author: String = author
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '-')
                .collect();
            if !author.is_empty() {
                query.push_str(&format!(" AND au:\"{author}\""));
            }
        }
        url.query_pairs_mut().append_pair("search_query", &query);
    }
    url.query_pairs_mut().append_pair("max_results", "8");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(35))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Codeg academic workbench")
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("arXiv response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_arxiv_feed(std::str::from_utf8(&bytes).map_err(|e| e.to_string())?)
}

pub fn parse_arxiv_feed(xml: &str) -> Result<Vec<ArxivCandidate>, String> {
    let doc =
        roxmltree::Document::parse(xml).map_err(|e| format!("Invalid arXiv response: {e}"))?;
    let mut results = Vec::new();
    for entry in doc.descendants().filter(|n| n.has_tag_name("entry")) {
        let field = |name| {
            entry
                .children()
                .find(|n| n.has_tag_name(name))
                .and_then(|n| n.text())
                .unwrap_or_default()
        };
        let Some(id) = arxiv_id(field("id")) else {
            continue;
        };
        results.push(ArxivCandidate {
            pdf_url: format!("https://arxiv.org/pdf/{id}"),
            id,
            title: normalized(field("title")),
            summary: normalized(field("summary")),
            authors: entry
                .children()
                .filter(|n| n.has_tag_name("author"))
                .filter_map(|n| {
                    n.children()
                        .find(|c| c.has_tag_name("name"))
                        .and_then(|n| n.text())
                        .map(str::to_string)
                })
                .collect(),
        });
    }
    Ok(results)
}

/// Only a paper's explicitly declared project page can supply secondary code evidence.
pub fn verify_project_page(url: &str, quote: &str, paper: &str) -> Result<url::Url, String> {
    let parsed = public_https_url(url)?;
    let quote = normalized(quote);
    let lower = quote.to_ascii_lowercase();
    if quote.len() > 3000
        || !normalized(paper).contains(&quote)
        || !quote.contains(url)
        || ![
            "project page",
            "project webpage",
            "project website",
            "project site",
            "project:",
            "project at",
            "our website",
        ]
        .iter()
        .any(|p| lower.contains(p))
    {
        return Err("Project page is not explicitly declared by this paper".into());
    }
    Ok(parsed)
}

fn public_https_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "Invalid project-page URL")?;
    if raw.len() > 2048
        || parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.host_str().is_none()
    {
        return Err(
            "Project pages must be public HTTPS URLs without credentials or custom ports".into(),
        );
    }
    Ok(parsed)
}

pub fn public_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    !ip.is_private()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_unspecified()
        && !ip.is_multicast()
        && !ip.is_broadcast()
        && !ip.is_documentation()
        && octets[0] != 0
        && octets[0] < 224
        && !(octets[0] == 100 && (64..=127).contains(&octets[1]))
        && !(octets[0] == 198 && matches!(octets[1], 18 | 19))
}

/// Resolve and pin public addresses for every fetch. Redirects never widen the approved URL.
pub async fn fetch_project_page(raw: &str) -> Result<String, String> {
    let url = public_https_url(raw)?;
    let host = url.host_str().ok_or("Project page has no hostname")?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|e| e.to_string())?
        .collect();
    if addresses.iter().any(|a| match a.ip() {
        std::net::IpAddr::V4(ip) => !public_ipv4(ip),
        std::net::IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }) {
        return Err("Project page resolved to a non-public address".into());
    }
    let addresses: Vec<_> = addresses
        .into_iter()
        .filter(|a| matches!(a.ip(), std::net::IpAddr::V4(ip) if public_ipv4(ip)))
        .collect();
    if addresses.is_empty() {
        return Err("Project page must resolve to a public IPv4 address".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(
            "Project page redirects are not accepted; use the URL declared in the paper".into(),
        );
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with("text/html") && !content_type.starts_with("text/plain") {
        return Err("Project page is not HTML or plain text".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Project page exceeded 2 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let html = String::from_utf8_lossy(&bytes);
    // Keep link targets in the evidence corpus while stripping active content.
    let inactive = Regex::new(r"(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)>")
        .map_err(|e| e.to_string())?
        .replace_all(&html, " ")
        .into_owned();
    let links = Regex::new(r#"(?is)<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .map_err(|e| e.to_string())?
        .replace_all(&inactive, "$2 $1")
        .into_owned();
    let text = Regex::new(r"(?s)<[^>]+>")
        .map_err(|e| e.to_string())?
        .replace_all(&links, " ")
        .replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"");
    Ok(normalized(&text))
}

pub fn verify_project_repository(repo: &str, quote: &str, corpus: &str) -> Result<String, String> {
    let canonical = repository_url(repo)?;
    let quote = normalized(quote);
    if quote.len() < 10
        || quote.len() > 3000
        || !normalized(corpus).contains(&quote)
        || !quote.contains(&canonical)
        || !["code", "implementation"]
            .iter()
            .any(|word| quote.to_ascii_lowercase().contains(word))
    {
        return Err("Repository evidence is absent from the verified official project page".into());
    }
    Ok(canonical)
}
