use super::*;

// Close/unsubscribe deliberately keeps the writer until PROCESS exit, as Codex
// does. Real children exercise the reaper, pid callbacks and command channel.
const AGENT: &str = r#"
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.argv[2];
function own(sid) {
  const file = path.join(root, sid);
  if (fs.existsSync(file)) {
    const writer = Number(fs.readFileSync(file, 'utf8'));
    if (writer !== process.pid) {
      try { process.kill(writer, 0); throw new Error('already has an active writer'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  fs.writeFileSync(file, String(process.pid));
}
function response(sid) {
  return {
    sessionId: sid,
    modes: {currentModeId: 'default-mode', availableModes: [{id: 'default-mode', name: 'Default'}, {id: 'chosen-mode', name: 'Chosen'}]},
    configOptions: [{id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default-model', options: [{value: 'default-model', name: 'Default'}, {value: 'chosen-model', name: 'Chosen'}]}],
  };
}
readline.createInterface({input: process.stdin}).on('line', line => {
  const req = JSON.parse(line);
  const p = req.params || {};
  let result = {};
  try {
    switch (req.method) {
      case 'initialize': result = {protocolVersion: 1, agentCapabilities: {loadSession: true, sessionCapabilities: {resume: {}, fork: {}, close: {}}}}; break;
      case 'session/new': own('s1'); result = response('s1'); break;
      case 'session/resume': own(p.sessionId); result = response(p.sessionId); break;
      case 'session/fork':
        if (fs.existsSync(path.join(root, 'fail-fork'))) throw new Error('fork rejected');
        result = response(fs.existsSync(path.join(root, 'same-fork')) ? p.sessionId : 's' + (Number(p.sessionId.slice(1)) + 1)); break;
      case 'session/set_config_option': result = {configOptions: [{id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: p.value, options: []}]}; break;
      case 'session/prompt':
        own(p.sessionId);
        process.stdout.write(JSON.stringify({jsonrpc: '2.0', method: 'session/update', params: {sessionId: p.sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'reply'}}}}) + '\n');
        result = {stopReason: 'end_turn'}; break;
      case 'session/close': break;
      default: break;
    }
    if (req.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, result}) + '\n');
  } catch(error) {
    process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, error: {code: -32603, message: error.message}}) + '\n');
  }
});
"#;

struct Driver {
    state: Arc<RwLock<SessionState>>,
    commands: mpsc::Sender<ConnectionCommand>,
    events: tokio::sync::broadcast::Receiver<Arc<crate::acp::types::EventEnvelope>>,
    done: oneshot::Receiver<Result<(), AcpError>>,
    exits: Arc<std::sync::atomic::AtomicUsize>,
}

impl Driver {
    async fn start(root: &Path, script: &Path, sid: Option<&str>) -> Self {
        let exits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&exits);
        let agent = AcpAgent::from_args(["node", script.to_str().unwrap(), root.to_str().unwrap()])
            .unwrap()
            .on_exit(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            });
        let state = Arc::new(RwLock::new(SessionState::new(
            uuid::Uuid::new_v4().to_string(),
            AgentType::Codex,
            Some(root.to_path_buf()),
            "win".into(),
            None,
        )));
        let events = state.read().await.event_stream().subscribe();
        let (commands, cmd_rx) = mpsc::channel(16);
        let (done_tx, done) = oneshot::channel();
        let runtime = tokio::runtime::Handle::current();
        let connection_id = state.read().await.connection_id.clone();
        let working_dir = Some(root.to_string_lossy().to_string());
        let session_id = sid.map(str::to_owned);
        let driver_state = Arc::clone(&state);
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let result = runtime.block_on(run_connection(
                    agent,
                    connection_id,
                    AgentType::Codex,
                    working_dir,
                    session_id,
                    cmd_rx,
                    EventEmitter::Noop,
                    driver_state,
                    BTreeMap::new(),
                    TerminalShellRuntimeConfig::default(),
                    None,
                    BTreeMap::new(),
                    None,
                    FsAccessPolicy::unrestricted(),
                    HostToolsPolicy::Agent,
                    Arc::new(StderrTail::new()),
                ));
                let _ = done_tx.send(result);
            })
            .unwrap();
        let mut driver = Self {
            state,
            commands,
            events,
            done,
            exits,
        };
        driver.wait_selectors().await;
        driver
    }

    async fn wait_event(&mut self, matches: impl Fn(&AcpEvent) -> bool) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let event = self.events.recv().await.expect("driver emits events");
                assert!(
                    !matches!(event.payload, AcpEvent::Error { terminal: true, .. }),
                    "{:?}",
                    event.payload
                );
                if matches(&event.payload) {
                    return;
                }
            }
        })
        .await
        .expect("driver responds");
    }

    async fn wait_selectors(&mut self) {
        self.wait_event(|event| matches!(event, AcpEvent::SelectorsReady))
            .await;
    }

    async fn prompt(&mut self) {
        self.commands
            .send(ConnectionCommand::Prompt {
                blocks: vec![PromptInputBlock::Text {
                    text: "hello".into(),
                }],
                user_message: None,
            })
            .await
            .unwrap();
        self.wait_event(|event| matches!(event, AcpEvent::TurnComplete { .. }))
            .await;
    }

    async fn fork(&mut self) -> Result<crate::acp::types::ForkProtocolResult, AcpError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(ConnectionCommand::Fork {
                fork_point: None,
                reply,
            })
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), result)
            .await
            .unwrap()
            .unwrap()
    }

    async fn stop(self) {
        self.commands
            .send(ConnectionCommand::Disconnect)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), self.done)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_forks_reap_old_writers_restore_selectors_and_keep_both_histories_promptable() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("agent.cjs");
    std::fs::write(&script, AGENT).unwrap();
    let mut fork = Driver::start(root.path(), &script, None).await;
    fork.commands
        .send(ConnectionCommand::SetMode {
            mode_id: "chosen-mode".into(),
        })
        .await
        .unwrap();
    fork.wait_event(
        |event| matches!(event, AcpEvent::ModeChanged { mode_id } if mode_id == "chosen-mode"),
    )
    .await;
    fork.commands
        .send(ConnectionCommand::SetConfigOption {
            config_id: "model".into(),
            value_id: "chosen-model".into(),
        })
        .await
        .unwrap();
    fork.wait_event(|event| matches!(event, AcpEvent::SessionConfigOptions { .. }))
        .await;
    fork.prompt().await;
    let result = fork.fork().await.unwrap();
    assert_eq!(result.original_session_id, "s1");
    assert_eq!(result.forked_session_id, "s2");
    assert_eq!(
        fork.exits.load(Ordering::SeqCst),
        1,
        "reply waits for old process reap"
    );
    fork.wait_selectors().await;
    assert_eq!(
        fork.state.read().await.current_mode.as_deref(),
        Some("chosen-mode")
    );
    assert_eq!(
        current_config_option_values(fork.state.read().await.config_options.as_deref().unwrap())
            .get("model")
            .map(String::as_str),
        Some("chosen-model")
    );

    let mut original = Driver::start(root.path(), &script, Some("s1")).await;
    original.prompt().await;
    fork.prompt().await;
    let result = fork.fork().await.unwrap();
    assert_eq!(result.original_session_id, "s2");
    assert_eq!(result.forked_session_id, "s3");
    assert_eq!(fork.exits.load(Ordering::SeqCst), 2);
    fork.wait_selectors().await;
    let mut previous = Driver::start(root.path(), &script, Some("s2")).await;
    previous.prompt().await;
    fork.prompt().await;
    original.prompt().await;
    previous.stop().await;
    original.stop().await;
    fork.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_codex_fork_keeps_the_original_process_and_session() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("agent.cjs");
    std::fs::write(&script, AGENT).unwrap();
    std::fs::write(root.path().join("fail-fork"), "").unwrap();
    let mut driver = Driver::start(root.path(), &script, None).await;
    assert!(driver.fork().await.is_err());
    assert_eq!(driver.exits.load(Ordering::SeqCst), 0);
    assert_eq!(driver.state.read().await.external_id.as_deref(), Some("s1"));
    driver.prompt().await;
    driver.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_fork_onto_the_same_session_keeps_its_writer_and_process() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("agent.cjs");
    std::fs::write(&script, AGENT).unwrap();
    std::fs::write(root.path().join("same-fork"), "").unwrap();
    let mut driver = Driver::start(root.path(), &script, None).await;
    let result = driver.fork().await.unwrap();
    assert_eq!(result.original_session_id, "s1");
    assert_eq!(result.forked_session_id, "s1");
    assert_eq!(driver.exits.load(Ordering::SeqCst), 0);
    driver.wait_selectors().await;
    driver.prompt().await;
    driver.stop().await;
}
