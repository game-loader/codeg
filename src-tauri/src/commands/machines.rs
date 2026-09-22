use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Semaphore;

use crate::app_error::AppCommandError;

const MAX_DISCOVERY_OUTPUT: usize = 256 * 1024;
const MAX_PROBE_OUTPUT: usize = 64 * 1024;
const MAX_METRIC_VALUE: usize = 4096;
const PROCESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const SSH_CONNECT_TIMEOUT: &str = "8";
static PROBE_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub dns_name: String,
    pub addresses: Vec<String>,
    pub os: String,
    pub online: bool,
    pub last_seen: Option<String>,
    pub is_self: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MachineSnapshot {
    pub machine: Machine,
    pub sampled_at: String,
    pub ssh_target: String,
    pub metrics: BTreeMap<String, String>,
}

#[derive(Debug)]
struct ProcessOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

const METRIC_KEYS: [&str; 11] = [
    "hostname",
    "os",
    "architecture",
    "cpu",
    "cpu_cores",
    "memory_total",
    "memory_available",
    "disk",
    "load",
    "uptime",
    "gpu",
];

pub async fn list_machines_core() -> Result<Vec<Machine>, AppCommandError> {
    let mut command = Command::new("tailscale");
    command.args(["status", "--json"]);
    let output = run_process(command, None, MAX_DISCOVERY_OUTPUT).await?;
    if !output.status.success() {
        return Err(AppCommandError::external_command(
            "Tailscale discovery failed",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let raw = std::str::from_utf8(&output.stdout).map_err(|e| {
        AppCommandError::external_command("Tailscale returned invalid output", e.to_string())
    })?;
    parse_discovery_json(raw)
}

pub async fn probe_machine_core(
    machine_id: String,
    ssh_user: Option<String>,
) -> Result<MachineSnapshot, AppCommandError> {
    let semaphore = PROBE_SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(4)));
    let _permit = semaphore
        .acquire()
        .await
        .map_err(|_| AppCommandError::task_execution_failed("Machine probe limit unavailable"))?;
    validate_machine_id(&machine_id)?;
    if let Some(user) = ssh_user.as_deref() {
        validate_ssh_user(user)?;
    }
    let machine = list_machines_core()
        .await?
        .into_iter()
        .find(|machine| machine.id == machine_id)
        .ok_or_else(|| AppCommandError::not_found("Machine was not found in Tailscale status"))?;
    let target = ssh_target(&machine)?;
    let display_target = ssh_user
        .as_deref()
        .map(|user| format!("{user}@{target}"))
        .unwrap_or_else(|| target.clone());

    let mut command = Command::new("ssh");
    let connect_timeout = format!("ConnectTimeout={SSH_CONNECT_TIMEOUT}");
    command
        .args(["-o", "BatchMode=yes"])
        .args(["-o", connect_timeout.as_str()])
        .args([
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "PreferredAuthentications=publickey",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            "NumberOfPasswordPrompts=0",
            "-T",
        ]);
    if let Some(user) = ssh_user.as_deref() {
        command.args(["-l", user]);
    }
    command.args([target.as_str(), "sh", "-s"]);
    let output = run_process(command, Some(PROBE_SCRIPT.as_bytes()), MAX_PROBE_OUTPUT).await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppCommandError::external_command(
            "SSH machine probe failed",
            if detail.is_empty() {
                format!("ssh exited with {}", output.status)
            } else {
                detail
            },
        ));
    }
    let raw = std::str::from_utf8(&output.stdout).map_err(|e| {
        AppCommandError::external_command("SSH probe returned invalid output", e.to_string())
    })?;
    Ok(MachineSnapshot {
        machine,
        sampled_at: chrono::Utc::now().to_rfc3339(),
        ssh_target: display_target,
        metrics: parse_probe_output(raw)?,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_machines() -> Result<Vec<Machine>, AppCommandError> {
    list_machines_core().await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn probe_machine(
    machine_id: String,
    ssh_user: Option<String>,
) -> Result<MachineSnapshot, AppCommandError> {
    probe_machine_core(machine_id, ssh_user).await
}

fn parse_discovery_json(raw: &str) -> Result<Vec<Machine>, AppCommandError> {
    let root: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        AppCommandError::external_command("Tailscale returned malformed JSON", e.to_string())
    })?;
    let object = root.as_object().ok_or_else(|| {
        AppCommandError::external_command("Tailscale returned malformed status", "expected object")
    })?;
    let mut machines = Vec::new();
    if let Some(node) = object.get("Self") {
        machines.push(parse_node(node, None, true)?);
    }
    let peers = object.get("Peer").filter(|value| !value.is_null());
    if let Some(peers) = peers {
        let peers = peers.as_object().ok_or_else(|| {
            AppCommandError::external_command(
                "Tailscale returned malformed peers",
                "expected object",
            )
        })?;
        for (key, node) in peers {
            machines.push(parse_node(node, Some(key), false)?);
        }
    }
    if machines.is_empty() {
        return Err(AppCommandError::external_command(
            "Tailscale returned no machines",
            "missing Self and Peer",
        ));
    }
    machines.sort_by(|a, b| {
        b.is_self
            .cmp(&a.is_self)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(machines)
}

fn parse_node(
    value: &serde_json::Value,
    fallback_id: Option<&str>,
    is_self: bool,
) -> Result<Machine, AppCommandError> {
    let object = value.as_object().ok_or_else(|| {
        AppCommandError::external_command("Tailscale returned malformed node", "expected object")
    })?;
    let id = string_field(object, "ID")
        .or_else(|| fallback_id.map(str::to_string))
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            AppCommandError::external_command("Tailscale node has no ID", "missing ID")
        })?;
    validate_machine_id(&id)?;
    let name = string_field(object, "HostName").unwrap_or_else(|| id.clone());
    let dns_name = string_field(object, "DNSName")
        .map(|name| name.trim_end_matches('.').to_string())
        .unwrap_or_default();
    if !dns_name.is_empty() {
        validate_ssh_host(&dns_name)?;
    }
    let addresses = object
        .get("TailscaleIPs")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            AppCommandError::external_command("Tailscale node has no addresses", id.clone())
        })?
        .iter()
        .map(|value| {
            let address = value.as_str().ok_or_else(|| {
                AppCommandError::external_command("Tailscale node has invalid address", id.clone())
            })?;
            if address.parse::<std::net::IpAddr>().is_err() {
                return Err(AppCommandError::external_command(
                    "Tailscale node has invalid address",
                    address,
                ));
            }
            Ok(address.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Machine {
        id,
        name,
        dns_name,
        addresses,
        os: string_field(object, "OS").unwrap_or_default(),
        online: object
            .get("Online")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        last_seen: string_field(object, "LastSeen"),
        is_self,
    })
}

fn string_field(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn validate_machine_id(id: &str) -> Result<(), AppCommandError> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err(AppCommandError::invalid_input("Invalid machine ID"));
    }
    Ok(())
}

fn validate_ssh_user(user: &str) -> Result<(), AppCommandError> {
    let mut chars = user.chars();
    let Some(first) = chars.next() else {
        return Err(AppCommandError::invalid_input(
            "SSH username cannot be empty",
        ));
    };
    if user.len() > 64
        || !(first == '_' || first.is_ascii_alphabetic())
        || chars.any(|ch| !(ch == '_' || ch == '-' || ch == '.' || ch.is_ascii_alphanumeric()))
    {
        return Err(AppCommandError::invalid_input("Invalid SSH username"));
    }
    Ok(())
}

fn validate_ssh_host(host: &str) -> Result<(), AppCommandError> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    if host.is_empty()
        || host.len() > 253
        || host.chars().any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(AppCommandError::invalid_input("Invalid SSH host"));
    }
    for label in host.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || label
                .chars()
                .any(|ch| !(ch.is_ascii_alphanumeric() || ch == '-'))
        {
            return Err(AppCommandError::invalid_input("Invalid SSH host"));
        }
    }
    Ok(())
}

fn ssh_target(machine: &Machine) -> Result<String, AppCommandError> {
    if !machine.dns_name.is_empty() && validate_ssh_host(&machine.dns_name).is_ok() {
        return Ok(machine.dns_name.clone());
    }
    for address in &machine.addresses {
        if validate_ssh_host(address).is_ok() {
            // OpenSSH takes raw IPv6 destinations (brackets are for URI/scp syntax).
            return Ok(address.clone());
        }
    }
    Err(AppCommandError::invalid_input(
        "Machine has no valid SSH address",
    ))
}

fn parse_probe_output(raw: &str) -> Result<BTreeMap<String, String>, AppCommandError> {
    let mut metrics: BTreeMap<String, String> = BTreeMap::new();
    for line in raw.lines() {
        let Some((key, value)) = line.split_once('\t') else {
            continue;
        };
        if !METRIC_KEYS.contains(&key) {
            continue;
        }
        let value = value.trim();
        if value.len() > MAX_METRIC_VALUE {
            return Err(AppCommandError::external_command(
                "SSH probe output exceeded limits",
                key,
            ));
        }
        if !value.is_empty() && (key != "gpu" || value != "unknown") {
            if key == "gpu" {
                metrics
                    .entry(key.to_string())
                    .and_modify(|existing| {
                        existing.push_str(", ");
                        existing.push_str(value);
                    })
                    .or_insert_with(|| value.to_string());
            } else {
                metrics.insert(key.to_string(), value.to_string());
            }
        }
    }
    if !metrics.contains_key("hostname") || !metrics.contains_key("os") {
        return Err(AppCommandError::external_command(
            "SSH probe returned incomplete output",
            "missing hostname or os",
        ));
    }
    Ok(metrics)
}

async fn run_process(
    mut command: Command,
    stdin: Option<&[u8]>,
    output_cap: usize,
) -> Result<ProcessOutput, AppCommandError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(AppCommandError::io)?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            tokio::time::timeout(PROCESS_TIMEOUT, pipe.write_all(input))
                .await
                .map_err(|_| AppCommandError::external_command("Process timed out", "stdin"))?
                .map_err(AppCommandError::io)?;
        }
    }
    match tokio::time::timeout(PROCESS_TIMEOUT, run_process_inner(&mut child, output_cap)).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            Err(AppCommandError::external_command(
                "Process timed out",
                format!("timeout after {} seconds", PROCESS_TIMEOUT.as_secs()),
            ))
        }
    }
}

async fn run_process_inner(
    child: &mut Child,
    output_cap: usize,
) -> Result<ProcessOutput, AppCommandError> {
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppCommandError::external_command("Process output unavailable", "stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppCommandError::external_command("Process output unavailable", "stderr"))?;
    let mut stdout_data = Vec::new();
    let mut stderr_data = Vec::new();
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut status = None;
    let mut stdout_chunk = [0_u8; 8192];
    let mut stderr_chunk = [0_u8; 8192];
    while status.is_none() || !stdout_done || !stderr_done {
        tokio::select! {
            result = child.wait(), if status.is_none() => {
                status = Some(result.map_err(AppCommandError::io)?);
            }
            result = stdout.read(&mut stdout_chunk), if !stdout_done => {
                let count = result.map_err(AppCommandError::io)?;
                if count == 0 {
                    stdout_done = true;
                } else if stdout_data.len() + count > output_cap {
                    let _ = child.kill().await;
                    return Err(AppCommandError::external_command("Process output exceeded limits", "stdout"));
                } else {
                    stdout_data.extend_from_slice(&stdout_chunk[..count]);
                }
            }
            result = stderr.read(&mut stderr_chunk), if !stderr_done => {
                let count = result.map_err(AppCommandError::io)?;
                if count == 0 {
                    stderr_done = true;
                } else if stderr_data.len() + count > output_cap {
                    let _ = child.kill().await;
                    return Err(AppCommandError::external_command("Process output exceeded limits", "stderr"));
                } else {
                    stderr_data.extend_from_slice(&stderr_chunk[..count]);
                }
            }
        }
    }
    Ok(ProcessOutput {
        status: status.expect("process status set before loop exits"),
        stdout: stdout_data,
        stderr: stderr_data,
    })
}

const PROBE_SCRIPT: &str = r#"set -u
os=$(uname -s 2>/dev/null || printf unknown)
printf 'hostname\t%s\n' "$(hostname 2>/dev/null || printf unknown)"
printf 'os\t%s\n' "$os"
printf 'architecture\t%s\n' "$(uname -m 2>/dev/null || printf unknown)"
if [ "$os" = Linux ]; then
  cpu=$(awk -F: '/^model name/{gsub(/^ +/, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)
  cores=$(nproc 2>/dev/null || true)
  total=$(awk '/^MemTotal:/{printf "%.0f MB", $2/1024}' /proc/meminfo 2>/dev/null || true)
  avail=$(awk '/^MemAvailable:/{printf "%.0f MB", $2/1024}' /proc/meminfo 2>/dev/null || true)
  load=$(cat /proc/loadavg 2>/dev/null | awk '{print $1" "$2" "$3}' || true)
  up=$(awk '{printf "%.0f seconds", $1}' /proc/uptime 2>/dev/null || true)
else
  cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)
  cores=$(sysctl -n hw.ncpu 2>/dev/null || true)
  total=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1073741824}' || true)
  page=$(vm_stat 2>/dev/null | sed -n 's/.*page size of \([0-9][0-9]*\) bytes.*/\1/p' | head -n 1)
  : "${page:=4096}"
  avail=$(vm_stat 2>/dev/null | awk -v page="$page" '/Pages free/{free=$3} /Pages inactive/{inactive=$3} END{gsub("\\.","",free); gsub("\\.","",inactive); if(free+inactive) printf "%.0f MB", (free+inactive)*page/1048576}' || true)
  load=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1" "$2" "$3}' || true)
  up=$(uptime 2>/dev/null | sed 's/.*up //; s/, [0-9].*//' || true)
fi
[ -n "$cpu" ] && printf 'cpu\t%s\n' "$cpu"
[ -n "$cores" ] && printf 'cpu_cores\t%s\n' "$cores"
[ -n "$total" ] && printf 'memory_total\t%s\n' "$total"
[ -n "$avail" ] && printf 'memory_available\t%s\n' "$avail"
disk=$(df -hP / 2>/dev/null | awk 'NR==2 {print $3" used / "$2" total ("$5" used)"}')
[ -n "$disk" ] && printf 'disk\t%s\n' "$disk"
[ -n "$load" ] && printf 'load\t%s\n' "$load"
[ -n "$up" ] && printf 'uptime\t%s\n' "$up"
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null) || gpu=""
  if [ -n "$gpu" ]; then
    printf '%s\n' "$gpu" | while IFS= read -r row; do printf 'gpu\t%s\n' "$row"; done
  fi
fi
exit 0
"#;

#[cfg(test)]
mod tests {
    use super::*;

    const DISCOVERY: &str = r#"{
      "Self": {
        "ID": "self-id",
        "HostName": "zeta",
        "DNSName": "zeta.tailnet.ts.net.",
        "OS": "linux",
        "TailscaleIPs": ["100.64.0.1", "fd7a:115c:a1e0::1"],
        "Online": true,
        "LastSeen": "2026-09-22T08:00:00Z"
      },
      "Peer": {
        "peer-key": {
          "ID": "peer-id",
          "HostName": "alpha",
          "DNSName": "alpha.tailnet.ts.net.",
          "OS": "darwin",
          "TailscaleIPs": ["100.64.0.2"],
          "Online": false,
          "LastSeen": "2026-09-22T07:00:00Z"
        }
      }
    }"#;

    #[test]
    fn parses_and_sorts_self_and_peers() {
        let machines = parse_discovery_json(DISCOVERY).expect("valid status");
        assert_eq!(machines.len(), 2);
        assert!(machines[0].is_self);
        assert_eq!(machines[0].id, "self-id");
        assert_eq!(machines[0].dns_name, "zeta.tailnet.ts.net");
        assert_eq!(machines[1].name, "alpha");
        assert_eq!(machines[1].os, "darwin");
        assert!(!machines[1].online);
    }

    #[test]
    fn empty_peer_map_can_be_null_in_tailscale_status() {
        let mut status: serde_json::Value = serde_json::from_str(DISCOVERY).unwrap();
        status["Peer"] = serde_json::Value::Null;
        let machines = parse_discovery_json(&status.to_string()).unwrap();
        assert_eq!(machines.len(), 1);
        assert!(machines[0].is_self);
    }

    #[test]
    fn malformed_discovery_is_rejected() {
        assert!(parse_discovery_json("[]").is_err());
        assert!(parse_discovery_json(r#"{"Self": {"ID": 7}}"#).is_err());
        assert!(
            parse_discovery_json(r#"{"Self": {"ID": "x", "TailscaleIPs": ["not-an-ip"]}}"#)
                .is_err()
        );
    }

    #[test]
    fn validates_usernames_and_hosts() {
        assert!(validate_ssh_user("alice-2").is_ok());
        assert!(validate_ssh_user("bad user").is_err());
        assert!(validate_ssh_user("alice;id").is_err());
        assert!(validate_ssh_host("host.tailnet.ts.net").is_ok());
        assert!(validate_ssh_host("100.64.0.2").is_ok());
        assert!(validate_ssh_host("[fd7a:115c:a1e0::2]").is_ok());
        assert!(validate_ssh_host("host;id").is_err());
    }

    #[test]
    fn prefers_dns_then_valid_address() {
        let mut machine = machines_fixture();
        machine.dns_name = "bad host".to_string();
        assert_eq!(ssh_target(&machine).unwrap(), "100.64.0.2");
        machine.addresses = vec!["fd7a:115c:a1e0::2".to_string()];
        assert_eq!(ssh_target(&machine).unwrap(), "fd7a:115c:a1e0::2");
    }

    #[test]
    fn parses_linux_and_macos_probe_lines() {
        let linux =
            parse_probe_output("hostname\tlinux-box\nos\tLinux\ncpu\tAMD Ryzen\ncpu_cores\t8\n")
                .unwrap();
        assert_eq!(linux.get("hostname"), Some(&"linux-box".to_string()));
        let mac =
            parse_probe_output("hostname\tmac-box\nos\tmacOS\nmemory_total\t16 GB\ngpu\tunknown\n")
                .unwrap();
        assert_eq!(mac.get("os"), Some(&"macOS".to_string()));
        assert_eq!(mac.get("memory_total"), Some(&"16 GB".to_string()));
    }

    #[test]
    fn probe_output_is_bounded() {
        let huge = format!("hostname\t{}\n", "x".repeat(MAX_METRIC_VALUE + 10));
        assert!(parse_probe_output(&huge).is_err());
        assert!(parse_probe_output("hostname\tbox\n").is_err());
    }

    #[cfg(unix)]
    fn run_script_with_tools(tools: &[(&str, &str)]) -> std::process::Output {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in tools {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::process::Command::new("sh")
            .args(["-c", PROBE_SCRIPT])
            .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
            .output()
            .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn script_reports_every_gpu_and_survives_optional_tool_failure() {
        let output = run_script_with_tools(&[(
            "nvidia-smi",
            "printf 'NVIDIA A100, 40960 MiB\\nNVIDIA T4, 15360 MiB\\n'",
        )]);
        assert!(output.status.success());
        let metrics = parse_probe_output(std::str::from_utf8(&output.stdout).unwrap()).unwrap();
        let gpu = metrics.get("gpu").unwrap();
        assert!(gpu.contains("NVIDIA A100"));
        assert!(gpu.contains("NVIDIA T4"));
        let failed = run_script_with_tools(&[("nvidia-smi", "exit 1")]);
        assert!(failed.status.success());
        let metrics = parse_probe_output(std::str::from_utf8(&failed.stdout).unwrap()).unwrap();
        assert!(!metrics.contains_key("gpu"));
        assert!(metrics.contains_key("hostname"));
    }

    #[cfg(unix)]
    #[test]
    fn macos_memory_uses_the_reported_page_size() {
        let output = run_script_with_tools(&[
            ("uname", "case \"$1\" in -s) echo Darwin;; -m) echo arm64;; esac"),
            ("sysctl", "case \"$2\" in hw.ncpu) echo 8;; hw.memsize) echo 17179869184;; machdep.cpu.brand_string) echo 'Apple M1';; vm.loadavg) echo '{ 1.0 2.0 3.0 }';; esac"),
            ("vm_stat", "printf 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free: 64.\\nPages inactive: 64.\\n'"),
            ("nvidia-smi", "exit 1"),
        ]);
        assert!(output.status.success());
        let metrics = parse_probe_output(std::str::from_utf8(&output.stdout).unwrap()).unwrap();
        assert_eq!(
            metrics.get("memory_available").map(String::as_str),
            Some("2 MB")
        );
        assert_eq!(
            metrics.get("architecture").map(String::as_str),
            Some("arm64")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn subprocess_output_limit_is_enforced() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 123456789"]);
        let error = run_process(command, None, 8).await.unwrap_err();
        assert!(format!("{error:?}").contains("output exceeded limits"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_process_is_terminated() {
        let pid_dir = tempfile::tempdir().unwrap();
        let pid_file = pid_dir.path().join("pid");
        let mut command = Command::new("sh");
        command.args(["-c", "echo $$ > \"$1\"; exec sleep 30", "probe-test"]);
        command.arg(&pid_file);
        let error = tokio::time::timeout(
            PROCESS_TIMEOUT + std::time::Duration::from_secs(2),
            run_process(command, None, 128),
        )
        .await
        .expect("runner must enforce its own timeout")
        .unwrap_err();
        assert!(format!("{error:?}").contains("Process timed out"));
        let pid = std::fs::read_to_string(pid_file).unwrap();
        let status = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(
            !status.success(),
            "timed-out process must not remain running"
        );
    }

    fn machines_fixture() -> Machine {
        Machine {
            id: "id".to_string(),
            name: "name".to_string(),
            dns_name: "host.tailnet.ts.net".to_string(),
            addresses: vec!["100.64.0.2".to_string()],
            os: "linux".to_string(),
            online: true,
            last_seen: None,
            is_self: false,
        }
    }
}
