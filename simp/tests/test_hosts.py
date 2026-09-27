from simp.bookmarks import clean_bookmark_title, parse_page_spec
from simp.hosts import MediaKind, classify_url
from simp.util import sanitize_filename, thread_slug_from_url


def test_classify_bunkr():
    link = classify_url("https://bunkr.si/a/abc123")
    assert link is not None
    assert link.prefer_cdl is True
    assert link.kind == MediaKind.ALBUM


def test_classify_attachment():
    link = classify_url("https://simpcity.cr/attachments/photo-jpg.99999/")
    assert link is not None
    assert link.source == "attachment"
    assert link.prefer_cdl is False


def test_classify_direct_image():
    link = classify_url("https://jpg5.su/img/foo.jpg")
    assert link is not None
    assert link.kind == MediaKind.IMAGE


def test_slug():
    assert thread_slug_from_url("https://simpcity.cr/threads/some-model.12345/") == "some-model"
    assert thread_slug_from_url("https://simpcity.cr/threads/ramierah.347998/") == "ramierah"


def test_sanitize():
    assert "/" not in sanitize_filename('a/b<c>:"d')


def test_clean_title():
    assert clean_bookmark_title("Thread 'Emilyrayxo'") == "Emilyrayxo"
    assert clean_bookmark_title("Post in thread 'GrettaGrand'") == "GrettaGrand"


def test_page_spec():
    assert parse_page_spec(3) == [3]
    assert parse_page_spec("2-4") == [2, 3, 4]
    assert parse_page_spec("1,3,8") == [1, 3, 8]
    assert parse_page_spec("2-3,7") == [2, 3, 7]
    assert parse_page_spec("all") is None
    assert parse_page_spec("9", last_page=8) == []
    assert parse_page_spec("5-9", last_page=8) == [5, 6, 7, 8]


def test_format_bytes():
    from simp.estimate import format_bytes

    assert format_bytes(500) == "500 B"
    assert "KB" in format_bytes(2048)
    assert "MB" in format_bytes(5 * 1024 * 1024)


def test_with_thread_page():
    from simp.hosts import with_thread_page

    link = classify_url("https://jpg5.su/img/foo.jpg")
    assert link is not None
    tagged = with_thread_page(link, 7)
    assert tagged.thread_page == 7
    assert tagged.url == link.url


def test_exclude_archives():
    from simp.hosts import is_excluded_ext

    assert is_excluded_ext("https://cdn.example/a/file.zip")
    assert is_excluded_ext("https://cdn.example/a/file.ZIP?x=1")
    assert is_excluded_ext("https://cdn.example/a/pack.rar")
    assert is_excluded_ext("https://cdn.example/a/pack.7z")
    assert classify_url(
        "https://example.com/x.zip", exclude_extensions=[".zip"]
    ) is None
    assert not is_excluded_ext("https://cdn.example/a/file.mp4")
