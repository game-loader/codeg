//! Explicit manual SSH connections. Each hop has independent authentication;
//! temporary identities live until the probe future completes or is cancelled.
use std::io::Write;
use std::path::Path;

use tempfile::{NamedTempFile, TempDir};
use tokio::process::Command;

use super::manual::{Credential, Credentials};
use super::{Machine, SSH_CONNECT_TIMEOUT};
use crate::{app_error::AppCommandError, ssh_askpass};

pub(super) struct PreparedProbe {
    pub command: Command,
    pub _identities: TempDir,
}

fn helper_path() -> Result<std::path::PathBuf, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        std::env::current_exe().map_err(AppCommandError::io)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Ok(crate::update::runtime::self_exe())
    }
}

fn arguments(
    host: &str,
    port: u16,
    user: &str,
    credential: &Credential,
    directory: &Path,
) -> Result<Vec<String>, AppCommandError> {
    super::validate_ssh_host(host)?;
    super::validate_ssh_user(user)?;
    let mut args: Vec<String> = ["-F", "none", "-T", "-p", &port.to_string(), "-l", user]
        .into_iter()
        .map(String::from)
        .collect();
    for option in [
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT}"),
        "ConnectionAttempts=1".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "SendEnv=-*".into(),
        "BatchMode=no".into(),
        "NumberOfPasswordPrompts=1".into(),
        "ForwardAgent=no".into(),
        "ClearAllForwardings=yes".into(),
        "ControlMaster=no".into(),
        "ControlPath=none".into(),
    ] {
        args.extend(["-o".into(), option]);
    }
    let options = match credential {
        Credential::Password { .. } => [
            "PreferredAuthentications=password,keyboard-interactive",
            "PasswordAuthentication=yes",
            "KbdInteractiveAuthentication=yes",
            "PubkeyAuthentication=no",
        ],
        Credential::PrivateKey { private_key, .. } => {
            let mut file = NamedTempFile::new_in(directory).map_err(AppCommandError::io)?;
            // NamedTempFile creates 0600 files on Unix inside a private directory.
            writeln!(file, "{}", private_key.trim().replace("\r\n", "\n"))
                .map_err(AppCommandError::io)?;
            let (_, path) = file
                .keep()
                .map_err(|_| AppCommandError::io_error("Could not prepare SSH identity"))?;
            args.extend(["-i".into(), path.to_string_lossy().to_string()]);
            args.extend([
                "-o".into(),
                "IdentitiesOnly=yes".into(),
                "-o".into(),
                "IdentityAgent=none".into(),
            ]);
            [
                "PreferredAuthentications=publickey",
                "PasswordAuthentication=no",
                "KbdInteractiveAuthentication=no",
                "PubkeyAuthentication=yes",
            ]
        }
    };
    for option in options {
        args.extend(["-o".into(), option.into()]);
    }
    Ok(args)
}

fn auth_environment(credential: &Credential) -> (&'static str, &str) {
    match credential {
        Credential::Password { password } => (ssh_askpass::MODE, password),
        Credential::PrivateKey { passphrase, .. } => (ssh_askpass::KEY_MODE, passphrase),
    }
}

// Only the installed executable is shell-evaluated; host/user/port and private
// identity paths are passed to the jump helper as a JSON argv array.
fn proxy_command(helper: &Path) -> Result<String, AppCommandError> {
    let path = helper
        .to_str()
        .ok_or_else(|| AppCommandError::io_error("SSH helper path is not UTF-8"))?;
    if path.contains(['\0', '\n', '\r']) {
        return Err(AppCommandError::io_error("Invalid SSH helper path"));
    }
    let path = path.replace('%', "%%"); // OpenSSH expands ProxyCommand tokens.
    #[cfg(not(windows))]
    let quoted = format!("'{}'", path.replace('\'', "'\\''"));
    #[cfg(windows)]
    let quoted = format!("\"{}\"", path.replace('"', "\\\""));
    Ok(format!("ProxyCommand={quoted} --codeg-ssh-jump"))
}

pub(super) fn prepare(
    machine: &Machine,
    credentials: &Credentials,
) -> Result<PreparedProbe, AppCommandError> {
    let directory = tempfile::Builder::new()
        .prefix("codeg-ssh-")
        .tempdir()
        .map_err(AppCommandError::io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .map_err(AppCommandError::io)?;
    }
    let host = super::ssh_target(machine)?;
    let user = machine
        .ssh_user
        .as_deref()
        .ok_or_else(|| AppCommandError::invalid_input("SSH username is missing"))?;
    let helper = helper_path()?;
    let mut command = Command::new("ssh");
    command.args(arguments(
        &host,
        machine.ssh_port,
        user,
        &credentials.target,
        directory.path(),
    )?);
    let (mode, secret) = auth_environment(&credentials.target);
    command
        .env("SSH_ASKPASS", &helper)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("DISPLAY", "codeg:0")
        .env("LC_ALL", "C")
        .env(ssh_askpass::MODE_ENV, mode)
        .env(ssh_askpass::PASSWORD_ENV, secret)
        .env_remove("SSH_ASKPASS_PROMPT")
        .env_remove(ssh_askpass::JUMP_ARGS_ENV)
        .env_remove(ssh_askpass::JUMP_MODE_ENV)
        .env_remove(ssh_askpass::JUMP_SECRET_ENV);
    if let Some(jump) = &machine.jump_host {
        let credential = credentials.jump.as_ref().ok_or_else(|| {
            AppCommandError::invalid_input("Jump host credentials are missing; edit the machine")
        })?;
        let mut args = arguments(
            &jump.host,
            jump.port,
            &jump.username,
            credential,
            directory.path(),
        )?;
        let destination = if host.contains(':') {
            format!("[{host}]:{}", machine.ssh_port)
        } else {
            format!("{host}:{}", machine.ssh_port)
        };
        args.extend(["-W".into(), destination, jump.host.clone()]);
        let (mode, secret) = auth_environment(credential);
        command
            .args(["-o", &proxy_command(&helper)?])
            .env(
                ssh_askpass::JUMP_ARGS_ENV,
                serde_json::to_string(&args)
                    .map_err(|_| AppCommandError::io_error("Could not prepare jump host"))?,
            )
            .env(ssh_askpass::JUMP_MODE_ENV, mode)
            .env(ssh_askpass::JUMP_SECRET_ENV, secret);
    }
    command.args([&host, "sh", "-s"]);
    Ok(PreparedProbe {
        command,
        _identities: directory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::machines::{AuthMethod, JumpHost};

    fn machine() -> Machine {
        Machine {
            id: "manual:test".into(),
            name: "test".into(),
            dns_name: String::new(),
            addresses: vec!["2001:db8::8".into()],
            os: String::new(),
            online: None,
            last_seen: None,
            is_self: false,
            source: "manual".into(),
            ssh_port: 2200,
            ssh_user: Some("alice".into()),
            auth_method: Some(AuthMethod::PrivateKey),
            jump_host: Some(JumpHost {
                host: "bastion.example.com".into(),
                port: 2222,
                username: "bob".into(),
                auth_method: AuthMethod::Password,
            }),
        }
    }

    #[test]
    fn identities_are_private_and_temporary_and_hop_secrets_are_separate() {
        let key =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key\n-----END OPENSSH PRIVATE KEY-----";
        let prepared = prepare(
            &machine(),
            &Credentials {
                target: Credential::PrivateKey {
                    private_key: key.into(),
                    passphrase: "target-passphrase".into(),
                },
                jump: Some(Credential::Password {
                    password: "jump-password".into(),
                }),
            },
        )
        .unwrap();
        let directory = prepared._identities.path().to_path_buf();
        let args: Vec<_> = prepared
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"IdentityAgent=none".to_string()));
        assert!(args.contains(&"IdentitiesOnly=yes".to_string()));
        assert!(!args.join(" ").contains("passphrase"));
        assert!(!args.join(" ").contains("jump-password"));
        let identity = &args[args.iter().position(|a| a == "-i").unwrap() + 1];
        assert_eq!(
            std::fs::read_to_string(identity).unwrap(),
            format!("{key}\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(identity).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        use std::ffi::OsStr;
        let env: std::collections::HashMap<_, _> = prepared.command.as_std().get_envs().collect();
        assert_eq!(
            env[OsStr::new(ssh_askpass::PASSWORD_ENV)],
            Some(OsStr::new("target-passphrase"))
        );
        assert_eq!(
            env[OsStr::new(ssh_askpass::JUMP_SECRET_ENV)],
            Some(OsStr::new("jump-password"))
        );
        let jump: Vec<String> = serde_json::from_str(
            env[OsStr::new(ssh_askpass::JUMP_ARGS_ENV)]
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert!(jump.windows(2).any(|p| p == ["-W", "[2001:db8::8]:2200"]));
        assert!(jump.windows(2).any(|p| p == ["-p", "2222"]));
        assert!(jump.contains(&"PubkeyAuthentication=no".into()));
        assert!(!jump.join(" ").contains("jump-password"));
        drop(prepared);
        assert!(!directory.exists());
    }

    #[cfg(unix)]
    #[test]
    fn proxy_executable_quotes_shell_metacharacters_and_ssh_tokens() {
        assert_eq!(
            proxy_command(Path::new("/tmp/a'b %h $(touch bad)/codeg")).unwrap(),
            "ProxyCommand='/tmp/a'\\''b %%h $(touch bad)/codeg' --codeg-ssh-jump"
        );
    }
}
