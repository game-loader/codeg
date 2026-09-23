use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Semaphore;

use crate::app_error::AppCommandError;
use sea_orm::DatabaseConnection;

mod manual;
pub use manual::{delete_manual_machine_core, save_manual_machine_core, ManualMachineInput};

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
    pub online: Option<bool>,
    pub last_seen: Option<String>,
    pub is_self: bool,
    pub source: String,
    pub ssh_port: u16,
    pub ssh_user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineInventory {
    pub machines: Vec<Machine>,
    pub discovery_error: Option<String>,
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

pub async fn list_machines_core(
    conn: &DatabaseConnection,
) -> Result<MachineInventory, AppCommandError> {
    let manual = manual::list(conn).await?;
    Ok(combine_inventory(manual, discover_tailscale().await))
}

fn combine_inventory(
    mut machines: Vec<Machine>,
    discovered: Result<Vec<Machine>, AppCommandError>,
) -> MachineInventory {
    let discovery_error = match discovered {
        Ok(mut tailnet) => {
            tailnet.append(&mut machines);
            machines = tailnet;
            None
        }
        Err(error) => Some(match error.detail {
            Some(detail) => format!("{}: {detail}", error.message),
            None => error.message,
        }),
    };
    MachineInventory {
        machines,
        discovery_error,
    }
}

async fn discover_tailscale() -> Result<Vec<Machine>, AppCommandError> {
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
    conn: &DatabaseConnection,
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
    let (machine, password) = if machine_id.starts_with("manual:") {
        let (machine, password) = manual::resolve(conn, &machine_id, ssh_user.as_deref()).await?;
        (machine, Some(password))
    } else {
        let machine = discover_tailscale()
            .await?
            .into_iter()
            .find(|machine| machine.id == machine_id)
            .ok_or_else(|| {
                AppCommandError::not_found("Machine was not found in Tailscale status")
            })?;
        (machine, None)
    };
    let target = ssh_target(&machine)?;
    let user = machine.ssh_user.as_deref().or(ssh_user.as_deref());
    let display_target = user
        .map(|user| format!("{user}@{target}"))
        .unwrap_or_else(|| target.clone());
    let command = probe_command(&target, machine.ssh_port, user, password.as_deref())?;
    let output = run_process(command, Some(PROBE_SCRIPT.as_bytes()), MAX_PROBE_OUTPUT)
        .await
        .map_err(|mut error| {
            if let (Some(password), Some(detail)) = (&password, &mut error.detail) {
                *detail = detail.replace(password, "[redacted]");
            }
            error
        })?;
    if !output.status.success() {
        let mut detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if let Some(password) = &password {
            detail = detail.replace(password, "[redacted]");
        }
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
    snapshot_from_probe(machine, display_target, raw)
}

fn snapshot_from_probe(
    mut machine: Machine,
    target: String,
    raw: &str,
) -> Result<MachineSnapshot, AppCommandError> {
    let metrics = parse_probe_output(raw)?;
    if machine.source == "manual" {
        machine.online = Some(true);
        machine.os = metrics.get("os").cloned().unwrap_or_default();
    }
    Ok(MachineSnapshot {
        machine,
        sampled_at: chrono::Utc::now().to_rfc3339(),
        ssh_target: target,
        metrics,
    })
}

fn probe_command(
    target: &str,
    port: u16,
    user: Option<&str>,
    password: Option<&str>,
) -> Result<Command, AppCommandError> {
    let mut command = Command::new("ssh");
    command
        .args(["-o", &format!("ConnectTimeout={SSH_CONNECT_TIMEOUT}")])
        .args([
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-T",
        ]);
    if let Some(password) = password {
        #[cfg(feature = "tauri-runtime")]
        let helper = std::env::current_exe().map_err(AppCommandError::io)?;
        #[cfg(not(feature = "tauri-runtime"))]
        let helper = crate::update::runtime::self_exe();
        // Direct IP connections intentionally ignore SSH configuration: in
        // particular SendEnv/SetEnv/LocalCommand/ProxyCommand must not forward
        // or expose the helper's child-only password environment.
        command
            .args(["-p", &port.to_string()])
            .args([
                "-F",
                "none",
                "-o",
                "SendEnv=-*",
                "-o",
                "BatchMode=no",
                "-o",
                "NumberOfPasswordPrompts=1",
                "-o",
                "PreferredAuthentications=password,keyboard-interactive",
                "-o",
                "PasswordAuthentication=yes",
                "-o",
                "KbdInteractiveAuthentication=yes",
                "-o",
                "PubkeyAuthentication=no",
            ])
            .env("SSH_ASKPASS", helper)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "codeg:0")
            .env("LC_ALL", "C")
            .env(crate::ssh_askpass::MODE_ENV, crate::ssh_askpass::MODE)
            .env(crate::ssh_askpass::PASSWORD_ENV, password)
            .env_remove("SSH_ASKPASS_PROMPT");
    } else {
        command.args([
            "-o",
            "BatchMode=yes",
            "-o",
            "PreferredAuthentications=publickey",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            "NumberOfPasswordPrompts=0",
        ]);
    }
    if let Some(user) = user {
        command.args(["-l", user]);
    }
    command.args([target, "sh", "-s"]);
    Ok(command)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_machines(
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<MachineInventory, AppCommandError> {
    list_machines_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn probe_machine(
    db: tauri::State<'_, crate::db::AppDatabase>,
    machine_id: String,
    ssh_user: Option<String>,
) -> Result<MachineSnapshot, AppCommandError> {
    probe_machine_core(&db.conn, machine_id, ssh_user).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn save_manual_machine(
    db: tauri::State<'_, crate::db::AppDatabase>,
    input: ManualMachineInput,
) -> Result<Machine, AppCommandError> {
    save_manual_machine_core(&db.conn, input).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn delete_manual_machine(
    db: tauri::State<'_, crate::db::AppDatabase>,
    machine_id: String,
) -> Result<(), AppCommandError> {
    delete_manual_machine_core(&db.conn, machine_id).await
}

fn parse_discovery_json(raw: &str) -> Result<Vec<Machine>, AppCommandError> {
    let root: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        AppCommandError::external_command("Tailscale returned malformed JSON", e.to_string())
    })?;
    let object = root.as_object().ok_or_else(|| {
        AppCommandError::external_command("Tailscale returned malformed status", "expected object")
    })?;
    let backend_state = object
        .get("BackendState")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if matches!(backend_state, "NeedsLogin" | "NeedsMachineAuth") {
        let auth_url = object
            .get("AuthURL")
            .and_then(serde_json::Value::as_str)
            .filter(|url| !url.trim().is_empty())
            .unwrap_or("Run `tailscale login` on the Codeg backend to obtain a login URL, then refresh the machine list.");
        return Err(AppCommandError::external_command(
            "Tailscale login required",
            auth_url,
        ));
    }
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
        online: Some(
            object
                .get("Online")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        ),
        last_seen: string_field(object, "LastSeen"),
        is_self,
        source: "tailscale".into(),
        ssh_port: 22,
        ssh_user: None,
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
    // Keep the buffer outside the timed future so cancellation cannot discard
    // a Tailscale SSH check URL already emitted while waiting for approval.
    let mut stderr_data = Vec::new();
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            tokio::time::timeout(PROCESS_TIMEOUT, pipe.write_all(input))
                .await
                .map_err(|_| AppCommandError::external_command("Process timed out", "stdin"))?
                .map_err(AppCommandError::io)?;
        }
    }
    match tokio::time::timeout(
        PROCESS_TIMEOUT,
        run_process_inner(&mut child, output_cap, &mut stderr_data),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            let diagnostic = String::from_utf8_lossy(&stderr_data);
            let mut detail = format!("timeout after {} seconds", PROCESS_TIMEOUT.as_secs());
            if !diagnostic.trim().is_empty() {
                detail.push('\n');
                detail.push_str(diagnostic.trim());
            }
            Err(AppCommandError::external_command(
                "Process timed out",
                detail,
            ))
        }
    }
}

async fn run_process_inner(
    child: &mut Child,
    output_cap: usize,
    stderr_data: &mut Vec<u8>,
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
        stderr: std::mem::take(stderr_data),
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
    fn discovery_reports_login_url_instead_of_stale_machines() {
        let mut status: serde_json::Value = serde_json::from_str(DISCOVERY).unwrap();
        status["BackendState"] = "NeedsLogin".into();
        status["AuthURL"] = "https://login.tailscale.com/a/test-login".into();
        let error = parse_discovery_json(&status.to_string()).unwrap_err();
        assert!(error.message.contains("login"));
        assert!(error
            .detail
            .unwrap()
            .contains("https://login.tailscale.com/a/test-login"));
    }

    #[test]
    fn parses_and_sorts_self_and_peers() {
        let machines = parse_discovery_json(DISCOVERY).expect("valid status");
        assert_eq!(machines.len(), 2);
        assert!(machines[0].is_self);
        assert_eq!(machines[0].id, "self-id");
        assert_eq!(machines[0].dns_name, "zeta.tailnet.ts.net");
        assert_eq!(machines[1].name, "alpha");
        assert_eq!(machines[1].os, "darwin");
        assert_eq!(machines[1].online, Some(false));
    }

    #[test]
    fn discovery_includes_connection_source_and_port() {
        let machines = parse_discovery_json(DISCOVERY).unwrap();
        let machine = serde_json::to_value(&machines[0]).unwrap();
        assert_eq!(machine["source"], "tailscale");
        assert_eq!(machine["ssh_port"], 22);
        assert!(machine["ssh_user"].is_null());
    }

    #[test]
    fn successful_manual_snapshot_marks_reachability_and_detected_os() {
        let mut machine = machines_fixture();
        machine.source = "manual".into();
        machine.online = None;
        machine.os.clear();
        let snapshot = snapshot_from_probe(
            machine.clone(),
            "root@203.0.113.8".into(),
            "hostname\tgpu\nos\tLinux\n",
        )
        .unwrap();
        assert_eq!(snapshot.machine.online, Some(true));
        assert_eq!(snapshot.machine.os, "Linux");
        assert!(!snapshot.sampled_at.is_empty());
        assert!(
            snapshot_from_probe(machine, "root@203.0.113.8".into(), "hostname\tgpu\n").is_err()
        );
    }

    #[test]
    fn manual_inventory_survives_discovery_failure() {
        let mut manual = machines_fixture();
        manual.source = "manual".into();
        manual.online = None;
        let inventory = combine_inventory(
            vec![manual.clone()],
            Err(AppCommandError::io_error("tailscale not installed")),
        );
        assert_eq!(inventory.machines, vec![manual]);
        assert!(inventory.discovery_error.unwrap().contains("tailscale"));
        let empty = combine_inventory(Vec::new(), Err(AppCommandError::io_error("offline")));
        assert!(empty.machines.is_empty());
        assert!(empty.discovery_error.is_some());
    }

    #[test]
    fn password_probe_uses_custom_port_and_child_environment_without_secret_argv() {
        let command =
            probe_command("2001:db8::8", 2222, Some("root"), Some("test-secret")).unwrap();
        let process = command.as_std();
        let args: Vec<_> = process
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args.windows(2).any(|pair| pair == ["-l", "root"]));
        assert!(args.windows(2).any(|pair| pair == ["-F", "none"]));
        assert!(args.contains(&"StrictHostKeyChecking=accept-new".into()));
        assert!(args.contains(&"SendEnv=-*".into()));
        assert!(args.contains(&"BatchMode=no".into()));
        assert!(args.contains(&"PubkeyAuthentication=no".into()));
        assert!(!args.iter().any(|arg| arg.contains("test-secret")));
        assert_eq!(&args[args.len() - 3..], ["2001:db8::8", "sh", "-s"]);
        let env: std::collections::HashMap<_, _> = process.get_envs().collect();
        assert_eq!(
            env.get(std::ffi::OsStr::new(crate::ssh_askpass::PASSWORD_ENV)),
            Some(&Some(std::ffi::OsStr::new("test-secret")))
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("SSH_ASKPASS_REQUIRE")),
            Some(&Some(std::ffi::OsStr::new("force")))
        );
        let tailnet = probe_command("100.64.0.2", 22, None, None).unwrap();
        assert!(tailnet
            .as_std()
            .get_args()
            .any(|value| value == "BatchMode=yes"));
        assert!(
            !tailnet.as_std().get_args().any(|value| value == "-p"),
            "Tailscale must preserve ports from SSH config"
        );
        assert!(!tailnet
            .as_std()
            .get_envs()
            .any(|(key, _)| key == crate::ssh_askpass::PASSWORD_ENV));
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
        command.args(["-c", "echo $$ > \"$1\"; printf 'Tailscale SSH requires an additional check.\\nhttps://login.tailscale.com/a/test-ssh\\n' >&2; exec sleep 30", "probe-test"]);
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
        assert!(
            error
                .detail
                .unwrap()
                .contains("https://login.tailscale.com/a/test-ssh"),
            "timeout must retain the SSH authorization URL"
        );
    }

    fn machines_fixture() -> Machine {
        Machine {
            id: "id".to_string(),
            name: "name".to_string(),
            dns_name: "host.tailnet.ts.net".to_string(),
            addresses: vec!["100.64.0.2".to_string()],
            os: "linux".to_string(),
            online: Some(true),
            last_seen: None,
            is_self: false,
            source: "tailscale".into(),
            ssh_port: 22,
            ssh_user: None,
        }
    }
}
