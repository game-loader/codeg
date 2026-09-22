//! Minimal early-exit SSH password helper, using the same installed executable.
use std::io::Write;

pub(crate) const MODE_ENV: &str = "CODEG_SSH_ASKPASS_MODE";
pub(crate) const PASSWORD_ENV: &str = "CODEG_SSH_ASKPASS_PASSWORD";
pub(crate) const MODE: &str = "password-v1";

/// Called before either runtime or logging starts. OpenSSH passes its prompt as
/// the helper's sole argument; the private marker distinguishes this invocation
/// from a normal application launch. Never print diagnostics or other prompts.
pub fn run_if_requested() -> Option<u8> {
    let marker = std::env::var_os(MODE_ENV)?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let confirm = std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    if marker != MODE || args.len() != 1 || !accepts_prompt(&args[0], &confirm) {
        return Some(1);
    }
    let Ok(password) = std::env::var(PASSWORD_ENV) else {
        return Some(1);
    };
    if password.is_empty() || password.len() > 4096 || password.contains(['\0', '\r', '\n']) {
        return Some(1);
    }
    let mut stdout = std::io::stdout().lock();
    Some(
        if writeln!(stdout, "{password}")
            .and_then(|_| stdout.flush())
            .is_ok()
        {
            0
        } else {
            1
        },
    )
}

fn accepts_prompt(prompt: &str, request: &str) -> bool {
    request.is_empty() && prompt.to_ascii_lowercase().contains("password")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_password_prompts_receive_credentials() {
        assert!(accepts_prompt("root@203.0.113.8's password: ", ""));
        assert!(accepts_prompt("Password: ", ""));
        assert!(!accepts_prompt(
            "Enter passphrase for key '/path/key': ",
            ""
        ));
        assert!(!accepts_prompt(
            "Are you sure you want to continue connecting?",
            "confirm"
        ));
        assert!(!accepts_prompt("password", "confirm"));
        assert!(!accepts_prompt("Verification code: ", ""));
    }
}
