//! Phones: agent tabs in a Chromium browser on an Android phone (docs/mobile.md).
//!
//! Chrome for Android runs no extensions, and the Android browsers that do (Edge, Vivaldi) give
//! them neither `chrome.debugger` nor native messaging. What every Chromium browser on Android
//! offers is DevTools on an abstract unix socket, reachable once the owner turned on USB
//! debugging and authorized this computer. The phone link stands in for the desktop extension
//! over that socket; the host, the executor and the agent are the same.

pub mod adb;
pub mod link;

use crate::host;

/// One browser the phone exposes DevTools for.
#[derive(Clone, Debug, serde::Serialize)]
pub struct PhoneBrowser {
    pub socket: String,
    pub product: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

/// One phone the ADB server knows, with its browsers once it is ready.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Phone {
    pub serial: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub browsers: Vec<PhoneBrowser>,
}

/// The phones and their browsers. A socket that does not answer as DevTools is left out.
pub async fn phones(server: &adb::Server) -> std::io::Result<Vec<Phone>> {
    let mut phones = Vec::new();
    for device in server.devices().await? {
        let mut browsers = Vec::new();
        if device.state == "device" {
            let sockets = server
                .shell(&device.serial, "cat /proc/net/unix")
                .await
                .map(|unix| adb::devtools_sockets(&unix))
                .unwrap_or_default();
            for socket in sockets {
                if let Ok(browser) = link::version(server, &device.serial, &socket).await {
                    browsers.push(PhoneBrowser {
                        socket,
                        product: browser.product,
                        package: browser.package,
                    });
                }
            }
        }
        phones.push(Phone {
            serial: device.serial,
            state: device.state,
            model: device.model,
            browsers,
        });
    }
    Ok(phones)
}

/// The browser socket to use when the owner names none: Chrome's, else the only browser's.
/// Chrome takes `chrome_devtools_remote` (with its process id appended when another browser holds
/// that name), other browsers `<name>_devtools_remote`, and apps' WebViews
/// `webview_devtools_remote_<pid>`, used only when nothing else is there.
pub fn default_socket(browsers: &[PhoneBrowser]) -> Option<&str> {
    fn only<'a>(mut candidates: impl Iterator<Item = &'a str>) -> Option<&'a str> {
        let first = candidates.next()?;
        candidates.next().is_none().then_some(first)
    }
    let sockets = || browsers.iter().map(|browser| browser.socket.as_str());
    sockets()
        .find(|socket| *socket == "chrome_devtools_remote")
        .or_else(|| only(sockets().filter(|socket| !socket.starts_with("webview_"))))
        .or_else(|| only(sockets()))
}

#[derive(Debug, thiserror::Error)]
pub enum ServeError {
    #[error("the phone's browser is not reachable")]
    Browser,
    #[error(transparent)]
    Host(#[from] host::HostError),
}

/// Runs the host for one phone's browser until the browser goes away or the host stops.
pub async fn serve(
    config: host::Config,
    server: adb::Server,
    serial: &str,
    socket: &str,
    observation: &str,
    stop: impl Future<Output = ()> + Send + 'static,
) -> Result<link::Ended, ServeError> {
    let browser = link::version(&server, serial, socket)
        .await
        .map_err(|_| ServeError::Browser)?;
    let devtools = link::connect(&server, serial, socket, &browser)
        .await
        .map_err(|_| ServeError::Browser)?;
    let (host_side, link_side) = tokio::io::duplex(4 * 1_048_576);
    let (input, output) = tokio::io::split(host_side);
    let notices = link::Notices {
        server,
        serial: serial.to_owned(),
    };
    let observation = observation.to_owned();
    let linked = tokio::spawn(async move {
        link::run(
            devtools,
            &browser,
            &observation,
            Some(notices),
            link_side,
            stop,
        )
        .await
    });
    let served = host::serve(config, None, input, output).await;
    let ended = linked.await.unwrap_or(link::Ended::Host);
    served?;
    Ok(ended)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_is_chosen_before_other_browsers_and_web_views() {
        let browsers = |sockets: &[&str]| -> Vec<PhoneBrowser> {
            sockets
                .iter()
                .map(|socket| PhoneBrowser {
                    socket: (*socket).to_owned(),
                    product: String::new(),
                    package: None,
                })
                .collect()
        };
        let chosen = |sockets: &[&str]| default_socket(&browsers(sockets)).map(str::to_owned);
        assert_eq!(
            chosen(&[
                "com.brave.browser_devtools_remote",
                "chrome_devtools_remote"
            ])
            .as_deref(),
            Some("chrome_devtools_remote")
        );
        assert_eq!(
            chosen(&[
                "webview_devtools_remote_812",
                "com.microsoft.emmx_devtools_remote"
            ])
            .as_deref(),
            Some("com.microsoft.emmx_devtools_remote")
        );
        assert_eq!(
            chosen(&["webview_devtools_remote_812"]).as_deref(),
            Some("webview_devtools_remote_812")
        );
        assert_eq!(chosen(&["a_devtools_remote", "b_devtools_remote"]), None);
        assert_eq!(chosen(&[]), None);
    }
}
