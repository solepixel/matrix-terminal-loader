"""Hold a pseudo-terminal open for the integration tests.

Forks a child on a fresh pty, sets the window size, prints the slave device
path on the first line of stdout, then forwards every byte the pty produces to
stdout until the child exits or stdin is closed. Node reads the device path,
points the plugin at it with MATRIX_TTY, and inspects the forwarded bytes to
see exactly what the plugin drew.

usage: python3 pty-holder.py <cols> <rows> [seconds]
"""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

cols, rows = int(sys.argv[1]), int(sys.argv[2])
seconds = sys.argv[3] if len(sys.argv) > 3 else '120'

pid, fd = pty.fork()
if pid == 0:
    os.execvp('sleep', ['sleep', seconds])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

# os.ttyname(master) is not the slave name, and on macOS it raises; ask ps.
try:
    slave = subprocess.check_output(['ps', '-o', 'tty=', '-p', str(pid)]).decode().strip()
    slave = slave if slave.startswith('/dev/') else '/dev/' + slave
except Exception:
    slave = os.readlink('/proc/%d/fd/0' % pid) if os.path.exists('/proc') else ''
sys.stdout.buffer.write((slave + '\n').encode())
sys.stdout.buffer.flush()

out = sys.stdout.buffer
stdin = sys.stdin.buffer
try:
    while True:
        r, _, _ = select.select([fd, stdin], [], [], 0.5)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out.write(data)
            out.flush()
        if stdin in r:
            if not stdin.read1(4096):
                break  # our controller went away
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            break
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
