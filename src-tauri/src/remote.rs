#[cfg(target_os = "macos")]
use crate::{askpass, platform::SSH};
use crate::{
    config::{Connection, valid_id},
    platform::ssh_program,
};
use base64::{Engine, engine::general_purpose::STANDARD};
#[cfg(target_os = "macos")]
use nix::{
    errno::Errno,
    libc,
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
#[cfg(target_os = "macos")]
use serde::Deserialize;
use serde::Serialize;
use std::{
    collections::{HashMap, hash_map::Entry},
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    os::unix::{fs::PermissionsExt, net::UnixListener, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
#[cfg(target_os = "macos")]
const RSYNC: &str = "/usr/bin/rsync";
const MAX_TERMINALS: usize = 24;

#[derive(Clone, Default)]
pub struct Sessions {
    terminals: Arc<Mutex<HashMap<String, Arc<LiveSession>>>>,
    #[cfg(target_os = "macos")]
    transfer: Arc<Mutex<Option<Child>>>,
}

struct LiveSession {
    #[cfg(target_os = "macos")]
    control: tempfile::TempDir,
    pty: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionEvent {
    Data { data: String, interactive: bool },
    Exit { detail: String },
}

#[cfg(target_os = "macos")]
fn interactive_pty(session: &LiveSession) -> bool {
    let Ok(pty) = session.pty.lock() else {
        return false;
    };
    let Some(fd) = pty.as_raw_fd() else {
        return false;
    };
    let mut mode = std::mem::MaybeUninit::<libc::termios>::uninit();
    unsafe {
        libc::tcgetattr(fd, mode.as_mut_ptr()) == 0
            && mode.assume_init().c_lflag & (libc::ICANON | libc::ECHO | libc::ISIG) == 0
    }
}

fn ssh_args(connection: &Connection, interactive: bool) -> Vec<String> {
    let mut args = vec![
        "-oConnectTimeout=12".into(),
        "-oServerAliveCountMax=3".into(),
        format!("-oServerAliveInterval={}", connection.keep_alive),
        "-oPermitLocalCommand=no".into(),
        "-oClearAllForwardings=yes".into(),
        "-oForwardAgent=no".into(),
        "-oForwardX11=no".into(),
        "-oRemoteCommand=none".into(),
        "-oSessionType=default".into(),
        "-oStdinNull=no".into(),
        "-oForkAfterAuthentication=no".into(),
        "-oEscapeChar=none".into(),
    ];
    if interactive {
        args.extend(["-tt", "-oBatchMode=no", "-oStrictHostKeyChecking=ask"].map(String::from));
        #[cfg(windows)]
        args.extend(["-oControlMaster=no", "-oControlPath=none"].map(String::from));
    } else {
        args.extend(
            [
                "-T",
                "-oBatchMode=yes",
                "-oStrictHostKeyChecking=yes",
                "-oControlPath=none",
            ]
            .map(String::from),
        );
    }
    if let Some(port) = connection.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if !connection.username.is_empty() {
        args.extend(["-l".into(), connection.username.clone()]);
    }
    if !connection.identity_file.is_empty() {
        args.extend(["-i".into(), connection.identity_file.clone()]);
    }
    args
}

fn ssh_terminal_args(connection: &Connection) -> Vec<String> {
    let mut args = ssh_args(connection, true);
    if cfg!(target_os = "macos") && connection.password.is_some() {
        args.extend(
            [
                "-oKbdInteractiveAuthentication=no",
                "-oPasswordAuthentication=yes",
            ]
            .map(String::from),
        );
    }
    args.extend(["--".into(), connection.host.clone()]);
    if connection.tmux {
        args.extend([
            "tmux".into(),
            "new-session".into(),
            "-A".into(),
            "-s".into(),
            format!("my-windterm-{}", connection.id.to_ascii_lowercase()),
        ]);
    }
    args
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 1000),
        rows: rows.clamp(2, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl Sessions {
    pub fn start(
        &self,
        id: String,
        mut connection: Connection,
        cols: u16,
        rows: u16,
        emit: impl FnMut(SessionEvent) -> bool + Send + 'static,
    ) -> Result<(), String> {
        connection.validate()?;
        let args = ssh_terminal_args(&connection);
        let password = connection.password.take().map(Zeroizing::new);
        self.launch_pty(id, args, size(cols, rows), password, emit)
    }

    fn launch_pty(
        &self,
        id: String,
        args: Vec<String>,
        size: PtySize,
        password: Option<Zeroizing<String>>,
        mut emit: impl FnMut(SessionEvent) -> bool + Send + 'static,
    ) -> Result<(), String> {
        if !valid_id(&id) {
            return Err("运行实例 ID 无效。".into());
        }
        let mut terminals = self.terminals.lock().map_err(|error| error.to_string())?;
        if terminals.len() >= MAX_TERMINALS {
            return Err("运行中的终端已达 24 个。".into());
        }
        let Entry::Vacant(slot) = terminals.entry(id.clone()) else {
            return Err("终端已存在。".into());
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| error.to_string())?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        #[cfg(target_os = "macos")]
        let control = tempfile::Builder::new()
            .prefix("mwt-")
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir_in("/tmp")
            .map_err(|error| format!("无法创建 SSH 控制目录：{error}"))?;
        let mut command = CommandBuilder::new(ssh_program()?);
        #[cfg(target_os = "macos")]
        {
            command.args(["-M", "-oControlPersist=no", "-S"]);
            command.arg(control.path().join("ctl"));
        }
        command.args(args);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        #[cfg(windows)]
        drop(password);
        #[cfg(target_os = "macos")]
        let broker = if let Some(password) = password {
            let path = control.path().join("pw");
            let listener = UnixListener::bind(&path)
                .map_err(|error| format!("无法创建 SSH 密码通道：{error}"))?;
            listener
                .set_nonblocking(true)
                .map_err(|error| error.to_string())?;
            command.env(
                "SSH_ASKPASS",
                std::env::current_exe().map_err(|error| error.to_string())?,
            );
            command.env("SSH_ASKPASS_REQUIRE", "force");
            command.env_remove("SSH_ASKPASS_PROMPT");
            command.env(askpass::SOCKET_ENV, &path);
            Some((path, listener, password))
        } else {
            None
        };
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("无法启动 OpenSSH：{error}"))?;
        #[cfg(target_os = "macos")]
        if let Some((path, listener, password)) = broker {
            askpass::serve(path, listener, password);
        }
        drop(pair.slave);
        let session = Arc::new(LiveSession {
            #[cfg(target_os = "macos")]
            control,
            pty: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
        });
        slot.insert(session.clone());
        let all = self.terminals.clone();
        thread::spawn(move || {
            let mut bytes = [0; 8192];
            #[cfg(target_os = "macos")]
            let mut interactive = false;
            #[cfg(windows)]
            let interactive = false;
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => {
                        #[cfg(target_os = "macos")]
                        {
                            interactive |= interactive_pty(&session);
                        }
                        if !emit(SessionEvent::Data {
                            data: STANDARD.encode(&bytes[..count]),
                            interactive,
                        }) {
                            if let Ok(mut killer) = session.killer.lock() {
                                let _ = killer.kill();
                            }
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let detail = child
                .wait()
                .map(|status| status.to_string())
                .unwrap_or_else(|error| error.to_string());
            if let Ok(mut terminals) = all.lock() {
                terminals.remove(&id);
            }
            emit(SessionEvent::Exit { detail });
        });
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<Arc<LiveSession>>, String> {
        Ok(self
            .terminals
            .lock()
            .map_err(|error| error.to_string())?
            .get(id)
            .cloned())
    }

    #[cfg(target_os = "macos")]
    pub async fn wait_for_sftp(&self, id: &str) -> Result<(), String> {
        loop {
            let socket = self.control_socket(id)?;
            if socket.exists() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    #[cfg(target_os = "macos")]
    pub fn control_socket(&self, id: &str) -> Result<PathBuf, String> {
        self.get(id)?
            .map(|session| session.control.path().join("ctl"))
            .ok_or_else(|| "SSH 会话已断开。".into())
    }

    pub fn input(&self, id: &str, data: &str) -> Result<(), String> {
        if data.len() > 88_000 {
            return Err("终端输入块过大。".into());
        }
        let bytes = STANDARD.decode(data).map_err(|error| error.to_string())?;
        if let Some(session) = self.get(id)? {
            let mut writer = session.writer.lock().map_err(|error| error.to_string())?;
            writer
                .write_all(&bytes)
                .and_then(|()| writer.flush())
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(session) = self.get(id)? {
            session
                .pty
                .lock()
                .map_err(|error| error.to_string())?
                .resize(size(cols, rows))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        if let Some(session) = self.get(id)? {
            session
                .killer
                .lock()
                .map_err(|error| error.to_string())?
                .kill()
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        #[cfg(target_os = "macos")]
        let _ = self.stop_sync();
        if let Ok(terminals) = self.terminals.lock() {
            for session in terminals.values() {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub fn stop_sync(&self) -> Result<(), String> {
        if let Some(child) = self
            .transfer
            .lock()
            .map_err(|error| error.to_string())?
            .as_mut()
        {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                match killpg(Pid::from_raw(child.id() as i32), Signal::SIGTERM) {
                    Ok(()) | Err(Errno::ESRCH) => (),
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn sync_folder(
        &self,
        request: SyncRequest,
        emit: impl Fn(String) + Sync,
    ) -> Result<SyncResult, String> {
        self.sync_with_args(request.args()?, emit)
    }

    #[cfg(target_os = "macos")]
    fn sync_with_args(
        &self,
        args: Vec<String>,
        emit: impl Fn(String) + Sync,
    ) -> Result<SyncResult, String> {
        let mut transfer = self.transfer.lock().map_err(|error| error.to_string())?;
        if transfer.is_some() {
            return Err("已有目录同步任务在运行。".into());
        }
        let mut child = Command::new(RSYNC)
            .args(args)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动 rsync：{error}"))?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        *transfer = Some(child);
        drop(transfer);
        let lines = Mutex::new(VecDeque::new());
        let record = |line: String| {
            if let Ok(mut lines) = lines.lock() {
                if lines.len() >= 400 {
                    lines.pop_front();
                }
                lines.push_back(line.clone());
            }
            emit(line);
        };
        let result = thread::scope(|scope| {
            scope.spawn(|| stream_log(stdout, &record));
            scope.spawn(|| stream_log(stderr, &record));
            loop {
                let mut transfer = self.transfer.lock().map_err(|error| error.to_string())?;
                let status = transfer
                    .as_mut()
                    .expect("transfer remains reserved")
                    .try_wait()
                    .map_err(|error| error.to_string());
                match status {
                    Ok(None) => {
                        drop(transfer);
                        thread::sleep(Duration::from_millis(100));
                    }
                    Ok(Some(status)) => break Ok(status),
                    Err(error) => break Err(error),
                }
            }
        });
        *self.transfer.lock().map_err(|error| error.to_string())? = None;
        result.map(|status| SyncResult {
            success: status.success(),
            detail: status.to_string(),
            lines: lines.into_inner().unwrap_or_default().into_iter().collect(),
        })
    }
}

#[cfg(target_os = "macos")]
fn stream_log(reader: impl Read, emit: &impl Fn(String)) {
    let mut reader = BufReader::new(reader);
    let mut pending = Vec::new();
    while let Ok(bytes) = reader.fill_buf() {
        if bytes.is_empty() {
            break;
        }
        let length = bytes
            .iter()
            .position(|byte| matches!(*byte, b'\n' | b'\r'))
            .map_or(bytes.len(), |index| index + 1);
        let last = bytes[length - 1];
        let room = 4096_usize.saturating_sub(pending.len());
        pending.extend_from_slice(&bytes[..length.min(room)]);
        reader.consume(length);
        if matches!(last, b'\n' | b'\r') {
            let line = String::from_utf8_lossy(&pending);
            if !line.trim().is_empty() {
                emit(line.trim_end().into());
            }
            pending.clear();
        }
    }
    if !pending.is_empty() {
        emit(String::from_utf8_lossy(&pending).into_owned());
    }
}

#[cfg(target_os = "macos")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    connection: Connection,
    local_dir: PathBuf,
    remote_dir: String,
    direction: Direction,
    preview: bool,
}

#[cfg(target_os = "macos")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Direction {
    Upload,
    Download,
}

#[cfg(target_os = "macos")]
#[derive(Serialize)]
pub struct SyncResult {
    success: bool,
    detail: String,
    lines: Vec<String>,
}

#[cfg(target_os = "macos")]
impl SyncRequest {
    fn args(&self) -> Result<Vec<String>, String> {
        self.connection.validate()?;
        if !self.local_dir.is_absolute() || !self.local_dir.is_dir() {
            return Err("请选择一个已存在的本地目录。".into());
        }
        let local_dir = self
            .local_dir
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if local_dir.parent().is_none() {
            return Err("不能同步整个本地文件系统。".into());
        }
        let local_dir = local_dir
            .to_str()
            .ok_or("本地目录不是有效的 UTF-8 路径。")?;
        let remote_dir = self.remote_dir.trim_end_matches('/');
        if !remote_dir.starts_with('/')
            || remote_dir.len() > 4096
            || remote_dir[1..]
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
            || !remote_dir
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"/._-".contains(&byte))
        {
            return Err(
                "远程目录需为非根目录的绝对路径，仅支持英文、数字、点、下划线和连字符。".into(),
            );
        }
        if self.connection.identity_file.contains(['\'', '"', '\\']) {
            return Err(
                "用于同步的密钥路径不能含引号或反斜杠；可在 ~/.ssh/config 中设置密钥。".into(),
            );
        }
        let ssh = std::iter::once(SSH.into())
            .chain(ssh_args(&self.connection, false))
            .map(|arg| {
                if arg.contains(' ') {
                    format!("'{arg}'")
                } else {
                    arg
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let host = &self.connection.host;
        let remote = if host.contains(':') {
            format!("[{host}]:{remote_dir}/")
        } else {
            format!("{host}:{remote_dir}/")
        };
        let local = format!("{local_dir}/");
        let mut args = vec!["-rti".into(), "--timeout=60".into(), "-e".into(), ssh];
        if self.preview {
            args.push("-n".into());
        }
        args.push("--".into());
        args.extend(match self.direction {
            Direction::Upload => [local, remote],
            Direction::Download => [remote, local],
        });
        Ok(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        Connection {
            id: "00000000-0000-4000-8000-000000000000".into(),
            name: "VM".into(),
            host: "::1".into(),
            username: "operator".into(),
            port: Some(2222),
            identity_file: "~/some key".into(),
            keep_alive: 30,
            tmux: true,
            ..Connection::default()
        }
    }

    #[test]
    fn terminal_uses_pty_host_verification_and_stable_tmux_name() {
        let args = ssh_terminal_args(&connection());
        assert!(args.iter().any(|arg| arg == "-oStrictHostKeyChecking=ask"));
        assert!(args.iter().any(|arg| arg == "-oServerAliveInterval=30"));
        assert!(
            args.ends_with(
                &[
                    "--",
                    "::1",
                    "tmux",
                    "new-session",
                    "-A",
                    "-s",
                    "my-windterm-00000000-0000-4000-8000-000000000000"
                ]
                .map(String::from)
            )
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_unsafe_host_user_and_transfer_paths() {
        let mut target = connection();
        target.host = "-oProxyCommand=foo".into();
        assert!(target.validate().is_err());
        target.host = "example.org".into();
        target.username = "a;bad".into();
        assert!(target.validate().is_err());
        let folder = tempfile::tempdir().unwrap();
        let mut request = SyncRequest {
            connection: connection(),
            local_dir: folder.path().into(),
            remote_dir: "/srv/backup/".into(),
            direction: Direction::Download,
            preview: true,
        };
        let args = request.args().unwrap();
        assert!(
            args.iter()
                .any(|arg| arg.contains("-oStrictHostKeyChecking=yes")
                    && arg.contains("'~/some key'"))
        );
        assert!(args.iter().any(|arg| arg == "-n"));
        assert!(!args.iter().any(|arg| arg.starts_with("--delete")));
        assert_eq!(args[args.len() - 2], "[::1]:/srv/backup/");
        for path in [
            "/",
            "/srv/../etc",
            "/invalid;whoami",
            "/srv/*.log",
            "relative",
        ] {
            request.remote_dir = path.into();
            assert!(request.args().is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "starts an isolated loopback sshd; requires local socket access"]
    fn loopback_ssh_pty_sftp_and_rsync() {
        use std::{
            fs,
            net::{TcpListener, TcpStream},
            sync::mpsc,
            time::Instant,
        };

        struct Server(Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path();
        let host_key = root.join("host");
        let user_key = root.join("test key");
        for path in [&host_key, &user_key] {
            let status = Command::new("/usr/bin/ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(path)
                .status()
                .unwrap();
            assert!(status.success());
        }
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        let server_config = root.join("sshd_config");
        let client_config = root.join("ssh_config");
        let known_hosts = root.join("known_hosts");
        let public_key = fs::read_to_string(host_key.with_extension("pub")).unwrap();
        fs::write(
            &known_hosts,
            format!(
                "[127.0.0.1]:{port} {}\n",
                public_key
                    .split_whitespace()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        )
        .unwrap();
        fs::write(
            &client_config,
            format!(
                "Host *\n  UserKnownHostsFile {}\n  IdentitiesOnly yes\n",
                known_hosts.display()
            ),
        )
        .unwrap();
        fs::write(&server_config, format!("ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nAuthorizedKeysFile \"{}\"\nPidFile {}\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nPrintMotd no\nSubsystem sftp internal-sftp\n", host_key.display(), user_key.with_extension("pub").display(), root.join("sshd.pid").display())).unwrap();
        drop(reservation);
        let _server = Server(
            Command::new("/usr/sbin/sshd")
                .args(["-D", "-e", "-f"])
                .arg(&server_config)
                .spawn()
                .unwrap(),
        );
        let ready = Instant::now() + Duration::from_secs(5);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < ready, "test sshd did not start");
            thread::sleep(Duration::from_millis(50));
        }
        let sessions = Sessions::default();
        let connection = Connection {
            host: "127.0.0.1".into(),
            username: String::new(),
            port: Some(port),
            identity_file: user_key.to_string_lossy().into_owned(),
            tmux: false,
            ..connection()
        };
        let config_path = client_config.to_string_lossy().into_owned();
        let mut args = vec!["-F".into(), config_path.clone()];
        args.extend(ssh_terminal_args(&connection));
        let (sender, receiver) = mpsc::channel();
        sessions
            .launch_pty(
                connection.id.clone(),
                args.clone(),
                size(90, 30),
                None,
                move |event| sender.send(event).is_ok(),
            )
            .unwrap();
        sessions.resize(&connection.id, 100, 40).unwrap();
        let script = "printf 'PTY-%s\\n' 'SMOKE'; stty size; exit\n";
        sessions
            .input(&connection.id, &STANDARD.encode(script))
            .unwrap();
        let mut output = Vec::new();
        let mut authenticated_terminal = false;
        loop {
            match receiver.recv_timeout(Duration::from_secs(15)).unwrap() {
                SessionEvent::Data { data, interactive } => {
                    authenticated_terminal |= interactive;
                    output.extend(STANDARD.decode(data).unwrap());
                }
                SessionEvent::Exit { .. } => break,
            }
        }
        let output = String::from_utf8_lossy(&output);
        assert!(
            output.contains("PTY-SMOKE") && output.contains("40 100"),
            "unexpected PTY output: {output}"
        );
        assert!(
            authenticated_terminal,
            "OpenSSH did not report an interactive PTY"
        );

        let local = root.join("local");
        let remote = root.join("remote");
        fs::create_dir(&local).unwrap();
        fs::create_dir(&remote).unwrap();
        fs::write(local.join("example.txt"), b"example").unwrap();
        fs::write(remote.join("keep.txt"), b"do not delete").unwrap();
        let sftp_id = "00000000-0000-4000-8000-000000000001".to_owned();
        let (sender, receiver) = mpsc::channel();
        sessions
            .launch_pty(sftp_id.clone(), args, size(90, 30), None, move |event| {
                sender.send(event).is_ok()
            })
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), sessions.wait_for_sftp(&sftp_id))
                .await
                .unwrap()
                .unwrap();
            let socket = sessions.control_socket(&sftp_id).unwrap();
            let permissions = fs::metadata(socket.parent().unwrap())
                .unwrap()
                .permissions();
            assert_eq!(permissions.mode() & 0o077, 0);
            crate::sftp::tests::exercise(socket, &local, &remote).await;
        });
        sessions
            .input(&sftp_id, &STANDARD.encode("exit\n"))
            .unwrap();
        loop {
            if matches!(
                receiver.recv_timeout(Duration::from_secs(10)).unwrap(),
                SessionEvent::Exit { .. }
            ) {
                break;
            }
        }
        assert!(sessions.control_socket(&sftp_id).is_err());
        let mut request = SyncRequest {
            connection,
            local_dir: local.clone(),
            remote_dir: remote
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            direction: Direction::Upload,
            preview: true,
        };
        let transfer = |request: &SyncRequest| {
            let mut args = request.args().unwrap();
            let shell = args.iter().position(|arg| arg == "-e").unwrap() + 1;
            args[shell].push_str(&format!(" -F '{config_path}'"));
            let result = sessions.sync_with_args(args, |_| {}).unwrap();
            assert!(
                result.success,
                "{}\n{}",
                result.detail,
                result.lines.join("\n")
            );
            result
        };
        assert!(
            transfer(&request)
                .lines
                .iter()
                .any(|line| line.contains("example.txt"))
        );
        assert!(!remote.join("example.txt").exists());
        request.preview = false;
        transfer(&request);
        assert_eq!(fs::read(remote.join("example.txt")).unwrap(), b"example");
        assert!(remote.join("keep.txt").exists());
        request.direction = Direction::Download;
        transfer(&request);
        assert_eq!(fs::read(local.join("keep.txt")).unwrap(), b"do not delete");
    }
}
