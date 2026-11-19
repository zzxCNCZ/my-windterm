use nix::libc::{c_char, c_int};
use std::{
    env,
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use zeroize::Zeroizing;

pub const SOCKET_ENV: &str = "MY_WINDTERM_ASKPASS_SOCKET";

unsafe extern "C" {
    fn readpassphrase(
        prompt: *const c_char,
        buffer: *mut c_char,
        size: usize,
        flags: c_int,
    ) -> *mut c_char;
}

fn login_prompt(prompt: &str) -> bool {
    let Some(target) = prompt.strip_suffix("'s password: ") else {
        return false;
    };
    target.split_once('@').is_some_and(|(user, host)| {
        !user.is_empty() && !host.is_empty() && !target.chars().any(char::is_whitespace)
    })
}

pub fn helper() -> Option<bool> {
    let socket = PathBuf::from(env::var_os(SOCKET_ENV)?);
    let Some(prompt) = env::args().nth(1) else {
        return Some(false);
    };
    let hint = env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    if hint == "none" {
        if let Ok(mut tty) = File::options().write(true).open("/dev/tty") {
            let _ = writeln!(tty, "{prompt}");
        }
        return Some(false);
    }
    Some(answer(&socket, &prompt, &hint).is_ok())
}

fn answer(socket: &Path, prompt: &str, hint: &str) -> std::io::Result<()> {
    if hint.is_empty()
        && login_prompt(prompt)
        && let Ok(stream) = UnixStream::connect(socket)
    {
        if let Some(password) = read_password(stream)? {
            let mut stdout = std::io::stdout().lock();
            stdout.write_all(&password)?;
            return stdout.write_all(b"\n");
        }
    }
    let prompt = CString::new(prompt)?;
    let confirm = hint == "confirm"
        || prompt.as_bytes().ends_with(b"(yes/no/[fingerprint])? ")
        || prompt.as_bytes().ends_with(b"(yes/no)? ")
        || prompt.as_bytes().starts_with(b"Please type 'yes'");
    let mut answer = Zeroizing::new([0u8; 1024]);
    let result = unsafe {
        readpassphrase(
            prompt.as_ptr(),
            answer.as_mut_ptr().cast(),
            answer.len(),
            2 | i32::from(confirm),
        )
    };
    let length = answer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(answer.len());
    if result.is_null() || (confirm && length == 0) {
        return Err(std::io::Error::other("SSH prompt cancelled"));
    }
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&answer[..length])?;
    stdout.write_all(b"\n")
}

fn read_password(stream: UnixStream) -> std::io::Result<Option<Zeroizing<Vec<u8>>>> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut password = Zeroizing::new(Vec::new());
    stream.take(513).read_to_end(&mut password)?;
    Ok((!password.is_empty() && password.len() <= 512).then_some(password))
}

pub fn serve(path: PathBuf, listener: UnixListener, password: Zeroizing<String>) {
    thread::spawn(move || {
        while path.exists() {
            match listener.accept() {
                Ok((mut client, _)) => {
                    let _ = client.set_write_timeout(Some(Duration::from_secs(2)));
                    let _ = client.write_all(password.as_bytes());
                    let _ = std::fs::remove_file(path);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_responds_to_login_password_not_other_ssh_prompts() {
        assert!(login_prompt("alex@example.org's password: "));
        assert!(!login_prompt("Enter passphrase for key '/tmp/example': "));
        assert!(!login_prompt("Enter alex@example.org's old password: "));
        assert!(!login_prompt("Password: "));
        assert!(!login_prompt(
            "Continue connecting (yes/no/[fingerprint])? "
        ));
    }

    #[test]
    #[ignore = "requires permission to bind a private Unix socket"]
    fn secret_is_served_once_over_private_socket() {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let path = directory.path().join("pw");
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        serve(
            path.clone(),
            listener,
            Zeroizing::new(" fixture password ".into()),
        );
        let mut first = String::new();
        UnixStream::connect(&path)
            .unwrap()
            .read_to_string(&mut first)
            .unwrap();
        assert_eq!(first, " fixture password ");
        assert!(UnixStream::connect(path).is_err());
    }
}
