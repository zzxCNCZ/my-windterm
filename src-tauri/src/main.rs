#[cfg(target_os = "macos")]
mod askpass;
mod config;
mod platform;
mod remote;
#[cfg(target_os = "macos")]
mod sftp;
mod updates;

use config::{ConfigStore, Connection, Profile, ProfileView};
use remote::{SessionEvent, Sessions};
#[cfg(target_os = "macos")]
use remote::{SyncRequest, SyncResult};
use serde::Serialize;
#[cfg(target_os = "macos")]
use sftp::{FileTransfers, Progress, TransferRequest};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use tauri::{Manager, State, ipc::Channel};

type SharedConfig = Arc<Mutex<ConfigStore>>;

fn validate_clipboard_text(text: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > 16_384 || text.chars().any(char::is_control) {
        return Err("命令文本无效，未复制。".into());
    }
    Ok(())
}

#[tauri::command]
fn copy_outline_command(text: String, window: tauri::WebviewWindow) -> Result<(), String> {
    validate_clipboard_text(&text)?;
    #[cfg(windows)]
    return platform::clipboard(&text, &window);
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        platform::clipboard(&text)
    }
}

#[cfg(test)]
mod clipboard_tests {
    use super::*;

    #[test]
    fn refuses_invalid_commands_before_accessing_clipboard() {
        for text in ["", "ls\n", "echo\x1b[0m"] {
            assert!(validate_clipboard_text(text).is_err());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires access to the macOS pasteboard service"]
    fn writes_exact_command_as_plain_text_without_touching_general_clipboard() {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        let command = "cat '目录/文件.txt' | head -n 5";
        platform::write_pasteboard(&pasteboard, command).unwrap();
        let copied = pasteboard
            .stringForType(unsafe { NSPasteboardTypeString })
            .unwrap();
        assert_eq!(copied.to_string(), command);
    }
}

#[tauri::command]
async fn load_profile(store: State<'_, SharedConfig>) -> Result<ProfileView, String> {
    let store = store.inner().clone();
    blocking(move || store.lock().map_err(|error| error.to_string())?.load()).await
}

#[tauri::command]
async fn save_profile(
    store: State<'_, SharedConfig>,
    profile: Profile,
    etag: String,
) -> Result<ProfileView, String> {
    let store = store.inner().clone();
    blocking(move || {
        store
            .lock()
            .map_err(|error| error.to_string())?
            .save(profile, &etag)
    })
    .await
}

#[tauri::command]
async fn select_profile_folder(
    store: State<'_, SharedConfig>,
    folder: Option<PathBuf>,
    migrate_etag: Option<String>,
) -> Result<ProfileView, String> {
    let store = store.inner().clone();
    blocking(move || {
        store
            .lock()
            .map_err(|error| error.to_string())?
            .select_dir(folder, migrate_etag.as_deref())
    })
    .await
}

#[tauri::command]
async fn start_session(
    sessions: State<'_, Sessions>,
    id: String,
    connection: Connection,
    cols: u16,
    rows: u16,
    events: Channel<SessionEvent>,
) -> Result<(), String> {
    let sessions = sessions.inner().clone();
    blocking(move || {
        sessions.start(id, connection, cols, rows, move |event| {
            events.send(event).is_ok()
        })
    })
    .await
}

#[tauri::command]
async fn session_input(
    sessions: State<'_, Sessions>,
    id: String,
    data: String,
) -> Result<(), String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.input(&id, &data)).await
}

#[tauri::command]
fn session_resize(
    sessions: State<'_, Sessions>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    sessions.resize(&id, cols, rows)
}

#[tauri::command]
async fn stop_session(sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.stop(&id)).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn sync_folder(
    sessions: State<'_, Sessions>,
    request: SyncRequest,
    events: Channel<String>,
) -> Result<SyncResult, String> {
    let sessions = sessions.inner().clone();
    blocking(move || {
        sessions.sync_folder(request, move |line| {
            let _ = events.send(line);
        })
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn stop_sync(sessions: State<'_, Sessions>) -> Result<(), String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.stop_sync()).await
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Filer {
    path: PathBuf,
    parent: Option<PathBuf>,
    entries: Vec<FileEntry>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: PathBuf,
    directory: bool,
    regular: bool,
    symlink: bool,
    size: u64,
    modified: Option<u64>,
}

#[tauri::command]
async fn list_directory(
    app: tauri::AppHandle,
    path: Option<PathBuf>,
    show_hidden: bool,
) -> Result<Filer, String> {
    let path = match path {
        Some(path) if path.is_absolute() => path,
        Some(_) => return Err("请输入绝对目录。".into()),
        None => app.path().home_dir().map_err(|error| error.to_string())?,
    };
    blocking(move || {
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        let mut entries = Vec::new();
        for item in fs::read_dir(&path)
            .map_err(|error| error.to_string())?
            .flatten()
        {
            let Some(name) = item.file_name().into_string().ok() else {
                continue;
            };
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            let Ok(metadata) = fs::metadata(item.path()) else {
                continue;
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_secs());
            entries.push(FileEntry {
                name,
                path: item.path(),
                directory: metadata.is_dir(),
                regular: metadata.is_file(),
                symlink: item.file_type().is_ok_and(|kind| kind.is_symlink()),
                size: metadata.len(),
                modified,
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
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn wait_for_sftp(sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.wait_for_sftp(&id).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn list_remote_directory(
    sessions: State<'_, Sessions>,
    id: String,
    path: Option<PathBuf>,
    show_hidden: bool,
) -> Result<Filer, String> {
    sftp::list(sessions.control_socket(&id)?, path, show_hidden).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn transfer_file(
    sessions: State<'_, Sessions>,
    transfers: State<'_, FileTransfers>,
    request: TransferRequest,
    events: Channel<Progress>,
) -> Result<u64, String> {
    let socket = sessions.control_socket(&request.session_id)?;
    transfers
        .run(socket, request, |progress| {
            let _ = events.send(progress);
        })
        .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn cancel_file_transfer(transfers: State<'_, FileTransfers>, id: String) -> Result<(), String> {
    transfers.cancel(&id)
}

#[tauri::command]
fn platform_features() -> PlatformFeatures {
    PlatformFeatures {
        remote_files: cfg!(target_os = "macos"),
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformFeatures {
    remote_files: bool,
    version: &'static str,
}

fn main() {
    #[cfg(target_os = "macos")]
    if let Some(success) = askpass::helper() {
        std::process::exit(i32::from(!success));
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Sessions::default());
    #[cfg(target_os = "macos")]
    let builder = builder.manage(FileTransfers::default());
    builder
        .setup(|app| {
            app.manage(Arc::new(Mutex::new(ConfigStore::new(
                app.path().app_config_dir()?,
            ))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            copy_outline_command,
            platform_features,
            updates::check_updates,
            updates::open_release_page,
            load_profile,
            save_profile,
            select_profile_folder,
            start_session,
            session_input,
            session_resize,
            stop_session,
            list_directory,
            #[cfg(target_os = "macos")]
            sync_folder,
            #[cfg(target_os = "macos")]
            stop_sync,
            #[cfg(target_os = "macos")]
            wait_for_sftp,
            #[cfg(target_os = "macos")]
            list_remote_directory,
            #[cfg(target_os = "macos")]
            transfer_file,
            #[cfg(target_os = "macos")]
            cancel_file_transfer
        ])
        .build(tauri::generate_context!())
        .expect("failed to initialize My WindTerm")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit
                    | tauri::RunEvent::WindowEvent {
                        event: tauri::WindowEvent::Destroyed,
                        ..
                    }
            ) {
                app.state::<Sessions>().shutdown();
            }
        });
}
