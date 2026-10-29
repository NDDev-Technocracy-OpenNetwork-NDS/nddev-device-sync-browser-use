//! A small client of the ADB server's own protocol: the device list, the output of a shell
//! command, and a raw stream to a socket on the device. A stream is opened inside the server's
//! connection (`host:transport:<serial>`, then `localabstract:<name>`), so nothing listens on
//! this machine and no `adb forward` is left behind.

use std::io::{Error, ErrorKind, Result};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

/// The most a shell command's output may be.
const SHELL_LIMIT: usize = 1024 * 1024;

/// One device the ADB server reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub serial: String,
    /// `device` once it is ready; `unauthorized`, `offline` and the like otherwise.
    pub state: String,
    pub model: Option<String>,
}

/// The ADB server this machine reaches: `ADB_SERVER_SOCKET=tcp:<host>:<port>`, else
/// `ANDROID_ADB_SERVER_PORT` on the loopback, else the loopback's port 5037.
#[derive(Clone, Debug)]
pub struct Server {
    address: String,
}

impl Server {
    pub fn from_env() -> Self {
        let address = std::env::var("ADB_SERVER_SOCKET")
            .ok()
            .and_then(|socket| socket.strip_prefix("tcp:").map(str::to_owned))
            .or_else(|| {
                std::env::var("ANDROID_ADB_SERVER_PORT")
                    .ok()
                    .filter(|port| port.parse::<u16>().is_ok())
                    .map(|port| format!("127.0.0.1:{port}"))
            })
            .unwrap_or_else(|| "127.0.0.1:5037".to_owned());
        Self { address }
    }

    pub fn at(address: impl Into<String>) -> Self {
        Self {
            address: address.into(),
        }
    }

    async fn connect(&self) -> Result<TcpStream> {
        let stream = TcpStream::connect(&self.address).await?;
        stream.set_nodelay(true)?;
        Ok(stream)
    }

    pub async fn devices(&self) -> Result<Vec<Device>> {
        let mut stream = self.connect().await?;
        request(&mut stream, "host:devices-l").await?;
        let text = String::from_utf8_lossy(&sized(&mut stream).await?).into_owned();
        Ok(parse_devices(&text))
    }

    /// A shell command's output on the device, at most 1 MiB.
    pub async fn shell(&self, serial: &str, command: &str) -> Result<String> {
        let mut stream = self.transport(serial).await?;
        request(&mut stream, &format!("shell:{command}")).await?;
        let mut output = Vec::new();
        (&mut stream)
            .take(SHELL_LIMIT as u64 + 1)
            .read_to_end(&mut output)
            .await?;
        if output.len() > SHELL_LIMIT {
            return Err(Error::new(ErrorKind::InvalidData, "shell output too large"));
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    /// A raw stream to the abstract unix socket `name` on the device.
    pub async fn open(&self, serial: &str, name: &str) -> Result<TcpStream> {
        let mut stream = self.transport(serial).await?;
        request(&mut stream, &format!("localabstract:{name}")).await?;
        Ok(stream)
    }

    async fn transport(&self, serial: &str) -> Result<TcpStream> {
        if !valid_serial(serial) {
            return Err(Error::new(ErrorKind::InvalidInput, "invalid device serial"));
        }
        let mut stream = self.connect().await?;
        request(&mut stream, &format!("host:transport:{serial}")).await?;
        Ok(stream)
    }
}

/// Serials are what `adb devices` prints: an emulator name, a USB serial or `host:port`.
pub fn valid_serial(serial: &str) -> bool {
    (1..=128).contains(&serial.len())
        && serial
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

/// Sends one length-prefixed request and reads the server's `OKAY` or its `FAIL` reason.
async fn request(stream: &mut TcpStream, message: &str) -> Result<()> {
    if message.len() > 0xffff {
        return Err(Error::new(ErrorKind::InvalidInput, "request too long"));
    }
    stream
        .write_all(format!("{:04x}{message}", message.len()).as_bytes())
        .await?;
    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let reason = String::from_utf8_lossy(&sized(stream).await?).into_owned();
            Err(Error::new(ErrorKind::ConnectionRefused, reason))
        }
        _ => Err(Error::new(ErrorKind::InvalidData, "not an ADB server")),
    }
}

/// A reply carried as four hex digits of length, then that many bytes.
async fn sized(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await?;
    let length = std::str::from_utf8(&length)
        .ok()
        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "invalid length"))?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await?;
    Ok(body)
}

fn parse_devices(text: &str) -> Vec<Device> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?.to_owned();
            let state = fields.next()?.to_owned();
            let model = fields
                .find_map(|field| field.strip_prefix("model:"))
                .map(str::to_owned);
            valid_serial(&serial).then_some(Device {
                serial,
                state,
                model,
            })
        })
        .collect()
}

/// The browsers' DevTools sockets among a device's `/proc/net/unix` lines: Chrome's
/// `chrome_devtools_remote`, other browsers' `<package>_devtools_remote` and WebView apps'
/// `webview_devtools_remote_<pid>`.
pub fn devtools_sockets(proc_net_unix: &str) -> Vec<String> {
    let mut sockets: Vec<String> = proc_net_unix
        .lines()
        .filter_map(|line| line.split_whitespace().last())
        .filter_map(|path| path.strip_prefix('@'))
        .filter(|name| name.contains("devtools_remote") && name.len() <= 128)
        .filter(|name| {
            name.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
        .map(str::to_owned)
        .collect();
    sockets.sort();
    sockets.dedup();
    sockets
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn devices_and_sockets_parse_as_adb_and_android_print_them() {
        let devices = parse_devices(
            "emulator-5580          device product:sdk_phone64_x86_64 model:sdk_gphone64_x86_64 transport_id:1\n\
             R58M12345AB            unauthorized usb:1-1 transport_id:2\n\
             bad/serial device\n",
        );
        assert_eq!(
            devices,
            [
                Device {
                    serial: "emulator-5580".into(),
                    state: "device".into(),
                    model: Some("sdk_gphone64_x86_64".into())
                },
                Device {
                    serial: "R58M12345AB".into(),
                    state: "unauthorized".into(),
                    model: None
                },
            ]
        );
        let unix = "Num       RefCount Protocol Flags    Type St Inode Path\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 12345 @chrome_devtools_remote\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_1592\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 12347 @jdwp-control\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 12348 @chrome_devtools_remote\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 12349 /dev/socket/zygote\n";
        assert_eq!(
            devtools_sockets(unix),
            ["chrome_devtools_remote", "webview_devtools_remote_1592"]
        );
        assert!(!valid_serial("a b") && !valid_serial(""));
    }

    // A fake ADB server: answers the device list, refuses an unknown device, and opens a stream
    // that echoes, the way a device socket carries bytes.
    #[tokio::test]
    async fn the_client_speaks_the_server_protocol_and_reports_its_refusals() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    loop {
                        let mut length = [0u8; 4];
                        if stream.read_exact(&mut length).await.is_err() {
                            return;
                        }
                        let length =
                            usize::from_str_radix(std::str::from_utf8(&length).unwrap(), 16)
                                .unwrap();
                        let mut message = vec![0u8; length];
                        stream.read_exact(&mut message).await.unwrap();
                        let message = String::from_utf8(message).unwrap();
                        if message == "host:devices-l" {
                            let body = "emulator-5580 device model:x\n";
                            let reply = format!("OKAY{:04x}{body}", body.len());
                            stream.write_all(reply.as_bytes()).await.unwrap();
                            return;
                        } else if message == "host:transport:missing" {
                            let reason = "device 'missing' not found";
                            let reply = format!("FAIL{:04x}{reason}", reason.len());
                            stream.write_all(reply.as_bytes()).await.unwrap();
                            return;
                        } else if message.starts_with("host:transport:") {
                            stream.write_all(b"OKAY").await.unwrap();
                        } else if message.starts_with("localabstract:") {
                            stream.write_all(b"OKAY").await.unwrap();
                            let mut buffer = [0u8; 64];
                            let read = stream.read(&mut buffer).await.unwrap();
                            stream.write_all(&buffer[..read]).await.unwrap();
                            return;
                        } else if message.starts_with("shell:") {
                            stream.write_all(b"OKAYoutput of the shell").await.unwrap();
                            return;
                        }
                    }
                });
            }
        });
        let server = Server::at(address);
        let devices = server.devices().await.unwrap();
        assert_eq!(devices[0].serial, "emulator-5580");
        assert_eq!(
            server.shell("emulator-5580", "true").await.unwrap(),
            "output of the shell"
        );
        let mut stream = server
            .open("emulator-5580", "chrome_devtools_remote")
            .await
            .unwrap();
        stream.write_all(b"ping").await.unwrap();
        let mut echo = [0u8; 4];
        stream.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"ping");
        let refused = server
            .open("missing", "chrome_devtools_remote")
            .await
            .unwrap_err();
        assert_eq!(refused.to_string(), "device 'missing' not found");
        assert_eq!(
            server.open("bad serial", "x").await.unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
    }
}
