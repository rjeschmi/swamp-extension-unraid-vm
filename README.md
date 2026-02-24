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

---

### `@rjeschmi/k3s`

Installs k3s on a provisioned VM via SSH and waits for the node to be ready.
Helm chart installs are handled separately by `@rjeschmi/helm-chart`.

**Global arguments:**

| Argument          | Description |
|-------------------|-------------|
| `sshHost`         | Unraid SSH hostname or IP |
| `sshUser`         | SSH username (typically `root`) |
| `sshPrivateKey`   | SSH private key for Unraid |
| `vmSshUser`       | Username on the VM |
| `vmSshPrivateKey` | SSH private key for the VM user |

**Methods:** `install`, `uninstall`

**`install` arguments:**

| Argument         | Description |
|------------------|-------------|
| `vmName`         | VM name (used to discover IP via virsh) |
| `timeoutSeconds` | Max seconds to wait (default: 600) |

Writes a `cluster` resource with `vmName`, `vmIp`, and `k3sVersion`.

---

### `@rjeschmi/rancher-kubeconfig`

Fetches `/etc/rancher/k3s/k3s.yaml` from a k3s VM over SSH, rewrites the
server address from `127.0.0.1` to the VM's real IP, and stores it as a
resource.

**Global arguments:**

| Argument          | Description |
|-------------------|-------------|
| `sshHost`         | Unraid SSH hostname or IP |
| `sshUser`         | SSH username (typically `root`) |
| `sshPrivateKey`   | SSH private key for Unraid |
| `vmSshUser`       | Username on the VM |
| `vmSshPrivateKey` | SSH private key for the VM user |

**Methods:** `fetch`

| Argument  | Description |
|-----------|-------------|
| `vmName`  | VM name to fetch kubeconfig from (default: `rancher`) |

```bash
# Fetch the kubeconfig (vmName defaults to "rancher")
swamp model method run rancher-kubeconfig fetch --json

# Fetch for a different VM
swamp model method run rancher-kubeconfig fetch --input '{"vmName": "my-vm"}' --json

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

### `@rjeschmi/helm-chart`

Installs, upgrades, and uninstalls Helm charts against any cluster using a
kubeconfig passed as a global argument. Runs `helm` locally — no Helm required
on the target VM.

**Global arguments:**

| Argument     | Description |
|--------------|-------------|
| `kubeconfig` | kubeconfig YAML content for the target cluster |

**Methods:** `install`, `uninstall`, `status`

**`install` arguments:**

| Argument          | Description |
|-------------------|-------------|
| `releaseName`     | Helm release name |
| `chart`           | Chart reference, e.g. `ingress-nginx/ingress-nginx` |
| `namespace`       | Target Kubernetes namespace |
| `repoName`        | Helm repo name to add (optional) |
| `repoUrl`         | Helm repo URL — required if `repoName` is set |
| `version`         | Chart version (default: latest) |
| `values`          | Key/value pairs passed as `--set` flags |
| `valuesYaml`      | Raw YAML string passed as `-f` |
| `createNamespace` | Create namespace if missing (default: `true`) |
| `waitSeconds`     | Seconds to `--wait` (default: 300, set to 0 to skip) |

Two instances are provided:

- **`rancher-helm`** — general-purpose instance wired to
  `vault.get(unraid-secrets, RANCHER_KUBECONFIG)`, useful for ad-hoc chart
  installs:

  ```bash
  swamp model method run rancher-helm install --input '{
    "releaseName": "ingress-nginx",
    "chart": "ingress-nginx/ingress-nginx",
    "namespace": "ingress-nginx",
    "repoName": "ingress-nginx",
    "repoUrl": "https://kubernetes.github.io/ingress-nginx"
  }' --json
  ```

- **`rancher-install-helm`** — used by the `rancher-vm` workflow; kubeconfig
  is wired to the live `rancher-kubeconfig` model resource so it always uses
  the freshly fetched kubeconfig:

  ```yaml
  kubeconfig: ${{ model.rancher-kubeconfig.resource.kubeconfig.rancher.attributes.kubeconfig }}
  ```

---

## Setup

### 1. Create a vault for secrets

```bash
swamp vault create local_encryption unraid-secrets
swamp vault put unraid-secrets UNRAID_API_KEY=<your-api-key>
swamp vault put unraid-secrets SSH_PRIVATE_KEY="$(cat ~/.ssh/id_ed25519)"
# For Rancher VM workflows:
swamp vault put unraid-secrets RANCHER_VM_SSH_PRIVATE_KEY="$(cat ~/.ssh/rancher_vm_key)"
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

---

## Rancher VM Workflow

The `rancher-vm` workflow provisions a VM on Unraid and installs a full Rancher
stack (k3s + cert-manager + Rancher) end-to-end. Each stage is a separate job
using the appropriate model:

| Job | Model | What it does |
|-----|-------|-------------|
| `provision` | `@rjeschmi/unraid-vm-provision` | Create Ubuntu VM with cloud-init |
| `install` | `@rjeschmi/k3s` | Install k3s, wait for node ready |
| `fetch-kubeconfig` | `@rjeschmi/rancher-kubeconfig` | Fetch kubeconfig, rewrite server IP |
| `install-cert-manager` | `@rjeschmi/helm-chart` | Install jetstack/cert-manager |
| `install-rancher` | `@rjeschmi/helm-chart` | Install rancher-latest/rancher |

### Prerequisites

Store secrets in the vault (one-time setup):

```bash
swamp vault create local_encryption unraid-secrets
swamp vault put unraid-secrets SSH_PRIVATE_KEY="$(cat ~/.ssh/id_ed25519)"
swamp vault put unraid-secrets RANCHER_VM_SSH_PRIVATE_KEY="$(cat ~/.ssh/rancher_vm_key)"
```

`helm` and `kubectl` must be installed locally — chart installs run on your
machine against the cluster, not on the VM.

### Run the workflow

```bash
swamp workflow run rancher-vm --input '{
  "sshPublicKey": "'$(cat ~/.ssh/rancher_vm_key.pub)'"
}' --json
```

Optional inputs (all have defaults):

| Input            | Default    | Description |
|------------------|------------|-------------|
| `vmName`         | `rancher`  | VM name and hostname |
| `username`       | `rancher`  | Unix username created by cloud-init |
| `sshPublicKey`   | _(required)_ | Public key injected into the VM |
| `rancherVersion` | `latest`   | Rancher Helm chart version |

Check progress:

```bash
swamp workflow history get rancher-vm --json
swamp workflow history logs rancher-vm --json
```

Once complete, Rancher is available at `https://<vm-ip>.sslip.io` with
bootstrap password `admin`.

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
- `helm` installed locally (for `@rjeschmi/helm-chart`)
- `kubectl` installed locally (for post-install status checks)

## License

[AGPL 3.0](LICENSE)
