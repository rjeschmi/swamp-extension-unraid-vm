# Unraid Swamp Models

[Swamp](https://github.com/systeminit/swamp) extension models for managing
virtual machines on [Unraid](https://unraid.net/).

**Repository:** https://github.com/rjeschmi/swamp-extension-unraid-vm

## Models

### `@rjeschmi/unraid-vm`

Controls existing Unraid VMs via the Unraid GraphQL API (requires Unraid 6.12+).

**Global arguments:**

| Argument | Description |
|----------|-------------|
| `host`   | Unraid server URL, e.g. `https://tower.local` |
| `apiKey` | API key from Unraid Settings → API Keys |

**Methods:** `list`, `start`, `stop`, `forceStop`, `pause`, `resume`

---

### `@rjeschmi/unraid-vm-provision`

Provisions new Ubuntu cloud-init VMs on Unraid over SSH using libvirt. No
Unraid plugins required — only SSH access and a working QEMU/libvirt setup.

**Global arguments:**

| Argument       | Description |
|----------------|-------------|
| `sshHost`      | Unraid SSH hostname or IP |
| `sshUser`      | SSH username (typically `root`) |
| `sshPrivateKey` | SSH private key in PEM format |
| `domainsDir`   | VM storage directory, e.g. `/mnt/user/domains` |

**Methods:** `provision`, `verify`, `destroy`, `restart`, `dumpXml`

**Provision arguments:**

| Argument        | Description |
|-----------------|-------------|
| `name`          | VM name / hostname |
| `cpus`          | Number of vCPUs |
| `memoryMiB`     | RAM in MiB |
| `diskSizeGb`    | Disk size in GB |
| `ubuntuVersion` | `24.04`, `22.04`, or `20.04` |
| `sshPublicKey`  | SSH public key to inject into the VM |
| `username`      | Unix username to create |

Ubuntu cloud images are cached in `<domainsDir>/.cloud-images` and reused
across provisions. VM disks are qcow2 with a backing file (no full copy).

**Verify arguments:**

| Argument            | Description |
|---------------------|-------------|
| `name`              | VM name to verify |
| `expectedHostname`  | Expected hostname after cloud-init |
| `expectedUsername`  | Expected Unix username |
| `userSshPrivateKey` | Private key matching the public key injected during provisioning |
| `timeoutSeconds`    | Max seconds to wait for boot (default 300) |

**What cloud-init configures on first boot:**
- Hostname
- User account with passwordless sudo
- SSH public key
- `qemu-guest-agent` installed and enabled

---

### `@rjeschmi/cloud-init-iso`

Generates a cloud-init NoCloud seed ISO (ISO 9660) locally in pure JavaScript —
no `genisoimage`, `mkisofs`, or Python required on the target host. Useful
standalone or as a library imported by other models.

**Methods:** `generate`

| Argument   | Description |
|------------|-------------|
| `userData` | cloud-config user-data content |
| `metaData` | cloud-init meta-data content |

Returns the ISO as a binary file artifact.

## Setup

### 1. Create a vault for secrets

```bash
swamp vault create local_encryption unraid-secrets
swamp vault put unraid-secrets UNRAID_API_KEY=<your-api-key>
swamp vault put unraid-secrets SSH_PRIVATE_KEY="$(cat ~/.ssh/id_ed25519)"
```

### 2. Create model instances

```bash
swamp model create @rjeschmi/unraid-vm unraid-vms
swamp model create @rjeschmi/unraid-vm-provision unraid-vm-provision
```

Then edit the generated YAML files to set your host, credentials, and VM
arguments.

### 3. Run methods

```bash
# List all VMs
swamp model method run unraid-vms list

# Provision a new VM
swamp model method run unraid-vm-provision provision

# Destroy it
swamp model method run unraid-vm-provision destroy
```

## Testing

The `test-vm-provisioning` workflow runs a full integration test: provisions an
ephemeral VM, verifies cloud-init applied correctly, then destroys it (~45s
end-to-end).

```bash
# Generate a throwaway keypair
ssh-keygen -t ed25519 -N "" -f /tmp/swamp-test-key -C "swamp-ci-test"

# Run the workflow
INPUT=$(python3 -c "
import json
pub = open('/tmp/swamp-test-key.pub').read().strip()
priv = open('/tmp/swamp-test-key').read()
print(json.dumps({'sshPublicKey': pub, 'userSshPrivateKey': priv}))
")
swamp workflow run test-vm-provisioning --input "$INPUT" --json

# Clean up the throwaway key
rm /tmp/swamp-test-key /tmp/swamp-test-key.pub
```

The workflow checks that:
- The VM booted and received a DHCP address
- SSH is reachable as the provisioned user
- `hostname` matches the VM name
- The user account exists
- `cloud-init status` is `done`

The destroy job runs unconditionally, so the test VM is always cleaned up even
if verification fails.

## Requirements

- [Swamp](https://github.com/systeminit/swamp)
- Unraid 6.12+ (for GraphQL API support)
- SSH access to Unraid with libvirt/QEMU available
- `virsh` on the Unraid host

## License

[AGPL 3.0](LICENSE)
