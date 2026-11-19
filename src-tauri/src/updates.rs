use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const LATEST: &str = "https://api.github.com/repos/zzxCNCZ/my-windterm/releases/latest";
pub const RELEASES: &str = "https://github.com/zzxCNCZ/my-windterm/releases";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    current: String,
    latest: Option<String>,
    available: bool,
    url: String,
}

fn stable_latest(current: &Version, release: Option<Release>) -> Result<Update, String> {
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
        .is_some_and(|latest| latest.pre.is_empty() && latest.cmp_precedence(current).is_gt());
    Ok(Update {
        current: current.to_string(),
        latest: latest.map(|version| version.to_string()),
        available,
        url: if available {
            format!("{RELEASES}/tag/{}", tag.unwrap_or_default())
        } else {
            RELEASES.into()
        },
    })
}

#[tauri::command]
pub async fn check_updates(app: tauri::AppHandle) -> Result<Update, String> {
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
    let mut command = {
        #[cfg(target_os = "macos")]
        {
            tokio::process::Command::new("/usr/bin/open")
        }
        #[cfg(windows)]
        {
            tokio::process::Command::new(crate::platform::system_directory()?.join("rundll32.exe"))
        }
    };
    #[cfg(windows)]
    command.arg("url.dll,FileProtocolHandler");
    let status = command
        .arg(url)
        .status()
        .await
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Unable to open the release page.".into())
    }
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
}
