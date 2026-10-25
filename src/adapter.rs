use crate::{
    BrowserUse, CancellationToken, Error, IoError, LocalIo,
    protocol::{self, Document, Header, Reply, Request},
    runtime, view,
};
use nddev_device_sync_adapter_io::LocalChannel;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

/// Session control and execution use short bounded exchanges; the host, not
/// this client, holds the long-lived browser link.
const CONTROL_DEADLINE: Duration = Duration::from_secs(20);
const EXECUTION_HEADROOM: Duration = Duration::from_secs(4);

#[derive(Clone)]
pub struct BrowserUseClient {
    io: LocalIo,
    socket: PathBuf,
}

impl BrowserUseClient {
    pub fn new(io: LocalIo, socket: PathBuf) -> Result<Self, Error> {
        if !socket.is_absolute() {
            return Err(IoError::InvalidConfiguration.into());
        }
        Ok(Self { io, socket })
    }

    pub fn for_current_user(io: LocalIo) -> Result<Self, Error> {
        Self::new(io, runtime::control_socket(&runtime::directory()?)?)
    }

    async fn exchange(
        &self,
        request: Request,
        deadline: Duration,
        cancellation: CancellationToken,
    ) -> Result<Reply, Error> {
        let frame = serde_json::to_vec(&request).map_err(|_| IoError::InvalidConfiguration)?;
        let socket = self.socket.clone();
        let start = Instant::now();
        let payload = self
            .io
            .local(cancellation, move |cancellation| {
                let mut channel =
                    LocalChannel::connect(&socket, deadline, protocol::FRAME_LIMIT, cancellation)?;
                channel.send_frame(&frame)?;
                let header: Header = serde_json::from_slice(&channel.read_frame()?)
                    .map_err(|_| IoError::InvalidResponse)?;
                channel.read_payload(header.bytes)
            })
            .await;
        let outcome = match &payload {
            Ok(_) => "ok",
            Err(_) => "error",
        };
        tracing::debug!(
            event.name = "browser.client.exchange",
            duration_ms = start.elapsed().as_millis() as u64,
            outcome,
        );
        match serde_json::from_slice(&payload?).map_err(|_| Error::InvalidResponse)? {
            Reply::Refused { refusal } => Err(refusal.into()),
            reply => Ok(reply),
        }
    }
}

impl BrowserUse for BrowserUseClient {
    async fn status(&self, cancellation: CancellationToken) -> Result<view::Status, Error> {
        match self
            .exchange(Request::Status, CONTROL_DEADLINE, cancellation)
            .await?
        {
            Reply::Status(status) => Ok(status),
            _ => Err(Error::InvalidResponse),
        }
    }

    async fn open(
        &self,
        project: &str,
        cancellation: CancellationToken,
    ) -> Result<view::Session, Error> {
        let request = Request::Open {
            project: project.into(),
        };
        match self
            .exchange(request, CONTROL_DEADLINE, cancellation)
            .await?
        {
            Reply::Session(session) => Ok(session),
            _ => Err(Error::InvalidResponse),
        }
    }

    async fn update(&self, cancellation: CancellationToken) -> Result<bool, Error> {
        match self
            .exchange(Request::Update, CONTROL_DEADLINE, cancellation)
            .await?
        {
            Reply::Updated { reload } => Ok(reload),
            _ => Err(Error::InvalidResponse),
        }
    }

    async fn sessions(&self, cancellation: CancellationToken) -> Result<Vec<view::Session>, Error> {
        match self
            .exchange(Request::Sessions, CONTROL_DEADLINE, cancellation)
            .await?
        {
            Reply::Sessions { sessions } => Ok(sessions),
            _ => Err(Error::InvalidResponse),
        }
    }

    async fn close(
        &self,
        project: &str,
        close_tabs: bool,
        cancellation: CancellationToken,
    ) -> Result<(), Error> {
        let request = Request::Close {
            project: project.into(),
            close_tabs,
        };
        match self
            .exchange(request, CONTROL_DEADLINE, cancellation)
            .await?
        {
            Reply::Closed => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    async fn execute(
        &self,
        project: &str,
        code: &str,
        timeout: Duration,
        expect: Option<Document>,
        cancellation: CancellationToken,
    ) -> Result<view::Outcome, Error> {
        let timeout_ms = timeout.as_millis() as u64;
        if !protocol::valid_execution(timeout_ms) {
            return Err(crate::protocol::Refusal::InvalidRequest.into());
        }
        let request = Request::Execute {
            project: project.into(),
            code: code.into(),
            timeout_ms,
            expect,
        };
        match self
            .exchange(request, timeout + EXECUTION_HEADROOM, cancellation)
            .await?
        {
            Reply::Executed(outcome) => Ok(outcome),
            _ => Err(Error::InvalidResponse),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NativeIo;

    #[test]
    fn client_requires_an_absolute_socket() {
        let io = NativeIo::new(1).unwrap().local_handle();
        assert!(matches!(
            BrowserUseClient::new(io.clone(), PathBuf::from("control.sock")),
            Err(Error::Io(IoError::InvalidConfiguration))
        ));
        assert!(BrowserUseClient::new(io, std::env::temp_dir().join("control.sock")).is_ok());
    }

    #[tokio::test]
    async fn absent_host_is_unavailable_not_success() {
        let root = tempfile::tempdir().unwrap();
        let io = NativeIo::new(1).unwrap().local_handle();
        let client = BrowserUseClient::new(io, root.path().join("control.sock")).unwrap();
        assert_eq!(
            client.status(CancellationToken::new()).await.err(),
            Some(Error::Io(IoError::Unavailable))
        );
    }

    #[tokio::test]
    async fn execution_deadline_is_validated_before_io() {
        let io = NativeIo::new(1).unwrap().local_handle();
        let client = BrowserUseClient::new(io, std::env::temp_dir().join("absent.sock")).unwrap();
        let result = client
            .execute(
                "nds",
                "1",
                Duration::from_secs(26),
                None,
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            result.err(),
            Some(Error::Refused(protocol::Refusal::InvalidRequest))
        );
    }
}
