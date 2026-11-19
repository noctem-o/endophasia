#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 guest launcher (ENDO-13), reconstructed from TRUST-003's retained qemu/boot.sh.
# Runs under the operator's own uid; needs only /dev/kvm. No host share, no forwarding, no listener, no device passthrough.
#   boot.sh provision   user-mode NIC (outbound only, no hostfwd) + cloud-init seed: package provisioning only
#   boot.sh offline     no NIC; vdb = read-only stage disk, vdc = writable evidence-out disk
# Every invocation's exact argv is appended to qemu-argv.log before exec.
set -eu
W=${ENDO13_WORK:-$HOME/.capy/work/endo13}
cd "$W/vm"
set -- "$1" -name endo13-guest -no-user-config -nodefaults -machine q35,accel=kvm -cpu host -smp 4 -m 4096 \
  -display none -vga none -monitor none -serial "pipe:$PWD/con" -pidfile "$PWD/qemu.pid" \
  -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
  -drive "if=virtio,file=$PWD/overlay.qcow2,format=qcow2"
mode=$1; shift
# Close every inherited descriptor above stderr: the provisioning boot inherited a directory descriptor from the operator's session.
for fd in $(ls /proc/$$/fd); do [ "$fd" -gt 2 ] && eval "exec $fd>&-" 2>/dev/null || true; done
case "$mode" in
provision) set -- "$@" -drive "if=virtio,file=$PWD/seed.iso,format=raw,readonly=on" -nic user,model=virtio-net-pci ;;
offline) set -- "$@" -drive "if=virtio,file=$PWD/stage.img,format=raw,readonly=on" -drive "if=virtio,file=$PWD/out.img,format=raw" -nic none ;;
*) echo "usage: boot.sh provision|offline" >&2; exit 64 ;;
esac
printf '%s %s:' "$(date -u +%FT%TZ)" "$mode" >> qemu-argv.log
for a in qemu-system-x86_64 "$@"; do printf ' %s' "$a"; done >> qemu-argv.log
echo >> qemu-argv.log
exec qemu-system-x86_64 "$@"
