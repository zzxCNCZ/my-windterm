use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::HashSet,
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

const CONFIG_FILE: &str = "my-windterm.json";
const MAX_CONFIG: u64 = 1024 * 1024;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub group_id: Option<String>,
    pub identity_file: String,
    pub keep_alive: u16,
    pub tmux: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    version: u8,
    pub groups: Vec<Group>,
    pub connections: Vec<Connection>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            version: 1,
            groups: vec![],
            connections: vec![],
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicePrefs {
    profile_dir: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub profile: Profile,
    pub etag: String,
    profile_path: PathBuf,
    custom_folder: bool,
}

pub struct ConfigStore {
    device_dir: PathBuf,
}

pub fn valid_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 100 && !value.chars().any(char::is_control)
}

impl Connection {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.id) || !valid_name(&self.name) {
            return Err("连接 ID 或名称无效。".into());
        }
        let host = self.host.as_bytes();
        let ipv6 = self.host.contains(':') && self.host.parse::<std::net::Ipv6Addr>().is_ok();
        let hostname = host.first().is_some_and(u8::is_ascii_alphanumeric)
            && host
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(byte));
        if host.len() > 253 || !(ipv6 || hostname) {
            return Err("请输入主机名、SSH 别名或 IP（IPv6 不加方括号）；端口请单独填写。".into());
        }
        if self.username.len() > 64
            || self.username.starts_with('-')
            || !self
                .username
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err("用户名只能包含英文字母、数字、点、下划线或连字符。".into());
        }
        if self.port == Some(0) || self.keep_alive > 3600 {
            return Err("端口或保活间隔超出范围。".into());
        }
        if self.password.as_ref().is_some_and(|password| {
            password.is_empty() || password.len() > 512 || password.contains(['\0', '\r', '\n'])
        }) {
            return Err("SSH 密码须为 1–512 字节，不能含换行或空字符。".into());
        }
        if !self.identity_file.is_empty()
            && (!Path::new(&self.identity_file).is_absolute()
                && !self.identity_file.starts_with("~/")
                || self.identity_file.len() > 4096
                || self.identity_file.contains(['%', '$'])
                || self.identity_file.chars().any(char::is_control))
        {
            return Err("密钥需使用绝对路径或 ~/ 开头的路径，不支持 SSH 路径变量。".into());
        }
        Ok(())
    }
}

impl Profile {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.groups.len() > 500 || self.connections.len() > 2000 {
            return Err("配置版本不受支持，或项目数超限。".into());
        }
        let mut groups = HashSet::new();
        for group in &self.groups {
            if !valid_id(&group.id) || !valid_name(&group.name) || !groups.insert(&group.id) {
                return Err("分组名称或 ID 无效，或 ID 重复。".into());
            }
        }
        let mut connections = HashSet::new();
        for connection in &self.connections {
            connection.validate()?;
            if !connections.insert(&connection.id)
                || connection
                    .group_id
                    .as_ref()
                    .is_some_and(|id| !groups.contains(id))
            {
                return Err("连接 ID 重复，或引用了不存在的分组。".into());
            }
        }
        Ok(())
    }
}

fn read<T: DeserializeOwned>(path: &Path) -> Result<(T, String), io::Error> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::other("不是普通文件"));
    }
    let file = fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("不是普通文件"));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_CONFIG + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err(io::Error::other("配置文件超过 1 MiB"));
    }
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    bytes.hash(&mut hasher);
    Ok((
        serde_json::from_slice(&bytes)?,
        format!("{:016x}", hasher.finish()),
    ))
}

fn write(path: &Path, value: &impl Serialize, replace: bool) -> Result<(), io::Error> {
    let bytes = Zeroizing::new(serde_json::to_vec_pretty(value)?);
    if bytes.len() as u64 >= MAX_CONFIG {
        return Err(io::Error::other("配置文件超过 1 MiB"));
    }
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::other("缺少父目录"))?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    if replace {
        file.persist(path)
    } else {
        file.persist_noclobber(path)
    }
    .map_err(|error| error.error)?;
    Ok(())
}

impl ConfigStore {
    pub fn new(device_dir: PathBuf) -> Self {
        Self { device_dir }
    }

    fn prefs(&self) -> Result<DevicePrefs, String> {
        match read(&self.device_dir.join("device.json")) {
            Ok((prefs, _)) => Ok(prefs),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DevicePrefs::default()),
            Err(error) => Err(format!("读取设备设置失败：{error}")),
        }
    }

    fn path(&self, prefs: &DevicePrefs) -> PathBuf {
        prefs
            .profile_dir
            .as_ref()
            .unwrap_or(&self.device_dir)
            .join(CONFIG_FILE)
    }

    pub fn load(&self) -> Result<ProfileView, String> {
        fs::create_dir_all(&self.device_dir).map_err(|error| error.to_string())?;
        let prefs = self.prefs()?;
        let path = self.path(&prefs);
        if prefs.profile_dir.is_none() && !path.try_exists().map_err(|error| error.to_string())? {
            match write(&path, &Profile::default(), false) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        Self::view(path, prefs.profile_dir.is_some())
    }

    fn view(profile_path: PathBuf, custom_folder: bool) -> Result<ProfileView, String> {
        let (profile, etag): (Profile, _) = read(&profile_path)
            .map_err(|error| format!("读取配置失败（{}）：{error}", profile_path.display()))?;
        profile.validate()?;
        Ok(ProfileView {
            profile,
            etag,
            profile_path,
            custom_folder,
        })
    }

    pub fn save(&self, profile: Profile, etag: &str) -> Result<ProfileView, String> {
        profile.validate()?;
        let current = self.load()?;
        if current.etag != etag {
            return Err("配置已被外部修改。请先重新加载，再重试更改。".into());
        }
        write(&current.profile_path, &profile, true)
            .map_err(|error| format!("保存失败：{error}"))?;
        Self::view(current.profile_path, current.custom_folder)
    }

    pub fn select_dir(
        &self,
        folder: Option<PathBuf>,
        migrate_etag: Option<&str>,
    ) -> Result<ProfileView, String> {
        fs::create_dir_all(&self.device_dir).map_err(|error| error.to_string())?;
        let default_dir = self
            .device_dir
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let prefs = DevicePrefs {
            profile_dir: folder
                .map(|path| {
                    if !path.is_absolute() || !path.is_dir() {
                        return Err("请选择一个已存在的绝对目录。".to_string());
                    }
                    path.canonicalize().map_err(|error| error.to_string())
                })
                .transpose()?
                .filter(|path| path != &default_dir),
        };
        let target = self.path(&prefs);
        let exists = match fs::symlink_metadata(&target) {
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        if let Some(etag) = migrate_etag {
            let source = self.load()?;
            if source.etag != etag {
                return Err("配置已被外部修改。请先重新加载，再重试更改。".into());
            }
            if source.profile_path == target {
                return Ok(source);
            }
            if exists {
                return Err("目标已有配置，未覆盖。请选择其他目录，或切换为打开已有配置。".into());
            }
            write(&target, &source.profile, false).map_err(|error| format!("迁移失败：{error}"))?;
        } else if !exists && prefs.profile_dir.is_none() {
            write(&target, &Profile::default(), false).map_err(|error| error.to_string())?;
        } else if !exists {
            return Err("此目录没有已有配置，若要复制当前配置，请使用迁移。".into());
        }
        let view = Self::view(target, prefs.profile_dir.is_some())?;
        write(&self.device_dir.join("device.json"), &prefs, true)
            .map_err(|error| error.to_string())?;
        Ok(view)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_ssh_password_round_trips_and_can_be_removed() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let device = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(device.path().into());
        let current = store.load().unwrap();
        let mut profile = current.profile;
        profile.connections.push(serde_json::from_str(r#"{"id":"00000000-0000-4000-8000-000000000000","name":"test","host":"localhost","port":null,"username":"tester","groupId":null,"identityFile":"","keepAlive":30,"tmux":false}"#).unwrap());
        assert!(profile.connections[0].password.is_none());
        profile.connections[0].password = Some(" padded password ".into());
        let mut saved = store.save(profile, &current.etag).unwrap();
        let file = device.path().join(CONFIG_FILE);
        assert!(
            fs::read_to_string(&file)
                .unwrap()
                .contains("\"password\": \" padded password \"")
        );
        #[cfg(unix)]
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o077, 0);
        saved.profile.connections[0].password = Some("bad\npassword".into());
        assert!(store.save(saved.profile.clone(), &saved.etag).is_err());
        saved.profile.connections[0].password = None;
        store.save(saved.profile, &saved.etag).unwrap();
        assert!(!fs::read_to_string(file).unwrap().contains("\"password\""));
    }

    #[test]
    fn sync_folder_uses_existing_config_and_rejects_stale_saves() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let cloud = tempfile::tempdir().unwrap();
        let one = ConfigStore::new(first.path().into());
        let two = ConfigStore::new(second.path().into());
        let initial = one.load().unwrap();
        let old = one
            .select_dir(Some(cloud.path().into()), Some(&initial.etag))
            .unwrap();
        let mut other = two.select_dir(Some(cloud.path().into()), None).unwrap();
        other.profile.groups.push(Group {
            id: "00000000-0000-4000-8000-000000000000".into(),
            name: "服务器".into(),
        });
        two.save(other.profile, &other.etag).unwrap();
        assert!(one.save(old.profile, &old.etag).is_err());
        assert_eq!(one.load().unwrap().profile.groups[0].name, "服务器");
        assert!(
            one.select_dir(None, None)
                .unwrap()
                .profile
                .groups
                .is_empty()
        );
    }

    #[test]
    fn malformed_profile_is_not_replaced() {
        let device = tempfile::tempdir().unwrap();
        let cloud = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(device.path().into());
        let file = cloud.path().join(CONFIG_FILE);
        fs::write(&file, b"broken json").unwrap();
        assert!(store.select_dir(Some(cloud.path().into()), None).is_err());
        assert_eq!(fs::read(file).unwrap(), b"broken json");
        assert!(!store.load().unwrap().custom_folder);
    }

    #[test]
    fn migration_copies_current_config_and_refuses_existing_or_stale_targets() {
        let device = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let occupied = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(device.path().into());
        let old = store.load().unwrap();
        let mut profile = old.profile;
        profile.groups.push(Group {
            id: "00000000-0000-4000-8000-000000000000".into(),
            name: "work".into(),
        });
        let current = store.save(profile, &old.etag).unwrap();
        let original = fs::read(&current.profile_path).unwrap();
        let existing = occupied.path().join(CONFIG_FILE);
        fs::write(&existing, b"already here").unwrap();
        assert!(
            store
                .select_dir(Some(occupied.path().into()), Some(&current.etag))
                .is_err()
        );
        assert_eq!(fs::read(existing).unwrap(), b"already here");
        assert!(
            store
                .select_dir(Some(target.path().into()), Some(&old.etag))
                .is_err()
        );
        assert!(store.select_dir(Some(target.path().into()), None).is_err());
        assert_eq!(store.load().unwrap().profile_path, current.profile_path);
        let copied = store
            .select_dir(Some(target.path().into()), Some(&current.etag))
            .unwrap();
        assert_eq!(copied.profile.groups[0].name, "work");
        assert_eq!(fs::read(&copied.profile_path).unwrap(), original);
        assert_eq!(fs::read(&current.profile_path).unwrap(), original);
        assert_eq!(store.load().unwrap().profile_path, copied.profile_path);
    }
}
