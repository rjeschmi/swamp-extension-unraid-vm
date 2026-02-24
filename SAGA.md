# Promotion Evidence: STAR Bullets from `swamp-extension-unraid-vm`

## Theme: Owned end-to-end infrastructure automation platform

---

**S** — The team needed repeatable, scriptable provisioning of VMs, Kubernetes clusters, and Rancher management on both local (Unraid) and cloud (OpenStack/OVH) infrastructure — with no reliable existing tooling.

**T** — Design and build a complete automation platform as a composable set of extension models and orchestration workflows.

**A** — Delivered **7 TypeScript extension models** (~2,200 lines) and **4 orchestration workflows** from scratch over 3 days:

- `@rjeschmi/unraid-vm-provision` — SSH/libvirt-based VM provisioning with cloud-init injection; eliminated dependency on Unraid plugins
- `@rjeschmi/cloud-init-iso` — Pure JavaScript ISO 9660 generation (no `genisoimage`/`mkisofs`/Python required on the target host) — a novel zero-dependency solution
- `@rjeschmi/k3s`, `@rjeschmi/rancher-kubeconfig`, `@rjeschmi/helm-chart` — composable Kubernetes lifecycle models, wired together via CEL expressions
- `@rjeschmi/rancher-openstack` (~918 lines) — full Rancher API integration covering cloud credentials, node templates, and RKE cluster provisioning against OVH OpenStack
- End-to-end `rancher-vm` workflow: VM → k3s → cert-manager → Rancher in a single command
- End-to-end `provision-openstack-cluster` workflow with parameterized multi-node RKE provisioning
- `test-vm-provisioning` integration test workflow with guaranteed teardown (destroy runs unconditionally)
- `delete-cluster-after` workflow: schedules TTL-based cluster cleanup via a Kubernetes CronJob deployed into the management cluster

**R** — A full Rancher stack (`https://<vm-ip>.sslip.io`) is provisionable end-to-end with one command in ~15 minutes. OpenStack clusters provision at configurable scale. Integration tests run in ~45 seconds with guaranteed cleanup, enabling CI-safe validation.

---

## Supporting Detail

| Dimension | Evidence |
|---|---|
| Technical depth | Zero-dependency ISO generation; libvirt/cloud-init without plugins; Rancher API automation across 5+ resource types |
| Scope | 2 infrastructure targets (local Unraid + OVH OpenStack); 4 workflows; 7 models |
| Reliability | Non-happy-path handling: guaranteed destroy in tests, MTU/OOM workarounds documented, kubeconfig server address rewrite |
| Reusability | Models are published as `@rjeschmi/` packages, parameterized via CEL expressions, composable by others |
| Operational maturity | Vault-based credential management; documented setup; `keepVm` escape hatch for debugging |
