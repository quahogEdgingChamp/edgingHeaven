import tempfile
import unittest
from pathlib import Path

from server import MediaLibrary


class DriveReconnectTests(unittest.TestCase):
    def test_missing_drive_connect_disconnect_reconnect_preserves_ratings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            drive = root / "drive"
            library = MediaLibrary(drive, root / "state.json")
            self.assertFalse(library.state_payload()["libraryReady"])

            drive.mkdir()
            (drive / "photo.jpg").write_bytes(b"photo")
            library._last_availability_check = 0
            self.assertTrue(library.availability_payload()["libraryReady"])
            self.assertEqual(library.library_payload()["counts"]["images"], 1)
            self.assertTrue(library.set_rating("photo.jpg", "like"))

            disconnected = root / "unplugged"
            drive.rename(disconnected)
            library._last_availability_check = 0
            self.assertFalse(library.availability_payload()["libraryReady"])
            self.assertEqual(library.library_payload()["counts"]["images"], 0)
            self.assertIsNone(library.resolve_media_path("photo.jpg"))

            # A process restart while unplugged must remember the library and ratings.
            library = MediaLibrary(None, root / "state.json")
            disconnected.rename(drive)
            library._last_availability_check = 0
            self.assertTrue(library.availability_payload()["libraryReady"])
            self.assertEqual(library.library_payload()["images"][0]["rating"], "like")

    def test_rescan_reactivates_saved_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            drive = root / "drive"
            library = MediaLibrary(drive, root / "state.json")
            drive.mkdir()
            (drive / "clip.mp4").write_bytes(b"video")
            library.scan()
            self.assertTrue(library.state_payload()["libraryReady"])
            self.assertEqual(library.library_payload()["counts"]["videos"], 1)

    def test_poll_does_not_rescan_connected_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            library = MediaLibrary(root, root / "state.json")
            updated = library.catalog["updatedAt"]
            library._last_availability_check = 0
            self.assertEqual(library.availability_payload()["updatedAt"], updated)


if __name__ == "__main__":
    unittest.main()
