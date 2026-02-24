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

## Rancher VM Kubeconfig

The `@rjeschmi/rancher-kubeconfig` model fetches `/etc/rancher/k3s/k3s.yaml`
from the Rancher VM over SSH, rewrites the server address from `127.0.0.1` to
the VM's real IP, and stores it as a resource.

### Global arguments

| Argument          | Description |
|-------------------|-------------|
| `sshHost`         | Unraid SSH hostname or IP |
| `sshUser`         | SSH username (typically `root`) |
| `sshPrivateKey`   | SSH private key for Unraid |
| `vmSshUser`       | Username on the VM |
| `vmSshPrivateKey` | SSH private key for the VM user |

### Methods

**`fetch`** — Discovers the VM's IP via `virsh domifaddr`, SSHes in, reads the
kubeconfig, rewrites the server URL, and stores the result.

| Argument  | Description |
|-----------|-------------|
| `vmName`  | VM name (used to look up the IP via virsh on Unraid) |

### Usage

```bash
# Fetch and store the kubeconfig
swamp model method run rancher-kubeconfig fetch --json

# Store the kubeconfig in vault for use outside swamp
KUBECONFIG=$(swamp model output data <output-id> --json | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['data']['kubeconfig'])")
swamp vault put unraid-secrets "RANCHER_KUBECONFIG=$KUBECONFIG" -f
```

The kubeconfig is stored in the `unraid-secrets` vault under `RANCHER_KUBECONFIG`
and can be used directly with `kubectl`:

```bash
# Use via vault expression in a workflow or model
kubeconfig: ${{ vault.get(unraid-secrets, RANCHER_KUBECONFIG) }}

# Export to a local file for direct kubectl use
OUTPUT_ID=$(swamp model output search rancher-kubeconfig --json | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
swamp model output data "$OUTPUT_ID" --json | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['data']['kubeconfig'])" > ~/.kube/rancher.yaml
export KUBECONFIG=~/.kube/rancher.yaml
kubectl get nodes
```

Reference the kubeconfig from other models using a CEL expression:

```yaml
kubeconfig: ${{ model.rancher-kubeconfig.resource.kubeconfig.rancher.attributes.kubeconfig }}
```

---

## Rancher OpenStack Cluster Provisioning

The `provision-openstack-cluster` workflow creates an RKE cluster on OpenStack
via Rancher end-to-end: cloud credential → node template → cluster.

### Prerequisites

Store your OpenStack password and Tailscale auth key in a vault:

```bash
swamp vault create local_encryption openstack-secrets
swamp vault put openstack-secrets OS_PASSWORD=<your-openstack-password>
swamp vault put openstack-secrets TAILSCALE_AUTH_KEY=<your-tailscale-key>  # optional
swamp vault put openstack-secrets RANCHER_TOKEN=<your-rancher-api-token>
```

Create the model instance (only needed once):

```bash
swamp model create @rjeschmi/rancher-openstack openstack-rancher
# Edit models/openstack-rancher/definition.yaml to set rancherUrl and rancherToken vault ref
```

### Run the workflow

```bash
swamp workflow run provision-openstack-cluster --input '{
  "clusterName": "my-cluster",
  "flavorName": "d2-2",
  "imageId": "49ccfac7-cfc6-498c-8c89-a86df5e31db8",
  "networkName": "test",
  "controlPlaneCount": 1,
  "workerCount": 1
}' --json
```

All other inputs default to OVH BHS5 region with `ubuntu` SSH user and 20 GB
root disk. Override any of these as needed:

| Input              | Default                       | Description                              |
|--------------------|-------------------------------|------------------------------------------|
| `clusterName`      | _(required)_                  | RKE cluster name                         |
| `flavorName`       | _(required)_                  | OpenStack flavor (e.g. `d2-2`)           |
| `networkName`      | _(required)_                  | OpenStack network name                   |
| `imageId`          |                               | OpenStack image UUID                     |
| `imageName`        |                               | OpenStack image name (alt. to imageId)   |
| `controlPlaneCount`| `1`                           | Control plane + etcd node count          |
| `workerCount`      | `2`                           | Worker node count                        |
| `rootDiskSizeGb`   | `20`                          | Root disk size in GB                     |
| `sshUser`          | `ubuntu`                      | SSH user on provisioned nodes            |
| `keypairName`      | `""`                          | OpenStack keypair name for SSH access    |
| `secGroups`        | `default`                     | Comma-separated security group names     |
| `kubernetesVersion`| `""`                          | Kubernetes version (empty = Rancher default) |
| `authUrl`          | `https://auth.cloud.ovh.net/v3` | OpenStack Keystone URL                 |
| `username`         | `user-CDEExRrfveQa`           | OpenStack username                       |
| `tenantName`       | `0815908386929626`            | OpenStack project/tenant name            |
| `domainName`       | `Default`                     | OpenStack domain name                    |
| `region`           | `BHS5`                        | OpenStack region                         |

### Delete and redeploy

```bash
# Delete the cluster from Rancher
swamp model method run openstack-rancher deleteCluster --input '{"clusterName": "my-cluster"}' --json

# Redeploy with the same inputs
swamp workflow run provision-openstack-cluster --input '{"clusterName": "my-cluster", ...}' --json
```

Provisioning typically takes ~15 minutes. Check progress with:

```bash
swamp workflow history get provision-openstack-cluster --json
```

---

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

# To keep the VM running after the test for inspection, add keepVm=true:
KEEP_INPUT=$(python3 -c "
import json
pub = open('/tmp/swamp-test-key.pub').read().strip()
priv = open('/tmp/swamp-test-key').read()
print(json.dumps({'sshPublicKey': pub, 'userSshPrivateKey': priv, 'keepVm': True}))
")
swamp workflow run test-vm-provisioning --input "$KEEP_INPUT" --json

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
