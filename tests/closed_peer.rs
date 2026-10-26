//! Experiment (not for merge): does LocalChannel read buffered data after its peer closed?
#![cfg(unix)]

use nddev_device_sync_adapter_io::LocalChannel;
use nddev_device_sync_browser_use::CancellationToken;
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixListener,
    time::Duration,
};

#[test]
fn a_payload_written_before_the_peer_closes_stays_readable() {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/tmp".into());
    let directory = tempfile::Builder::new()
        .prefix("nds-bu-exp-")
        .tempdir_in(base)
        .unwrap();
    let path = directory.path().join("s.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let mut failures = Vec::new();
    for _ in 0..50 {
        let server = {
            let listener = listener.try_clone().unwrap();
            std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut writer = stream;
                writer.write_all(b"{\"bytes\":5}\n").unwrap();
                writer.flush().unwrap();
                std::thread::sleep(Duration::from_millis(30));
                writer.write_all(b"hello").unwrap();
                // The host drops its connection right after the reply.
            })
        };
        let mut channel = LocalChannel::connect(
            &path,
            Duration::from_secs(5),
            65_536,
            CancellationToken::new(),
        )
        .unwrap();
        channel.send_frame(b"{\"op\":\"status\"}").unwrap();
        let header = channel.read_frame().unwrap();
        assert_eq!(header, b"{\"bytes\":5}");
        server.join().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        match channel.read_payload(5) {
            Ok(payload) => assert_eq!(payload, b"hello"),
            Err(error) => failures.push(format!("{error:?}")),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of 50 reads failed after the peer closed: {:?}",
        failures.len(),
        failures.first()
    );
}
