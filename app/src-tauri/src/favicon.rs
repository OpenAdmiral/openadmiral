//! A project's logo from a website: the page's own icon (the largest it declares, the
//! apple-touch-icon first), else `/favicon.ico`, returned as a data URL the sidebar keeps.
//! curl ships with macOS, so no HTTP client in the app.

use std::process::Command;

/// Icons bigger than this are not a logo.
const MAX_BYTES: usize = 512 * 1024;

fn get(url: &str) -> Option<(Vec<u8>, String, String)> {
    // -w prints the final URL (after redirects) and the content type after the body.
    let out = Command::new("curl")
        .args(["-sL", "-m", "8", "--max-filesize", &MAX_BYTES.to_string(), "-A", "Mozilla/5.0 OpenAdmiral", "-w", "\n%{url_effective}\n%{content_type}\n%{http_code}", url])
        .output()
        .ok()?;
    let mut body = out.stdout;
    let mut tail = Vec::new();
    for _ in 0..3 {
        let cut = body.iter().rposition(|&b| b == b'\n')?;
        tail.push(String::from_utf8_lossy(&body[cut + 1..]).trim().to_string());
        body.truncate(cut);
    }
    let (code, ctype, final_url) = (tail[0].clone(), tail[1].clone(), tail[2].clone());
    if !code.starts_with('2') || body.is_empty() {
        return None;
    }
    Some((body, ctype, final_url))
}

/// "applivery.com" → "https://applivery.com".
pub fn normalize(url: &str) -> String {
    let u = url.trim();
    if u.contains("://") { u.to_string() } else { format!("https://{u}") }
}

/// `href` resolved against `base` (the page's final URL).
fn resolve(base: &str, href: &str) -> String {
    if href.contains("://") || href.starts_with("data:") {
        return href.to_string();
    }
    let scheme_end = base.find("://").map(|i| i + 3).unwrap_or(0);
    let origin_end = base[scheme_end..].find('/').map(|i| scheme_end + i).unwrap_or(base.len());
    if let Some(rest) = href.strip_prefix("//") {
        return format!("{}{rest}", &base[..scheme_end]);
    }
    if href.starts_with('/') {
        return format!("{}{href}", &base[..origin_end]);
    }
    let dir_end = base.rfind('/').filter(|&i| i >= origin_end).map(|i| i + 1).unwrap_or(base.len());
    let dir = &base[..dir_end];
    if dir.ends_with('/') { format!("{dir}{href}") } else { format!("{dir}/{href}") }
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name).map(|i| from + i) {
        from = i + name.len();
        let before_ok = i == 0 || lower.as_bytes()[i - 1].is_ascii_whitespace();
        let rest = lower[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let start = tag.len() - rest.len() + 1;
        let v = tag[start..].trim_start();
        let (q, body) = match v.chars().next()? {
            c @ ('"' | '\'') => (Some(c), &v[1..]),
            _ => (None, v),
        };
        let end = match q {
            Some(q) => body.find(q)?,
            None => body.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(body.len()),
        };
        return Some(body[..end].to_string());
    }
    None
}

/// The icons a page declares, best first: apple-touch-icon, then the largest `sizes`, SVG last
/// (a WebKit `<img>` shows it, but a mask icon or a huge SVG is often not the logo).
pub fn icons(html: &str) -> Vec<String> {
    let mut found: Vec<(i32, String)> = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<link").map(|i| at + i) {
        let end = lower[i..].find('>').map(|e| i + e).unwrap_or(lower.len());
        let tag = &html[i..end];
        at = end;
        let rel = attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        let Some(href) = attr(tag, "href") else { continue };
        if rel.contains("mask-icon") || !rel.split_whitespace().any(|r| r == "icon" || r == "apple-touch-icon" || r == "apple-touch-icon-precomposed") {
            continue;
        }
        let size = attr(tag, "sizes").and_then(|s| s.split(['x', 'X']).next().and_then(|n| n.trim().parse::<i32>().ok())).unwrap_or(16);
        let score = if rel.contains("apple-touch-icon") { 1000 + size } else if href.ends_with(".svg") { 100 } else { size };
        found.push((score, href));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, h)| h).collect()
}

fn mime(bytes: &[u8], ctype: &str, url: &str) -> Option<&'static str> {
    let t = ctype.to_ascii_lowercase();
    if bytes.is_empty() { return None }
    if bytes.starts_with(b"\x89PNG") { return Some("image/png") }
    if bytes.starts_with(&[0xff, 0xd8]) { return Some("image/jpeg") }
    if bytes.starts_with(b"GIF8") { return Some("image/gif") }
    if bytes.starts_with(&[0, 0, 1, 0]) { return Some("image/x-icon") }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return Some("image/webp") }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
    if t.contains("svg") || url.ends_with(".svg") || head.contains("<svg") { return Some("image/svg+xml") }
    None
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The site's icon as a data URL, or why not.
#[tauri::command]
pub async fn fetch_favicon(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || find(&normalize(&url))).await.map_err(|e| e.to_string())?
}

fn find(url: &str) -> Result<String, String> {
    // The page may not open (a slow or guarded site): /favicon.ico is still worth a try.
    let (page, ctype, final_url) = get(url).unwrap_or_else(|| (Vec::new(), String::new(), url.to_string()));
    // A direct link to an image is the logo itself.
    if let Some(m) = mime(&page, &ctype, &final_url) {
        return Ok(format!("data:{m};base64,{}", base64(&page)));
    }
    let html = String::from_utf8_lossy(&page);
    let mut tries: Vec<String> = icons(&html).into_iter().map(|h| resolve(&final_url, &h)).collect();
    tries.push(resolve(&final_url, "/favicon.ico"));
    for t in tries {
        if let Some(rest) = t.strip_prefix("data:") {
            return Ok(format!("data:{rest}"));
        }
        if let Some((bytes, ctype, u)) = get(&t) {
            if let Some(m) = mime(&bytes, &ctype, &u) {
                return Ok(format!("data:{m};base64,{}", base64(&bytes)));
            }
        }
    }
    Err(format!("No icon found at {url}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_best_icon_a_page_declares() {
        let html = r#"<head><link rel="icon" href="/fav-32.png" sizes="32x32"><link rel='mask-icon' href='/m.svg'>
            <LINK REL="apple-touch-icon" HREF="/apple.png"><link rel="shortcut icon" href=fav.ico></head>"#;
        assert_eq!(icons(html), vec!["/apple.png", "/fav-32.png", "fav.ico"]);
    }

    #[test]
    fn resolves_links_against_the_page() {
        assert_eq!(resolve("https://a.com/docs/x.html", "/i.png"), "https://a.com/i.png");
        assert_eq!(resolve("https://a.com/docs/x.html", "i.png"), "https://a.com/docs/i.png");
        assert_eq!(resolve("https://a.com", "i.png"), "https://a.com/i.png");
        assert_eq!(resolve("https://a.com/", "//cdn.b.com/i.png"), "https://cdn.b.com/i.png");
        assert_eq!(normalize(" applivery.com "), "https://applivery.com");
    }

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }
}

#[cfg(test)]
mod live {
    /// `cargo test favicon::live -- --ignored --nocapture`: fetches real sites.
    #[test]
    #[ignore]
    fn real_sites() {
        for u in ["applivery.com", "github.com", "anthropic.com"] {
            let r = super::find(&super::normalize(u));
            println!("{u}: {}", r.as_ref().map(|d| d[..40.min(d.len())].to_string()).unwrap_or_else(|e| e.clone()));
            assert!(r.is_ok());
        }
    }
}
