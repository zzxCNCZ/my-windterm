#[cfg(target_os = "macos")]
pub const SSH: &str = "/usr/bin/ssh";

pub async fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut command = tokio::process::Command::new(system_directory()?.join("rundll32.exe"));
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
        Err("Unable to open the page.".into())
    }
}

#[cfg(windows)]
pub fn system_directory() -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = [0; 260];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Unable to find the Windows system directory.".into());
    }
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    )))
}

#[cfg(windows)]
pub fn ssh_program() -> Result<std::path::PathBuf, String> {
    let path = system_directory()?.join("OpenSSH").join("ssh.exe");
    if !path.is_file() {
        return Err("Install OpenSSH Client from Windows Settings → Optional features.".into());
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
pub fn ssh_program() -> Result<std::path::PathBuf, String> {
    Ok(SSH.into())
}

#[cfg(target_os = "macos")]
pub fn clipboard(text: &str) -> Result<(), String> {
    use objc2_app_kit::NSPasteboard;
    write_pasteboard(&NSPasteboard::generalPasteboard(), text)
}

#[cfg(target_os = "macos")]
pub fn write_pasteboard(
    pasteboard: &objc2_app_kit::NSPasteboard,
    text: &str,
) -> Result<(), String> {
    use objc2_app_kit::NSPasteboardTypeString;
    let text = objc2_foundation::NSString::from_str(text);
    pasteboard.clearContents();
    if pasteboard.setString_forType(&text, unsafe { NSPasteboardTypeString }) {
        Ok(())
    } else {
        Err("无法写入系统剪贴板。".into())
    }
}

#[cfg(windows)]
pub fn clipboard(text: &str, window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
        },
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let units = text.encode_utf16().chain([0]).collect::<Vec<_>>();
    let error = || "Unable to write to the Windows clipboard.".to_string();
    unsafe {
        if OpenClipboard(hwnd.0) == 0 {
            return Err(error());
        }
        let result = (|| {
            let allocation = GlobalAlloc(GMEM_MOVEABLE, units.len() * size_of::<u16>());
            if allocation.is_null() {
                return Err(error());
            }
            let target = GlobalLock(allocation).cast::<u16>();
            if target.is_null() {
                GlobalFree(allocation);
                return Err(error());
            }
            std::ptr::copy_nonoverlapping(units.as_ptr(), target, units.len());
            GlobalUnlock(allocation);
            const CF_UNICODETEXT: u32 = 13;
            if EmptyClipboard() == 0 || SetClipboardData(CF_UNICODETEXT, allocation).is_null() {
                GlobalFree(allocation);
                return Err(error());
            }
            Ok(())
        })();
        CloseClipboard();
        result
    }
}
