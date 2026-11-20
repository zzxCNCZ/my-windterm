use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_updater::{Update as Package, UpdaterExt};

const LATEST: &str = "https://api.github.com/repos/zzxCNCZ/my-windterm/releases/latest";
pub const RELEASES: &str = "https://github.com/zzxCNCZ/my-windterm/releases";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    latest: Option<String>,
    available: bool,
    installable: bool,
    url: String,
}

#[derive(Default)]
pub struct InstallLock(tokio::sync::Mutex<()>);

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallProgress {
    Downloading { received: u64, total: Option<u64> },
    Installing,
}

fn is_new_stable(current: &Version, latest: &Version) -> bool {
    latest.pre.is_empty() && latest.cmp_precedence(current).is_gt()
}

fn stable_latest(current: &Version, release: Option<Release>) -> Result<UpdateStatus, String> {
    let tag = release.map(|release| release.tag_name);
    let latest = tag
        .as_deref()
        .map(|tag| {
            Version::parse(tag.strip_prefix('v').unwrap_or(tag))
                .map_err(|_| "GitHub returned an invalid release version.".to_string())
        })
        .transpose()?;
    let available = latest
        .as_ref()
        .is_some_and(|latest| is_new_stable(current, latest));
    Ok(UpdateStatus {
        latest: latest.map(|version| version.to_string()),
        available,
        installable: false,
        url: if available {
            format!("{RELEASES}/tag/{}", tag.unwrap_or_default())
        } else {
            RELEASES.into()
        },
    })
}

fn package_tag<'a>(version: &str, url: &'a str) -> Option<&'a str> {
    let (tag, filename) = url
        .strip_prefix(RELEASES)?
        .strip_prefix("/download/")?
        .split_once('/')?;
    let valid_tag = tag.strip_prefix('v').unwrap_or(tag) == version;
    let valid_file = !filename.is_empty() && !filename.contains(['/', '?', '#']);
    (valid_tag && valid_file).then_some(tag)
}

#[cfg(target_os = "macos")]
fn in_application_bundle(executable: &std::path::Path) -> bool {
    executable.parent().is_some_and(|directory| {
        directory.ends_with("Contents/MacOS")
            && directory
                .parent()
                .and_then(std::path::Path::parent)
                .and_then(std::path::Path::extension)
                .is_some_and(|extension| extension == "app")
    })
}

async fn signed_package(app: &AppHandle) -> Result<Option<Package>, String> {
    let builder = app
        .updater_builder()
        .timeout(Duration::from_secs(10))
        .version_comparator(|current, release| is_new_stable(&current, &release.version));
    #[cfg(target_os = "macos")]
    let builder = {
        // Tauri otherwise falls back to replacing the executable's parent directory.
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        if !in_application_bundle(&executable) {
            return Err("Updates require an installed macOS application bundle.".into());
        }
        builder.executable_path(executable)
    };
    let updater = builder.build().map_err(|error| error.to_string())?;
    let package = updater.check().await.map_err(|error| error.to_string())?;
    if let Some(package) = &package
        && package_tag(&package.version, package.download_url.as_str()).is_none()
    {
        return Err("Invalid GitHub update asset URL.".into());
    }
    Ok(package)
}

#[tauri::command]
pub async fn check_updates(app: AppHandle) -> Result<UpdateStatus, String> {
    match signed_package(&app).await {
        Ok(Some(package)) => {
            let tag = package_tag(&package.version, package.download_url.as_str())
                .ok_or("Invalid GitHub update asset URL.")?;
            return Ok(UpdateStatus {
                latest: Some(package.version.clone()),
                available: true,
                installable: true,
                url: format!("{RELEASES}/tag/{tag}"),
            });
        }
        Ok(None) => {
            return Ok(UpdateStatus {
                latest: Some(app.package_info().version.to_string()),
                available: false,
                installable: false,
                url: RELEASES.into(),
            });
        }
        Err(_) => {} // Fall back to the release page if the signed feed is unavailable.
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("MyWindTerm/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let release = match response.status() {
        reqwest::StatusCode::OK => Some(
            response
                .json::<Release>()
                .await
                .map_err(|error| error.to_string())?,
        ),
        reqwest::StatusCode::NOT_FOUND => None,
        status => return Err(format!("GitHub HTTP {status}")),
    };
    stable_latest(&app.package_info().version, release)
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    lock: State<'_, InstallLock>,
    version: String,
    progress: Channel<InstallProgress>,
) -> Result<(), String> {
    let _guard = lock.0.try_lock().map_err(|_| "已有更新正在安装。")?;
    let mut package = signed_package(&app)
        .await?
        .filter(|package| package.version == version)
        .ok_or("可用版本已变化，请重新检查更新。")?;
    package.timeout = Some(Duration::from_secs(600));
    let mut received = 0;
    let mut last_report = None;
    package
        .download_and_install(
            |length, total| {
                received += length as u64;
                let now = Instant::now();
                if last_report.is_none_or(|last| now - last >= Duration::from_millis(100))
                    || total == Some(received)
                {
                    last_report = Some(now);
                    let _ = progress.send(InstallProgress::Downloading { received, total });
                }
            },
            || {
                let _ = progress.send(InstallProgress::Installing);
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    // On Windows the NSIS installer relaunches the app.
    #[cfg(target_os = "macos")]
    app.request_restart();
    Ok(())
}

pub fn release_url(url: &str) -> bool {
    url == RELEASES
        || url
            .strip_prefix(&format!("{RELEASES}/tag/"))
            .is_some_and(|tag| Version::parse(tag.strip_prefix('v').unwrap_or(tag)).is_ok())
}

#[tauri::command]
pub async fn open_release_page(url: String) -> Result<(), String> {
    if !release_url(&url) {
        return Err("Invalid release URL.".into());
    }
    crate::platform::open_browser(&url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_semver_and_only_offers_stable_new_releases() {
        let current = Version::parse("1.9.0").unwrap();
        let result = |tag: &str| {
            stable_latest(
                &current,
                Some(Release {
                    tag_name: tag.into(),
                }),
            )
        };
        assert!(result("v1.10.0").unwrap().available);
        assert!(!result("v1.10.0").unwrap().installable);
        assert_eq!(
            result("1.10.0").unwrap().url,
            format!("{RELEASES}/tag/1.10.0")
        );
        for tag in ["1.9.0", "1.9.0+other", "1.8.0", "2.0.0-rc.1"] {
            assert!(!result(tag).unwrap().available);
        }
        assert!(result("../other").is_err());
        assert!(stable_latest(&current, None).unwrap().latest.is_none());
        assert!(release_url(&format!("{RELEASES}/tag/1.10.0")));
        assert!(!release_url(&format!("{RELEASES}/tag/../other")));
    }

    #[test]
    fn accepts_only_assets_for_the_announced_repository_release() {
        let url = |tag: &str| format!("{RELEASES}/download/{tag}/package.exe");
        for tag in ["1.2.0", "v1.2.0"] {
            assert_eq!(package_tag("1.2.0", &url(tag)), Some(tag));
        }
        assert!(package_tag("1.2.0", &url("v1.1.1")).is_none());
        assert!(package_tag("1.2.0", &url("v1.2.0").replace("zzxCNCZ", "other")).is_none());
        assert!(package_tag("1.2.0", &format!("{}?url=other", url("v1.2.0"))).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_updates_macos_executables_inside_an_application_bundle() {
        use std::path::Path;
        assert!(in_application_bundle(Path::new(
            "/Applications/My WindTerm.app/Contents/MacOS/my-windterm"
        )));
        assert!(!in_application_bundle(Path::new(
            "/project/target/debug/my-windterm"
        )));
        assert!(!in_application_bundle(Path::new(
            "/project/Contents/MacOS/my-windterm"
        )));
    }
}
