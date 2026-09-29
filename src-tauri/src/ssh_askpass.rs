//! Early-exit SSH askpass and jump helpers, using the installed executable.
use std::io::Write;

pub(crate) const MODE_ENV: &str = "CODEG_SSH_ASKPASS_MODE";
pub(crate) const PASSWORD_ENV: &str = "CODEG_SSH_ASKPASS_PASSWORD";
pub(crate) const MODE: &str = "password-v1";
pub(crate) const KEY_MODE: &str = "key-v1";
pub(crate) const JUMP_ARGS_ENV: &str = "CODEG_SSH_JUMP_ARGS";
pub(crate) const JUMP_MODE_ENV: &str = "CODEG_SSH_JUMP_MODE";
pub(crate) const JUMP_SECRET_ENV: &str = "CODEG_SSH_JUMP_SECRET";

/// Called before either runtime or logging starts. OpenSSH passes its prompt as
/// the helper's sole argument; the private marker distinguishes this invocation
/// from a normal application launch. Never print diagnostics or other prompts.
pub fn run_if_requested() -> Option<u8> {
    let marker = std::env::var_os(MODE_ENV)?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--codeg-ssh-jump"] && (marker == MODE || marker == KEY_MODE) {
        return Some(run_jump());
    }
    let confirm = std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    if args.len() != 1 || !accepts_prompt(&args[0], &confirm, &marker.to_string_lossy()) {
        return Some(1);
    }
    let Ok(password) = std::env::var(PASSWORD_ENV) else {
        return Some(1);
    };
    if password.len() > 4096 || password.contains(['\0', '\r', '\n']) {
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

fn accepts_prompt(prompt: &str, request: &str, mode: &str) -> bool {
    if !request.is_empty() {
        return false;
    }
    let prompt = prompt.to_ascii_lowercase();
    match mode {
        MODE => prompt.contains("password") && !prompt.contains("passphrase"),
        KEY_MODE => prompt.starts_with("enter passphrase for key "),
        _ => false,
    }
}

fn jump_command(args: Vec<String>, mode: &str, secret: &str) -> std::process::Command {
    let mut command = std::process::Command::new("ssh");
    command
        .args(args)
        .env(MODE_ENV, mode)
        .env(PASSWORD_ENV, secret)
        .env_remove(JUMP_ARGS_ENV)
        .env_remove(JUMP_MODE_ENV)
        .env_remove(JUMP_SECRET_ENV)
        .env_remove("SSH_ASKPASS_PROMPT");
    command
}

fn run_jump() -> u8 {
    let Ok(raw) = std::env::var(JUMP_ARGS_ENV) else {
        return 1;
    };
    let Ok(args) = serde_json::from_str::<Vec<String>>(&raw) else {
        return 1;
    };
    let Ok(mode) = std::env::var(JUMP_MODE_ENV) else {
        return 1;
    };
    let Ok(secret) = std::env::var(JUMP_SECRET_ENV) else {
        return 1;
    };
    if ![MODE, KEY_MODE].contains(&mode.as_str()) {
        return 1;
    }
    let mut command = jump_command(args, &mode, &secret);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Replace the helper, preserving the parent's process group and pipes.
        let _ = command.exec();
        1
    }
    #[cfg(not(unix))]
    {
        command
            .status()
            .ok()
            .and_then(|s| s.code())
            .and_then(|c| u8::try_from(c).ok())
            .unwrap_or(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_password_prompts_receive_credentials() {
        assert!(accepts_prompt("root@203.0.113.8's password: ", "", MODE));
        assert!(accepts_prompt("Password: ", "", MODE));
        assert!(!accepts_prompt(
            "Enter passphrase for key '/path/key': ",
            "",
            MODE
        ));
        assert!(!accepts_prompt(
            "Are you sure you want to continue connecting?",
            "confirm",
            MODE
        ));
        assert!(!accepts_prompt("password", "confirm", MODE));
        assert!(!accepts_prompt("Verification code: ", "", MODE));
    }
    #[test]
    fn passphrase_and_password_helpers_do_not_answer_each_others_prompts() {
        assert!(accepts_prompt(
            "Enter passphrase for key '/tmp/key': ",
            "",
            KEY_MODE
        ));
        assert!(!accepts_prompt("Password:", "", KEY_MODE));
        assert!(!accepts_prompt(
            "Enter passphrase for key '/tmp/password': ",
            "",
            MODE
        ));
        assert!(!accepts_prompt(
            "Enter passphrase for key '/tmp/key': ",
            "confirm",
            KEY_MODE
        ));
    }

    #[test]
    fn jump_process_overrides_target_secret_and_removes_jump_envelope() {
        let command = jump_command(
            vec!["-W".into(), "target:22".into()],
            KEY_MODE,
            "jump-passphrase",
        );
        let env: std::collections::HashMap<_, _> = command.get_envs().collect();
        use std::ffi::OsStr;
        assert_eq!(
            env[OsStr::new(PASSWORD_ENV)],
            Some(OsStr::new("jump-passphrase"))
        );
        assert_eq!(env[OsStr::new(MODE_ENV)], Some(OsStr::new(KEY_MODE)));
        for name in [JUMP_ARGS_ENV, JUMP_MODE_ENV, JUMP_SECRET_ENV] {
            assert_eq!(env[OsStr::new(name)], None);
        }
        assert!(!command.get_args().any(|arg| arg == "jump-passphrase"));
    }
}
