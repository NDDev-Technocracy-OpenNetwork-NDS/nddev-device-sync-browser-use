//! Local stream sockets of the host: the control channel and the CDP endpoint.
//!
//! Unix uses tokio's Unix sockets. Windows has `AF_UNIX` sockets that tokio does not drive, so
//! `async-io` drives `socket2` sockets there and `Stream` exposes tokio's I/O traits.

use std::{io, path::Path};

#[cfg(unix)]
pub(crate) use tokio::net::{UnixListener as Listener, UnixStream as Stream};

#[cfg(unix)]
pub(crate) fn bind(path: &Path) -> io::Result<Listener> {
    Listener::bind(path)
}

#[cfg(unix)]
pub(crate) async fn accept(listener: &Listener) -> io::Result<Stream> {
    listener.accept().await.map(|(stream, _)| stream)
}

/// Whether a host already answers on `path`.
#[cfg(unix)]
pub(crate) fn answers(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

#[cfg(windows)]
pub(crate) struct Listener(async_io::Async<socket2::Socket>);

#[cfg(windows)]
fn unix_socket() -> io::Result<socket2::Socket> {
    socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)
}

#[cfg(windows)]
pub(crate) fn bind(path: &Path) -> io::Result<Listener> {
    let socket = unix_socket()?;
    socket.bind(&socket2::SockAddr::unix(path)?)?;
    socket.listen(128)?;
    async_io::Async::new(socket).map(Listener)
}

#[cfg(windows)]
pub(crate) async fn accept(listener: &Listener) -> io::Result<Stream> {
    let (stream, _) = listener.0.read_with(|listener| listener.accept()).await?;
    async_io::Async::new(stream).map(Stream)
}

#[cfg(windows)]
pub(crate) fn answers(path: &Path) -> bool {
    socket2::SockAddr::unix(path)
        .and_then(|address| unix_socket()?.connect(&address))
        .is_ok()
}

/// A connected socket. Reads and writes go through the shared-reference stream impls of
/// `async-io`, which need no `IoSafe` assertion.
#[cfg(windows)]
pub(crate) struct Stream(async_io::Async<socket2::Socket>);

#[cfg(windows)]
impl tokio::io::AsyncRead for Stream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        let mut socket = &self.0;
        let read = std::task::ready!(futures_io::AsyncRead::poll_read(
            std::pin::Pin::new(&mut socket),
            context,
            buffer.initialize_unfilled(),
        ))?;
        buffer.advance(read);
        std::task::Poll::Ready(Ok(()))
    }
}

#[cfg(windows)]
impl tokio::io::AsyncWrite for Stream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        data: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        let mut socket = &self.0;
        futures_io::AsyncWrite::poll_write(std::pin::Pin::new(&mut socket), context, data)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        let mut socket = &self.0;
        futures_io::AsyncWrite::poll_flush(std::pin::Pin::new(&mut socket), context)
    }

    /// Ends the write direction, as tokio's sockets do.
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::task::Poll::Ready(self.0.get_ref().shutdown(std::net::Shutdown::Write))
    }
}
