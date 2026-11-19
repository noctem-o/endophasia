import subprocess
import sys
from pathlib import Path


def main(pre):
    checker = Path(__file__).with_name("extract.py")
    for archive in ("state.tar", "install.tar", "repos-availability.tar", "repos-installed-1.tar", "repos-installed-2.tar"):
        subprocess.run([sys.executable, "-I", checker, "--check", pre / archive], check=True)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
