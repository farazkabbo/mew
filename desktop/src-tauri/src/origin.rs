//! Which web app the window shows, and where it may navigate.

use tauri::Url;

/// Used when MEW_APP_URL isn't set (at run time or at build time): the local dev server.
pub const DEFAULT_APP_URL: &str = "http://localhost:3000";

/// The Mew web app to open: MEW_APP_URL at run time, else at build time, else the dev server.
/// Only https, or plain http on this machine, is accepted.
pub fn app_url(runtime: Option<String>) -> Url {
    runtime
        .or_else(|| option_env!("MEW_APP_URL").map(str::to_owned))
        .and_then(|raw| Url::parse(raw.trim()).ok())
        .filter(is_allowed_app_url)
        .unwrap_or_else(|| Url::parse(DEFAULT_APP_URL).expect("default URL is valid"))
}

fn is_allowed_app_url(url: &Url) -> bool {
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => is_loopback(url),
        _ => false,
    }
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// The window may show the app itself and Clerk's sign-in pages (for sign-in redirects);
/// anything else is refused rather than opened inside the app.
pub fn may_navigate(app: &Url, target: &Url) -> bool {
    if target.origin() == app.origin() {
        return true;
    }
    if target.scheme() != "https" {
        return false;
    }
    let host = target.host_str().unwrap_or("");
    host.ends_with(".clerk.accounts.dev") || host == "clerk.com" || host.ends_with(".clerk.com")
}

/// The URL pattern for the capability that lets the app's pages call `notify_due`.
pub fn capability_pattern(app: &Url) -> String {
    format!("{}/*", app.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn uses_the_dev_server_unless_a_safe_url_is_given() {
        assert_eq!(app_url(None).as_str(), "http://localhost:3000/");
        assert_eq!(
            app_url(Some("https://mew.example.com".into())).as_str(),
            "https://mew.example.com/"
        );
        // Plain http only on this machine; other schemes never.
        assert_eq!(
            app_url(Some("http://evil.example".into())).as_str(),
            "http://localhost:3000/"
        );
        assert_eq!(
            app_url(Some("file:///C:/x.html".into())).as_str(),
            "http://localhost:3000/"
        );
        assert_eq!(
            app_url(Some("not a url".into())).as_str(),
            "http://localhost:3000/"
        );
    }

    #[test]
    fn stays_on_the_app_and_clerk() {
        let app = url("http://localhost:3000/");
        assert!(may_navigate(
            &app,
            &url("http://localhost:3000/notebook?course=x")
        ));
        assert!(may_navigate(
            &app,
            &url("https://still-mosquito-3338.clerk.accounts.dev/sign-in")
        ));
        assert!(!may_navigate(&app, &url("http://localhost:3001/")));
        assert!(!may_navigate(&app, &url("https://evil.example/")));
        assert!(!may_navigate(&app, &url("http://x.clerk.accounts.dev/")));
        assert!(!may_navigate(
            &app,
            &url("https://clerk.accounts.dev.evil.example/")
        ));
    }

    #[test]
    fn grants_the_capability_to_the_app_origin_only() {
        assert_eq!(
            capability_pattern(&url("https://mew.example.com/notebook")),
            "https://mew.example.com/*"
        );
    }
}
