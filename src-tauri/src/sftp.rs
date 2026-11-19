use crate::{FileEntry, Filer, platform::SSH};
use futures_util::StreamExt;
use openssh_sftp_client::{Sftp, SftpOptions};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::oneshot,
    time::timeout,
};

const TIMEOUT: Duration = Duration::from_secs(25);
const BLOCK: usize = 64 * 1024;

async fn deadline<T, E: std::fmt::Display>(
    operation: impl Future<Output = Result<T, E>>,
) -> Result<T, String> {
    timeout(TIMEOUT, operation)
        .await
        .map_err(|_| "SFTP 请求超时。".to_owned())?
        .map_err(|error| error.to_string())
}

async fn connect(socket: &Path) -> Result<(Child, Sftp), String> {
    if !socket.exists() {
        return Err("SSH 尚未完成认证，或会话已断开。".into());
    }
    let mut child = Command::new(SSH)
        .args([
            "-F",
            "/dev/null",
            "-T",
            "-oBatchMode=yes",
            "-oControlMaster=no",
            "-oProxyCommand=/usr/bin/false",
            "-S",
        ])
        .arg(socket)
        .args(["-s", "--", "my-windterm.invalid", "sftp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("无法启动 SFTP：{error}"))?;
    let sftp = deadline(Sftp::new(
        child.stdin.take().expect("piped stdin"),
        child.stdout.take().expect("piped stdout"),
        SftpOptions::default(),
    ))
    .await
    .map_err(|error| format!("无法打开 SFTP 通道，请确认 SSH 在线且服务端允许 SFTP：{error}"))?;
    Ok((child, sftp))
}

fn safe_name(path: &Path) -> Option<&str> {
    let name = path.to_str()?;
    if name.len() > 1024 || name.chars().any(char::is_control) || name.contains('/') {
        return None;
    }
    matches!(path.components().next(), Some(Component::Normal(_))).then_some(name)
}

fn absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|value| value.len() > 4096 || value.contains('\0'))
    {
        Err("路径必须是有效的绝对路径。".into())
    } else {
        Ok(())
    }
}

pub async fn list(
    socket: PathBuf,
    path: Option<PathBuf>,
    show_hidden: bool,
) -> Result<Filer, String> {
    if let Some(path) = &path {
        absolute(path)?;
    }
    let (_child, sftp) = connect(&socket).await?;
    let result = deadline(read_directory(
        &sftp,
        path.as_deref().unwrap_or(Path::new(".")),
        show_hidden,
    ))
    .await;
    let _ = timeout(Duration::from_secs(2), sftp.close()).await;
    result
}

async fn read_directory(sftp: &Sftp, path: &Path, show_hidden: bool) -> Result<Filer, String> {
    let mut fs = sftp.fs();
    let path = fs
        .canonicalize(path)
        .await
        .map_err(|error| error.to_string())?;
    absolute(&path)?;
    let mut directory = std::pin::pin!(
        fs.open_dir(&path)
            .await
            .map_err(|error| error.to_string())?
            .read_dir()
    );
    let mut entries = Vec::new();
    while let Some(entry) = directory.next().await {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(name) = safe_name(entry.filename()) else {
            continue;
        };
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let metadata = entry.metadata();
        let kind = metadata.file_type();
        entries.push(FileEntry {
            name: name.into(),
            path: path.join(name),
            directory: kind.is_some_and(|kind| kind.is_dir()),
            regular: kind.is_some_and(|kind| kind.is_file()),
            symlink: kind.is_some_and(|kind| kind.is_symlink()),
            size: metadata.len().unwrap_or(0),
            modified: metadata.modified().map(|time| u64::from(time.into_raw())),
        });
        if entries.len() > 2000 {
            break;
        }
    }
    let truncated = entries.len() > 2000;
    entries.truncate(2000);
    entries.sort_by_cached_key(|entry| (!entry.directory, entry.name.to_lowercase()));
    Ok(Filer {
        parent: path.parent().map(ToOwned::to_owned),
        path,
        entries,
        truncated,
    })
}

#[derive(Default)]
pub struct FileTransfers(Mutex<Option<TransferSlot>>);

struct TransferSlot {
    id: String,
    cancel: Option<oneshot::Sender<()>>,
}

struct TransferGuard<'a>(&'a FileTransfers);

impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.0.lock() {
            *slot = None;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    id: String,
    pub session_id: String,
    local_path: PathBuf,
    remote_path: PathBuf,
    direction: Direction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Direction {
    Upload,
    Download,
}

#[derive(Clone, Serialize)]
pub struct Progress {
    bytes: u64,
    total: Option<u64>,
}

const CANCELLED: &str = "SFTP 传输已取消。";

impl FileTransfers {
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|error| error.to_string())?;
        if let Some(task) = slot.as_mut().filter(|task| task.id == id)
            && let Some(cancel) = task.cancel.take()
        {
            let _ = cancel.send(());
        }
        Ok(())
    }

    pub async fn run(
        &self,
        socket: PathBuf,
        request: TransferRequest,
        emit: impl Fn(Progress),
    ) -> Result<u64, String> {
        absolute(&request.local_path)?;
        absolute(&request.remote_path)?;
        for path in [&request.local_path, &request.remote_path] {
            if path
                .file_name()
                .and_then(|name| safe_name(Path::new(name)))
                .is_none()
            {
                return Err("请选择有效的文件名。".into());
            }
        }
        let (sender, mut cancel) = oneshot::channel();
        {
            let mut slot = self.0.lock().map_err(|error| error.to_string())?;
            if slot.is_some() {
                return Err("已有 SFTP 文件传输。".into());
            }
            *slot = Some(TransferSlot {
                id: request.id,
                cancel: Some(sender),
            });
        }
        let _guard = TransferGuard(self);
        let (_child, sftp) = tokio::select! {
            _ = &mut cancel => return Err(CANCELLED.into()),
            result = connect(&socket) => result?,
        };
        let mut meter = Meter {
            report: emit,
            last: Instant::now(),
            bytes: 0,
            total: None,
        };
        let result = match request.direction {
            Direction::Upload => {
                upload(
                    &sftp,
                    &request.local_path,
                    &request.remote_path,
                    &mut cancel,
                    &mut meter,
                )
                .await
            }
            Direction::Download => {
                download(
                    &sftp,
                    &request.remote_path,
                    &request.local_path,
                    &mut cancel,
                    &mut meter,
                )
                .await
            }
        };
        let _ = timeout(Duration::from_secs(2), sftp.close()).await;
        result.map(|()| {
            meter.emit();
            meter.bytes
        })
    }
}

struct Meter<F> {
    report: F,
    last: Instant,
    bytes: u64,
    total: Option<u64>,
}

impl<F: Fn(Progress)> Meter<F> {
    fn emit(&self) {
        (self.report)(Progress {
            bytes: self.bytes,
            total: self.total,
        });
    }
    fn advance(&mut self, count: usize) {
        self.bytes += count as u64;
        if self.last.elapsed() >= Duration::from_millis(160) {
            self.emit();
            self.last = Instant::now();
        }
    }
}

async fn upload(
    sftp: &Sftp,
    local: &Path,
    remote: &Path,
    cancel: &mut oneshot::Receiver<()>,
    meter: &mut Meter<impl Fn(Progress)>,
) -> Result<(), String> {
    if !deadline(fs::symlink_metadata(local)).await?.is_file() {
        return Err("仅支持上传普通文件（不跟随符号链接）。".into());
    }
    let mut input = deadline(
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(local),
    )
    .await?;
    let metadata = deadline(input.metadata()).await?;
    if !metadata.is_file() {
        return Err("仅支持上传普通文件。".into());
    }
    meter.total = Some(metadata.len());
    meter.emit();
    let mut options = sftp.options();
    options.write(true).create_new(true);
    let mut output = deadline(options.open(remote))
        .await
        .map_err(|error| format!("无法创建远程文件（不会覆盖同名文件）：{error}"))?;
    let result = async {
        let mut buffer = vec![0; BLOCK];
        loop {
            let count = tokio::select! {
                _ = &mut *cancel => return Err(CANCELLED.into()),
                read = deadline(input.read(&mut buffer)) => read?,
            };
            if count == 0 {
                break;
            }
            deadline(output.write_all(&buffer[..count])).await?;
            meter.advance(count);
        }
        Ok::<_, String>(())
    }
    .await;
    let closed = deadline(output.close()).await;
    let failure = result.and(closed);
    if failure.is_err()
        && timeout(Duration::from_secs(3), sftp.fs().remove_file(remote))
            .await
            .is_ok_and(|result| result.is_ok())
    {
        return failure;
    }
    failure.map_err(|error| format!("{error} 远程可能残留未完成的文件。"))
}

async fn download(
    sftp: &Sftp,
    remote: &Path,
    local: &Path,
    cancel: &mut oneshot::Receiver<()>,
    meter: &mut Meter<impl Fn(Progress)>,
) -> Result<(), String> {
    let metadata = deadline(sftp.fs().symlink_metadata(remote)).await?;
    if !metadata.file_type().is_some_and(|kind| kind.is_file()) {
        return Err("仅支持下载普通文件（不跟随符号链接）。".into());
    }
    let mut input = deadline(sftp.open(remote)).await?;
    let metadata = deadline(input.metadata()).await?;
    if !metadata.file_type().is_some_and(|kind| kind.is_file()) {
        return Err("仅支持下载普通文件。".into());
    }
    meter.total = metadata.len();
    meter.emit();
    if fs::symlink_metadata(local).await.is_ok() {
        return Err("本地已存在同名文件，不会覆盖。".into());
    }
    let parent = local.parent().ok_or("缺少本地父目录。")?.to_owned();
    let (output, temp) = tokio::task::spawn_blocking(move || {
        tempfile::NamedTempFile::new_in(parent).map(|file| file.into_parts())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let mut output = fs::File::from_std(output);
    let mut buffer = Default::default();
    loop {
        let next = tokio::select! {
            _ = &mut *cancel => return Err(CANCELLED.into()),
            read = deadline(input.read(BLOCK as u32, buffer)) => read?,
        };
        let Some(mut chunk) = next else { break };
        deadline(output.write_all(&chunk)).await?;
        meter.advance(chunk.len());
        chunk.clear();
        buffer = chunk;
    }
    deadline(input.close()).await?;
    deadline(output.flush()).await?;
    drop(output);
    let local = local.to_owned();
    tokio::task::spawn_blocking(move || temp.persist_noclobber(local))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("无法保存本地文件（不会覆盖同名文件）：{error}"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn accepts_unicode_and_spaces_but_not_path_components_from_listings() {
        for name in ["报告 1.txt", "a[b]*.txt", ".hidden"] {
            assert_eq!(safe_name(Path::new(name)), Some(name));
        }
        for name in [".", "..", "a/", "/a", "other/file", "bad\nname", ""] {
            assert!(safe_name(Path::new(name)).is_none());
        }
    }

    pub(crate) async fn exercise(socket: PathBuf, local: &Path, remote: &Path) {
        use std::{fs, os::unix::fs::symlink};

        let missing_socket = local.join("missing-socket");
        assert!(list(missing_socket, None, false).await.is_err());
        assert!(
            list(socket.clone(), None, false)
                .await
                .unwrap()
                .path
                .is_absolute()
        );
        let remote = remote.canonicalize().unwrap();
        fs::create_dir(remote.join("子目录")).unwrap();
        fs::write(remote.join(".hidden"), b"hidden").unwrap();
        symlink("keep.txt", remote.join("link")).unwrap();
        let listing = list(socket.clone(), Some(remote.clone()), false)
            .await
            .unwrap();
        assert_eq!(listing.parent.as_deref(), remote.parent());
        assert_eq!(listing.entries[0].name, "子目录");
        assert!(listing.entries[0].directory);
        assert!(
            listing
                .entries
                .iter()
                .any(|entry| entry.name == "link" && entry.symlink && !entry.regular)
        );
        assert!(!listing.entries.iter().any(|entry| entry.name == ".hidden"));
        let listing = list(socket.clone(), Some(remote.clone()), true)
            .await
            .unwrap();
        assert!(listing.entries.iter().any(|entry| entry.name == ".hidden"));

        let transfers = FileTransfers::default();
        let uploaded = remote.join("报告 [1].txt");
        let downloaded = local.join("SFTP 下载.txt");
        let contents = b"\x00SFTP\xff".repeat(35_000);
        fs::write(local.join("upload.bin"), &contents).unwrap();
        let request = |direction, local_path, remote_path| TransferRequest {
            id: "transfer".into(),
            session_id: "fixture".into(),
            local_path,
            remote_path,
            direction,
        };
        let upload = || {
            request(
                Direction::Upload,
                local.join("upload.bin"),
                uploaded.clone(),
            )
        };
        let download = || request(Direction::Download, downloaded.clone(), uploaded.clone());
        assert_eq!(
            transfers
                .run(socket.clone(), upload(), |_| {})
                .await
                .unwrap(),
            contents.len() as u64
        );
        assert!(
            transfers
                .run(socket.clone(), upload(), |_| {})
                .await
                .is_err()
        );
        assert_eq!(
            transfers
                .run(socket.clone(), download(), |_| {})
                .await
                .unwrap(),
            contents.len() as u64
        );
        assert!(
            transfers
                .run(socket.clone(), download(), |_| {})
                .await
                .is_err()
        );
        assert_eq!(fs::read(&downloaded).unwrap(), contents);
        let link = request(
            Direction::Download,
            local.join("rejected.txt"),
            remote.join("link"),
        );
        assert!(transfers.run(socket.clone(), link, |_| {}).await.is_err());
        assert!(!local.join("rejected.txt").exists());
        let cancelled_path = remote.join("cancelled.bin");
        let cancelled = request(
            Direction::Upload,
            local.join("upload.bin"),
            cancelled_path.clone(),
        );
        let error = transfers
            .run(socket, cancelled, |_| transfers.cancel("transfer").unwrap())
            .await
            .unwrap_err();
        assert_eq!(error, CANCELLED);
        assert!(!cancelled_path.exists());
        fs::remove_file(remote.join("link")).unwrap();
    }
}
