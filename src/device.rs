//! Agent browsers on the owner's other devices. The agent's CLI runs that device's own CLI over
//! the owner's existing remote shell, so agent code runs beside the device's browser and its
//! network, and nothing here listens, forwards a port or opens a tunnel. Each device keeps its own
//! host, extension and tab groups; this module only says how to reach its CLI.

use crate::IoError;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

const NAME_LIMIT: usize = 32;
const VALUE_LIMIT: usize = 256;
const DEVICE_LIMIT: usize = 32;
/// Where `just install` puts the CLI, relative to the remote user's home.
const REMOTE_CLI: &str = ".local/share/nds-browser-use/bin/nds-browser-use";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    schema: u32,
    devices: BTreeMap<String, Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    /// An ssh host or alias; the owner's ssh configuration says how to reach it.
    ssh: Option<String>,
    /// The CLI on the device, absolute or relative to the remote home.
    cli: Option<String>,
    /// A command that runs the device's CLI, given as its arguments; nothing is shell-parsed.
    command: Option<Vec<String>>,
}

/// How a device's CLI is reached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transport {
    Ssh { host: String, cli: String },
    Command { argv: Vec<String> },
}

impl Transport {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Ssh { .. } => "ssh",
            Self::Command { .. } => "command",
        }
    }

    /// The program and arguments that run the device's CLI with `args`. Over ssh the remote
    /// shell parses one command line, so every argument is quoted for it; nothing is interpreted.
    pub fn invocation(&self, args: &[&str]) -> (String, Vec<String>) {
        match self {
            Self::Ssh { host, cli } => {
                let mut line = remote_path(cli);
                for arg in args {
                    line.push(' ');
                    line.push_str(&quote(arg));
                }
                let options = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
                let mut argv: Vec<String> = options.iter().map(|option| (*option).into()).collect();
                argv.extend([host.clone(), "--".into(), line]);
                ("ssh".into(), argv)
            }
            Self::Command { argv } => {
                let mut rest: Vec<String> = argv[1..].to_vec();
                rest.extend(args.iter().map(|arg| (*arg).to_owned()));
                (argv[0].clone(), rest)
            }
        }
    }
}

/// The configured devices, by name.
pub struct Devices(BTreeMap<String, Transport>);

impl Devices {
    /// `devices.json` beside the host configuration. A missing file means no devices. The file
    /// says which commands run, so it must be a regular file only its owner can change.
    pub fn load() -> Result<Self, IoError> {
        let path = crate::install::config_dir()?.join("devices.json");
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                private(&path, &metadata)?;
                Self::parse(&std::fs::read(&path).map_err(|_| IoError::Unavailable)?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self(BTreeMap::new())),
            Err(_) => Err(IoError::Unavailable),
        }
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, IoError> {
        let file: File =
            serde_json::from_slice(bytes).map_err(|_| IoError::InvalidConfiguration)?;
        if file.schema != 1 || file.devices.len() > DEVICE_LIMIT {
            return Err(IoError::InvalidConfiguration);
        }
        let mut devices = BTreeMap::new();
        for (name, entry) in file.devices {
            if !valid_name(&name) {
                return Err(IoError::InvalidConfiguration);
            }
            let transport = match (entry.ssh, entry.command) {
                (Some(host), None) if valid_host(&host) => Transport::Ssh {
                    host,
                    cli: match entry.cli {
                        Some(cli) if valid_value(&cli) => cli,
                        Some(_) => return Err(IoError::InvalidConfiguration),
                        None => REMOTE_CLI.into(),
                    },
                },
                (None, Some(argv))
                    if entry.cli.is_none()
                        && !argv.is_empty()
                        && argv.len() <= 16
                        && argv.iter().all(|arg| valid_value(arg))
                        && Path::new(&argv[0]).is_absolute() =>
                {
                    Transport::Command { argv }
                }
                _ => return Err(IoError::InvalidConfiguration),
            };
            devices.insert(name, transport);
        }
        Ok(Self(devices))
    }

    pub fn get(&self, name: &str) -> Option<&Transport> {
        self.0.get(name)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Transport)> {
        self.0.iter()
    }
}

pub fn valid_name(name: &str) -> bool {
    (1..=NAME_LIMIT).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// An ssh destination: an alias or `user@host`, never an option.
fn valid_host(host: &str) -> bool {
    (1..=VALUE_LIMIT).contains(&host.len())
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@'))
}

fn valid_value(value: &str) -> bool {
    (1..=VALUE_LIMIT).contains(&value.len())
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}

// The CLI path for the remote shell: `~/` names the remote home, which the shell expands outside
// the quotes.
fn remote_path(cli: &str) -> String {
    match cli.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", quote(rest)),
        None => quote(cli),
    }
}

// One shell word: single-quoted, with each single quote closed, escaped and reopened.
fn quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

#[cfg(unix)]
fn private(path: &Path, metadata: &std::fs::Metadata) -> Result<(), IoError> {
    use std::os::unix::fs::MetadataExt;
    let mode = metadata.mode();
    if !metadata.file_type().is_file()
        || metadata.uid() != directory_owner(path)?
        || mode & 0o022 != 0
    {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(())
}

// The owner of the configuration directory is the user the file must belong to.
#[cfg(unix)]
fn directory_owner(path: &Path) -> Result<u32, IoError> {
    use std::os::unix::fs::MetadataExt;
    let parent = path.parent().ok_or(IoError::InvalidConfiguration)?;
    std::fs::metadata(parent)
        .map(|metadata| metadata.uid())
        .map_err(|_| IoError::Unavailable)
}

#[cfg(windows)]
fn private(_path: &Path, metadata: &std::fs::Metadata) -> Result<(), IoError> {
    // The per-user local application data directory is private to the user on Windows.
    if metadata.file_type().is_file() {
        Ok(())
    } else {
        Err(IoError::InvalidConfiguration)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_reach_a_cli_over_ssh_or_a_command() {
        let devices = Devices::parse(
            br#"{"schema":1,"devices":{"pc":{"ssh":"rldyourmnd-pc"},"lab":{"ssh":"me@lab.example","cli":"~/bin/nds-browser-use"},"self":{"command":["/usr/bin/nds-browser-use"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            devices.get("pc"),
            Some(&Transport::Ssh {
                host: "rldyourmnd-pc".into(),
                cli: REMOTE_CLI.into()
            })
        );
        assert_eq!(devices.get("self").unwrap().kind(), "command");
        assert_eq!(devices.iter().count(), 3);
    }

    #[test]
    fn a_device_never_takes_an_option_or_an_unknown_field() {
        for file in [
            r#"{"schema":1,"devices":{"pc":{"ssh":"-oProxyCommand=x"}}}"#,
            r#"{"schema":1,"devices":{"pc":{"ssh":"pc","command":["/bin/x"]}}}"#,
            r#"{"schema":1,"devices":{"pc":{"command":["relative"]}}}"#,
            r#"{"schema":1,"devices":{"pc":{"command":[]}}}"#,
            r#"{"schema":1,"devices":{"pc":{"ssh":"pc","cli":"-x"}}}"#,
            r#"{"schema":1,"devices":{"PC":{"ssh":"pc"}}}"#,
            r#"{"schema":1,"devices":{"pc":{"ssh":"pc","port":22}}}"#,
            r#"{"schema":2,"devices":{}}"#,
            r#"{"schema":1,"devices":{"pc":{"ssh":"pc host"}}}"#,
        ] {
            assert!(Devices::parse(file.as_bytes()).is_err(), "{file}");
        }
    }

    #[test]
    fn ssh_quotes_every_argument_for_the_remote_shell() {
        let transport = Transport::Ssh {
            host: "pc".into(),
            cli: "~/bin/nds browser".into(),
        };
        let (program, argv) = transport.invocation(&["-s", "it's", "-e", "$(rm -rf ~) `x` \"y\""]);
        assert_eq!(program, "ssh");
        assert_eq!(
            &argv[..7],
            [
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "pc",
                "--"
            ]
        );
        assert_eq!(
            argv[7],
            r#""$HOME"/'bin/nds browser' '-s' 'it'\''s' '-e' '$(rm -rf ~) `x` "y"'"#
        );
    }

    #[test]
    fn a_command_device_appends_the_arguments_without_a_shell() {
        let transport = Transport::Command {
            argv: vec!["/usr/bin/nds-browser-use".into()],
        };
        assert_eq!(
            transport.invocation(&["-s", "a b", "status"]),
            (
                "/usr/bin/nds-browser-use".into(),
                vec!["-s".into(), "a b".into(), "status".into()]
            )
        );
    }
}
