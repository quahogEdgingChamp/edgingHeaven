import io
import select
import socket
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

from server import AppServer, MediaLibrary, RequestHandler, OPEN_RANGE_CHUNK


class MediaHTTPTests(unittest.TestCase):
    def serve(self, path, range_header=None, head=False):
        handler = object.__new__(RequestHandler)
        handler.headers = {"Range": range_header} if range_header else {}
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler._serve_file(path, send_body=not head)
        return (handler.send_response.call_args.args[0],
                dict(call.args for call in handler.send_header.call_args_list),
                handler.wfile.getvalue())

    def test_ranges_suffix_clamped_end_and_head(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.webm"
            path.write_bytes(b"0123456789")
            for requested, content_range, expected in (
                ("bytes=2-5", "bytes 2-5/10", b"2345"),
                ("bytes=-3", "bytes 7-9/10", b"789"),
                ("bytes=8-999", "bytes 8-9/10", b"89"),
            ):
                status, headers, body = self.serve(path, requested)
                self.assertEqual(status, 206)
                self.assertEqual(headers["Content-Range"], content_range)
                self.assertEqual(int(headers["Content-Length"]), len(expected))
                self.assertEqual(body, expected)
                self.assertEqual(self.serve(path, requested, head=True)[2], b"")
            status, headers, body = self.serve(path, "bytes=10-")
            self.assertEqual(status, 416)
            self.assertEqual(headers["Content-Range"], "bytes */10")
            self.assertEqual(body, b"")

    def test_open_ranges_are_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.webm"
            path.write_bytes(b"v" * (OPEN_RANGE_CHUNK + 100))
            status, headers, body = self.serve(path, "bytes=0-")
            self.assertEqual(status, 206)
            self.assertEqual(len(body), OPEN_RANGE_CHUNK)
            self.assertEqual(int(headers["Content-Length"]), OPEN_RANGE_CHUNK)


class ListenQueueTests(unittest.TestCase):
    def test_a_burst_of_connections_is_held_not_dropped(self):
        # The server is bound but not accepting, like one busy for a moment.
        # With socketserver's default backlog of 5 the kernel completed only
        # six of these handshakes and dropped the rest's SYNs (retried 1 s
        # later); every one must complete at once.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "media").mkdir()
            library = MediaLibrary(root / "media", root / "data" / "state.json")
            server = AppServer(("127.0.0.1", 0), RequestHandler, library)
            clients = []
            try:
                for _ in range(40):
                    client = socket.socket()
                    client.setblocking(False)
                    client.connect_ex(server.server_address)
                    clients.append(client)
                deadline = time.monotonic() + 0.5
                waiting = list(clients)
                while waiting and time.monotonic() < deadline:
                    _, writable, _ = select.select([], waiting, [], 0.05)
                    waiting = [client for client in waiting if client not in writable]
                self.assertEqual(len(waiting), 0, f"{len(waiting)} of 40 connections were not accepted")
                for client in clients:
                    self.assertEqual(client.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR), 0)
            finally:
                for client in clients:
                    client.close()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
