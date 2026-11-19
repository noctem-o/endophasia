#!/bin/sh
# endo11 guest boot. $1 = provision (user-mode NIC, seed ISO) | offline (no NIC, stage + out disks)
set -eu
cd "$HOME/.capy/work/endo11/vm"
common="-name endo11-guest -no-user-config -nodefaults -machine q35,accel=kvm -cpu host -smp 4 -m 6144 \
 -display none -vga none -monitor none -serial pipe:$PWD/con -pidfile $PWD/qemu.pid \
 -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
 -drive if=virtio,file=$PWD/overlay.qcow2,format=qcow2"
case "$1" in
provision) exec qemu-system-x86_64 $common -drive if=virtio,file=$PWD/seed.iso,format=raw,readonly=on -nic user,model=virtio-net-pci ;;
offline) exec qemu-system-x86_64 $common -drive if=virtio,file=$PWD/stage.img,format=raw,readonly=on -drive if=virtio,file=$PWD/out.img,format=raw -nic none ;;
esac
