use codex_protocol::protocol::SessionName;
use thiserror::Error;

/// Errors that can occur while normalizing a session name.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SessionNameError {
    #[error("session name cannot be empty")]
    Empty,
}

/// Normalize a session title into a [`SessionName`].
///
/// Returns an error when the provided title is empty after trimming.
pub fn make_session_name(title: &str) -> Result<SessionName, SessionNameError> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(SessionNameError::Empty);
    }
    let slug = slugify(trimmed);
    Ok(SessionName {
        title: trimmed.to_string(),
        slug,
    })
}

/// Normalize a session title into an optional [`SessionName`].
///
/// Returns `None` when the provided title is empty after trimming.
pub fn normalize_session_name(title: &str) -> Option<SessionName> {
    make_session_name(title).ok()
}

fn slugify(title: &str) -> String {
    const MAX_SLUG_LEN: usize = 64;

    let mut slug = String::with_capacity(title.len().min(MAX_SLUG_LEN));
    let mut last_was_dash = true;

    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if ch.is_ascii_whitespace() || matches!(ch, '-' | '_' | '.' | '/') {
            if !last_was_dash && !slug.is_empty() {
                slug.push('-');
                last_was_dash = true;
            }
        } else {
            // Treat any other character as a separator, but avoid
            // repeated hyphens.
            if !last_was_dash && !slug.is_empty() {
                slug.push('-');
                last_was_dash = true;
            }
        }
        if slug.len() >= MAX_SLUG_LEN {
            break;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        slug.push_str("session");
    }

    slug
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        let name = make_session_name("Testing Edge Functions").unwrap();
        assert_eq!(name.title, "Testing Edge Functions");
        assert_eq!(name.slug, "testing-edge-functions");
    }

    #[test]
    fn slugify_trims_and_collapses() {
        let name = make_session_name("  Hello   World  ").unwrap();
        assert_eq!(name.slug, "hello-world");
    }

    #[test]
    fn slugify_drops_symbols() {
        let name = make_session_name("!!!").unwrap();
        assert_eq!(name.slug, "session");
    }

    #[test]
    fn empty_is_error() {
        assert_eq!(make_session_name("   "), Err(SessionNameError::Empty));
    }
}
