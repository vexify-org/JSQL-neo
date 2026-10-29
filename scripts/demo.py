#!/usr/bin/env python3
"""Drive `jsql tui` in a pty for the README terminal demo.

Requires a global install and asciinema:

    npm install -g jsql-neo
    asciinema rec --overwrite --cols 100 --rows 30 \
        --idle-time-limit 1 -c "python3 scripts/demo.py" doc/demo.cast
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

COLS, ROWS = 100, 30

STEPS = [
    (0.4, "jsql tui\r"),
    (2.6, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL, team TEXT);\r"),
    (0.8, "CREATE TABLE orders (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, amount INT);\r"),
    (0.8, "INSERT INTO users (name, team) VALUES ('Alice','core'),('Bob','core'),('Cara','web');\r"),
    (0.8, "INSERT INTO orders (user_id, amount) VALUES (1,120),(1,80),(2,50),(3,200);\r"),
    (0.8, "SELECT u.team, COUNT(*) AS orders, SUM(o.amount) AS total\r"),
    (0.4, "FROM users u JOIN orders o ON o.user_id = u.id\r"),
    (0.4, "GROUP BY u.team ORDER BY total DESC;\r"),
    (1.6, "SELECT NULL = NULL AS eq, NULL IS NULL AS is_null;\r"),
    (1.6, "SELECT 9007199254740993 AS big_int;\r"),
    (0.8, "BEGIN;\r"),
    (0.5, "INSERT INTO users (name, team) VALUES ('Dana','ops');\r"),
    (0.5, "SAVEPOINT sp1;\r"),
    (0.5, "INSERT INTO users (name, team) VALUES ('Eve','ops');\r"),
    (0.5, "ROLLBACK TO sp1;\r"),
    (0.5, "COMMIT;\r"),
    (1.6, "SELECT COUNT(*) AS users FROM users;\r"),
    (1.6, "SELECT id, name, team FROM users ORDER BY id;\r"),
    (1.5, "\x04"),
    (0.5, "exit\r"),
]


def main() -> int:
    schedule = []
    total = 0.0
    for delay, text in STEPS:
        total += delay
        schedule.append((total, text))

    env = os.environ.copy()
    env.update({"JSQL_NO_STAR_NAG": "1", "PS1": "$ ", "TERM": "xterm-256color"})

    pid, master = pty.fork()
    if pid == 0:
        os.chdir(os.path.expanduser("~"))
        os.execvpe("bash", ["bash", "--norc", "--noprofile", "-i"], env)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    start = time.monotonic()
    sent = 0
    out = sys.stdout.buffer
    while True:
        elapsed = time.monotonic() - start
        while sent < len(schedule) and elapsed >= schedule[sent][0]:
            try:
                os.write(master, schedule[sent][1].encode())
            except OSError:
                break
            sent += 1

        try:
            ready, _, _ = select.select([master], [], [], 0.03)
        except InterruptedError:
            continue
        if not ready:
            if sent >= len(schedule) and os.waitpid(pid, os.WNOHANG)[0] == pid:
                break
            continue

        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()

    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    os.close(master)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
