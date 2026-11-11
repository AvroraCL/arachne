"""Process-owned locks for disposable geometry caches; never unlink lock files."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import threading
import time


@contextmanager
def cache_lock(folder, waiting=None):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    # flock/locking is attached to this open file. Keeping the inode avoids a
    # stale-lock reclaim race when two servers recover the same cache.
    with (folder / '.build.lock').open('a+b') as file:
        if os.name == 'nt':
            import msvcrt
            file.seek(0, os.SEEK_END)
            if file.tell() == 0:
                file.write(b'\0')
                file.flush()
            def acquire():
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            def release():
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            def acquire():
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            def release():
                fcntl.flock(file.fileno(), fcntl.LOCK_UN)
        notified = False
        while True:
            try:
                acquire()
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if not notified and waiting is not None:
                    waiting()
                    notified = True
                time.sleep(.1)
        try:
            yield
        finally:
            release()


def watch_parent(owner_pid):
    """Stop orphaned Mac/Linux Blender work even if its Node parent was killed.

    Windows still uses the kernel cache lock. Parent lifetime monitoring here
    is intentionally POSIX-only and does not probe Windows PIDs with kill().
    """
    if os.name != 'posix' or owner_pid is None:
        return
    if not isinstance(owner_pid, int) or isinstance(owner_pid, bool) or owner_pid <= 0:
        raise ValueError('模型任务所属进程无效')
    def check():
        if os.getppid() != owner_pid:
            # Immediate process exit also releases the kernel lock; an
            # incomplete cache has no published report and is rebuilt later.
            os._exit(3)
    check()
    def monitor():
        while True:
            time.sleep(.2)
            check()
    threading.Thread(target=monitor, name='geometry-owner', daemon=True).start()
