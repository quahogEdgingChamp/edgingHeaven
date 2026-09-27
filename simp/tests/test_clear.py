from simp.clear import clear_target
from simp.config import Config


def test_clear_downloads_keeps_hidden_entries(tmp_path):
    cfg = Config(root=tmp_path)
    root = cfg.models_root()
    (root / "model").mkdir(parents=True)
    (root / "model" / "a.jpg").write_bytes(b"x")
    (root / ".heaven-trash" / "tok").mkdir(parents=True)
    clear_target(cfg, "downloads")
    assert not (root / "model").exists()
    assert (root / ".heaven-trash" / "tok").is_dir()
